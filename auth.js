import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  closeBrowser,
  getDefaultContext,
  getOrCreatePage,
  restoreStorageState,
  safeContextCall,
  safeGoto,
  X_LOGIN_URL,
  X_REFERER,
} from './lib/browser.js';

/**
 * Manual X (Twitter) login helper.
 *
 * Opens a visible local Chromium window for manual sign-in/2FA/captcha, then
 * saves cookies and localStorage to auth.json. Container deployments use the
 * dashboard's cookie import instead; no remote browser service is involved.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR || ROOT);
const LOGIN_URL = X_LOGIN_URL;
const AUTH_FILE = join(DATA_DIR, 'auth.json');
const SESSION_COOKIE = 'auth_token'; // set by X once you are actually logged in
const LOGIN_WAIT_MS = 15_000;

async function loadSavedState() {
  try {
    const parsed = JSON.parse((await readFile(AUTH_FILE, 'utf8')).replace(/^\uFEFF/, ''));
    const state = Array.isArray(parsed) ? { cookies: parsed, origins: [] } : parsed;
    return state && Array.isArray(state.cookies) ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const banner = `
────────────────────────────────────────────────────────────
 X login — manual sign-in
────────────────────────────────────────────────────────────
  1. A local Chromium window opens on ${LOGIN_URL}
  2. Log in to X in that browser window
    (password, 2FA, captcha — as prompted).
 3. When you can see your timeline, come back here and press
    ENTER to save the session to ${AUTH_FILE}.

 Do NOT type your password in this terminal — only in the browser.
────────────────────────────────────────────────────────────
`;

/** Resolves when the user presses ENTER in this terminal. */
function waitForEnter(promptText) {
  const rl = createInterface({ input, output });
  return rl.question(promptText).finally(() => rl.close());
}

/** Polls until X's session cookie exists or the timeout expires. */
async function waitForSessionCookie(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cookieResult = await safeContextCall(context, () => context.cookies(), 'Reading session cookies');
    if (!cookieResult.ok) return { loggedIn: false, error: cookieResult.error };
    if (cookieResult.value.some((cookie) => cookie.name === SESSION_COOKIE)) {
      return { loggedIn: true, error: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { loggedIn: false, error: null };
}

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
    throw new Error('Manual X login requires a local desktop. On Render, import auth_token and ct0 through the dashboard.');
  }
  console.log(banner);

  let browser = null;
  try {
    // Only this desktop login helper is headed. Automation always uses the
    // shared headless launcher, regardless of request flags or environment.
    browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
    const context = await getDefaultContext(browser);
    const savedState = await loadSavedState();
    const restored = await safeContextCall(
      context,
      () => restoreStorageState(context, savedState, { clearCookies: true }),
      'Restoring saved browser state',
    );
    if (!restored.ok) {
      console.warn(`${restored.error.message}. Aborting sign-in.`);
      process.exitCode = 1;
      return;
    }
    if (savedState) {
      console.log(
        `Restored ${restored.value.cookieCount} cookies and ${restored.value.localStorageCount} localStorage entries from ${AUTH_FILE}.`,
      );
    }
    const page = await getOrCreatePage(context);

    const navigation = await safeGoto(page, LOGIN_URL, {
      waitUntil: 'commit',
      timeout: 45_000,
      referer: X_REFERER,
    });
    if (navigation.error) {
      console.warn(`Navigation warning: ${navigation.error.message}. Continuing to wait for sign-in…`);
    } else if (navigation.response && navigation.response.status() >= 400) {
      console.warn(
        `X returned HTTP ${navigation.response.status()} on the login page; continuing to wait for sign-in…`,
      );
    }

    await waitForEnter('Press ENTER after you have finished logging in… ');

    console.log('\nChecking the session…');
    const session = await waitForSessionCookie(context, LOGIN_WAIT_MS);
    if (session.error) {
      console.warn(`${session.error.message}. No cookies were saved.`);
      process.exitCode = 1;
      return;
    }
    if (!session.loggedIn) {
      console.warn(
        `Warning: no "${SESSION_COOKIE}" cookie found. You may not be fully logged in.\n` +
          'Saving the cookies anyway — re-run `npm run auth` if the session does not work.',
      );
    }

    const storageResult = await safeContextCall(
      context,
      () => context.storageState(),
      'Capturing browser storage state',
    );
    if (!storageResult.ok) {
      console.warn(`${storageResult.error.message}. No browser state was saved.`);
      process.exitCode = 1;
      return;
    }
    const storageState = storageResult.value;
    const cookies = storageState.cookies;
    if (cookies.length === 0) {
      console.error('No cookies to save. Nothing written.');
      process.exitCode = 1;
      return;
    }

    const payload = {
      ...storageState,
      savedAt: new Date().toISOString(),
      loginUrl: LOGIN_URL,
      cookieCount: cookies.length,
    };

    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(AUTH_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    console.log(
      `\nSaved ${cookies.length} cookies to ${AUTH_FILE}` +
        ` with localStorage from ${storageState.origins.length} origin(s)` +
        (session.loggedIn ? ' (session valid).' : ' (session unverified).') +
        `\n\nReuse them in another script with:\n` +
        `  import { readFile } from 'node:fs/promises';\n` +
        `  import { getDefaultContext, restoreStorageState } from './lib/browser.js';\n` +
        `  const state = JSON.parse(await readFile('auth.json', 'utf8'));\n` +
        `  const context = await getDefaultContext(browser);\n` +
        `  await restoreStorageState(context, state, { clearCookies: true });\n\n` +
        'auth.json grants full access to your X account — keep it private and never commit it.\n',
    );
  } finally {
    await closeBrowser(browser);
  }
}

main().catch((error) => {
  if (error?.name === 'AbortError' || error?.code === 'ERR_USE_AFTER_CLOSE') {
    console.log('\nCancelled — no cookies saved.');
    process.exitCode = 130;
    return;
  }
  console.error('\nLogin failed:', error.message);
  process.exitCode = 1;
});
