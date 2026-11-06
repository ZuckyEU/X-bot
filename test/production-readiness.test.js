import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import bcrypt from 'bcrypt';
import { INTERACTIVE_CALLBACK_PATH, INTERACTIVE_LOGIN_PATH } from '../lib/interactive-login.js';
import {
  browserbaseSessionParams,
  CHROME_USER_AGENT,
  chromeIdentityForVersion,
  closeBrowser,
  connectBrowser,
  createBrowserbaseClient,
  createTrustedLoginProfile,
  createLiveInspection,
  getBrowserbaseSession,
  getDefaultContext,
  getOrCreatePage,
  hasXSessionCookies,
  isXHomeURL,
  resolveBrowserbaseLiveURL,
  resolveBrowserbaseConfig,
  resolveSessionTimeoutSeconds,
  resolveVerifiedModeEnabled,
  restoreStorageState,
  safeContextCall,
  safeGoto,
  X_LOGIN_URL,
  X_REFERER,
} from '../lib/browser.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SESSION_SECRET = 'test-only-session-secret-with-more-than-32-characters';
const INTERACTIVE_SERVICE_TOKEN = 'test-interactive-service-token-with-more-than-32-characters';

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
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      SESSION_SECRET,
      BCRYPT_ROUNDS: '10',
      INTERACTIVE_LOGIN_ENABLED: 'false',
      ...(options.callbackToSelf ? {
        RENDER_EXTERNAL_URL: `http://127.0.0.1:${port}`,
        HARVEST_CALLBACK_URL: '',
      } : {}),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out\n${output}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (!output.includes('X automation API service')) return;
      clearTimeout(timer);
      resolve();
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('X automation API service')) {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}\n${output}`));
      }
    });
  });
  await ready;

  let stopping;
  const stop = () => stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const stopped = await Promise.race([exited.then(() => true), delay(5_000, false, { ref: false })]);
      if (!stopped) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    if (cleanupData) await rm(dataDir, { recursive: true, force: true });
  })();
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

async function startHarvestService(t, { status = 200, body } = {}) {
  const calls = [];
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { calls, url: `http://127.0.0.1:${port}/api/harvest-token` };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check, message = 'condition did not become true') {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function startInteractiveService(t, options = {}) {
  const calls = [];
  const sessions = new Map();
  let origin;
  const server = createHttpServer(async (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      if (req.headers.authorization !== `Bearer ${INTERACTIVE_SERVICE_TOKEN}`) {
        return respond(401, { error: 'Service token required' });
      }
      const url = new URL(req.url, origin);
      if (req.method === 'POST' && url.pathname === INTERACTIVE_LOGIN_PATH) {
        const id = call.body.requestId;
        if (sessions.has(id)) return respond(409, { error: 'Request already used' });
        const session = {
          sessionId: id,
          machineId: 'test-machine-a',
          status: options.status ?? 'waiting',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          browserClosed: false,
        };
        sessions.set(id, session);
        await options.onStart?.(call, session);
        return respond(201, {
          ...session,
          viewerUrl: `${origin}/remote-login/${id}?machine=${session.machineId}#token=${'v'.repeat(43)}`,
        });
      }
      const id = url.pathname.slice(`${INTERACTIVE_LOGIN_PATH}/`.length);
      const session = sessions.get(id);
      if (!session) return respond(404, { error: 'Session not found' });
      if (req.method === 'DELETE') {
        await options.onCancel?.(call, session);
        session.status = 'cancelled';
        session.browserClosed = options.cancelClosed !== false;
      }
      return respond(200, session);
    } catch {
      respond(503, { error: 'Simulated Fly failure' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const callback = (id, overrides = {}, token) => {
    const call = calls.find((request) => request.method === 'POST' && request.body.requestId === id);
    assert.ok(call, 'Fly START was not received');
    return fetch(call.body.callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? call.body.callbackToken}` },
      body: JSON.stringify({
        requestId: id, sessionId: id, status: 'completed', browserClosed: true,
        username: 'alice', cookies: xStorageState('alice').cookies, ...overrides,
      }),
    });
  };
  return { calls, sessions, callback, url: `${origin}/api/harvest-token` };
}

async function startInteractiveRender(t, { flyOptions, environment, ...options } = {}) {
  const fly = await startInteractiveService(t, flyOptions);
  const render = await startServer(t, {
    HARVEST_API_URL: fly.url,
    HARVEST_API_TOKEN: INTERACTIVE_SERVICE_TOKEN,
    ...environment,
  }, { callbackToSelf: true, ...options });
  return { ...render, fly };
}

async function startInteractiveLogin(baseUrl, cookie, body = {}) {
  const response = await fetch(`${baseUrl}/api/auth/x-accounts/interactive`, {
    method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  return result;
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

test('Connect X Account harvests cookies through the Fly service and links the account', async (t) => {
  const harvest = await startHarvestService(t, {
    body: {
      ok: true,
      username: 'carol',
      cookies: [
        { name: 'auth_token', value: 'carol_auth_token_value', domain: '.x.com', path: '/', secure: true, httpOnly: true },
        { name: 'ct0', value: 'carol_csrf_token_value', domain: '.x.com', path: '/', secure: true, httpOnly: false },
      ],
    },
  });
  const harvestToken = 'test-harvest-token-1234567890abcdef';
  const { baseUrl, dataDir } = await startServer(t, {
    HARVEST_API_URL: harvest.url,
    HARVEST_API_TOKEN: harvestToken,
  });
  const { cookie, body } = await register(baseUrl, 'harvest');

  const unauthenticated = await fetch(`${baseUrl}/api/auth/x-accounts/harvest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'carol@example.test', password: 'X-Password-123!' }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(harvest.calls.length, 0);

  const response = await fetch(`${baseUrl}/api/auth/x-accounts/harvest`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({
      identifier: 'carol@example.test',
      password: 'X-Password-123!',
      twoFactorCode: '123456',
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.username, 'carol');
  assert.equal(result.activeXAccount, 'carol');
  assert.deepEqual(result.accounts, [{ xUsername: 'carol', active: true, status: 'ready' }]);

  assert.equal(harvest.calls.length, 1);
  assert.equal(harvest.calls[0].method, 'POST');
  assert.equal(harvest.calls[0].url, '/api/harvest-token');
  assert.equal(harvest.calls[0].headers.authorization, `Bearer ${harvestToken}`);
  assert.equal(harvest.calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(harvest.calls[0].body, {
    identifier: 'carol@example.test',
    password: 'X-Password-123!',
    twoFactorCode: '123456',
  });

  const saved = JSON.parse(await readFile(join(dataDir, 'sessions', body.user.id, 'carol.json'), 'utf8'));
  assert.equal(saved.username, 'carol');
  assert.equal(saved.source, 'fly-harvest');
  assert.deepEqual(saved.cookies.map((item) => item.name), ['auth_token', 'ct0']);
  assert.equal(saved.cookies.find((item) => item.name === 'auth_token').httpOnly, true);
  assert.equal(saved.cookies.find((item) => item.name === 'ct0').httpOnly, false);

  const staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(staged.username, 'carol');
  assert.deepEqual(staged.cookies.map((item) => item.name), ['auth_token', 'ct0']);

  const status = await fetch(`${baseUrl}/api/auth`, { headers: { cookie } });
  const statusBody = await status.json();
  assert.equal(statusBody.authenticated, true);
  assert.equal(statusBody.username, 'carol');
  assert.deepEqual(statusBody.xAccounts, ['carol']);
});

test('interactive Render starts require app authentication and keep pending logins session-owned', { timeout: 20_000 }, async (t) => {
  const { baseUrl, fly } = await startInteractiveRender(t, { flyOptions: { status: 'completed' } });
  const owner = await register(baseUrl, 'interactive_owner');
  const other = await register(baseUrl, 'interactive_other');
  const endpoint = `${baseUrl}/api/auth/x-accounts/interactive`;
  const unauthenticated = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unauthenticated.status, 401);
  const malformed = await fetch(endpoint, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId: [crypto.randomUUID()] }),
  });
  assert.equal(malformed.status, 400);
  assert.equal(fly.calls.length, 0);

  const id = crypto.randomUUID();
  const login = await startInteractiveLogin(baseUrl, owner.cookie, {
    requestId: id, userId: other.body.user.id,
    callbackUrl: 'http://169.254.169.254/', callbackToken: 'browser-supplied-token',
  });
  assert.equal(login.requestId, id);
  const start = fly.calls.find((call) => call.method === 'POST');
  assert.equal(start.body.callbackUrl, `${baseUrl}${INTERACTIVE_CALLBACK_PATH}`);
  assert.match(start.body.callbackToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(start.headers.authorization, `Bearer ${INTERACTIVE_SERVICE_TOKEN}`);
  assert.equal(Object.hasOwn(start.body, 'userId'), false);
  assert.equal(JSON.stringify(login).includes(INTERACTIVE_SERVICE_TOKEN), false);
  assert.equal(JSON.stringify(login).includes(start.body.callbackToken), false);
  await until(() => fly.calls.some((call) => call.method === 'GET'));
  assert.equal(new URL(fly.calls.find((call) => call.method === 'GET').url, fly.url).searchParams.get('machine'), 'test-machine-a');
  const status = await fetch(`${endpoint}/${id}`, { headers: { cookie: owner.cookie } });
  const state = await status.json();
  assert.notEqual(state.status, 'completed', 'Fly status alone must not link an account');
  assert.equal(Object.hasOwn(state, 'viewerUrl'), false);
  assert.equal(Object.hasOwn(state, 'cookies'), false);

  const foreignStatus = await fetch(`${endpoint}/${id}`, { headers: { cookie: other.cookie } });
  assert.equal(foreignStatus.status, 404);
  const foreignCancel = await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(other.cookie), body: JSON.stringify({ requestId: id }),
  });
  assert.equal(foreignCancel.status, 404);
  const foreignGenericCancel = await fetch(`${baseUrl}/auth/x/cancel`, { method: 'POST', headers: jsonHeaders(other.cookie), body: '{}' });
  assert.equal(foreignGenericCancel.status, 403);
  const overlaps = await Promise.all([owner.cookie, other.cookie].map((cookie) => fetch(endpoint, {
    method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ requestId: id }),
  })));
  assert.deepEqual(overlaps.map((response) => response.status), [409, 409]);
  assert.equal(fly.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(fly.calls.some((call) => call.method === 'DELETE'), false, 'A duplicate START must not cancel the real owner');
  const cancelled = await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId: id }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).closed, true);
});

test('interactive callbacks validate identity and cookies, persist per tenant, and acknowledge identical retries', { timeout: 20_000 }, async (t) => {
  const { baseUrl, dataDir, fly, output } = await startInteractiveRender(t);
  const owner = await register(baseUrl, 'callback_owner');
  const other = await register(baseUrl, 'callback_other');
  const login = await startInteractiveLogin(baseUrl, owner.cookie);
  const id = login.requestId;
  const wrongToken = await fly.callback(id, {}, INTERACTIVE_SERVICE_TOKEN);
  assert.equal(wrongToken.status, 401, 'The shared service token is not a callback credential');
  for (const [body, expected] of [
    [{ sessionId: crypto.randomUUID() }, 400],
    [{ username: '../escape' }, 400],
    [{ cookies: [xStorageState('alice').cookies[0]] }, 400],
    [{ cookies: xStorageState('alice').cookies.map((cookie) => ({ ...cookie, domain: '.evilx.com' })) }, 400],
    [{ cookies: xStorageState('alice').cookies.map((cookie) => ({ ...cookie, secure: false })) }, 400],
    [{ browserClosed: false }, 400],
  ]) {
    const rejected = await fly.callback(id, body);
    assert.equal(rejected.status, expected, await rejected.text());
  }
  await assert.rejects(stat(join(dataDir, 'sessions', owner.body.user.id, 'alice.json')), { code: 'ENOENT' });
  const acknowledgements = await Promise.all([fly.callback(id), fly.callback(id)]);
  assert.deepEqual(acknowledgements.map((response) => response.status), [200, 200]);
  const destination = join(dataDir, 'sessions', owner.body.user.id, 'alice.json');
  const firstSave = await readFile(destination, 'utf8');
  const saved = JSON.parse(firstSave);
  assert.equal(saved.username, 'alice');
  assert.equal(saved.source, 'fly-interactive');
  assert.deepEqual(saved.cookies.map((cookie) => cookie.name), ['auth_token', 'ct0']);
  assert.deepEqual(saved.origins, []);
  assert.equal(saved.cookies[0].httpOnly, true);
  assert.equal(saved.cookies[1].httpOnly, false);
  const staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.deepEqual(staged.cookies, saved.cookies);
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);

  const retry = await fly.callback(id);
  assert.equal(retry.status, 200);
  assert.equal(await readFile(destination, 'utf8'), firstSave, 'An acknowledged retry must not rewrite the session');
  const conflicting = await fly.callback(id, { cookies: xStorageState('conflict').cookies });
  assert.equal(conflicting.status, 409);
  const status = await fetch(`${baseUrl}/api/auth/x-accounts/interactive/${id}`, { headers: { cookie: owner.cookie } });
  const statusText = await status.text();
  const state = JSON.parse(statusText);
  assert.equal(state.status, 'completed');
  assert.equal(state.username, 'alice');
  assert.deepEqual(state.accounts, [{ xUsername: 'alice', active: true, status: 'ready' }]);
  assert.equal(statusText.includes(saved.cookies[0].value), false);
  const cancelledAfterSave = await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId: id }),
  });
  assert.deepEqual(await cancelledAfterSave.json(), { ok: true, cancelled: false, closed: true, status: 'completed' });

  const otherLogin = await startInteractiveLogin(baseUrl, other.cookie);
  const otherCookies = xStorageState('other_tenant').cookies;
  const secondCallback = await fly.callback(otherLogin.requestId, { username: 'alice', cookies: otherCookies });
  assert.equal(secondCallback.status, 200);
  assert.equal(await readFile(destination, 'utf8'), firstSave);
  const otherSave = JSON.parse(await readFile(join(dataDir, 'sessions', other.body.user.id, 'alice.json'), 'utf8'));
  assert.equal(otherSave.cookies[0].value, otherCookies[0].value);
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  for (const user of users) {
    assert.deepEqual(user.xAccounts, ['alice']);
    assert.equal(user.preferences.defaultXAccount, 'alice');
  }
  for (const secret of [INTERACTIVE_SERVICE_TOKEN, saved.cookies[0].value, otherCookies[0].value]) {
    assert.equal(output().includes(secret), false, 'Login credentials must not appear in server logs');
  }
});

test('interactive starts and callbacks enforce requested handles and recheck the three-account limit', { timeout: 20_000 }, async (t) => {
  const { baseUrl, dataDir, fly } = await startInteractiveRender(t);
  const full = await register(baseUrl, 'interactive_full');
  const link = async (cookie, username) => {
    const response = await fetch(`${baseUrl}/api/auth/x-accounts`, {
      method: 'POST', headers: jsonHeaders(cookie),
      body: JSON.stringify({ xUsername: username, storageState: xStorageState(username) }),
    });
    assert.equal(response.status, 201, await response.text());
  };
  for (const username of ['alpha', 'beta', 'gamma']) await link(full.cookie, username);
  const refused = await fetch(`${baseUrl}/api/auth/x-accounts/interactive`, {
    method: 'POST', headers: jsonHeaders(full.cookie), body: '{}',
  });
  assert.equal(refused.status, 409);
  assert.equal(fly.calls.length, 0);
  const refresh = await startInteractiveLogin(baseUrl, full.cookie, { xUsername: '@beta' });
  const wrongIdentity = await fly.callback(refresh.requestId);
  assert.equal(wrongIdentity.status, 409);
  const refreshed = await fly.callback(refresh.requestId, { username: 'beta', cookies: xStorageState('beta').cookies });
  assert.equal(refreshed.status, 200);

  const growing = await register(baseUrl, 'interactive_growing');
  await link(growing.cookie, 'alpha');
  await link(growing.cookie, 'beta');
  const pending = await startInteractiveLogin(baseUrl, growing.cookie);
  await link(growing.cookie, 'gamma');
  const overLimit = await fly.callback(pending.requestId, { username: 'delta', cookies: xStorageState('delta').cookies });
  assert.equal(overLimit.status, 409);
  await assert.rejects(stat(join(dataDir, 'sessions', growing.body.user.id, 'delta.json')), { code: 'ENOENT' });
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.deepEqual(users.find((user) => user.id === growing.body.user.id).xAccounts, ['alpha', 'beta', 'gamma']);
  await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(growing.cookie), body: JSON.stringify({ requestId: pending.requestId }),
  });
});

test('cancel, logout, session rotation, and unlink reject late interactive callbacks', { timeout: 30_000 }, async (t) => {
  const { baseUrl, dataDir, fly } = await startInteractiveRender(t);
  for (const action of ['request', 'generic', 'logout', 'rotation', 'unlink']) {
    const owner = await register(baseUrl, `late_${action}`);
    if (action === 'unlink') {
      const linked = await fetch(`${baseUrl}/api/auth/x-accounts`, {
        method: 'POST', headers: jsonHeaders(owner.cookie),
        body: JSON.stringify({ xUsername: 'alice', storageState: xStorageState('alice') }),
      });
      assert.equal(linked.status, 201);
    }
    const login = await startInteractiveLogin(baseUrl, owner.cookie, action === 'unlink' ? { xUsername: 'alice' } : {});
    let response;
    if (action === 'logout') {
      response = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: owner.cookie } });
    } else if (action === 'rotation') {
      response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: owner.body.user.username, password: owner.password }),
      });
    } else if (action === 'unlink') {
      response = await fetch(`${baseUrl}/api/auth/x-accounts/alice`, { method: 'DELETE', headers: { cookie: owner.cookie } });
    } else {
      response = await fetch(`${baseUrl}/auth/x/cancel`, {
        method: 'POST', headers: jsonHeaders(owner.cookie),
        body: JSON.stringify(action === 'request' ? { requestId: login.requestId } : {}),
      });
    }
    assert.equal(response.status, 200, `${action}: ${await response.text()}`);
    const late = await fly.callback(login.requestId);
    assert.equal(late.status, 410, `${action}: ${await late.text()}`);
    await assert.rejects(stat(join(dataDir, 'sessions', owner.body.user.id, 'alice.json')), { code: 'ENOENT' });
    const deletion = fly.calls.find((call) => call.method === 'DELETE' && call.url.includes(login.requestId));
    assert.ok(deletion, `${action} must cancel the Fly browser`);
    assert.equal(new URL(deletion.url, fly.url).searchParams.get('machine'), 'test-machine-a');
    const status = await fetch(`${baseUrl}/api/auth/x-accounts/interactive/${login.requestId}`, { headers: { cookie: owner.cookie } });
    assert.equal(status.status, ['logout', 'rotation'].includes(action) ? 401 : 200);
  }
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.ok(users.every((user) => user.xAccounts.length === 0));
});

test('cancelling a delayed Fly START waits for its Machine affinity before closing the desktop', { timeout: 20_000 }, async (t) => {
  const acknowledgement = deferred();
  t.after(() => acknowledgement.resolve());
  const { baseUrl, fly } = await startInteractiveRender(t, { flyOptions: { onStart: () => acknowledgement.promise } });
  const owner = await register(baseUrl, 'delayed_start');
  const requestId = crypto.randomUUID();
  const starting = fetch(`${baseUrl}/api/auth/x-accounts/interactive`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId }),
  });
  await until(() => fly.calls.some((call) => call.method === 'POST'));
  const cancelling = fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId }),
  });
  await until(async () => {
    const response = await fetch(`${baseUrl}/api/auth/x-accounts/interactive/${requestId}`, { headers: { cookie: owner.cookie } });
    return (await response.json()).status === 'cancelled';
  });
  assert.equal(fly.calls.some((call) => call.method === 'DELETE'), false);
  const overlap = await fetch(`${baseUrl}/api/auth/x-accounts/interactive`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: '{}',
  });
  assert.equal(overlap.status, 409, 'The pending desktop cleanup must keep the reservation');
  acknowledgement.resolve();
  assert.equal((await starting).status, 410);
  const cancelled = await cancelling;
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).closed, true);
  const deletion = fly.calls.find((call) => call.method === 'DELETE');
  assert.equal(new URL(deletion.url, fly.url).searchParams.get('machine'), 'test-machine-a');
  const next = await startInteractiveLogin(baseUrl, owner.cookie);
  await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId: next.requestId }),
  });
});

test('interactive terminal callbacks are idempotent and unconfirmed cleanup is never reported as closed', { timeout: 20_000 }, async (t) => {
  const { baseUrl, fly } = await startInteractiveRender(t, { flyOptions: { cancelClosed: false } });
  const owner = await register(baseUrl, 'terminal_callbacks');
  for (const status of ['failed', 'expired']) {
    const login = await startInteractiveLogin(baseUrl, owner.cookie);
    for (let retry = 0; retry < 2; retry += 1) {
      const response = await fly.callback(login.requestId, { status, cookies: undefined, username: undefined });
      assert.equal(response.status, 200);
    }
    assert.equal((await fly.callback(login.requestId)).status, 410);
  }
  const login = await startInteractiveLogin(baseUrl, owner.cookie);
  const cancel = await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId: login.requestId }),
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).closed, false);
  const state = await fetch(`${baseUrl}/api/auth/x-accounts/interactive/${login.requestId}`, { headers: { cookie: owner.cookie } });
  assert.match((await state.json()).error, /close could not be confirmed/);
  assert.equal((await fly.callback(login.requestId)).status, 410);
});

test('Fly interactive APIs require the backend service token, not an app session', { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await startServer(t, {
    HARVEST_API_TOKEN: INTERACTIVE_SERVICE_TOKEN,
    INTERACTIVE_LOGIN_ENABLED: 'true',
    INTERACTIVE_LOGIN_PUBLIC_ORIGIN: 'https://fly.example.test',
    HARVEST_CALLBACK_URL: `https://render.example.test${INTERACTIVE_CALLBACK_PATH}`,
  });
  const owner = await register(baseUrl, 'fly_access');
  const requestId = crypto.randomUUID();
  for (const method of ['POST', 'GET', 'DELETE']) {
    const path = method === 'POST' ? INTERACTIVE_LOGIN_PATH : `${INTERACTIVE_LOGIN_PATH}/${requestId}`;
    const denied = await fetch(`${baseUrl}${path}`, {
      method, headers: jsonHeaders(owner.cookie), ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.equal(denied.status, 401);
  }
  const internalHeaders = { 'content-type': 'application/json', authorization: `Bearer ${INTERACTIVE_SERVICE_TOKEN}` };
  const deleted = await fetch(`${baseUrl}${INTERACTIVE_LOGIN_PATH}/${requestId}`, { method: 'DELETE', headers: internalHeaders });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).browserClosed, true);
  const delayed = await fetch(`${baseUrl}${INTERACTIVE_LOGIN_PATH}`, {
    method: 'POST', headers: internalHeaders,
    body: JSON.stringify({ requestId, callbackUrl: `https://render.example.test${INTERACTIVE_CALLBACK_PATH}`, callbackToken: 't'.repeat(43) }),
  });
  assert.equal(delayed.status, 409, 'Cancellation must reject a later START with the same ID');
  const override = await fetch(`${baseUrl}${INTERACTIVE_LOGIN_PATH}`, {
    method: 'POST', headers: internalHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), callbackUrl: 'http://169.254.169.254/', callbackToken: 't'.repeat(43) }),
  });
  assert.equal(override.status, 400);
});

test('a failed interactive save rolls back tenant metadata and permits an identical callback retry', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-write-retry-'));
  const marker = join(dataDir, 'stage-write-gate');
  const { baseUrl, fly } = await startInteractiveRender(t, {
    dataDir, cleanupData: true,
    environment: { INTERACTIVE_TEST_WRITE_GATE: marker },
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'interactive-write-gate.cjs')],
  });
  const owner = await register(baseUrl, 'storage_retry');
  const previousUsers = await readFile(join(dataDir, 'user-db.json'), 'utf8');
  const previousActive = `${JSON.stringify({ ...xStorageState('previous'), username: 'previous' })}\n`;
  await writeFile(join(dataDir, 'auth.json'), previousActive);
  const login = await startInteractiveLogin(baseUrl, owner.cookie);
  await writeFile(marker, 'fail');
  const failure = await fly.callback(login.requestId);
  assert.equal(failure.status, 500);
  assert.equal(await readFile(join(dataDir, 'user-db.json'), 'utf8'), previousUsers);
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), previousActive);
  await assert.rejects(stat(join(dataDir, 'sessions', owner.body.user.id, 'alice.json')), { code: 'ENOENT' });
  const changedPayload = await fly.callback(login.requestId, { cookies: xStorageState('different').cookies });
  assert.equal(changedPayload.status, 409, 'A retriable save must remain bound to the original cookie payload');
  const retry = await fly.callback(login.requestId);
  assert.equal(retry.status, 200, await retry.text());
  const saved = JSON.parse(await readFile(join(dataDir, 'sessions', owner.body.user.id, 'alice.json'), 'utf8'));
  assert.equal(saved.cookies[0].value, xStorageState('alice').cookies[0].value);
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.deepEqual(users.find((user) => user.id === owner.body.user.id).xAccounts, ['alice']);
});

test('cancellation during an interactive save restores the prior session before acknowledging cleanup', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-write-cancel-'));
  const marker = join(dataDir, 'stage-write-gate');
  t.after(() => unlink(marker).catch(() => {}));
  const { baseUrl, fly } = await startInteractiveRender(t, {
    dataDir, cleanupData: true,
    environment: { INTERACTIVE_TEST_WRITE_GATE: marker },
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'interactive-write-gate.cjs')],
  });
  const owner = await register(baseUrl, 'storage_cancel');
  const linked = await fetch(`${baseUrl}/api/auth/x-accounts`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ xUsername: 'alice', storageState: xStorageState('alice') }),
  });
  assert.equal(linked.status, 201);
  const switched = await fetch(`${baseUrl}/api/auth/switch-account`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ xUsername: 'alice' }),
  });
  assert.equal(switched.status, 200);
  const paths = [join(dataDir, 'user-db.json'), join(dataDir, 'auth.json'), join(dataDir, 'sessions', owner.body.user.id, 'alice.json')];
  const previous = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const login = await startInteractiveLogin(baseUrl, owner.cookie, { xUsername: 'alice' });
  await writeFile(marker, 'pause');
  const saving = fly.callback(login.requestId, { cookies: xStorageState('updated').cookies });
  await until(() => stat(`${marker}.entered`).then(() => true, () => false), 'The callback did not reach session staging');
  const cancelling = fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ requestId: login.requestId }),
  });
  await until(async () => {
    const response = await fetch(`${baseUrl}/api/auth/x-accounts/interactive/${login.requestId}`, { headers: { cookie: owner.cookie } });
    return (await response.json()).status === 'cancelled';
  });
  assert.equal(fly.calls.some((call) => call.method === 'DELETE'), false, 'Cancellation must wait for the interrupted write to roll back');
  await unlink(marker);
  assert.equal((await saving).status, 410);
  const cancelled = await cancelling;
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).closed, true);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, 'utf8'))), previous);
  assert.equal((await fly.callback(login.requestId)).status, 410);
});

test('a Render restart preserves saved users but discards pending interactive callback ownership', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-pending-restart-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await startInteractiveRender(t, { dataDir });
  const owner = await register(first.baseUrl, 'pending_restart');
  const pending = await startInteractiveLogin(first.baseUrl, owner.cookie);
  const start = first.fly.calls.find((call) => call.method === 'POST');
  await first.stop();
  const second = await startServer(t, {
    HARVEST_API_URL: first.fly.url, HARVEST_API_TOKEN: INTERACTIVE_SERVICE_TOKEN,
  }, { dataDir, callbackToSelf: true });
  const status = await fetch(`${second.baseUrl}/api/auth/x-accounts/interactive/${pending.requestId}`, { headers: { cookie: owner.cookie } });
  assert.equal(status.status, 404);
  const late = await fetch(`${second.baseUrl}${INTERACTIVE_CALLBACK_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${start.body.callbackToken}` },
    body: JSON.stringify({ requestId: pending.requestId, sessionId: pending.requestId, status: 'completed', browserClosed: true, username: 'alice', cookies: xStorageState('alice').cookies }),
  });
  assert.equal(late.status, 404);
  const me = await fetch(`${second.baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } });
  assert.equal(me.status, 200);
  const fresh = await startInteractiveLogin(second.baseUrl, owner.cookie);
  assert.notEqual(fresh.requestId, pending.requestId);
  const completed = await first.fly.callback(fresh.requestId);
  assert.equal(completed.status, 200);
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

test('production refuses an insecure harvest token', async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      SESSION_SECRET: 'test-only-session-secret-with-more-than-32-characters',
      HARVEST_API_TOKEN: 'change-me',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(output, /HARVEST_API_TOKEN must be a unique value/);
});

test('production accepts a strong secret and emits hardened session cookies', async (t) => {
  const { baseUrl } = await startServer(t, {
    NODE_ENV: 'production',
    HARVEST_API_TOKEN: 'test-harvest-token-1234567890abcdef',
  });
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

});
test('production allows Render origins and rejects unknown origins', async (t) => {
  const { baseUrl } = await startServer(t, {
    NODE_ENV: 'production',
    RENDER_EXTERNAL_URL: 'https://x-bot.onrender.com',
    HARVEST_API_TOKEN: 'test-harvest-token-1234567890abcdef',
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

test('Browserbase live inspection passes through the SDK URL without hardcoding a domain', async () => {
  const sdkUrl = 'https://live.browserbase.test/fullscreen?token=abc&navbar=false';
  assert.equal(resolveBrowserbaseLiveURL({ debuggerFullscreenUrl: sdkUrl }), sdkUrl);
  assert.equal(resolveBrowserbaseLiveURL({ debuggerUrl: sdkUrl }), sdkUrl);
  assert.equal(
    resolveBrowserbaseLiveURL({ pages: [{ debuggerFullscreenUrl: sdkUrl }] }),
    sdkUrl,
  );
  assert.equal(resolveBrowserbaseLiveURL({ debuggerFullscreenUrl: 'not a url' }), null);
  assert.equal(resolveBrowserbaseLiveURL({ debuggerFullscreenUrl: 'javascript:alert(1)' }), null);

  const browserSource = await readFile(join(ROOT, 'lib', 'browser.js'), 'utf8');
  assert.equal(
    browserSource.includes('browserbase.com'),
    false,
    'the live URL builder must not force a Browserbase domain',
  );

  const { client, calls } = fakeBrowserbaseClient({ debugResponse: { debuggerFullscreenUrl: sdkUrl } });
  const browser = fakePlaywrightBrowser();
  await connectBrowser({
    client,
    projectId: 'project-id',
    connectOverCDP: async () => browser,
  });
  const page = { context: () => ({ browser: () => browser }) };

  const inspection = await createLiveInspection(page, { timeoutMs: 60_000 });
  assert.equal(inspection.liveURL, sdkUrl);
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

test('remote X sign-in detection recognizes home and both required cookies', () => {
  assert.equal(isXHomeURL('https://x.com/home'), true);
  assert.equal(isXHomeURL('https://mobile.twitter.com/home/'), true);
  assert.equal(isXHomeURL('https://x.com/i/flow/login'), false);
  assert.equal(isXHomeURL('https://example.test/home'), false);

  assert.equal(hasXSessionCookies([{ name: 'auth_token', value: 'session' }, { name: 'ct0', value: 'csrf' }]), true);
  assert.equal(hasXSessionCookies([{ name: 'auth_token' }]), false);
  assert.equal(hasXSessionCookies([{ name: 'ct0' }]), false);
});

test('Chrome identity follows the actual Chromium build and falls back safely', () => {
  const identity = chromeIdentityForVersion('156.0.8078.4');
  assert.equal(
    identity.userAgent,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  );
  assert.equal(identity.userAgentMetadata.fullVersion, '156.0.8078.4');
  assert.deepEqual(identity.userAgentMetadata.brands, [
    { brand: 'Chromium', version: '156' },
    { brand: 'Google Chrome', version: '156' },
    { brand: 'Not(A:Brand', version: '24' },
  ]);

  const fallback = chromeIdentityForVersion('not-a-version');
  assert.equal(fallback.userAgent, CHROME_USER_AGENT);
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
  assert.match(stealthSource, /pdfViewerEnabled/);
  assert.match(stealthSource, /outerWidth/);
  assert.match(stealthSource, /outerHeight/);
  assert.match(stealthSource, /PluginArray/);
  assert.match(stealthSource, /MimeTypeArray/);
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

test('container exposes only the Fly.io app port and starts the supervised desktop stack', async () => {
  const [dockerfile, server, lockText] = await Promise.all([
    readFile(join(ROOT, 'Dockerfile'), 'utf8'),
    readFile(join(ROOT, 'server.js'), 'utf8'),
    readFile(join(ROOT, 'package-lock.json'), 'utf8'),
  ]);

  const playwrightVersion = JSON.parse(lockText).packages['node_modules/playwright'].version;
  const playwrightImage = `v${playwrightVersion}-jammy`.replace(/\./g, '\\.');
  assert.match(
    dockerfile,
    new RegExp(`^FROM mcr\\.microsoft\\.com/playwright:${playwrightImage}$`, 'm'),
  );
  assert.match(dockerfile, /^ENV PORT=3000$/m);
  assert.match(dockerfile, /^EXPOSE 3000$/m);
  assert.match(dockerfile, /^CMD \["\/usr\/local\/bin\/start-x-login"\]$/m);
  assert.match(dockerfile, /xvfb x11vnc novnc websockify openbox/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "-s", "--"\]/);
  assert.equal((dockerfile.match(/^EXPOSE /gm) || []).length, 1);
  assert.match(server, /process\.env\.PORT \|\| 3000/);
  assert.match(server, /app\.listen\(PORT, '0\.0\.0\.0'/);
  assert.match(server, /Server listening on port/);

  const loginFlow = server.slice(
    server.indexOf('async function runBrowserLogin'),
    server.indexOf("app.post('/auth/x'"),
  );
  assert.ok(loginFlow.indexOf('createLiveInspection(page') < loginFlow.indexOf('safeGoto(page, LOGIN_URL'));
  assert.match(loginFlow, /waitForRemoteSignIn\(page, context, signal, send\)/);
  assert.equal(server.includes('/auth/x/credentials'), false);
});

test('production preflight and docs include the harvest API token', async () => {
  const [checkProd, envExample, readme] = await Promise.all([
    readFile(join(ROOT, 'scripts', 'check-prod.js'), 'utf8'),
    readFile(join(ROOT, '.env.example'), 'utf8'),
    readFile(join(ROOT, 'README.md'), 'utf8'),
  ]);

  assert.match(checkProd, /HARVEST_API_TOKEN/);
  assert.match(envExample, /^HARVEST_API_TOKEN=/m);
  assert.match(readme, /POST \/api\/harvest-token/);
  assert.match(readme, /lib\/harvest-client\.js/);
});

test('dashboard connects X accounts through interactive Fly login without asking for X credentials', async () => {
  const html = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal(html.includes('id="x-credentials-form"'), false);
  assert.equal(html.includes('id="x-password"'), false);
  assert.match(html, /\/api\/auth\/x-accounts\/interactive/);
  assert.match(html, /launchRemoteLoginWindow\(data\.viewerUrl, preparedWindow\)/);
  assert.match(html, /state\.status === 'completed'/);
});

test('root serves the dashboard and X harvest authentication is enforced', async (t) => {
  const { baseUrl } = await startServer(t, { HARVEST_API_TOKEN: 'harvest-test-token-123' });

  const root = await fetch(`${baseUrl}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await root.text(), /<title>X automation console<\/title>/);

  const index = await fetch(`${baseUrl}/index.html`);
  assert.equal(index.status, 200);

  const missingApi = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { error: 'No route for GET /api/does-not-exist' });

  const unauthorized = await fetch(`${baseUrl}/api/harvest-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'x_user', password: 'Password-123!' }),
  });
  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = await unauthorized.json();
  assert.equal(unauthorizedBody.ok, false);

  const authorized = await fetch(`${baseUrl}/api/harvest-token`, {
    method: 'POST',
    headers: { authorization: 'Bearer harvest-test-token-123', 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: '', password: 'Password-123!' }),
  });
  assert.equal(authorized.status, 400);
  const authorizedBody = await authorized.json();
  assert.equal(authorizedBody.ok, false);
});
