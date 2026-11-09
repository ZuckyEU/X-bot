# X-Engine

Local-first X reply automation. The dashboard stores accounts and settings locally, opens a real Chromium window for X sign-in, and runs automation from the saved Playwright profile — no cookie copying required.

## Quick start (local)

Requirements: Node.js 20+ and Windows, macOS, or Linux with a desktop session.

```bash
git clone https://github.com/ZuckyEU/X-bot.git
cd X-bot
npm run setup
cp .env.example .env    # Windows: copy .env.example .env
npm start
```

Open <http://localhost:3000>.

1. Create a local app account.
2. Add a Groq API key in the dashboard (used for reply generation).
3. Click **Connect X**, enter the X handle, and finish signing in to X in the Chromium window that opens.
4. Add a tweet URL and run.

`npm run setup` installs dependencies and the local Chromium build. No remote browser service or browser API key is required.

The basic `.env` is:

```dotenv
NODE_ENV=development
PORT=3000
SESSION_SECRET=replace-with-at-least-32-random-characters
```

Generate the secret with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Leave `DATABASE_URL` unset for local storage.

## How X sessions work

**Interactive connect (recommended).** The server calls Playwright's `chromium.launchPersistentContext` with a real, headful browser. After you sign in, X writes its cookies and storage into the profile on disk. The app then verifies the session and saves a storage-state copy for health checks and fallbacks.

Chromium persists cookies and local storage. The app also saves X's JavaScript `sessionStorage` in a private `_x-session-storage.json` inside the profile and restores it before X loads on the next launch.

Profiles are namespaced by app user and X handle:

```text
<DATA_DIR>/user_data/<app-user-id>/<x-handle>/
```

The app-user level prevents two local accounts that link the same public X handle from sharing cookies. You can set `PERSISTENT_PROFILES=0` to ignore profiles and use storage-state restoration only.

**Automation runs.** `POST /api/run` re-verifies the active session, then launches the saved profile with `chromium.launchPersistentContext(profile, { headless: true })` when it exists; otherwise it restores the storage-state copy in headless Chromium. Cookies rotated during a run are written back to the session store.

**Advanced fallback.** If the app runs on a headless server, use **Advanced fallback → paste auth_token and ct0** in the dashboard, or call:

```http
POST /api/auth/import-session
{ "handle": "your_handle", "auth_token": "...", "ct0": "..." }
```

Manual values are verified with X before they are saved.

## Local storage

With no `DATABASE_URL`, the app stores its data under `DATA_DIR` (default: the project directory):

| Path | Contents |
| --- | --- |
| `data/db.json` | App accounts, bcrypt password hashes, Groq keys, execution history |
| `sessions/<app-user-id>/<handle>.json` | Verified Playwright storage state for each linked X account |
| `sessions/<app-user-id>/_trusted-login-profile.json` | Non-account bootstrap cookies for the fallback login flow |
| `user_data/<app-user-id>/<handle>/` | Persistent Chromium profile (cookies + storage) |
| `auth.json` | Currently staged session used by the runner |
| `history.json`, `user-db.json` | Legacy files imported automatically on first run |

`data/`, `sessions/`, `user_data/`, `auth.json`, and `.env` are gitignored because they contain credentials. Back up `DATA_DIR` if you want to preserve profiles; never commit it.

Profile deletion removes matching account records and history from both the current database and retained legacy files, along with that user's saved X sessions and browser profiles. Other users' data is preserved.

### Supabase PostgreSQL (optional)

Set `DATABASE_URL` to a Supabase/PostgreSQL connection string and the app creates its `users` and `x_sessions` tables on boot. Persistent profiles still live on the local filesystem; on an ephemeral server, disable interactive login with `INTERACTIVE_LOGIN_DISABLED=1` and use the advanced import or a mounted `DATA_DIR`.

## Session verification

Every imported and staged session is checked before it can publish:

1. `https://api.x.com/1.1/account/settings.json`
2. `https://x.com/i/api/1.1/account/settings.json`
3. A local headless Chromium fallback that opens `https://x.com/home`.

- Verified cookies: saved and usable.
- X clearly rejects the cookies: `409` (`X_SESSION_EXPIRED`).
- Check unavailable (network, challenge, datacenter IP): retryable `503` (`X_SESSION_CHECK_UNAVAILABLE`); nothing is staged or spawned.
- `X_SESSION_CHECK_DISABLED=1` is a development/test convenience only and is ignored in production.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run setup` | `npm install && npx playwright install chromium` |
| `npm start` | Start the dashboard server on port 3000 |
| `npm test` | Backend and runner regression tests |
| `npm run test:ui` | Dashboard browser regression tests |
| `npm run automate -- <tweet-url>` | Run the runner directly (uses staged `auth.json`) |
| `npm run check:prod` | Production configuration, syntax, and test gate; then start the server |

## API overview

- `POST /api/auth/register`, `POST /api/auth/login` — local app accounts
- `POST /api/auth/connect-interactive` — open a browser and connect X (`{ "handle": "..." }`)
- `POST /api/auth/import-session` — advanced cookie import
- `GET /api/auth/x-accounts` — linked accounts and health
- `POST /api/auth/switch-account` — choose the active X account
- `DELETE /api/auth/x-accounts/:handle` — unlink and remove the saved profile
- `DELETE /api/auth/me` — delete the app profile, Groq key, X sessions, and history
- `GET/PUT/DELETE /api/config/groq` — per-account Groq key
- `GET/DELETE /api/history` — execution log
- `POST /api/run` — start a run; responds with an NDJSON event stream

## Configuration

See [`.env.example`](.env.example). Common options:

- `PORT` (default `3000`)
- `SESSION_SECRET` (recommended; required in production)
- `DATA_DIR` (defaults to the project directory)
- `DATABASE_URL` (optional PostgreSQL/Supabase)
- `INTERACTIVE_LOGIN_DISABLED=1` (headless servers)
- `INTERACTIVE_LOGIN_TIMEOUT_MS` (browser sign-in wait, default 5 minutes)
- `PERSISTENT_PROFILES=0` (disable persistent profiles)
- `X_SESSION_CHECK_*` (verification timeouts/URLs)

## Troubleshooting

- **"Interactive X sign-in needs a desktop display"** — run the app on a machine with a desktop session, or use the advanced cookie import.
- **"Could not open the sign-in browser"** — confirm Chromium is installed: `npx playwright install chromium`.
- **X connection expired** — reconnect the account; the dashboard disables publishing until the session verifies.
- **Port 3000 already in use** — set `PORT` in `.env`.
- **Data disappeared after a redeploy** — point `DATA_DIR` at a mounted/persistent disk. Render containers are ephemeral by default.

## Security notes

- `data/db.json`, session files, and browser profiles grant full X account access. Keep them private (`0600` where supported) and out of version control.
- The server binds to `0.0.0.0` so container platforms can reach it. For anything beyond localhost, terminate TLS and set a strong `SESSION_SECRET`.
- This app uses browser automation against X. Follow X's terms, rate limits, and automation rules; you are responsible for the accounts you connect.
