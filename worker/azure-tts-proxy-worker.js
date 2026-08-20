// Cloudflare Worker: does two jobs for the Routine Coach app —
// 1. Proxies Azure Speech TTS requests (avoids browser CORS, keeps the
//    Azure key off the client).
// 2. Stores/loads your habit routines in Cloudflare KV so the same data
//    shows up on every device, keyed by a "sync code" you choose in the app.
//
// SETUP (TTS part — skip if you already did this):
// 1. Go to https://dash.cloudflare.com -> sign up free (no credit card needed).
// 2. Compute -> Workers & Pages -> Create -> "Create Worker". Name it, e.g. "tts-proxy".
// 3. Delete the default code in the editor and paste this whole file in. Click "Deploy".
// 4. Settings -> Variables and Secrets, add:
//      AZURE_KEY    = <your Azure Speech key>   (mark as Secret)
//      AZURE_REGION = eastasia
//
// SETUP (new — sync storage):
// 5. In the Cloudflare dashboard, go to Storage & Databases -> KV -> Create namespace.
//    Name it anything, e.g. "routine-coach-sync". Create it.
// 6. Go back to this Worker -> Settings -> Bindings -> Add binding -> KV namespace.
//      Variable name: ROUTINES_KV   (must match exactly, all caps)
//      KV namespace:  pick the one you just created
//    Save/Deploy.
// 7. That's it — the app will handle the rest once you set a sync code in it.

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAzureToken(env){
  const now = Date.now();
  if(cachedToken && now < cachedTokenExpiry) return cachedToken;
  const res = await fetch(`https://${env.AZURE_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": env.AZURE_KEY }
  });
  if(!res.ok) throw new Error("token fetch failed: " + res.status + " (region used: '" + env.AZURE_REGION + "')");
  cachedToken = await res.text();
  cachedTokenExpiry = now + 9 * 60 * 1000;
  return cachedToken;
}

function escapeSSML(text){
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function handleTTS(request, env){
  if(request.method !== "POST"){
    return new Response("Use POST", { status: 405, headers: CORS_HEADERS });
  }
  try{
    const { text, voice, lang } = await request.json();
    if(!text || !voice || !lang){
      return new Response("Missing text/voice/lang", { status: 400, headers: CORS_HEADERS });
    }

    const token = await getAzureToken(env);
    const ssml = `<speak version="1.0" xml:lang="${lang}"><voice name="${voice}">${escapeSSML(text)}</voice></speak>`;

    const azureRes = await fetch(`https://${env.AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "RoutineCoachProxy"
      },
      body: ssml
    });

    if(!azureRes.ok){
      const errText = await azureRes.text();
      return new Response("Azure synth failed: " + azureRes.status + " " + errText, {
        status: 502, headers: CORS_HEADERS
      });
    }

    const audioBuf = await azureRes.arrayBuffer();
    return new Response(audioBuf, {
      headers: { ...CORS_HEADERS, "Content-Type": "audio/mpeg" }
    });
  }catch(err){
    return new Response("Proxy error: " + err.message, { status: 500, headers: CORS_HEADERS });
  }
}

function isValidCode(code){
  // keep KV keys sane: letters/numbers/dashes/underscores, 3-64 chars
  return typeof code === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(code);
}

async function handleSyncSave(request, env){
  if(request.method !== "POST"){
    return new Response("Use POST", { status: 405, headers: CORS_HEADERS });
  }
  if(!env.ROUTINES_KV){
    return new Response("ROUTINES_KV binding not set up on this Worker", { status: 500, headers: CORS_HEADERS });
  }
  try{
    const { code, data } = await request.json();
    if(!isValidCode(code)){
      return new Response("Invalid sync code", { status: 400, headers: CORS_HEADERS });
    }
    if(typeof data !== "string"){
      return new Response("Missing data", { status: 400, headers: CORS_HEADERS });
    }
    await env.ROUTINES_KV.put("routines:" + code, data);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }catch(err){
    return new Response("Sync save error: " + err.message, { status: 500, headers: CORS_HEADERS });
  }
}

async function handleSyncLoad(request, env){
  if(!env.ROUTINES_KV){
    return new Response("ROUTINES_KV binding not set up on this Worker", { status: 500, headers: CORS_HEADERS });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if(!isValidCode(code)){
    return new Response("Invalid sync code", { status: 400, headers: CORS_HEADERS });
  }
  try{
    const data = await env.ROUTINES_KV.get("routines:" + code);
    return new Response(JSON.stringify({ data: data || null }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }catch(err){
    return new Response("Sync load error: " + err.message, { status: 500, headers: CORS_HEADERS });
  }
}

export default {
  async fetch(request, env){
    if(request.method === "OPTIONS"){
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if(url.pathname === "/sync/save") return handleSyncSave(request, env);
    if(url.pathname === "/sync/load") return handleSyncLoad(request, env);
    // default: treat everything else (including the root "/") as the TTS endpoint,
    // so the existing app config pointing at the bare Worker URL keeps working.
    return handleTTS(request, env);
  }
};
