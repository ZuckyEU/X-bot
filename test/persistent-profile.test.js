import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  captureProfileState,
  closePersistentProfile,
  DEFAULT_LOGIN_TIMEOUT_MS,
  interactiveLoginUnavailableReason,
  launchPersistentProfile,
  persistentProfileDirectory,
  persistentProfileRoot,
  PROFILE_SESSION_STORAGE_FILE,
  signedInHandle,
  waitForProfileLogin,
} from '../lib/persistent-profile.js';

const authCookie = {
  name: 'auth_token',
  value: 'opaque_auth_token_value',
  domain: '.x.com',
  path: '/',
  secure: true,
};
const csrfCookie = {
  name: 'ct0',
  value: 'opaque_ct0_value',
  domain: '.x.com',
  path: '/',
  secure: true,
};

function fakePage(url, { closed = false, link = null } = {}) {
  return {
    currentUrl: url,
    isClosed: () => closed,
    url() {
      return this.currentUrl;
    },
    locator(selector) {
      const locator = {
        first: () => locator,
        async getAttribute(name) {
          if (selector.includes('Profile_Link') && name === 'href') return link;
          return null;
        },
        async innerText() {
          return '';
        },
      };
      return locator;
    },
  };
}

function fakeContext({ cookies = [], page = fakePage('https://x.com/home'), browserOpen = true } = {}) {
  const context = {
    pages: () => [page],
    async cookies() {
      return cookies;
    },
    async storageState() {
      return { cookies, origins: [{ origin: 'https://x.com', localStorage: [] }] };
    },
    browser() {
      return { isConnected: () => browserOpen };
    },
  };
  return context;
}

test('persistent profiles are namespaced by app user and normalized handle', () => {
  assert.equal(
    persistentProfileDirectory('C:\\data', '12345678-1234-1234-9234-123456789abc', '@Alice'),
    join('C:\\data', 'user_data', '12345678-1234-1234-9234-123456789abc', 'alice'),
  );
  assert.equal(persistentProfileRoot('/tmp/x'), join('/tmp/x', 'user_data'));
  assert.throws(() => persistentProfileDirectory('/tmp/x', '../oops', 'alice'), /Invalid user id/);
  assert.throws(() => persistentProfileDirectory('/tmp/x', '1', '../alice'), /Invalid X handle/);
  assert.throws(() => persistentProfileDirectory('/tmp/x', '1', 'alice/../../bob'), /Invalid X handle/);
});

test('interactive login availability reports disabled profiles, disabled login, and headless Linux', () => {
  assert.equal(interactiveLoginUnavailableReason({ platform: 'win32', env: {} }), null);
  assert.equal(interactiveLoginUnavailableReason({ platform: 'darwin', env: {} }), null);
  assert.match(
    interactiveLoginUnavailableReason({ platform: 'win32', env: { PERSISTENT_PROFILES: '0' } }),
    /Persistent browser profiles are disabled/,
  );
  assert.match(
    interactiveLoginUnavailableReason({ platform: 'win32', env: { INTERACTIVE_LOGIN_DISABLED: '1' } }),
    /disabled on this server/,
  );
  assert.match(
    interactiveLoginUnavailableReason({ platform: 'linux', env: {} }),
    /desktop display/,
  );
  assert.equal(
    interactiveLoginUnavailableReason({ platform: 'linux', env: { DISPLAY: ':0' } }),
    null,
  );
  assert.equal(
    interactiveLoginUnavailableReason({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }),
    null,
  );
});

test('persistent profile initialization failure closes the launched context', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'x-engine-profile-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let closed = 0;
  t.mock.method(chromium, 'launchPersistentContext', async (path, options) => {
    assert.equal(path, directory);
    assert.equal(options.headless, false);
    return {
      async addInitScript() { throw new Error('Synthetic initialization failure'); },
      async close() { closed += 1; },
    };
  });
  await assert.rejects(launchPersistentProfile(directory, { headless: false }), /initialize/);
  assert.equal(closed, 1);
});

test('real persistent profiles retain cookies, local storage, and private X session storage across launches', { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'x-engine-profile-storage-'));
  let context;
  t.after(async () => {
    await closePersistentProfile(context);
    await rm(directory, { recursive: true, force: true });
  });
  const launch = async () => {
    context = await launchPersistentProfile(directory, { headless: true });
    await context.route('**/*', (route) => new URL(route.request().url()).hostname === 'x.com'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Profile fixture</title>' })
      : route.abort());
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    return page;
  };

  const first = await launch();
  await context.addCookies([{ ...authCookie, expires: Math.floor(Date.now() / 1000) + 3600 }]);
  await first.evaluate(() => {
    localStorage.setItem('synthetic-device', 'local-profile-value');
    sessionStorage.setItem('synthetic-session', 'opaque_session%2B+/_value==');
  });
  await closePersistentProfile(context);
  const snapshotPath = join(directory, PROFILE_SESSION_STORAGE_FILE);
  assert.deepEqual(JSON.parse(await readFile(snapshotPath, 'utf8')), [{
    origin: 'https://x.com',
    sessionStorage: [{ name: 'synthetic-session', value: 'opaque_session%2B+/_value==' }],
  }]);
  if (process.platform !== 'win32') assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);

  const second = await launch();
  assert.deepEqual(await second.evaluate(() => ({
    local: localStorage.getItem('synthetic-device'),
    session: sessionStorage.getItem('synthetic-session'),
  })), { local: 'local-profile-value', session: 'opaque_session%2B+/_value==' });
  assert.equal((await context.cookies('https://x.com')).find((cookie) => cookie.name === 'auth_token').value, authCookie.value);
});

test('malformed optional session storage does not block sign-in or leak its contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'x-engine-profile-storage-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = 'synthetic_profile_storage_secret';
  await writeFile(join(directory, PROFILE_SESSION_STORAGE_FILE), `{"value":"${secret}",`, { mode: 0o600 });
  let closed = 0;
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(chromium, 'launchPersistentContext', async () => ({
    async addInitScript() {},
    on() {},
    pages: () => [],
    async close() { closed += 1; },
  }));
  const context = await launchPersistentProfile(directory);
  const output = warnings.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  assert.match(output, /Could not restore X session storage/);
  assert.equal(output.includes(secret), false);
  await closePersistentProfile(context);
  assert.equal(closed, 1);
});

test('waitForProfileLogin returns complete cookies once the login page is left', async () => {
  const page = fakePage('https://x.com/home');
  const context = fakeContext({ cookies: [authCookie, csrfCookie], page });
  const cookies = await waitForProfileLogin(context, { timeoutMs: 500, pollMs: 10, page });
  assert.deepEqual(cookies.map((cookie) => cookie.name), ['auth_token', 'ct0']);
});

test('waitForProfileLogin does not accept stale cookies while the browser is still on login', async () => {
  const page = fakePage('https://x.com/i/flow/login');
  const context = fakeContext({ cookies: [authCookie, csrfCookie], page });
  const started = Date.now();
  await assert.rejects(
    waitForProfileLogin(context, { timeoutMs: 120, pollMs: 10, page }),
    { code: 'X_LOGIN_TIMEOUT' },
  );
  assert.ok(Date.now() - started >= 100, 'stale cookies must not short-circuit the login wait');
});

test('waitForProfileLogin reports cancellation and a closed browser window', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForProfileLogin(fakeContext(), { timeoutMs: 1_000, signal: controller.signal }),
    { code: 'X_LOGIN_CANCELLED' },
  );

  const closedPage = fakePage('https://x.com/i/flow/login', { closed: true });
  await assert.rejects(
    waitForProfileLogin(fakeContext({ page: closedPage }), { timeoutMs: 5_000, pollMs: 10 }),
    { code: 'X_LOGIN_BROWSER_CLOSED' },
  );

  await assert.rejects(waitForProfileLogin(null), { code: 'X_LOGIN_BROWSER_CLOSED' });
});

test('waitForProfileLogin default timeout is five minutes', () => {
  assert.equal(DEFAULT_LOGIN_TIMEOUT_MS, 5 * 60 * 1000);
});

test('captureProfileState canonicalizes cookies and rejects incomplete sessions', async () => {
  const context = fakeContext({ cookies: [authCookie, csrfCookie] });
  const state = await captureProfileState(context, { username: '@Alice' });
  assert.equal(state.username, 'alice');
  assert.equal(state.source, 'interactive-login');
  assert.match(state.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  const cookies = new Map(state.cookies.map((cookie) => [cookie.name, cookie]));
  assert.deepEqual(cookies.get('auth_token'), {
    name: 'auth_token',
    value: 'opaque_auth_token_value',
    domain: '.x.com',
    path: '/',
    expires: -1,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
  assert.deepEqual(cookies.get('ct0'), {
    name: 'ct0',
    value: 'opaque_ct0_value',
    domain: '.x.com',
    path: '/',
    expires: -1,
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
  });

  await assert.rejects(
    captureProfileState(fakeContext({ cookies: [authCookie] }), { username: 'alice' }),
    { code: 'X_LOGIN_NO_COOKIES' },
  );
  await assert.rejects(
    captureProfileState(fakeContext({ cookies: [authCookie, csrfCookie] }), { username: 'not valid!' }),
    /Invalid X handle/,
  );
});

test('signedInHandle reads the profile link and ignores login pages', async () => {
  assert.equal(await signedInHandle(fakePage('https://x.com/home', { link: '/Alice' })), 'alice');
  assert.equal(await signedInHandle(fakePage('https://x.com/i/flow/login', { link: '/Alice' })), null);
  assert.equal(await signedInHandle(fakePage('https://x.com/home')), null);
  assert.equal(await signedInHandle(null), null);
});
