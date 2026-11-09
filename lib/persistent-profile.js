import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import {
  applyStealthProfile,
  hasXSessionCookies,
  isXLoginURL,
  normalizeXSessionCookies,
  X_LOGIN_URL,
} from './browser.js';

/**
 * Persistent, on-disk Playwright profiles.
 *
 * Each app user gets their own directory below
 * <DATA_DIR>/user_data/<app-user-id>/<x-handle>. The app-user-id level is
 * deliberate: two app accounts may link the same public X handle, and a profile
 * must never leak cookies across tenants.
 */

export const PROFILE_DIRNAME = 'user_data';
export const PROFILE_SESSION_STORAGE_FILE = '_x-session-storage.json';
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const profileDirectories = new WeakMap();
const closingContexts = new WeakMap();

function isXStorageOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(x|twitter)\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

async function restoreProfileSessionStorage(context, directory) {
  let snapshots;
  try {
    snapshots = JSON.parse(await readFile(join(directory, PROFILE_SESSION_STORAGE_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    // A damaged optional snapshot must not prevent re-authentication. Never
    // print the parser error, which may include stored credential values.
    console.warn('[profile] Could not restore X session storage; using the browser profile.');
    return;
  }
  const origins = (Array.isArray(snapshots) ? snapshots : [])
    .filter((entry) => isXStorageOrigin(entry?.origin) && Array.isArray(entry.sessionStorage))
    .map((entry) => ({
      origin: new URL(entry.origin).origin,
      sessionStorage: entry.sessionStorage
        .filter((item) => typeof item?.name === 'string' && typeof item?.value === 'string')
        .map(({ name, value }) => ({ name, value })),
    }));
  if (!origins.length) return;
  await context.addInitScript((snapshots) => {
    const snapshot = snapshots.find((entry) => entry.origin === window.location.origin);
    if (!snapshot) return;
    try {
      for (const { name, value } of snapshot.sessionStorage) {
        if (window.sessionStorage.getItem(name) === null) window.sessionStorage.setItem(name, value);
      }
    } catch {
      // Storage may be unavailable in a sandboxed frame.
    }
  }, origins);
}

async function saveProfileSessionStorage(context, directory) {
  const snapshots = new Map();
  for (const page of context.pages?.() ?? []) {
    try {
      if (page.isClosed() || !isXStorageOrigin(page.url()) || typeof page.evaluate !== 'function') continue;
      const snapshot = await page.evaluate(() => ({
        origin: window.location.origin,
        sessionStorage: Object.keys(window.sessionStorage)
          .map((name) => ({ name, value: window.sessionStorage.getItem(name) })),
      }));
      if (isXStorageOrigin(snapshot.origin) && !snapshots.has(snapshot.origin)) {
        snapshots.set(snapshot.origin, snapshot);
      }
    } catch {
      // A tab closed during capture must not overwrite a previous snapshot.
    }
  }
  if (!snapshots.size) return;
  await writeFile(join(directory, PROFILE_SESSION_STORAGE_FILE), `${JSON.stringify([...snapshots.values()])}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
}

function validUserId(value) {
  const id = String(value ?? '');
  if (!/^(?:\d+|[a-f0-9-]{16,64})$/i.test(id)) throw new Error('Invalid user id for a persistent profile');
  return id;
}

function validHandle(value) {
  const handle = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error('Invalid X handle for a persistent profile');
  return handle;
}

export function persistentProfileRoot(dataDir) {
  return join(dataDir, PROFILE_DIRNAME);
}

export function persistentProfileDirectory(dataDir, userId, handle) {
  return join(persistentProfileRoot(dataDir), validUserId(userId), validHandle(handle));
}

/** User-visible reason interactive sign-in cannot run here, or null when it can. */
export function interactiveLoginUnavailableReason({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (String(env.PERSISTENT_PROFILES ?? '').toLowerCase() === '0') {
    return 'Persistent browser profiles are disabled (PERSISTENT_PROFILES=0).';
  }
  if (env.INTERACTIVE_LOGIN_DISABLED === '1') {
    return 'Interactive X sign-in is disabled on this server. Use the advanced session import instead.';
  }
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return 'Interactive X sign-in needs a desktop display. Run the app locally or use the advanced session import on a headless server.';
  }
  return null;
}

export function persistentProfilesEnabled(env = process.env) {
  return String(env.PERSISTENT_PROFILES ?? '').toLowerCase() !== '0';
}

export async function launchPersistentProfile(directory, { headless = true, timeout } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(directory, {
    headless,
    args: ['--no-sandbox'],
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    ...(timeout === undefined ? {} : { timeout }),
  });
  profileDirectories.set(context, directory);
  try {
    await applyStealthProfile(context);
    await restoreProfileSessionStorage(context, directory);
    return context;
  } catch (error) {
    await closePersistentProfile(context);
    throw error;
  }
}

export async function closePersistentProfile(context) {
  if (!context) return;
  if (closingContexts.has(context)) return closingContexts.get(context);
  const closing = (async () => {
    const directory = profileDirectories.get(context);
    if (directory) {
      await saveProfileSessionStorage(context, directory)
        .catch(() => console.warn('[profile] Could not save X session storage.'));
    }
    try {
      await context.close();
    } catch {
      // The browser window may already have been closed by the user.
    }
  })();
  closingContexts.set(context, closing);
  return closing;
}

export async function profileCookies(context) {
  try {
    return await context.cookies(['https://x.com']);
  } catch {
    return [];
  }
}

function loginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Wait until X has written both authentication cookies into the persistent
 * profile. The caller keeps the browser window open while the user signs in.
 */
export async function waitForProfileLogin(context, {
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  pollMs = 500,
  signal = null,
  page = null,
} = {}) {
  if (!context) throw loginError('X_LOGIN_BROWSER_CLOSED', 'The sign-in browser window is not open.');
  const deadline = Date.now() + Math.max(1_000, timeoutMs);

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw loginError('X_LOGIN_CANCELLED', 'Interactive X sign-in was cancelled.');
    }
    const cookies = await profileCookies(context);
    if (hasXSessionCookies(cookies)) {
      // A profile can still hold stale cookies from an earlier login. Keep the
      // window open until X leaves the login flow, otherwise the immediate
      // health check would reject before the user can sign in again.
      let stillOnLogin = false;
      try {
        stillOnLogin = page ? isXLoginURL(page.url()) : false;
      } catch {
        stillOnLogin = false;
      }
      if (!stillOnLogin) return cookies;
    }

    let open = true;
    try {
      open = context.browser()?.isConnected() !== false && context.pages().some((page) => !page.isClosed());
    } catch {
      open = false;
    }
    if (!open) {
      throw loginError('X_LOGIN_BROWSER_CLOSED', 'The sign-in browser window closed before X login completed.');
    }
    await delay(pollMs);
  }

  throw loginError('X_LOGIN_TIMEOUT', 'Timed out waiting for X sign-in. Retry and finish the login in the browser window.');
}

/** Best-effort read of the signed-in handle from the authenticated X page. */
export async function signedInHandle(page) {
  if (!page) return null;
  try {
    if (isXLoginURL(page.url())) return null;
  } catch {
    // A closed page cannot provide a handle; the caller can fall back.
  }

  try {
    const href = await page
      .locator('[data-testid="AppTabBar_Profile_Link"]')
      .first()
      .getAttribute('href', { timeout: 2_000 });
    const match = String(href ?? '').match(/^\/@?([A-Za-z0-9_]{1,15})\/?$/);
    if (match) return match[1].toLowerCase();
  } catch {
    // Continue with the account switcher label.
  }

  try {
    const control = page
      .locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Account_Menu_Button"]')
      .first();
    const [text, label] = await Promise.all([
      control.innerText({ timeout: 2_000 }).catch(() => ''),
      control.getAttribute('aria-label', { timeout: 2_000 }).catch(() => ''),
    ]);
    for (const value of [text, label]) {
      const match = String(value ?? '').match(/@([A-Za-z0-9_]{1,15})\b/);
      if (match) return match[1].toLowerCase();
    }
  } catch {
    // The profile link and the switcher label are both optional.
  }

  return null;
}

/** Build the storage-state record saved for verification and remote fallbacks. */
export async function captureProfileState(context, { username, source = 'interactive-login' } = {}) {
  const state = await context.storageState();
  const cookies = normalizeXSessionCookies(state.cookies);
  const authToken = cookies.find((cookie) => cookie.name === 'auth_token')?.value;
  const ct0 = cookies.find((cookie) => cookie.name === 'ct0')?.value;
  if (!authToken || !ct0) {
    throw loginError('X_LOGIN_NO_COOKIES', 'X did not issue a complete auth_token/ct0 session.');
  }
  return {
    ...state,
    cookies,
    username: validHandle(username),
    savedAt: new Date().toISOString(),
    loginUrl: X_LOGIN_URL,
    cookieCount: cookies.length,
    source,
  };
}
