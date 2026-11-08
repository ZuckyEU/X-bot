# playwright-gemini

Minimal starting point: **Playwright** (browser automation), **@google/genai** (Gemini API), and **dotenv** (environment config).

## Setup

```powershell
npm install
npx playwright install chromium   # required for local automation and UI tests
```

Add your keys to `.env` (created from `.env.example`):

```
GEMINI_API_KEY=your-key-from-https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-3.6-flash
DATABASE_URL=your-supabase-postgres-connection-string
```

User accounts and X sessions are stored in **Supabase PostgreSQL**; the server creates the required tables on boot. Reply automation launches **local headless Chromium** through Playwright inside the application container. The shared `lib/browser.js` launcher uses `chromium.launch({ headless: true, args: ['--no-sandbox'] })`; it never connects to a remote browser and needs no browser-service API key. On Render, select the **Docker runtime** and use the repository's Dockerfile, which includes Chromium and its Linux dependencies. Manual session imports do not launch a browser.

`gemini-2.5-flash` is retired for new API keys (returns 404), and `gemini-3.8-flash` was returning 503 during setup, so the default is **`gemini-3.6-flash`**. Change `GEMINI_MODEL` to use another model — both scripts read it.

## Run

```powershell
npm start
npm start -- https://news.ycombinator.com   # custom URL
```

`index.js` loads `.env`, opens the URL in local headless Chromium, reads the title/heading, then asks Gemini to describe the page. If `GEMINI_API_KEY` is missing it still runs the Playwright part and prints a warning.

## X login (saves session to auth.json)

```powershell
$env:NODE_ENV='development'   # manual sign-in requires a local desktop, not Render
npm run auth
```

1. A visible local Chromium window opens directly on `https://x.com/i/flow/login`.
2. Log in yourself in that browser window — password, 2FA, captcha, anything X asks for.
3. Return to the terminal and press **ENTER**.
4. The script checks for the `auth_token` cookie, then writes cookies and X localStorage to `auth.json`.

If you press ENTER too early, the script warns that the session is unverified and saves anyway — just re-run `npm run auth`.

This CLI helper is the only headed browser path and refuses to run in production or on Render. Use **Connect X Account** in the dashboard to import existing cookies for container automation; there is no remote sign-in viewer.

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

Prerequisites: a saved session (`npm run auth` locally, or dashboard cookie import on Render) and a Groq API key (`GROQ_API_KEY` for CLI use, or the saved dashboard key for `/api/run`).

```powershell
npm run automate -- https://x.com/user/status/1234567890 --dry-run  # generate only, no posting
npm run automate -- https://x.com/user/status/1234567890            # asks for confirmation
npm run automate -- https://x.com/user/status/1234567890 --yes      # no prompt
```

Flow: launches local headless Chromium → restores cookies and localStorage from `auth.json` → verifies the session on `x.com/home` → opens the tweet → extracts the text (expanding "Show more") → asks Groq to classify the tweet and write a reply → performs the requested reply/like actions.

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
| `--headless` | Accepted for compatibility; automation always runs headless |

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

## Connect X Account: manual session import

In the dashboard, open the account menu → **Connect X Account**. Paste your X handle and the **values** of `auth_token` and `ct0`, then click **Import & activate account**. No X password, remote desktop, or login callback is needed.

To get the values, sign in to the matching account on **x.com** in your own browser. Open Developer Tools → **Application** (or **Storage**) → **Cookies** → **https://x.com**. Copy each cookie's Value, not a full cookie header. Both must come from the same account. Only use accounts you own or are authorized to manage.

The authenticated dashboard calls `POST /api/auth/import-session` with:

```json
{
  "handle": "@your_handle",
  "auth_token": "paste-the-auth-token-value",
  "ct0": "paste-the-ct0-value"
}
```

The server normalizes the handle, validates both values, and formats standard Playwright cookies with domain `.x.com`, path `/`, `secure: true`, `expires: -1`, and `sameSite: "Lax"`. `auth_token` is HttpOnly; `ct0` remains readable by X's client code for CSRF protection.

The credentials are upserted into PostgreSQL (`x_sessions`), the account is linked and selected, and a two-cookie Playwright state is staged in `auth.json` for the bot. A maximum of three X accounts can be linked per app user; importing an existing handle replaces its cookies and makes it active without adding a duplicate. Users' saved sessions remain separate even when they import the same handle.

Imports require a current app session, reject changes while a browser run is active, and use serialized writes with rollback if saving fails. Account switching is also blocked until the active run finishes. Import and switch responses contain only account metadata; raw cookie values are returned only by the authenticated `GET /api/auth/me` bootstrap response so a new device can restore its active X account. The form uses masked inputs, does not write cookies to browser storage, and clears pasted values on submission, close, navigation, or app logout.

After login and on every dashboard bootstrap, `GET /api/auth/me` reads the user's active row from `x_sessions`, returns `activeXAccount` plus `xSession.auth_token`/`xSession.ct0`, and restages `auth.json` when no browser run is active. A missing or stale `auth.json` therefore no longer requires re-pasting cookies on a new device.

**Cookies grant account access.** Use HTTPS in production and protect the PostgreSQL connection string and `auth.json`. `auth_token` and `ct0` are stored as plain text in `x_sessions` and in the staged `auth.json`; they are not encrypted at the application layer. The import checks syntax, not validity or ownership with X. Expired/revoked cookies, a mismatched handle, or X's cloud-IP restrictions can still cause a run to fail; re-import fresh matching cookies when needed.

Run `npm test` for API, tenant-isolation, persistence, rollback, and runner regression checks. Run `npm run test:ui` after installing local Chromium for form submission, secret cleanup, error handling, and stale-response checks. Tests use synthetic cookies and local fixtures, not a credentialed X login.

### Browser execution and session flow

Before the local-browser migration, `lib/browser.js` imported the Browserbase SDK, called `sessions.create()`, connected with `chromium.connectOverCDP()`, minted live URLs with `sessions.debug()`, and released sessions with `sessions.update()`. `main.js`, `index.js`, `auth.js`, and the optional `/auth/x` route all used that shared remote path. Only the dashboard browser tests used local `chromium.launch()`.

The current execution paths are:

| Entry point | Browser execution |
|---|---|
| `POST /api/run` in `server.js` | Stages the authenticated user's cookies, then spawns `main.js`; the server itself does not launch a browser |
| `main.js` and `index.js` | `connectBrowser()` → local `chromium.launch({ headless: true, args: ['--no-sandbox'] })` |
| `auth.js` | Local headed Chromium for desktop-only manual login; blocked in production/Render |
| Dashboard browser tests | Local headless Chromium against a fixture server |

1. Server boot initializes PostgreSQL and creates the `users`/`x_sessions` schema. Boot hydration stages the most recently active saved account in `auth.json`; this does not launch Chromium.
2. App login and `GET /api/auth/me` resolve that user's active `x_sessions` row. They restage `auth.json` only while idle, so dashboard bootstrap cannot replace cookies during a run.
3. `POST /api/run` validates URLs, authenticates the app session, checks the saved Groq key, reserves the single-run lock, and re-reads/stages the selected user's `auth_token`/`ct0` from PostgreSQL. The boot-staged account is not blindly reused.
4. Each target attempt spawns `main.js` with `AUTH_FILE_PATH`, `X_ACCOUNT_USERNAME`, and the user's Groq key. The child launches Chromium inside the same container, awaits a new browser context, injects the staged cookies with `context.addCookies()`, and only then opens X.
5. The child performs the requested actions and closes its local browser in `finally`. The server preserves bounded retries, final-attempt history, NDJSON progress, cancellation-aware delays, and run-lock cleanup.

The Browserbase SDK and its configuration are no longer used. Existing browser-service environment variables may be removed from Render; they cannot switch automation back to a remote browser. X will now see the Render container's outbound IP, so cloud-IP restrictions and expired cookies can still block a run.

### Retired remote sign-in endpoints

Authenticated `POST /auth/x` now returns **410 Gone** with a message directing clients to `POST /api/auth/import-session`. It never launches a browser or reserves the run lock; during an existing run/import it still returns 409. `POST /auth/x/cancel` remains an authenticated compatibility no-op returning `{ "ok": true, "cancelled": false }` and cannot cancel automation. The dashboard already uses cookie import, so its login flow is unchanged.

## Session dashboard and API (server.js)

```powershell
npm run serve            # dashboard + API on http://127.0.0.1:10000
$env:PORT=4000; npm run serve
```

The dashboard is served from `public/index.html` at `/`. All API routes remain under `/api` and are unaffected by static file serving.

| Route | Purpose |
|---|---|
| `GET /` | Dashboard UI from `public/index.html` |
| `GET /api/auth` | Authentication status and active-account metadata; no raw cookie values |
| `GET /api/auth/me` | App user profile plus active X account, saved `xSession.auth_token`/`ct0`, and account summaries; restages `auth.json` when idle |
| `PUT /api/auth` | Body `{"auth_token": "…", "ct0": "…"}` — either field alone is fine (browser session) |
| `POST /api/auth/import-session` | Body `{"handle": "…", "auth_token": "…", "ct0": "…"}` — save, link, and activate an X session |
| `GET /api/auth/x-accounts` | List the authenticated user's linked accounts |
| `POST /api/auth/switch-account` | Body `{"xUsername": "…"}` — stage a linked account for the bot |
| `DELETE /api/auth/x-accounts/:xUsername` | Unlink an account and remove its saved session |
| `POST /api/auth/logout` | Revoke the app session and stop its active run; saved X sessions survive logout |
| `GET /api/history` | Read the local `history.json` run log |
| `DELETE /api/history` | Clear the local `history.json` run log |
| `POST /auth/x` | Retired interactive sign-in; authenticated 410 response directs clients to cookie import |
| `POST /auth/x/cancel` | Authenticated compatibility no-op; does not cancel automation |
| `POST /api/run` | Body `{"url": "…", "dryRun": true, "headless": true, "reply": true, "like": true, "repost": true}` — spawns `main.js` and streams its output |

`POST /api/run` responds with `application/x-ndjson`; each line is one event:

```
{"type":"start","command":"node main.js https://x.com/user/status/1 --yes --dry-run --headless","pid":1524}
{"type":"stdout","data":"Opening https://x.com/user/status/1 …"}
{"type":"stderr","data":"…"}
{"type":"exit","code":0,"signal":null}
```

Consumers should render only a **status notification** (`Idle` / `Running…` / `Completed successfully` / `Run failed` / sign-in equivalents) — raw log lines stay off the dashboard.

### Run actions

The run request accepts action flags; they map to `main.js` flags:

- `reply` → `--reply` (posts the generated reply; writes it to `--reply-out=<path>` for history)
- `like` → `--like`
- `repost` → `--repost`

Replies are confirmed within a five-second verification window by a successful X `CreateTweet` response containing the created tweet ID, or by a newly rendered matching tweet. A toast or a closed composer alone is not proof. Missing confirmation throws `Reply verification failed: Post was not confirmed on X`.

Each URL gets at most **two retries (three total attempts)** for transient network errors or an unconfirmed reply. The legacy `Warning: could not confirm the reply was sent` is also a failed attempt, even if the child exits zero. Exhausted retries log `[QUEUE] Hard failure for URL, skipping to next target`, emit a failed `item-complete` with updated success/failure counts, and continue to the next URL after the normal cooldown. Only the final attempt is recorded in history, and an unconfirmed reply is never recorded as a successful `replied` action. Missing confirmation does not prove X rejected the post, so check the thread before manually restarting a failed target to avoid duplicate replies.

### Automation history

Every completed run appends an entry to `history.json` (capped at the last 50 runs):

```json
{ "id": "…", "at": "…", "url": "…", "dryRun": false, "actions": [], "reply": "…", "ok": false, "error": "Reply verification failed: Post was not confirmed on X" }
```

`GET /api/history` reads it; `DELETE /api/history` clears it; the UI lists entries and offers **Clear History**.

Runner details:

- Passes `--yes` because a spawned child has no TTY to answer the confirmation prompt — **clicking Run with "Dry run" unchecked posts immediately**.
- One run at a time; a second request gets `409`.
- URL is validated against the tweet pattern and passed in an `argv` array (`spawn`, no shell), so it can't inject commands.
- Closing the tab or pressing Stop kills the child **and its Chromium tree** (`taskkill /T /F` on Windows) — verified no orphan browsers/processes afterwards.
- Runs are capped at 10 minutes.

Safety rails, because this endpoint can replace your session:

- Binds to **0.0.0.0** on Render's dynamic `PORT` (falling back to `3000`, or `10000` in `.env.example`) so the platform can reach it.
- CORS allows the local UI, explicitly configured origins (`PUBLIC_ORIGIN` / `ALLOWED_ORIGINS`), Render's `RENDER_EXTERNAL_URL`, and `*.onrender.com` in production. Other websites are rejected.
- Manual imports create a cookie-only session from the supplied handle, `auth_token`, and `ct0`. The legacy `PUT /api/auth` updates just those two cookie names while preserving other cookies, `origins`, and metadata.
- Values are validated (`[A-Za-z0-9._~%+/-]+` with optional trailing Base64 padding, 8–512 chars); responses never include raw cookie values.
- Writes are serialised and atomic (temp file + rename), so an interrupted save can't truncate `auth.json`.

## Persistent users and X sessions

User accounts and X credentials live in **Supabase PostgreSQL**. Set `DATABASE_URL` to the pooler connection string from Supabase → **Project Settings → Database**. On boot the server connects with `pg` and automatically creates these tables when they do not exist:

- `users` — account id, username, bcrypt password hash, email, app session token, linked handles, default X handle, Groq key, and timestamps.
- `x_sessions` — one row per app user and X handle, containing `auth_token` and `ct0`, with `ON DELETE CASCADE` from `users`.

Passwords are stored as bcrypt hashes; X session cookies are stored as plain text so they can be staged for Playwright. Protect the database connection string and use Supabase network/SSL controls. The server uses TLS by default for remote databases; set `DATABASE_SSL=false` only for a local PostgreSQL server without TLS.

For durable accounts and sessions:

1. Create a Supabase project and copy its pooler `DATABASE_URL`.
2. Set `DATABASE_URL` and a stable `SESSION_SECRET` in the deployment environment.
3. Restart the service. The schema and saved sessions survive Render redeploys because PostgreSQL is external. On boot the most recently active saved account is automatically staged into `auth.json`; login and `GET /api/auth/me` restage the authenticated user's saved account, and each run re-stages the selected account before launching the bot.

`auth.json`, `history.json`, and `sessions/<userId>/_trusted-login-profile.json` remain runtime files under `DATA_DIR`. Set `DATA_DIR` to a mounted disk if you want automation history and trusted login profiles to survive restarts; user accounts and X sessions do not depend on it.

For **Render**, deploy with the **Docker runtime**, this directory as the service root, and the repository's `Dockerfile`. It uses `mcr.microsoft.com/playwright:v1.64.1-jammy`, matching the pinned `playwright` package version, with Chromium and Linux dependencies preinstalled. The build smoke-tests the shared headless launcher and starts **`npm run serve`**. Keep the image tag and dependency version aligned when upgrading Playwright.

Set `NODE_ENV=production`, a strong `SESSION_SECRET`, `DATABASE_URL`, and optionally `DATA_DIR`. No browser-service key or interactive desktop worker is required. A native Linux Node deployment must additionally run **`npx playwright install --with-deps chromium`** after **`npm ci`** (with permission to install system packages); `npm ci` alone does not install Chromium. `npm run check:prod` validates the production secret/database URL, syntax-checks the project, runs the API regression suite, and then starts the server.

Run one server process per deployment: the write queue and active-run reservation are in-process locks, not distributed locks across replicas.

Set all three `DEFAULT_ADMIN_USERNAME`, `DEFAULT_ADMIN_EMAIL`, and `DEFAULT_ADMIN_PASSWORD` values if you want the server to create an initial account when it does not exist. It never overwrites an existing account or its password. The local JSON fallback is for development and the test suite only; production startup fails without `DATABASE_URL`.

The CLI (`npm run auth` and `npm run automate`) honors the same `DATA_DIR` for `auth.json`; the server still passes an explicit `AUTH_FILE_PATH` to automation runs.

## Versions

- Node.js >= 20 (project uses ESM: `"type": "module"`)
- playwright 1.64.1 (pinned to the Docker image), @google/genai 2.32, dotenv 18, express 5.3, body-parser 2.4, cors 2.8
