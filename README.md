# playwright-gemini

Minimal starting point: **Playwright** (browser automation), **@google/genai** (Gemini API), and **dotenv** (environment config).

## Setup

```powershell
npm install
npx playwright install chromium   # only needed for the local UI regression tests
```

Add your keys to `.env` (created from `.env.example`):

```
GEMINI_API_KEY=your-key-from-https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-3.6-flash
BROWSERBASE_API_KEY=YOUR_API_KEY
BROWSERBASE_PROJECT_ID=YOUR_PROJECT_ID
```

All application browser automation creates a **Browserbase** session through the official `@browserbasehq/sdk` (`sessions.create()` with stealth enabled) and connects Playwright with `chromium.connectOverCDP(session.connectUrl)`. Keep `BROWSERBASE_API_KEY` and (recommended) `BROWSERBASE_PROJECT_ID` in `.env` or the deployment environment, never in source control. If the project ID is omitted, the SDK infers the project from the API key. Stealth uses Browserbase Verified mode (`browserSettings.verified`), so the plan must support it. Sessions are explicitly released with `REQUEST_RELEASE` when a run finishes, fails, or is cancelled.

`gemini-2.5-flash` is retired for new API keys (returns 404), and `gemini-3.8-flash` was returning 503 during setup, so the default is **`gemini-3.6-flash`**. Change `GEMINI_MODEL` to use another model — both scripts read it.

## Run

```powershell
npm start
npm start -- https://news.ycombinator.com   # custom URL
```

`index.js` loads `.env`, opens the URL in a Browserbase remote Chromium session, reads the title/heading, then asks Gemini to describe the page. If `GEMINI_API_KEY` is missing it still runs the Playwright part and prints a warning.

## X login (saves session to auth.json)

```powershell
npm run auth
```

1. A Browserbase remote Chromium session opens directly on `https://x.com/i/flow/login`.
2. Open the printed Browserbase live view and log in yourself — password, 2FA, captcha, anything X asks for.
3. Return to the terminal and press **ENTER**.
4. The script checks for the `auth_token` cookie, then writes cookies and X localStorage to `auth.json`.

If you press ENTER too early, the script warns that the session is unverified and saves anyway — just re-run `npm run auth`.

Reuse the session in another script:

```js
import { readFile } from 'node:fs/promises';
import { getDefaultContext, restoreStorageState } from './lib/browser.js';

const state = JSON.parse(await readFile('auth.json', 'utf8'));
const context = await getDefaultContext(browser);
await restoreStorageState(context, state, { clearCookies: true });
```

`auth.json` contains live session tokens and localStorage with full account access. It is in `.gitignore` — keep it out of version control and never share it.

It uses Playwright's `storageState` shape, so you can also write it by hand (or copy cookies from DevTools):

```json
{ "cookies": [ { "name": "auth_token", "value": "…", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true } ], "origins": [] }
```

`auth_token` alone is not enough — X also needs the `ct0` CSRF cookie. Extra metadata keys (`savedAt`, `cookieCount`) are ignored by Playwright.

## Reply automation (main.js)

Prerequisites: a saved session (`npm run auth`) and `GEMINI_API_KEY` in `.env`.

```powershell
npm run automate -- https://x.com/user/status/1234567890 --dry-run  # generate only, no posting
npm run automate -- https://x.com/user/status/1234567890            # asks for confirmation
npm run automate -- https://x.com/user/status/1234567890 --yes      # no prompt
```

Flow: restores cookies and localStorage from `auth.json` → verifies the session on `x.com/home` → opens the tweet → extracts the text (expanding "Show more") → asks Gemini (`GEMINI_MODEL`, default 3.6 Flash) to classify the tweet and write a reply in that domain (≤ 240 chars) → types it into the reply composer → posts it → likes the tweet.

**Dynamic tone, not a crypto bot.** The system prompt makes Gemini identify the tweet's domain first — `crypto`, `web-development`, `software-engineering`, `ui-ux-design`, `ai-ml`, `product-startup` or `other` — and reply in that domain's vocabulary:

```
Detected topic: ui-ux-design
Proposed reply (135/240):
  The hard part is never setting up tokens, it is getting devs to actually use them
  without creating hardcoded overrides two weeks later.
```

Crypto framing (tokens, price action, "alpha", on-chain, trading) is allowed only when the tweet itself is explicitly about crypto. As a safety net, if a non-crypto reply still contains crypto jargon, it is regenerated once with an explicit correction; a failed regeneration falls back to the original draft.

| Flag | Effect |
|---|---|
| `--dry-run` | Stop after printing the generated reply |
| `--yes`, `-y` | Skip the confirmation prompt |
| `--headless` | Accepted for compatibility; Browserbase controls browser visibility |

Output example:

```
Tweet by @somebody:
  ETF flows flipped positive for the first time in 3 weeks…

Detected topic: crypto
Proposed reply (168/240):
  Flows turning positive while funding is still flat is the interesting part…

Post this reply and like the tweet? [Y/n]
```

Notes:

- X changes its `data-testid` attributes from time to time. If a step breaks, inspect the page and update the `SEL` map at the top of `main.js`.
- Automated posting/liking may violate X's automation rules and can get an account limited. This script handles one reply per run, on your own account — don't turn it into a mass-reply loop.
- Gemini runs with thinking disabled (`thinkingBudget: 0`) so the whole token budget goes to the reply. Overload 503s are retried 3× with backoff before failing.

## X sign-in via the web UI (Add X Account)

**Add X Account** opens a direct credential form by default. `POST /auth/x/credentials` accepts an X username/email/phone plus password over same-origin HTTPS, keeps the password in request memory only, and types it into a top-level **Browserbase remote Chromium** page at `https://x.com/i/flow/login`. The password is deleted from the parsed request immediately, never logged, never written to disk, and never returned by the API.

After X sets `auth_token`, the server captures the complete Playwright storage state, atomically writes `sessions/<userId>/<xUsername>.json`, updates the linked-account list, and returns the refreshed accounts so the dropdown updates immediately. If X requests 2FA, email/phone verification, or a captcha, the API returns `challenge_required` and the modal offers the remote-window fallback. It does not attempt to bypass those checks. Production credential requests are rejected unless they arrive through HTTPS.

### Remote challenge fallback

`POST /auth/x` starts the interactive fallback on the same direct X login URL.

Flow:

1. The server creates a **Browserbase** session with `sessions.create()` and stealth (`browserSettings.verified`), connects with `chromium.connectOverCDP(session.connectUrl)`, reuses the remote browser's default context, applies context-wide stealth init scripts (`navigator.webdriver`, permissions, Chrome runtime, WebGL, canvas) to every page, and applies the Chrome 122 User-Agent plus native `sec-ch-ua` client hints to existing pages and popups.
2. Before X navigation, it restores that app tenant's trusted cookies/localStorage, mints the Browserbase debugger URL with `sessions.debug()`, and immediately emits it to the authenticated NDJSON client. The same remote page then opens `https://x.com/i/flow/login` with `Referer: https://x.com/`.
3. The dashboard intentionally does **not** embed the live stream. The 2FA/captcha action pre-opens a native tab and routes it to the debugger URL as soon as the event arrives; **Open Remote Sign-In Window** remains an explicit `window.open(liveUrl, '_blank')` fallback. Client hints are generated natively through CDP metadata rather than forced as global extra headers, because global non-safelisted headers break X's cross-origin onboarding API preflights.
4. Sign in to X in the remote window, including 2FA or any challenge.
5. Click **I’ve completed sign-in** in the dashboard. The server checks for the `auth_token` cookie, captures cookies and localStorage with `context.storageState()`, writes `sessions/<userId>/<xUsername>.json` under persistent `DATA_DIR`, updates the user's linked accounts, and refreshes the account list.
6. The browser disconnects and the Browserbase session is released with `REQUEST_RELEASE`, invalidating the debugger URL. The live link is a short-lived bearer credential; the server sends it only over the authenticated NDJSON stream and never logs it.
7. Press **Cancel** to stop an active remote sign-in. The dashboard calls `POST /auth/x/cancel`, which releases the active-run lock immediately, aborts the Playwright flow, and releases the Browserbase session so **Add X Account** can start a fresh session.

Each app user also gets `sessions/<userId>/_trusted-login-profile.json`. It keeps X guest/device cookies and X localStorage while deliberately removing `auth_token`, `ct0`, `twid`, and other account-authentication cookies, so adding another account reuses a consistent browser identity without silently opening the previously linked account. A request that explicitly supplies an already linked `xUsername` restores that account's complete storage state. Login state is checkpointed during the live session and saved atomically.

An existing **“We've temporarily limited your login”** response is enforced by X and cannot be removed by JavaScript. Stop retrying until X's cooldown expires; repeated attempts from the same cloud IP can extend it. These changes reduce unnecessary fresh-device logins, but a consistent/reputable Browserbase session region is still important.

If the live link cannot be minted, the dashboard still exposes **I’ve completed sign-in** so an operator who can reach the Browserbase dashboard can finish there and confirm it.

`POST /auth/x` responds with `application/x-ndjson` (same event shape as the run endpoint):

```
{"type":"start","command":"browser sign-in -> https://x.com/i/flow/login (Browserbase remote Chromium)"}
{"type":"live","status":"ready","url":"https://browserbase.com/sessions/…","expiresAt":"…"}
{"type":"stdout","data":"Opening https://x.com/i/flow/login …"}
{"type":"stdout","data":"Waiting for you to complete sign-in in the remote window …"}
{"type":"status","stage":"signed-in","data":"X session detected. Click I’ve completed sign-in to save it."}
{"type":"stdout","data":"Login confirmed. Waiting for X home and account identity …"}
{"type":"exit","code":0,"result":{"ok":true,"cookieCount":2,"username":"…"}}
```

`POST /auth/x/complete` requires the same authenticated session as the active sign-in, asks the running Playwright flow to save the X session, and returns `{"ok":true}`. It returns `409` when no X sign-in is in progress and `403` if the active run belongs to another app user.

`POST /auth/x/cancel` is idempotent: it returns `{ "ok": true, "cancelled": false }` when nothing is running, and otherwise clears the active sign-in lock, aborts the Playwright run, and releases the Browserbase session before replying. It is scoped to the authenticated app user.

The optional `BROWSERBASE_LIVE_TIMEOUT_MS` environment variable controls how long the debugger URL stays valid (default: the 10-minute login window, minimum 30 seconds, capped at the login window). The underlying Browserbase session stays open until sign-in finishes or the run is cancelled. Use `BROWSERBASE_SESSION_TIMEOUT_SECONDS` (default `900`) when the X login flow needs longer; Browserbase caps sessions at 21,600 seconds. A legacy `BROWSERLESS_LIVE_TIMEOUT_MS` value is still read for migration.

The equivalent CLI flow is `npm run auth` (same URL, press ENTER after login, writes `auth.json`).

## Session admin UI (server.js)

```powershell
npm run serve            # http://127.0.0.1:10000
$env:PORT=4000; npm run serve
```

The UI has three parts: the **X account** profile card (session status + handle + **Connect X Account** / **Sign out**), the **Run automation** panel with a status card, and the **Automation History** list.

| Route | Purpose |
|---|---|
| `GET /` | UI: X account card, run controls, status card, history panel |
| `GET /api/auth` | JSON status: presence, masked preview, length, domain, flags (browser session) |
| `PUT /api/auth` | Body `{"auth_token": "…", "ct0": "…"}` — either field alone is fine (browser session) |
| `POST /api/auth/logout` | Clear `auth.json` |
| `GET /api/history` | Read the local `history.json` run log |
| `DELETE /api/history` | Clear the local `history.json` run log |
| `POST /auth/x/credentials` | Direct X credential sign-in; password is memory-only, verifies `auth_token`, saves per-tenant storage state |
| `POST /auth/x` | NDJSON: start → live → stdout/stderr/status → exit (Browserbase browser sign-in) |
| `POST /auth/x/complete` | Confirm the active remote X sign-in; saves storage state and updates linked accounts |
| `POST /auth/x/cancel` | Cancel an active remote X sign-in, release the run lock, and release the Browserbase session |
| `POST /api/run` | Body `{"url": "…", "dryRun": true, "headless": true, "reply": true, "like": true, "repost": true}` — spawns `main.js` and streams its output |

`POST /api/run` responds with `application/x-ndjson`; each line is one event:

```
{"type":"start","command":"node main.js https://x.com/user/status/1 --yes --dry-run --headless","pid":1524}
{"type":"stdout","data":"Opening https://x.com/user/status/1 …"}
{"type":"stderr","data":"…"}
{"type":"exit","code":0,"signal":null}
```

`POST /auth/x` responds the same way; the final event carries the sign-in result (`{"type":"exit","code":0,"result":{"ok":true,"cookieCount":2}}`).

The UI consumes the stream for events but renders only a **status notification** (`Idle` / `Running…` / `Completed successfully` / `Run failed` / sign-in equivalents) — raw log lines stay off the dashboard.

### Run actions

The run form exposes checkboxes for the actions to perform; they map to `main.js` flags:

- `reply` → `--reply` (posts the generated reply; writes it to `--reply-out=<path>` for history)
- `like` → `--like`
- `repost` → `--repost`

### Automation history

Every completed run appends an entry to `history.json` (capped at the last 50 runs):

```json
{ "id": "…", "at": "…", "url": "…", "dryRun": false, "actions": ["replied", "liked", "reposted"], "reply": "…", "ok": false, "error": "exit 1" }
```

`GET /api/history` reads it; `DELETE /api/history` clears it; the UI lists entries and offers **Clear History**.

Runner details:

- Passes `--yes` because a spawned child has no TTY to answer the confirmation prompt — **clicking Run with "Dry run" unchecked posts immediately**.
- One run at a time; a second request gets `409`.
- URL is validated against the tweet pattern and passed in an `argv` array (`spawn`, no shell), so it can't inject commands.
- Closing the tab or pressing Stop kills the child **and its Chromium tree** (`taskkill /T /F` on Windows) — verified no orphan browsers/processes afterwards.
- Runs are capped at 10 minutes.

Safety rails, because this endpoint can replace your session:

- Binds to **0.0.0.0** on Render's dynamic `PORT` (falling back to `10000`) so container platforms can reach it.
- CORS allows the local UI, explicitly configured origins (`PUBLIC_ORIGIN` / `ALLOWED_ORIGINS`), Render's `RENDER_EXTERNAL_URL`, and `*.onrender.com` in production. Other websites are rejected.
- Only `auth_token` and `ct0` are writable; other cookies, `origins` and metadata are preserved.
- Values are validated (`[A-Za-z0-9._~%+/-]+`, 8–512 chars) and **masked** in responses — the API never echoes a full cookie back.
- Writes are serialised and atomic (temp file + rename), so an interrupted save can't truncate `auth.json`.

## Persistent users and sessions

`user-db.json`, `auth.json`, `sessions/`, and `history.json` all live under `DATA_DIR`. It defaults to the project directory, which is fine locally but is **ephemeral on Render/Docker unless a disk is mounted**.

For durable accounts:

1. Mount a persistent disk on the hosting platform (for example at `/var/data`).
2. Set `DATA_DIR=/var/data` in the deployment environment.
3. Keep the same production `SESSION_SECRET` and restart the service. Existing app sessions and linked X sessions survive restarts because the user database, session token, and storage-state files stay on the disk. Changing `SESSION_SECRET` invalidates password verification because it is also the password-hash pepper.

For free/ephemeral deployments, set all three `DEFAULT_ADMIN_USERNAME`, `DEFAULT_ADMIN_EMAIL`, and `DEFAULT_ADMIN_PASSWORD` values. On boot the server creates that account when the database is empty (or when the username/email is missing). It never overwrites an existing account or its password. The server logs a warning at startup when it detects Render without `DATA_DIR`.

The CLI (`npm run auth` and `npm run automate`) honors the same `DATA_DIR` for `auth.json`; the server still passes an explicit `AUTH_FILE_PATH` to automation runs.

## Versions

- Node.js >= 20 (project uses ESM: `"type": "module"`)
- playwright 1.64, @browserbasehq/sdk 2.25, @google/genai 2.32, dotenv 18, express 5.3, body-parser 2.4, cors 2.8
