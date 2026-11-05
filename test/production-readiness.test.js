import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { chromium } from 'playwright';
import {
  browserbaseSessionParams,
  CHROME_USER_AGENT,
  closeBrowser,
  connectBrowser,
  createBrowserbaseClient,
  createTrustedLoginProfile,
  createLiveInspection,
  getBrowserbaseSession,
  getDefaultContext,
  getOrCreatePage,
  normalizeBrowserbaseLiveURL,
  resolveBrowserbaseConfig,
  resolveSessionTimeoutSeconds,
  resolveVerifiedModeEnabled,
  restoreStorageState,
  safeContextCall,
  safeGoto,
  X_LOGIN_URL,
  X_REFERER,
} from '../lib/browser.js';
import { automateXCredentialLogin } from '../lib/x-credentials.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SESSION_SECRET = 'test-only-session-secret-with-more-than-32-characters';

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(t, extraEnv = {}, options = {}) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'x-engine-test-')));
  const cleanupData = options.cleanupData ?? !options.dataDir;
  const port = await availablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      SESSION_SECRET,
      BCRYPT_ROUNDS: '10',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out\n${output}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (!output.includes('X automation admin UI')) return;
      clearTimeout(timer);
      resolve();
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('X automation admin UI')) {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}\n${output}`));
      }
    });
  });
  await ready;

  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (cleanupData) await rm(dataDir, { recursive: true, force: true });
  };
  t.after(stop);

  return { baseUrl: `http://127.0.0.1:${port}`, dataDir, child, output: () => output, stop };
}

function sessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'session cookie was not set');
  return setCookie.split(';', 1)[0];
}

async function register(baseUrl, suffix = 'primary') {
  const password = `Password-${suffix}-123!`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: `user_${suffix}`,
      email: `${suffix}@example.test`,
      password,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(Object.hasOwn(body, 'sessionToken'), false);
  return { body, cookie: sessionCookie(response), password };
}

function jsonHeaders(cookie) {
  return { cookie, 'content-type': 'application/json' };
}

function xStorageState(username) {
  return {
    cookies: [
      { name: 'auth_token', value: `${username}_auth_token_value`, domain: '.x.com', path: '/', secure: true, httpOnly: true },
      { name: 'ct0', value: `${username}_csrf_token_value`, domain: '.x.com', path: '/', secure: true, httpOnly: false },
      { name: 'guest_id', value: `${username}_trusted_guest_value`, domain: '.x.com', path: '/', secure: true, httpOnly: false },
    ],
    origins: [
      {
        origin: 'https://x.com',
        localStorage: [{ name: 'trusted-device', value: `${username}-device-state` }],
      },
    ],
  };
}

test('registration writes remain valid under concurrency and passwords use bcrypt', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const registrations = await Promise.all(
    ['one', 'two', 'three', 'four'].map((suffix) =>
      fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: `user_${suffix}`,
          email: `${suffix}@example.test`,
          password: `Password-${suffix}-123!`,
        }),
      }),
    ),
  );
  assert.deepEqual(registrations.map((response) => response.status), [201, 201, 201, 201]);

  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.equal(users.length, 4);
  for (const user of users) {
    assert.match(user.passwordHash, /^\$2[aby]\$10\$/);
    assert.equal(Object.hasOwn(user, 'password'), false);
    assert.equal(Object.hasOwn(user, 'passwordMaterial'), false);
  }

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'user_one', password: 'Password-one-123!' }),
  });
  assert.equal(login.status, 200);
  assert.ok(sessionCookie(login).startsWith('x_engine_session='));
  assert.equal(await bcrypt.getRounds(users[0].passwordHash), 10);
});

test('stable DATA_DIR preserves users and app sessions across restarts', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-persist-'));
  let first;
  let second;
  try {
    first = await startServer(t, { DATA_DIR: dataDir }, { dataDir });
    const { cookie } = await register(first.baseUrl, 'persist');
    await first.stop();

    second = await startServer(t, { DATA_DIR: dataDir }, { dataDir });
    const me = await fetch(`${second.baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.authenticated, true);
    assert.equal(meBody.user.username, 'user_persist');

    const login = await fetch(`${second.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user_persist', password: 'Password-persist-123!' }),
    });
    assert.equal(login.status, 200);

    const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'user_persist');
  } finally {
    await second?.stop();
    await first?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('default admin is seeded on boot when configured', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, {
    DEFAULT_ADMIN_USERNAME: 'admin_seed',
    DEFAULT_ADMIN_EMAIL: 'admin-seed@example.test',
    DEFAULT_ADMIN_PASSWORD: 'Admin-Seed-Password-123!',
  });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin_seed', password: 'Admin-Seed-Password-123!' }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.equal(body.user.username, 'admin_seed');
  assert.equal(body.user.email, 'admin-seed@example.test');

  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'admin_seed');
  assert.equal(Object.hasOwn(users[0], 'password'), false);
});

test('legacy scrypt passwords migrate to bcrypt after a successful login', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const password = 'Legacy-Password-123!';
  const salt = crypto.randomBytes(16).toString('hex');
  const legacyHash = crypto.scryptSync(`${password}${SESSION_SECRET}`, salt, 64).toString('hex');
  const legacyUser = {
    id: crypto.randomUUID(),
    username: 'legacy_user',
    email: 'legacy@example.test',
    passwordHash: `scrypt$${salt}$${legacyHash}`,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    preferences: { defaultXAccount: null },
    xAccounts: [],
    sessionToken: null,
    ipAddress: '127.0.0.1',
  };
  await writeFile(join(dataDir, 'user-db.json'), `${JSON.stringify([legacyUser], null, 2)}\n`, 'utf8');

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: legacyUser.username, password }),
  });
  assert.equal(login.status, 200);

  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.match(users[0].passwordHash, /^\$2[aby]\$10\$/);
  assert.equal(await bcrypt.compare(
    crypto.createHmac('sha256', SESSION_SECRET).update(password, 'utf8').digest('base64'),
    users[0].passwordHash,
  ), true);
});
test('X account deletion rejects traversal and restages the next active account', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const { cookie, body } = await register(baseUrl, 'xaccounts');

  for (const username of ['alpha', 'beta']) {
    const response = await fetch(`${baseUrl}/api/auth/x-accounts`, {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ xUsername: username, storageState: xStorageState(username) }),
    });
    assert.equal(response.status, 201, await response.text());
  }

  const traversal = await fetch(`${baseUrl}/api/auth/x-accounts/..%2Fescape`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.ok([400, 404].includes(traversal.status));

  const deleted = await fetch(`${baseUrl}/api/auth/x-accounts/alpha`, {
    method: 'DELETE',
    headers: { cookie },
  });
  const result = await deleted.json();
  assert.equal(deleted.status, 200, JSON.stringify(result));
  assert.equal(result.wasActive, true);
  assert.equal(result.activeXAccount, 'beta');
  assert.equal(result.activeSessionStaged, true);

  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  const user = users.find((candidate) => candidate.id === body.user.id);
  assert.deepEqual(user.xAccounts, ['beta']);
  assert.equal(user.preferences.defaultXAccount, 'beta');
  await assert.rejects(stat(join(dataDir, 'sessions', user.id, 'alpha.json')), { code: 'ENOENT' });
  const staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(staged.username, 'beta');
  assert.deepEqual(staged.origins, xStorageState('beta').origins);

  const trustedProfile = JSON.parse(
    await readFile(join(dataDir, 'sessions', user.id, '_trusted-login-profile.json'), 'utf8'),
  );
  assert.deepEqual(trustedProfile.cookies.map((cookie) => cookie.name), ['guest_id']);
  assert.deepEqual(trustedProfile.origins, xStorageState('beta').origins);

  const deletedLast = await fetch(`${baseUrl}/api/auth/x-accounts/beta`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(deletedLast.status, 200, await deletedLast.text());
  await assert.rejects(
    stat(join(dataDir, 'sessions', user.id, '_trusted-login-profile.json')),
    { code: 'ENOENT' },
  );
});

test('Groq status is masked and explicit deletion purges persisted state', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const { cookie, body } = await register(baseUrl, 'groq');
  const apiKey = `gsk_${'s'.repeat(48)}`;

  const saved = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ apiKey }),
  });
  assert.equal(saved.status, 200);

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  const meText = await me.text();
  assert.equal(me.status, 200);
  assert.equal(meText.includes(apiKey), false);
  const meBody = JSON.parse(meText);
  assert.equal(meBody.groq.configured, true);
  assert.ok(meBody.groq.preview);
  assert.equal(Object.hasOwn(meBody.user, 'groqApiKey'), false);

  let users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.equal(users.find((user) => user.id === body.user.id).groqApiKey, apiKey);

  const cleared = await fetch(`${baseUrl}/api/config/groq`, { method: 'DELETE', headers: { cookie } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { configured: false, source: 'none', preview: null });

  users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.equal(Object.hasOwn(users.find((user) => user.id === body.user.id), 'groqApiKey'), false);
  const status = await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie } });
  assert.deepEqual(await status.json(), { configured: false, source: 'none', preview: null });
});

test('production refuses an insecure session secret', async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SESSION_SECRET: 'change-me' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(output, /SESSION_SECRET must be a unique value/);
});

test('production accepts a strong secret and emits hardened session cookies', async (t) => {
  const { baseUrl } = await startServer(t, { NODE_ENV: 'production' });
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'production_user',
      email: 'production@example.test',
      password: 'Production-Password-123!',
    }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Secure/i);

  const insecureCredentialRequest = await fetch(`${baseUrl}/auth/x/credentials`, {
    method: 'POST',
    headers: jsonHeaders(cookie.split(';', 1)[0]),
    body: JSON.stringify({ identifier: 'production_user', password: 'not-sent-to-x' }),
  });
  assert.equal(insecureCredentialRequest.status, 400);
  assert.match((await insecureCredentialRequest.json()).error, /requires HTTPS/);
});
test('production allows Render origins and rejects unknown origins', async (t) => {
  const { baseUrl } = await startServer(t, {
    NODE_ENV: 'production',
    RENDER_EXTERNAL_URL: 'https://x-bot.onrender.com',
  });

  const registerFrom = (origin, suffix) => fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      username: `user_${suffix}`,
      email: `${suffix}@example.test`,
      password: `Password-${suffix}-123!`,
    }),
  });

  const preflight = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://preview-check.onrender.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get('access-control-allow-origin'),
    'https://preview-check.onrender.com',
  );

  const render = await registerFrom('https://x-bot.onrender.com', 'render');
  assert.equal(render.status, 201, await render.text());
  assert.equal(render.headers.get('access-control-allow-origin'), 'https://x-bot.onrender.com');

  const wildcard = await registerFrom('https://preview-check.onrender.com', 'preview');
  assert.equal(wildcard.status, 201, await wildcard.text());

  const rejected = await registerFrom('https://evil.example', 'evil');
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: 'Origin not allowed' });
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('navigation absorbs non-200 HTTP response failures', async () => {
  const failure = new Error(
    'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://x.com/i/flow/login',
  );
  const page = {
    goto: async () => {
      throw failure;
    },
  };

  const result = await safeGoto(page, 'https://x.com/i/flow/login', { waitUntil: 'commit' });
  assert.equal(result.response, null);
  assert.equal(result.error, failure);
});

test('cookie operations are skipped on closed or disconnected contexts', async () => {
  const makeContext = ({ connected = true, tracked = true } = {}) => {
    const context = {
      cookies: async () => [{ name: 'auth_token', value: 'test' }],
      browser: () => ({
        isConnected: () => connected,
        contexts: () => (tracked ? [context] : []),
      }),
    };
    return context;
  };

  const openContext = makeContext();
  const openResult = await safeContextCall(
    openContext,
    () => openContext.cookies(),
    'Reading cookies',
  );
  assert.equal(openResult.ok, true);
  assert.equal(openResult.value.length, 1);

  for (const [name, context] of [
    ['closed', makeContext({ tracked: false })],
    ['disconnected', makeContext({ connected: false })],
  ]) {
    let operationRan = false;
    const result = await safeContextCall(
      context,
      async () => {
        operationRan = true;
        return [];
      },
      'Reading cookies',
    );
    assert.equal(result.ok, false, `${name} context should fail`);
    assert.match(result.error.message, /closed or disconnected/);
    assert.equal(operationRan, false, `${name} context must not run the operation`);
  }

  const closingContext = makeContext();
  closingContext.cookies = async () => {
    throw new Error('Target page, context or browser has been closed');
  };
  const closingResult = await safeContextCall(
    closingContext,
    () => closingContext.cookies(),
    'Reading cookies',
  );
  assert.equal(closingResult.ok, false);
  assert.match(closingResult.error.message, /browser context was closed/);
});

function fakeBrowserbaseClient({
  createResponse = { id: 'session-1', connectUrl: 'wss://connect.browserbase.test/session-1' },
  debugResponse = {
    debuggerFullscreenUrl: 'https://browserbase.test/live/fullscreen',
    debuggerUrl: 'https://browserbase.test/live/debugger',
    pages: [{ id: 'page-1', debuggerUrl: 'https://browserbase.test/live/page-1' }],
  },
} = {}) {
  const calls = { create: [], update: [], debug: [] };
  const client = {
    sessions: {
      create: async (params) => {
        calls.create.push(params);
        if (createResponse instanceof Error) throw createResponse;
        return createResponse;
      },
      update: async (id, body) => {
        calls.update.push({ id, body });
        return {};
      },
      debug: async (id, query) => {
        calls.debug.push({ id, query });
        if (debugResponse instanceof Error) throw debugResponse;
        return debugResponse;
      },
    },
  };
  return { client, calls };
}

function fakePlaywrightBrowser() {
  const context = {
    pages: () => [],
    addInitScript: async () => {},
    on: () => {},
  };
  return {
    contexts: () => [context],
    newContext: () => context,
    close: async () => {},
    isConnected: () => true,
  };
}

test('Browserbase credentials and stealth session parameters are resolved safely', () => {
  assert.deepEqual(
    resolveBrowserbaseConfig({
      BROWSERBASE_API_KEY: '  api-key  ',
      BROWSERBASE_PROJECT_ID: '  project-id  ',
    }),
    { apiKey: 'api-key', projectId: 'project-id' },
  );
  assert.deepEqual(resolveBrowserbaseConfig({}), { apiKey: '', projectId: '' });
  assert.throws(() => createBrowserbaseClient({}), /BROWSERBASE_API_KEY is required/);
  assert.equal(createBrowserbaseClient({ BROWSERBASE_API_KEY: 'key' }).projectId, '');
  assert.ok(createBrowserbaseClient({ BROWSERBASE_API_KEY: 'key' }).client.sessions);

  assert.equal(resolveSessionTimeoutSeconds({}), 900);
  assert.equal(resolveSessionTimeoutSeconds({ BROWSERBASE_SESSION_TIMEOUT_MS: 1_200_000 }), 1200);
  assert.equal(resolveSessionTimeoutSeconds({ BROWSERBASE_SESSION_TIMEOUT_SECONDS: '600' }), 600);
  assert.equal(resolveSessionTimeoutSeconds({ BROWSERBASE_SESSION_TIMEOUT_SECONDS: '1' }), 60);
  assert.equal(resolveSessionTimeoutSeconds({ BROWSERBASE_SESSION_TIMEOUT_SECONDS: '999999' }), 21_600);

  const params = browserbaseSessionParams({
    projectId: 'project-id',
    timeoutSeconds: 900,
    userMetadata: { tenant: 'one' },
  });
  assert.equal(params.projectId, 'project-id');
  assert.equal(params.api_timeout, 900);
  assert.equal(params.browserSettings.verified, undefined, 'Verified mode is opt-in');
  assert.equal(params.browserSettings.os, undefined, 'stealth-only OS is omitted on Free tier');
  assert.equal(params.browserSettings.solveCaptchas, true);
  assert.deepEqual(params.userMetadata, { tenant: 'one' });
  assert.equal(Object.hasOwn(browserbaseSessionParams({}), 'projectId'), false);

  const verified = browserbaseSessionParams({ verifiedMode: true });
  assert.equal(verified.browserSettings.verified, true);
  assert.equal(verified.browserSettings.os, 'windows');

  assert.equal(resolveVerifiedModeEnabled({}), false);
  assert.equal(resolveVerifiedModeEnabled({ BROWSERBASE_VERIFIED_MODE: 'false' }), false);
  assert.equal(resolveVerifiedModeEnabled({ BROWSERBASE_VERIFIED_MODE: 'true' }), true);
  assert.equal(resolveVerifiedModeEnabled({ BROWSERBASE_VERIFIED_MODE: '1' }), true);
  assert.equal(resolveVerifiedModeEnabled({ BROWSERBASE_VERIFIED_MODE: 'on' }), true);
});

test('connectBrowser creates a stealth Browserbase session and releases it on cleanup', async () => {
  const { client, calls } = fakeBrowserbaseClient();
  const browser = fakePlaywrightBrowser();
  let connectArgs = null;

  const connected = await connectBrowser({
    client,
    projectId: 'project-id',
    timeoutSeconds: 1_200,
    connectOverCDP: async (endpoint, options) => {
      connectArgs = { endpoint, options };
      return browser;
    },
  });

  assert.equal(connected, browser);
  assert.equal(connectArgs.endpoint, 'wss://connect.browserbase.test/session-1');
  assert.equal(connectArgs.options.timeout, 60_000);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].projectId, 'project-id');
  assert.equal(calls.create[0].api_timeout, 1_200);
  assert.equal(calls.create[0].browserSettings.verified, undefined);
  assert.equal(calls.create[0].browserSettings.os, undefined);
  assert.equal(getBrowserbaseSession(browser).session.id, 'session-1');

  await closeBrowser(browser);
  assert.deepEqual(calls.update, [{ id: 'session-1', body: { status: 'REQUEST_RELEASE' } }]);
  assert.equal(getBrowserbaseSession(browser), null);

  await closeBrowser(browser);
  assert.equal(calls.update.length, 1, 'release is idempotent');
});

test('connectBrowser releases the Browserbase session when connection setup fails', async () => {
  const { client, calls } = fakeBrowserbaseClient();
  await assert.rejects(
    connectBrowser({
      client,
      projectId: 'project-id',
      connectOverCDP: async () => {
        throw new Error('CDP refused');
      },
    }),
    /Could not connect Playwright to Browserbase: CDP refused/,
  );
  assert.deepEqual(calls.update, [{ id: 'session-1', body: { status: 'REQUEST_RELEASE' } }]);

  const missingUrl = fakeBrowserbaseClient({ createResponse: { id: 'session-2' } });
  await assert.rejects(
    connectBrowser({ client: missingUrl.client, projectId: 'project-id' }),
    /did not return a session connect URL/,
  );
  assert.deepEqual(missingUrl.calls.update, [{ id: 'session-2', body: { status: 'REQUEST_RELEASE' } }]);
});

test('Browserbase live inspection exposes the SDK debugger URL', async () => {
  const { client, calls } = fakeBrowserbaseClient();
  const browser = fakePlaywrightBrowser();
  await connectBrowser({
    client,
    projectId: 'project-id',
    connectOverCDP: async () => browser,
  });
  const page = { context: () => ({ browser: () => browser }) };

  const inspection = await createLiveInspection(page, { timeoutMs: 600_000 });
  assert.equal(inspection.liveURL, 'https://browserbase.test/live/fullscreen');
  assert.equal(inspection.liveURLId, 'page-1');
  assert.ok(inspection.expiresAt > Date.now());
  assert.deepEqual(calls.debug, [{ id: 'session-1', query: { expiresIn: 600 } }]);

  await inspection.close();
  await closeBrowser(browser);
});

test('Browserbase live inspection uses the SDK URL and upgrades the legacy inspector path', async () => {
  const legacyQuery = 'wss=connect.browserbase.com%2Fsessions%2Fsession-1';
  const legacy = `https://www.browserbase.com/devtools-fullscreen/inspector.html?${legacyQuery}`;
  const current = `https://www.browserbase.com/devtools-fullscreen-compiled/index.html?${legacyQuery}`;
  assert.equal(normalizeBrowserbaseLiveURL(legacy), current);
  assert.equal(normalizeBrowserbaseLiveURL(current), current);
  assert.equal(normalizeBrowserbaseLiveURL('not a url'), null);
  assert.equal(normalizeBrowserbaseLiveURL('javascript:alert(1)'), null);

  const { client, calls } = fakeBrowserbaseClient({ debugResponse: { debuggerFullscreenUrl: legacy } });
  const browser = fakePlaywrightBrowser();
  await connectBrowser({
    client,
    projectId: 'project-id',
    connectOverCDP: async () => browser,
  });
  const page = { context: () => ({ browser: () => browser }) };

  const inspection = await createLiveInspection(page, { timeoutMs: 60_000 });
  assert.equal(inspection.liveURL, current);
  assert.deepEqual(calls.debug, [{ id: 'session-1', query: { expiresIn: 60 } }]);

  await closeBrowser(browser);
});

test('Browserbase live inspection falls back to the debugger URL and reports failures', async () => {
  const fallback = fakeBrowserbaseClient({
    debugResponse: { debuggerUrl: 'https://browserbase.test/live/debugger' },
  });
  const fallbackBrowser = fakePlaywrightBrowser();
  await connectBrowser({
    client: fallback.client,
    projectId: 'project-id',
    connectOverCDP: async () => fallbackBrowser,
  });
  const fallbackPage = { context: () => ({ browser: () => fallbackBrowser }) };
  const inspection = await createLiveInspection(fallbackPage, { timeoutMs: 60_000 });
  assert.equal(inspection.liveURL, 'https://browserbase.test/live/debugger');
  assert.equal(inspection.liveURLId, 'session-1');
  assert.deepEqual(fallback.calls.debug, [{ id: 'session-1', query: { expiresIn: 60 } }]);
  await closeBrowser(fallbackBrowser);

  await assert.rejects(
    createLiveInspection({ context: () => ({ browser: () => null }) }),
    /requires an active Browserbase session/,
  );

  const failing = fakeBrowserbaseClient({ debugResponse: new Error('debug unavailable') });
  const failingBrowser = fakePlaywrightBrowser();
  await connectBrowser({
    client: failing.client,
    projectId: 'project-id',
    connectOverCDP: async () => failingBrowser,
  });
  await assert.rejects(
    createLiveInspection({ context: () => ({ browser: () => failingBrowser }) }),
    /Browserbase could not create a live inspection link: debug unavailable/,
  );
  await closeBrowser(failingBrowser);
});

test('Browserbase session creation clamps invalid timeouts and rejects missing debug URLs', async () => {
  const { client, calls } = fakeBrowserbaseClient({ debugResponse: {} });
  const browser = fakePlaywrightBrowser();
  await connectBrowser({
    client,
    projectId: 'project-id',
    timeoutSeconds: 30,
    connectOverCDP: async () => browser,
  });
  assert.equal(calls.create[0].api_timeout, 60);
  await assert.rejects(
    createLiveInspection({ context: () => ({ browser: () => browser }) }),
    /did not return a live inspection URL/,
  );
  await closeBrowser(browser);
});

test('storage state restores cookies and localStorage while tenant profiles omit account auth', async () => {
  const operations = [];
  const initScripts = [];
  const state = {
    cookies: [
      { name: 'auth_token', value: 'account-secret', domain: '.x.com', path: '/' },
      { name: 'ct0', value: 'csrf-secret', domain: '.x.com', path: '/' },
      { name: 'guest_id', value: 'trusted-guest', domain: '.x.com', path: '/' },
      { name: 'kdt', value: 'known-device', domain: '.twitter.com', path: '/' },
      { name: 'external', value: 'ignore-me', domain: '.example.com', path: '/' },
    ],
    origins: [
      { origin: 'https://x.com', localStorage: [{ name: 'device', value: 'trusted' }] },
      { origin: 'https://example.com', localStorage: [{ name: 'external', value: 'ignore-me' }] },
    ],
  };
  const context = {
    clearCookies: async () => operations.push('clearCookies'),
    addCookies: async (cookies) => operations.push({ addCookies: cookies }),
    addInitScript: async (script, argument) => initScripts.push({ script, argument }),
  };

  const restored = await restoreStorageState(context, state, { clearCookies: true });
  assert.deepEqual(operations, ['clearCookies', { addCookies: state.cookies }]);
  assert.deepEqual(restored, { cookieCount: 5, originCount: 2, localStorageCount: 2 });
  assert.equal(initScripts.length, 1);
  assert.match(String(initScripts[0].script), /localStorage\.getItem/);
  assert.match(String(initScripts[0].script), /localStorage\.setItem/);
  assert.deepEqual(initScripts[0].argument, state.origins);

  const trustedProfile = createTrustedLoginProfile(state);
  assert.deepEqual(trustedProfile.cookies.map((cookie) => cookie.name), ['guest_id', 'kdt']);
  assert.deepEqual(trustedProfile.origins, [state.origins[0]]);
});

test('credential automation submits the X form and waits for an auth cookie', async () => {
  const actions = [];
  let authenticated = false;
  const page = {
    locator(selector) {
      const kind = selector === 'input[name="username_or_email"]'
        ? 'identifier'
        : selector === 'input[name="password"]'
          ? 'password'
          : selector === 'body'
            ? 'body'
            : 'missing';
      return {
        first() { return this; },
        isVisible: async () => kind === 'identifier' || kind === 'password',
        fill: async (value) => actions.push({ kind, value }),
        press: async (key) => {
          actions.push({ kind, key });
          if (kind === 'password' && key === 'Enter') authenticated = true;
        },
        innerText: async () => '',
      };
    },
    waitForTimeout: async () => {},
  };
  const context = {
    cookies: async () => authenticated ? [{ name: 'auth_token', value: 'session' }] : [],
  };

  const result = await automateXCredentialLogin({
    context,
    page,
    identifier: 'test_user',
    password: 'test-password',
    timeoutMs: 2_000,
  });
  assert.deepEqual(result, { status: 'authenticated' });
  assert.deepEqual(actions, [
    { kind: 'identifier', value: 'test_user' },
    { kind: 'password', value: 'test-password' },
    { kind: 'password', key: 'Enter' },
  ]);
});

test('credential automation stops immediately when X reports a temporary limit', async () => {
  const page = {
    locator(selector) {
      return {
        first() { return this; },
        isVisible: async () => false,
        innerText: async () => selector === 'body' ? "We've temporarily limited your login" : '',
      };
    },
    waitForTimeout: async () => {},
  };
  const result = await automateXCredentialLogin({
    context: { cookies: async () => [] },
    page,
    identifier: 'test_user',
    password: 'test-password',
    timeoutMs: 2_000,
  });
  assert.deepEqual(result, { status: 'temporarily_limited' });
});

test('Browserbase contexts and pages use a realistic Chrome identity and stealth profile', async () => {
  const page = { isClosed: () => false };
  const commands = [];
  const initScripts = [];
  const pageHandlers = [];
  const context = {
    pages: () => [page],
    newPage: async () => page,
    addInitScript: async (script) => initScripts.push(script),
    on: (event, handler) => {
      if (event === 'page') pageHandlers.push(handler);
    },
    newCDPSession: async (target) => {
      return {
        send: async (method, params) => commands.push({ target, method, params }),
        detach: async () => {},
      };
    },
  };
  const browser = { contexts: () => [context], newContext: () => context };

  assert.equal(X_LOGIN_URL, 'https://x.com/i/flow/login');
  assert.equal(X_REFERER, 'https://x.com/');
  assert.equal(await getDefaultContext(browser), context);
  assert.equal(await getOrCreatePage(context), page);
  assert.equal(initScripts.length, 1);
  assert.equal(pageHandlers.length, 1);
  const stealthSource = String(initScripts[0]);
  assert.match(stealthSource, /webdriver/);
  assert.match(stealthSource, /permissions/);
  assert.match(stealthSource, /Notification/);
  assert.match(stealthSource, /chrome/);
  assert.match(stealthSource, /runtime/);
  assert.match(stealthSource, /WebGLRenderingContext/);
  assert.match(stealthSource, /getParameter/);
  assert.match(stealthSource, /toDataURL/);
  assert.match(stealthSource, /toBlob/);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].method, 'Network.setUserAgentOverride');
  assert.equal(commands[0].params.userAgent, CHROME_USER_AGENT);
  assert.equal(
    commands[0].params.userAgent,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  );
  assert.equal(commands[0].params.platform, 'Win32');
  assert.equal(commands[0].params.acceptLanguage, 'en-US,en');
  assert.equal(commands[0].params.userAgentMetadata.platform, 'Windows');
  assert.deepEqual(commands[0].params.userAgentMetadata.brands, [
    { brand: 'Chromium', version: '122' },
    { brand: 'Google Chrome', version: '122' },
    { brand: 'Not(A:Brand', version: '24' },
  ]);
  assert.equal(commands[0].params.userAgentMetadata.mobile, false);

  await getDefaultContext(browser);
  await getOrCreatePage(context);
  assert.equal(initScripts.length, 1);
  assert.equal(commands.length, 1);

  const popup = { isClosed: () => false };
  await pageHandlers[0](popup);
  assert.equal(commands.length, 2);
  assert.equal(commands[1].target, popup);
  assert.equal(commands[1].method, 'Network.setUserAgentOverride');
});

test('remote sign-in completion requires an active sign-in run', async (t) => {
  const { baseUrl } = await startServer(t);
  const { cookie } = await register(baseUrl, 'remotecomplete');

  const unauthorized = await fetch(`${baseUrl}/auth/x/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(unauthorized.status, 401);

  const noRun = await fetch(`${baseUrl}/auth/x/complete`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({}),
  });
  assert.equal(noRun.status, 409);
  assert.match((await noRun.json()).error, /No X sign-in/);
});

test('credential sign-in requires app authentication and validates secrets before Browserbase', async (t) => {
  const { baseUrl } = await startServer(t);
  const { cookie } = await register(baseUrl, 'credentials');
  const testPassword = 'X-Credential-Test-Password!';

  const unauthorized = await fetch(`${baseUrl}/auth/x/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'x_user', password: testPassword }),
  });
  const unauthorizedText = await unauthorized.text();
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorizedText.includes(testPassword), false);

  const missingPassword = await fetch(`${baseUrl}/auth/x/credentials`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ identifier: 'x_user' }),
  });
  const invalidBody = await missingPassword.text();
  assert.equal(missingPassword.status, 400);
  assert.equal(invalidBody.includes(testPassword), false);
  assert.match(invalidBody, /password is required/i);
});

test('remote sign-in cancellation is authenticated and idempotent', async (t) => {
  const { baseUrl } = await startServer(t);
  const { cookie } = await register(baseUrl, 'remotecancel');

  const unauthorized = await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(unauthorized.status, 401);

  const noRun = await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({}),
  });
  assert.equal(noRun.status, 200);
  assert.deepEqual(await noRun.json(), { ok: true, cancelled: false });
});

test('container exposes the Render port and starts Node directly', async () => {
  const [dockerfile, server] = await Promise.all([
    readFile(join(ROOT, 'Dockerfile'), 'utf8'),
    readFile(join(ROOT, 'server.js'), 'utf8'),
  ]);

  assert.match(dockerfile, /^ENV PORT=10000$/m);
  assert.match(dockerfile, /^EXPOSE 10000$/m);
  assert.match(dockerfile, /^CMD \["node", "server\.js"\]$/m);
  assert.match(server, /process\.env\.PORT \|\| 10000/);
  assert.match(server, /app\.listen\(PORT, '0\.0\.0\.0'/);
  assert.match(server, /Server listening on port/);

  const loginFlow = server.slice(
    server.indexOf('async function runBrowserLogin'),
    server.indexOf("app.post('/auth/x'"),
  );
  assert.ok(loginFlow.indexOf('createLiveInspection(page') < loginFlow.indexOf('safeGoto(page, LOGIN_URL'));
});

test('UI mobile dropdown, credential sign-in, Clear All, and sign-out remain stable', async (t) => {
  const { baseUrl } = await startServer(t);
  // Keep this browser local: the remote browser cannot reach the ephemeral 127.0.0.1 test server.
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  await page.locator('#signup-tab').click();
  await page.locator('#auth-username').fill('ui_state_user');
  await page.locator('#auth-email').fill('ui-state@example.test');
  await page.locator('#auth-password').fill('UI-State-Password-123!');
  await page.locator('#auth-submit').click();
  await page.locator('#auth-modal').waitFor({ state: 'hidden' });

  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 760 });
    await page.locator('#account-chip').click();
    const dropdownLayout = await page.locator('#account-dropdown').evaluate((dropdown) => {
      const style = getComputedStyle(dropdown);
      const rect = dropdown.getBoundingClientRect();
      const topElement = document.elementFromPoint(
        Math.min(window.innerWidth - 2, Math.max(1, rect.left + 12)),
        Math.min(window.innerHeight - 2, Math.max(rect.top + 12, rect.bottom - 12)),
      );
      return {
        backgroundColor: style.backgroundColor,
        containsTopElement: Boolean(topElement?.closest('#account-dropdown')),
        left: rect.left,
        overflow: style.overflow,
        position: style.position,
        right: rect.right,
        viewportWidth: window.innerWidth,
        zIndex: style.zIndex,
      };
    });
    assert.equal(dropdownLayout.position, 'absolute');
    assert.equal(dropdownLayout.zIndex, '9999');
    assert.equal(dropdownLayout.backgroundColor, 'rgb(17, 24, 39)');
    assert.equal(dropdownLayout.overflow, 'hidden');
    assert.equal(dropdownLayout.containsTopElement, true);
    assert.ok(dropdownLayout.left >= 0);
    assert.ok(dropdownLayout.right <= dropdownLayout.viewportWidth);
    await page.locator('#account-chip').click();
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  let submittedCredentials = null;
  await page.route('**/auth/x/credentials', async (route) => {
    submittedCredentials = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        username: 'directuser',
        activeXAccount: 'directuser',
        cookieCount: 3,
        accounts: [{ xUsername: 'directuser', active: true, status: 'ready' }],
      }),
    });
  });
  await page.locator('#account-chip').click();
  await page.locator('#add-x-account').click();
  await page.locator('#x-credentials-modal').waitFor({ state: 'visible' });
  await page.locator('#x-credential-identifier').fill('directuser');
  await page.locator('#x-credential-password').fill('Direct-X-Password-123!');
  await page.locator('#toggle-x-credential-password').click();
  assert.equal(await page.locator('#x-credential-password').getAttribute('type'), 'text');
  await page.locator('#x-credentials-submit').click();
  await page.locator('#x-credentials-modal').waitFor({ state: 'hidden' });
  assert.deepEqual(submittedCredentials, {
    identifier: 'directuser',
    password: 'Direct-X-Password-123!',
  });
  assert.equal(await page.locator('#x-credential-password').inputValue(), '');
  assert.equal(await page.locator('.linked-account-item').count(), 1);
  await page.unroute('**/auth/x/credentials');

  const liveUrl = `${baseUrl}/?browserless-live-test=1`;
  await page.route('**/auth/x', async (route) => {
    const events = [
      { type: 'live', status: 'ready', url: liveUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { type: 'exit', code: 1, result: { ok: false } },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    });
  });
  await page.locator('#account-chip').click();
  await page.locator('#add-x-account').click();
  const [automaticRemoteTab] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#x-credentials-remote').click(),
  ]);
  await automaticRemoteTab.waitForURL(liveUrl);
  assert.equal(automaticRemoteTab.url(), liveUrl);
  await automaticRemoteTab.close();
  await page.locator('#remote-login-modal').waitFor({ state: 'hidden' });
  await page.unroute('**/auth/x');

  assert.equal(await page.locator('#remote-login-modal').isVisible(), false);
  await page.evaluate(() => eval('openRemoteLoginModal()'));
  assert.equal(await page.locator('#remote-login-open').getAttribute('aria-disabled'), 'true');
  await page.evaluate(() => eval("setRemoteLoginUrl('about:blank', Date.now() + 60_000)"));
  assert.equal(await page.locator('#remote-login-modal').isVisible(), true);
  assert.equal(await page.locator('#remote-login-open').getAttribute('aria-disabled'), 'false');
  assert.equal(await page.locator('#remote-login-open').getAttribute('target'), '_blank');
  assert.equal(await page.locator('#remote-login-open').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('#remote-login-open').getAttribute('href'), 'about:blank');
  assert.equal(await page.locator('#remote-login-complete').isEnabled(), true);
  assert.equal(await page.locator('#remote-login-complete').textContent(), 'I’ve completed sign-in');
  assert.equal(await page.locator('#remote-login-iframe').count(), 0);
  assert.match(await page.locator('#remote-login-empty').textContent(), /new tab/i);
  const [remoteTab] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#remote-login-open').click(),
  ]);
  assert.equal(remoteTab.url(), 'about:blank');
  await remoteTab.close();
  await page.locator('#remote-login-cancel').click();
  await page.locator('#remote-login-modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#remote-login-modal').isVisible(), false);

  await page.locator('#run-url').fill('https://x.com/a/status/123\nhttps://x.com/b/status/456');
  assert.equal(await page.evaluate(() => eval('targetUrls.length')), 2);
  await page.locator('#clear-urls').click();
  assert.equal(await page.locator('#run-url').inputValue(), '');
  assert.equal(await page.evaluate(() => eval('targetUrls.length')), 0);

  await page.evaluate(() => eval("applyLinkedAccounts([{ xUsername: 'alpha', active: true }, { xUsername: 'beta' }], 'alpha')"));
  await page.locator('#account-chip').click();
  assert.equal(await page.locator('.linked-account-item').count(), 2);
  await page.locator('#run-url').fill('https://x.com/c/status/789');
  await page.locator('#signout').click();
  await page.locator('#signin').waitFor({ state: 'visible' });

  const state = await page.evaluate(() => ({
    currentUser: eval('currentUser'),
    currentAppUsername: eval('currentAppUsername'),
    currentUserEmail: eval('currentUserEmail'),
    activeXAccount: eval('activeXAccount'),
    linkedAccounts: eval('linkedXAccounts.length'),
    targetUrls: eval('targetUrls.length'),
    controllerIsNull: eval('controller === null'),
    credentialControllerIsNull: eval('credentialController === null'),
  }));
  assert.deepEqual(state, {
    currentUser: null,
    currentAppUsername: null,
    currentUserEmail: '',
    activeXAccount: null,
    linkedAccounts: 0,
    targetUrls: 0,
    controllerIsNull: true,
    credentialControllerIsNull: true,
  });
  assert.equal(await page.locator('.linked-account-item').count(), 0);
  assert.equal(await page.locator('#run-url').inputValue(), '');
  assert.deepEqual(pageErrors, []);
});
