import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Manual X (Twitter) login helper.
 *
 * Opens a real, non-headless Chromium window on the X login page. You log in
 * yourself (password, 2FA, captcha — whatever X asks for), then press ENTER in
 * this terminal. The script then saves the session cookies to auth.json.
 */

const LOGIN_URL = 'https://x.com/login';
const AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), 'auth.json');
const SESSION_COOKIE = 'auth_token'; // set by X once you are actually logged in
const LOGIN_WAIT_MS = 15_000;

const banner = `
────────────────────────────────────────────────────────────
 X login — manual sign-in
────────────────────────────────────────────────────────────
 1. A Chromium window will open on ${LOGIN_URL}
 2. Log in to X there (password, 2FA, captcha — as prompted).
 3. When you can see your timeline, come back here and press
    ENTER to save the session to auth.json.

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
    const cookies = await context.cookies();
    if (cookies.some((cookie) => cookie.name === SESSION_COOKIE)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  console.log(banner);

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    await waitForEnter('Press ENTER after you have finished logging in… ');

    console.log('\nChecking the session…');
    const loggedIn = await waitForSessionCookie(context, LOGIN_WAIT_MS);
    if (!loggedIn) {
      console.warn(
        `Warning: no "${SESSION_COOKIE}" cookie found. You may not be fully logged in.\n` +
          'Saving the cookies anyway — re-run `npm run auth` if the session does not work.',
      );
    }

    const cookies = await context.cookies();
    if (cookies.length === 0) {
      console.error('No cookies to save. Nothing written.');
      process.exitCode = 1;
      return;
    }

    const payload = {
      savedAt: new Date().toISOString(),
      loginUrl: LOGIN_URL,
      cookieCount: cookies.length,
      cookies,
    };

    await writeFile(AUTH_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    console.log(
      `\nSaved ${cookies.length} cookies to auth.json` +
        (loggedIn ? ' (session valid).' : ' (session unverified).') +
        `\n\nReuse them in another script with:\n` +
        `  import { readFile } from 'node:fs/promises';\n` +
        `  const { cookies } = JSON.parse(await readFile('auth.json', 'utf8'));\n` +
        `  const context = await browser.newContext();\n` +
        `  await context.addCookies(cookies);\n\n` +
        'auth.json grants full access to your X account — keep it private and never commit it.\n',
    );
  } finally {
    await browser.close();
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
