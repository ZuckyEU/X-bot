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

Reply automation creates a **Browserbase** session through the official `@browserbasehq/sdk` (`sessions.create()`) and connects Playwright with `chromium.connectOverCDP(session.connectUrl)`. Fly's login microservice instead runs its own Chromium and does not need a Browserbase key. Keep `BROWSERBASE_API_KEY` and (recommended) `BROWSERBASE_PROJECT_ID` on the automation/Render backend, never in source control. If the project ID is omitted, the SDK infers the project from the API key. Sessions use Browserbase's standard stealth defaults on the Free tier; Enterprise Verified mode is opt-in via `BROWSERBASE_VERIFIED_MODE=true` because it otherwise fails with a 403. Sessions are explicitly released with `REQUEST_RELEASE` when a run finishes, fails, or is cancelled.

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

## X sign-in via the web UI (Connect X Account)

**Connect X Account** opens a temporary **noVNC browser window on Fly.io**. Type credentials, 2FA codes, and challenges directly into the official X login page there; the dashboard no longer asks for an X password. The app stores the resulting session cookies, which grant account access, so use this only with accounts you own or are authorized to manage.

Flow:

1. The authenticated dashboard posts `{ requestId }` to `POST /api/auth/x-accounts/interactive`. The client-generated UUID lets cancellation target this login even while its start response is pending. Render reserves a pending login bound to the app user **and current app session**, then calls Fly through `lib/interactive-login-client.js` using `HARVEST_API_TOKEN` and a separate one-time callback token.
2. Fly opens headed Chromium at **`https://x.com/login`** on `DISPLAY=:99`. Xvfb supplies the display, Openbox manages the window, x11vnc streams it, and websockify/noVNC provide keyboard/mouse access over the app's HTTPS port.
3. Render returns a private `viewerUrl`. The dashboard pre-opens a native tab and navigates it to the viewer. If popups are blocked, click **Open Remote Sign-In Window**. Do not share the URL.
4. Fly polls cookies once a second. Only `auth_token` **and** `ct0` scoped to X qualify. It waits for X's home timeline, detects the actual handle, revokes viewer input, and closes Chromium before posting the result to the configured Render callback.
5. Render authenticates the callback, validates the account/cookies, atomically writes `sessions/<userId>/<xUsername>.json`, links the account (maximum three), and stages it as the active session. Identical callback retries are idempotent. Raw cookies are never returned to dashboard JavaScript.
6. The dashboard polls its own authenticated status endpoint and updates the connected account automatically. Cancel, account unlink, app logout, expiry, or shutdown abort the pending login. Late callbacks cannot resurrect an unlinked or cleared session.

### Fly desktop deployment

The Docker image installs **Xvfb, x11vnc, noVNC, websockify, Openbox, X authority tools, and tini**. `scripts/start-desktop.sh` waits for the display/transports, starts Node, monitors every service, and tears down the stack if a service fails. Playwright's image version matches `package-lock.json`.

| Service | Setting | Value |
|---|---|---|
| Both | `HARVEST_API_TOKEN` | The same random secret of at least 32 characters |
| Both | `SESSION_SECRET` | A separate strong app-session secret for each backend |
| Fly | `HARVEST_CALLBACK_URL` | `https://YOUR-RENDER-SERVICE.onrender.com/api/auth/x-accounts/interactive/callback` |
| Fly | `INTERACTIVE_LOGIN_ENABLED` | `true` (already in `fly.toml`) |
| Fly | `INTERACTIVE_LOGIN_PUBLIC_ORIGIN` | `https://x-auth-bot-free.fly.dev` (already in `fly.toml`; change for another app/domain) |
| Render | `HARVEST_API_URL` | Optional; defaults to `https://x-auth-bot-free.fly.dev/api/harvest-token` |
| Render | `HARVEST_CALLBACK_URL` | Optional when `RENDER_EXTERNAL_URL` is set automatically; otherwise use the same exact callback URL as Fly |
| Render | `INTERACTIVE_LOGIN_ENABLED` | Leave unset/`false`; Render does not host the desktop |
| Render | `DATA_DIR` | Your persistent disk directory, for example `/var/data` |

Replace all placeholders before running:

```sh
fly secrets set --app x-auth-bot-free \
  SESSION_SECRET='<fly-session-secret>' \
  HARVEST_API_TOKEN='<shared-service-secret>' \
  HARVEST_CALLBACK_URL='https://YOUR-RENDER-SERVICE.onrender.com/api/auth/x-accounts/interactive/callback'
fly deploy --remote-only --app x-auth-bot-free
fly scale count 1 --app x-auth-bot-free
```

Set the matching shared token on Render and deploy its updated backend/dashboard too. `fly.toml` now requests **1 GB RAM and one always-on Machine** instead of 256 MB/autostop: a headed browser plus the desktop needs more memory, and the watcher/callback must survive viewer disconnection. This increases hosting usage/cost. Start with one Fly Machine and one Render process; pending Render logins are in memory and require a fresh login after a restart. Viewer/status/cancel requests include Fly Machine affinity and use `fly-replay` when routed elsewhere.

Only **port 3000** is exposed. **5900 and 6080 bind to `127.0.0.1`**, not the public/private Fly interfaces. Node serves noVNC's static modules and authenticates the WebSocket tunnel before forwarding to websockify. The viewer capability is carried in a URL **fragment**, exchanged for a session-path-scoped HttpOnly, SameSite=Strict cookie, and removed from the address bar. Transport access is revoked immediately on capture/cancel/expiry; old connections cannot observe a subsequent tenant's desktop. The default login window is ten minutes (`INTERACTIVE_LOGIN_TIMEOUT_MS`, 30–900 seconds).

Chromium runs as the unprivileged `xbrowser` user (UID 1001); the window manager/transports use `xdesktop` (UID 1002). Both get whitelisted environments. Backend code/data remain private to the backend user; each browser gets a fresh HOME/TMPDIR that is deleted before desktop reuse. Cleanup verifies that no live UID-1001 processes remain, including Chromium's separate process group; an unconfirmed cleanup blocks desktop reuse until the Fly Machine is restarted. Clipboard/file-transfer inputs and desktop shell shortcuts are disabled. This limits exposure but is **not** a hardened general-purpose sandbox: do not offer an unrestricted public desktop. The service token stays on trusted backends, and callbacks go only to Fly's fixed `HARVEST_CALLBACK_URL` with redirects disabled.

### Interactive API reference

| Endpoint | Access | Purpose |
|---|---|---|
| Render `POST /api/auth/x-accounts/interactive` | App session | Start login; returns `requestId`, private `viewerUrl`, `expiresAt` |
| Render `GET /api/auth/x-accounts/interactive/:requestId` | Owning app session | Status and connected-account metadata; no raw cookies |
| Render `POST /auth/x/cancel` | Owning app session | Revoke pending login and close the Fly browser; `{ requestId }` scopes it to one login |
| Render `POST /api/auth/x-accounts/interactive/callback` | One-time callback bearer | Receive `{ requestId, sessionId, status, browserClosed, username, cookies }` from Fly; completion requires `browserClosed: true` |
| Fly `POST /api/interactive-login/sessions` | `HARVEST_API_TOKEN` | Start with `{ requestId, callbackUrl, callbackToken }`; destination must match configuration |
| Fly `GET /api/interactive-login/sessions/:sessionId` | `HARVEST_API_TOKEN` | Inspect status only |
| Fly `DELETE /api/interactive-login/sessions/:sessionId` | `HARVEST_API_TOKEN` | Close/revoke session |
| Fly `/remote-login/:sessionId?...#token=...` | Private viewer capability | Interactive noVNC URL; not a public/shared desktop |

Each Fly instance permits **one desktop login at a time** and returns 409 when busy. Closing the viewer alone does not cancel login; use the dashboard's Cancel button. A fresh session is required after callback delivery failure. Headed streaming does not remove X's IP reputation checks, rate limits, or challenges.

Run `npm test` for the regression gate. Tests use fake browser/transport targets and local Render↔Fly HTTP services without credentials, including cancellation, tenant ownership, callback retries, and interrupted-write rollback. Run `npm run test:ui` after installing local Chromium for browser checks of popup isolation/fallback, automatic completion, cancellation, and stale-response cleanup. Those UI tests use a stub viewer, not a real noVNC desktop. The full Linux desktop image, real noVNC rendering/input, credentialed X login/2FA, and deployed Fly→Render callbacks still require deployment verification.

### Optional interactive Browserbase sign-in (`POST /auth/x`)

The original Browserbase API remains available as an alternative. `POST /auth/x` streams a Browserbase live URL plus status events to an authenticated NDJSON client, and the user finishes sign-in directly in that remote browser. The default dashboard button now uses Fly/noVNC instead.

Flow:

1. The server creates a **Browserbase** session with `sessions.create()` using standard Free-tier-compatible stealth defaults (`browserSettings.verified` is not requested unless `BROWSERBASE_VERIFIED_MODE=true`), connects with `chromium.connectOverCDP(session.connectUrl)`, reuses the remote browser's default context, applies context-wide stealth init scripts (`navigator.webdriver`, permissions, Chrome runtime, WebGL, canvas) to every page, and applies the Chrome 122 User-Agent plus native `sec-ch-ua` client hints to existing pages and popups.
2. Before X navigation, it restores that app tenant's trusted cookies/localStorage, mints the Browserbase debugger URL with `sessions.debug()`, and immediately emits it to the authenticated NDJSON client. The backend passes through the SDK's `debuggerFullscreenUrl` without rewriting or hardcoding Browserbase's debugger domain. The same remote page then opens `https://x.com/i/flow/login` with `Referer: https://x.com/`.
3. Clients should open the debugger URL in a native tab rather than embedding it. The existing Browserbase dashboard helper can consume these events; the default **Connect X Account** button uses Fly above. Client hints are generated natively through CDP metadata rather than forced as global extra headers, because global non-safelisted headers break X's cross-origin onboarding API preflights.
4. Sign in to X in the remote window, including 2FA or any challenge.
5. The server watches for navigation to X's `/home` timeline or for both `auth_token` and `ct0`. It then captures cookies and localStorage with `context.storageState()`, atomically writes `sessions/<userId>/<xUsername>.json` under persistent `DATA_DIR`, updates the user's linked accounts, and refreshes the account list automatically.
6. The browser disconnects and the Browserbase session is released with `REQUEST_RELEASE`, invalidating the debugger URL. The live link is a short-lived bearer credential; the server sends it only over the authenticated NDJSON stream and never logs it.
7. Press **Cancel** to stop an active remote sign-in. The dashboard calls `POST /auth/x/cancel`, which releases the active-run lock immediately, aborts the Playwright flow, and releases the Browserbase session so **Connect X Account** can start a fresh session.

Each app user also gets `sessions/<userId>/_trusted-login-profile.json`. It keeps X guest/device cookies and X localStorage while deliberately removing `auth_token`, `ct0`, `twid`, and other account-authentication cookies, so adding another account reuses a consistent browser identity without silently opening the previously linked account. A request that explicitly supplies an already linked `xUsername` restores that account's complete storage state. Login state is checkpointed during the live session and saved atomically.

An existing **“We've temporarily limited your login”** response is enforced by X and cannot be removed by JavaScript. Stop retrying until X's cooldown expires; repeated attempts from the same cloud IP can extend it. These changes reduce unnecessary fresh-device logins, but a consistent/reputable Browserbase session region is still important.

If the live link cannot be minted, start a new **Connect X Account** sign-in when the Browserbase session is available again.

`POST /auth/x` responds with `application/x-ndjson` (same event shape as the run endpoint):

```
{"type":"start","command":"browser sign-in -> https://x.com/i/flow/login (Browserbase remote Chromium)"}
{"type":"live","status":"ready","url":"https://browserbase.com/sessions/…","expiresAt":"…"}
{"type":"stdout","data":"Opening https://x.com/i/flow/login …"}
{"type":"stdout","data":"Waiting for X sign-in to finish in the remote window …"}
{"type":"status","stage":"signed-in","data":"X session cookies detected — saving the account automatically…"}
{"type":"stdout","data":"Waiting for X home and account identity …"}
{"type":"exit","code":0,"result":{"ok":true,"cookieCount":2,"username":"…"}}
```

`POST /auth/x/cancel` is idempotent: it returns `{ "ok": true, "cancelled": false }` when nothing is running, and otherwise clears the active sign-in lock, aborts the Playwright run, and releases the Browserbase session before replying. It is scoped to the authenticated app user.

The optional `BROWSERBASE_LIVE_TIMEOUT_MS` environment variable controls how long the debugger URL stays valid (default: the 10-minute login window, minimum 30 seconds, capped at the login window). The underlying Browserbase session stays open until sign-in finishes or the run is cancelled. Use `BROWSERBASE_SESSION_TIMEOUT_SECONDS` (default `900`) when the X login flow needs longer; Browserbase caps sessions at 21,600 seconds. A legacy `BROWSERLESS_LIVE_TIMEOUT_MS` value is still read for migration.

The equivalent CLI flow is `npm run auth` (same URL, press ENTER after login, writes `auth.json`).

## Session dashboard and API (server.js)

```powershell
npm run serve            # dashboard + API on http://127.0.0.1:10000
$env:PORT=4000; npm run serve
```

The dashboard is served from `public/index.html` at `/`. All API routes remain under `/api` and are unaffected by static file serving.

| Route | Purpose |
|---|---|
| `GET /` | Dashboard UI from `public/index.html` |
| `GET /api/auth` | JSON status: presence, masked preview, length, domain, flags (browser session) |
| `PUT /api/auth` | Body `{"auth_token": "…", "ct0": "…"}` — either field alone is fine (browser session) |
| `POST /api/auth/x-accounts/harvest` | Body `{"identifier": "…", "password": "…", "twoFactorCode": "…"}` — harvest and link an X account |
| `POST /api/auth/logout` | Clear `auth.json` |
| `GET /api/history` | Read the local `history.json` run log |
| `DELETE /api/history` | Clear the local `history.json` run log |
| `POST /auth/x` | NDJSON: start → live → auto-detect X session → save → exit (interactive Browserbase sign-in) |
| `POST /auth/x/cancel` | Cancel an active remote X sign-in, release the run lock, and release the Browserbase session |
| `POST /api/run` | Body `{"url": "…", "dryRun": true, "headless": true, "reply": true, "like": true, "repost": true}` — spawns `main.js` and streams its output |

### Fly.io X harvest API

`POST /api/harvest-token` is the automated login endpoint used by the Fly.io deployment. The service launches headless Chromium with a Chrome identity and stealth init script. It completes X's identifier/password onboarding flow (including the hidden password field), optionally submits a 2FA/email code, waits for the authenticated home timeline, and returns the detected `@handle` plus `auth_token` and `ct0`.

In production it requires the internal bearer token:

```
Authorization: Bearer <HARVEST_API_TOKEN>
```

Request body:

```json
{
  "identifier": "alice@example.com",
  "password": "…",
  "twoFactorCode": "123456"
}
```

`twoFactorCode` is optional. A successful response contains the harvested X cookies:

```json
{
  "ok": true,
  "username": "alice",
  "cookies": [
    { "name": "auth_token", "value": "…" },
    { "name": "ct0", "value": "…" }
  ]
}
```

Errors use `{ "ok": false, "error": "…" }` with a non-2xx status. The request time is bounded by `HARVEST_LOGIN_TIMEOUT_MS` plus cleanup headroom.

Trusted backends should use `lib/harvest-client.js`:

```js
import { harvestXAccount } from './lib/harvest-client.js';

const { username, authToken, ct0 } = await harvestXAccount({
  identifier,
  password,
  twoFactorCode,
});

// Persist authToken/ct0 in the caller's account store before marking the
// X account connected. This service's own account API accepts:
await fetch(`${appBaseUrl}/api/auth`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Cookie: appSessionCookie,
  },
  body: JSON.stringify({ auth_token: authToken, ct0 }),
});
```

The helper reads `HARVEST_API_TOKEN` and optional `HARVEST_API_URL` from the environment. Do not expose the token to browser code; call the helper from the Render bot's backend when an X account is added.

`POST /api/run` responds with `application/x-ndjson`; each line is one event:

```
{"type":"start","command":"node main.js https://x.com/user/status/1 --yes --dry-run --headless","pid":1524}
{"type":"stdout","data":"Opening https://x.com/user/status/1 …"}
{"type":"stderr","data":"…"}
{"type":"exit","code":0,"signal":null}
```

`POST /auth/x` responds the same way; the final event carries the sign-in result (`{"type":"exit","code":0,"result":{"ok":true,"cookieCount":2}}`).

Consumers should render only a **status notification** (`Idle` / `Running…` / `Completed successfully` / `Run failed` / sign-in equivalents) — raw log lines stay off the dashboard.

### Run actions

The run request accepts action flags; they map to `main.js` flags:

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
