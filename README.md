# Routine Coach（日常打卡助手）

A voice-guided, bilingual (Mandarin — Mainland & Taiwan) daily habit tracker. Runs entirely as a single HTML file in the browser, speaks you through your morning and night routines with a natural-sounding voice, and syncs across devices.

---

## What this actually is

A personal habit-coaching app that:

- Walks you through a **morning** and **night** routine, one habit at a time, with a visual countdown ring
- **Speaks** each habit out loud when it starts (using Azure's neural text-to-speech, not the robotic default browser voice), and counts down aloud every 5 seconds in "X分Y秒" format
- Supports **guided sequences** — a single habit made of several timed sub-steps (e.g. a stretch routine: fold → rest → split → rest, repeated several times), each with its own optional voice line
- Lets you restrict any habit to specific **days of the week** (e.g. laundry only on Saturdays)
- Has a full **Mainland Chinese / Taiwan Chinese** toggle — not just Simplified vs. Traditional script, but actual regional vocabulary differences (拉伸 vs 伸展, 熄灯 vs 關燈, etc.)
- **Syncs across devices** via a user-chosen "sync code," backed by Cloudflare KV
- Keeps **local version history** of your routines with a real diff view, so you can see exactly what changed between any two versions and restore an old one
- Supports **import/export** of your entire routine set as JSON, for backup or bulk-editing

---

## Architecture

This is intentionally a **static site + one small backend proxy** — no database server, no user accounts, no build step.

```
┌─────────────────────────────────────────────────────────────┐
│  Your phone / computer browser                                │
│                                                                 │
│   index.html  (the entire app — HTML + CSS + JS, one file)    │
│     │                                                          │
│     ├── localStorage ─── habit data, sync code, version       │
│     │                     history, locale preference          │
│     │                     (all persist per-device)             │
│     │                                                          │
│     └── fetch() calls out to ↓                                 │
└─────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
                 ┌───────────────────────────┐
                 │  Cloudflare Worker          │
                 │  (tts-proxy)                │
                 │                              │
                 │  /            → TTS proxy    │
                 │  /sync/save   → write to KV   │
                 │  /sync/load   → read from KV  │
                 └───────┬───────────┬──────────┘
                         │           │
                         ▼           ▼
              ┌────────────────┐  ┌─────────────────┐
              │ Azure Speech    │  │ Cloudflare KV     │
              │ (neural voice)  │  │ (cross-device      │
              │                 │  │  routine storage)  │
              └────────────────┘  └─────────────────┘
```

**Why a Worker exists at all:** Azure's text-to-speech REST API doesn't allow direct calls from browser JavaScript (CORS). The Worker exists purely to sit in the middle — it holds the real Azure key (never exposed to the browser) and forwards requests. It does double duty as the cross-device sync backend too, since it was already there.

**Why no framework/build step:** the whole point was to keep this a single file you can open, edit, and redeploy trivially, without npm, bundlers, or a local dev server. Everything — UI, state, rendering, the Azure/sync/history logic — lives in one `<script>` tag in `index.html`.

---

## File structure

| File | Purpose |
|---|---|
| `index.html` | The entire app. Frontend only — no server-side code. |
| `azure-tts-proxy-worker.js` | Cloudflare Worker source. Proxies Azure TTS requests and handles cloud sync via KV. **Not currently auto-deployed** — see "Known limitations" below. |

---

## How data flows and where it lives

| Data | Where it lives | Notes |
|---|---|---|
| Your habits (morning/night routines) | `localStorage` on each device, **and** Cloudflare KV if a sync code is set | Local copy acts as an offline cache; KV is the shared source of truth across devices |
| Locale preference (cn/tw) | `localStorage` only | Per-device, not synced |
| Sync code | `localStorage` only | Per-device — each device remembers which code it's "connected" to |
| Version history (last 30 snapshots) | `localStorage` only | **Not synced across devices** — each device has its own history trail |
| Azure API key | Cloudflare Worker secret (dashboard-only) | Never touches the browser or any file in this repo |

---

## Setup (from scratch)

### 1. The Worker (voice + sync backend)

1. Create a free Cloudflare account.
2. Compute → Workers & Pages → Create Worker. Paste in `azure-tts-proxy-worker.js`. Deploy.
3. Settings → Variables and Secrets, add:
   - `AZURE_KEY` (your Azure Speech resource key, marked as **Secret**)
   - `AZURE_REGION` (e.g. `eastasia` — must match your Azure resource's region)
4. Create a KV namespace (Storage & Databases → KV → Create namespace).
5. Bind it to the Worker: Settings → Bindings → Add → KV namespace → variable name **exactly** `ROUTINES_KV`.
6. Note the Worker's URL (e.g. `https://tts-proxy.yoursubdomain.workers.dev`) — this needs to match the `PROXY_URL` constant near the top of the `<script>` in `index.html`.

### 2. The app itself

Either:
- **Direct upload** — Cloudflare Pages → Create → Upload assets → drop in `index.html`. Manually re-upload a new deployment whenever the file changes.
- **Git-connected** — Cloudflare Pages/Compute → Create → Connect to Git → point at this repo. Build command: leave blank. Output directory: repo root (`/` or `.`). Every push auto-deploys. *(This repo may or may not currently be wired this way — check your Cloudflare dashboard to confirm which mode is active.)*

### 3. Add to your phone

Open the live URL in Safari (iPhone) or Chrome (Android) → Share/Menu → "Add to Home Screen." This gives you an app-like icon with no browser chrome.

---

## Day-to-day usage

- **Editing habits:** tap 编辑/編輯 (Edit) at the bottom of the app. Changes save automatically (to `localStorage`, and to the cloud if a sync code is set).
- **Cross-device sync:** in the 跨设备同步/跨裝置同步 section, enter any code (letters/numbers/dashes/underscores, 3–64 characters) and tap 设置/設定 to connect. Then explicitly choose 从云端拉取/從雲端拉取 (Pull) or 推送到云端/推送到雲端 (Push) — **entering a code does not automatically move data in either direction**, on purpose, so nothing gets silently overwritten.
- **Looking back at old versions:** the 历史版本/歷史版本 section auto-records snapshots (throttled to roughly one every 3 minutes of active changes) and lets you view a plain-language diff against your current version, or restore any past snapshot.
- **Bulk editing / backup:** the 导入 / 导出 (Import/Export) section lets you paste in a full JSON routine set (see the data shape below) or copy out your current one.

---

## Routine JSON shape (for import/export)

```json
{
  "morning": [
    { "name": "喝水", "seconds": 30, "days": [], "voice": "", "midway": "" },
    {
      "name": "拉伸",
      "days": [1, 3, 5],
      "subSteps": [
        { "name": "前屈", "seconds": 30, "voice": "" },
        { "name": "休息", "seconds": 10, "voice": "" }
      ]
    }
  ],
  "night": []
}
```

- `days`: array of weekday numbers, `0` = Sunday through `6` = Saturday. Empty array `[]` means every day.
- A habit is either a **simple timer** (has `seconds`) or a **guided sequence** (has `subSteps`, no top-level `seconds`) — never both.
- `voice`: optional custom line spoken at the start of the habit/sub-step. Falls back to the habit's name if blank.
- `midway`: optional line spoken partway through a simple (non-sequence) habit, if it's longer than 40 seconds.

---

## Known limitations / things to know

- **The Worker isn't currently set up for auto-deploy from Git.** Updating `azure-tts-proxy-worker.js` still means manually pasting the new code into the Cloudflare dashboard. This was left as a manual step deliberately, since auto-deploying a Worker requires a `wrangler.toml`/`wrangler.jsonc` config file declaring the exact KV namespace ID, and getting that wrong risks temporarily breaking voice/sync — happy to revisit this later.
- **No real authentication on sync.** A sync code is a shared secret, not a login — anyone who knows your code can read or overwrite your routines via the Worker's `/sync/save` and `/sync/load` endpoints. Don't reuse a real password as your sync code, and don't share it.
- **Sync is last-write-wins, not merge-based.** If the same routine set were edited on two devices at the exact same moment while both were offline, whichever device syncs *last* overwrites the other. In normal single-person use this essentially never comes up.
- **Version history is local per device**, not synced through the cloud. Your phone's history trail and your computer's history trail are separate, and each is capped at the most recent 30 snapshots.
- **Habit diffs match by name, not a stable ID.** Renaming a habit while also changing it will show up as "one habit removed + a different one added" in the diff view, rather than being recognized as a rename.
- **The app relies on the Web Speech API's `speechSynthesis`** as a fallback whenever the Azure call fails (offline, quota, etc.) — so voice guidance should never go fully silent, but the fallback voice will sound noticeably more robotic than the Azure neural voice.
