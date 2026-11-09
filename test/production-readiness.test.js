import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import bcrypt from 'bcrypt';
import { chromium } from 'playwright';
import {
  CHROME_USER_AGENT,
  chromeIdentityForVersion,
  closeBrowser,
  connectBrowser,
  createTrustedLoginProfile,
  getDefaultContext,
  getOrCreatePage,
  hasXSessionCookies,
  isXHomeURL,
  restoreStorageState,
  safeContextCall,
  safeGoto,
  X_LOGIN_URL,
  X_REFERER,
} from '../lib/browser.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SESSION_SECRET = 'test-only-session-secret-with-more-than-32-characters';
const PROFILE_DELETION_MESSAGE = 'User profile, Groq API key, and associated X sessions completely deleted.';

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
  const healthFixture = extraEnv.X_SESSION_CHECK_DISABLED === '0'
    ? ['--require', join(ROOT, 'test', 'fixtures', 'x-health-browser.cjs')]
    : [];
  const child = spawn(process.execPath, [...healthFixture, ...(options.nodeArgs ?? []), 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Never inherit a real deployment database or admin seed into API fixtures.
      DATABASE_URL: '',
      DEFAULT_ADMIN_USERNAME: '',
      DEFAULT_ADMIN_EMAIL: '',
      DEFAULT_ADMIN_PASSWORD: '',
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      SESSION_SECRET,
      BCRYPT_ROUNDS: '10',
      // Tests must never call X. Individual health-check tests opt back in
      // with X_SESSION_CHECK_DISABLED=0 and a local fixture URL.
      X_SESSION_CHECK_DISABLED: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', ...(options.ipc ? ['ipc'] : [])],
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
  await ready;

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

function accountIdentity(accounts) {
  return accounts.map(({ xUsername, active, status }) => ({ xUsername, active, status }));
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

function importPayload(handle, prefix = handle) {
  return { handle, auth_token: `${prefix}_auth_token_value`, ct0: `${prefix}_csrf_token_value` };
}

function importSession(baseUrl, cookie, body) {
  return fetch(`${baseUrl}/api/auth/import-session`, {
    method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify(body),
  });
}

function deleteProfile(baseUrl, cookie) {
  return fetch(`${baseUrl}/api/auth/me`, { method: 'DELETE', headers: { cookie } });
}

async function saveGroqKey(baseUrl, cookie, apiKey = 'test-only-groq-key-no-external-requests') {
  const response = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({ apiKey }),
  });
  assert.equal(response.status, 200, await response.text());
}

function profileDatabaseCommand(child, action, userId) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', receive);
    };
    const receive = (message) => {
      if (message?.requestId !== requestId) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Profile deletion database fixture timed out'));
    }, 5_000);
    child.on('message', receive);
    child.send({ fixture: 'profile-deletion-database', requestId, action, userId }, (error) => {
      if (!error) return;
      cleanup();
      reject(error);
    });
  });
}

async function assertDeletedProfileCannotAuthenticate(baseUrl, account) {
  for (const path of ['/api/config/groq', '/api/auth/x-accounts', '/api/history', '/api/auth']) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: account.cookie } });
    assert.equal(response.status, 401, path);
  }
  const token = account.cookie.slice(account.cookie.indexOf('=') + 1);
  const bearer = await fetch(`${baseUrl}/api/config/groq`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 401);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: account.cookie } });
  assert.equal(me.status, 200); // Preserve the signed-out dashboard bootstrap contract.
  const signedOut = await me.json();
  assert.equal(signedOut.user, null);
  assert.equal(signedOut.userAuthenticated, false);
  assert.equal(signedOut.xSession, undefined);
  assert.equal(signedOut.groq, undefined);
  assert.equal((await deleteProfile(baseUrl, account.cookie)).status, 401);
  const saved = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(account.cookie),
    body: JSON.stringify({ apiKey: 'deleted-profile-cannot-save-this-key' }),
  });
  assert.equal(saved.status, 401);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: account.body.user.username, password: account.password }),
  });
  assert.equal(login.status, 401);
}

/**
 * Stand-in for X's authenticated settings endpoint. Cookies containing
 * "expired" are rejected; other named cookie pairs simulate failed probes.
 * This keeps the health-check tests deterministic and offline.
 */
async function startXHealthFixture(t) {
  const requests = [];
  let override = null;
  const server = createHttpServer((req, res) => {
    const cookie = String(req.headers.cookie ?? '');
    requests.push({
      url: req.url, cookie, csrf: req.headers['x-csrf-token'], authorization: req.headers.authorization,
      authType: req.headers['x-twitter-auth-type'], activeUser: req.headers['x-twitter-active-user'],
    });
    if (override) {
      res.writeHead(override.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(override.body));
    }
    if (req.url?.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ message: 'Not found' }] }));
    }
    if (cookie.includes('notfound')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ message: 'Not found', ...(cookie.includes('autherror') ? { code: 89 } : {}) }] }));
    }
    if (cookie.includes('gone')) {
      res.writeHead(410, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ message: 'Gone' }] }));
    }
    if (req.url?.includes('fallback=1')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ screen_name: 'fixture' }));
    }
    if (cookie.includes('unauthorized')) {
      res.writeHead(401, { 'content-type': 'text/html' });
      return res.end('<html>Sign in</html>');
    }
    if (cookie.includes('autherror')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ code: 89, message: 'Invalid or expired token' }] }));
    }
    if (cookie.includes('forbidden')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ code: 89, message: 'Forbidden' }] }));
    }
    if (cookie.includes('ratelimited')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }));
    }
    if (cookie.includes('html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>Sign in</html>');
    }
    if (cookie.includes('malformed')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (cookie.includes('timeout')) return;
    if (cookie.includes('network')) return req.socket.destroy();
    if (cookie.includes('expired')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ code: 32, message: 'Could not authenticate you.' }] }));
    }
    if (cookie.includes('flaky')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ code: 130, message: 'Over capacity' }] }));
    }
    if (cookie.includes('browservalid') || cookie.includes('browsererror')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ message: 'API unavailable for this fixture' }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ screen_name: 'fixture' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/i/api/1.1/account/settings.json`,
    missingUrl: `${base}/missing/1.1/account/settings.json`,
    requests,
    setResponse: (response) => { override = response; },
  };
}

async function until(check, message = 'condition did not become true', timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
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

test('manual session import saves standard X cookies, activates the account, and never exposes values', async (t) => {
  const { baseUrl, dataDir, output } = await startServer(t);
  const { cookie, body } = await register(baseUrl, 'import');
  const values = importPayload('carol');
  const unauthenticated = await fetch(`${baseUrl}/api/auth/import-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  assert.equal(unauthenticated.status, 401);
  const response = await importSession(baseUrl, cookie, {
    ...values, handle: ' @CAROL ', auth_token: ` ${values.auth_token} `,
    userId: crypto.randomUUID(), domain: '.attacker.test', path: '../escape',
    storageState: xStorageState('ignored'),
  });
  const responseText = await response.text();
  const result = JSON.parse(responseText);
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.cookieCount, 2);
  assert.equal(result.username, 'carol');
  assert.equal(result.activeXAccount, 'carol');
  assert.deepEqual(accountIdentity(result.accounts), [{ xUsername: 'carol', active: true, status: 'ready' }]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const destination = join(dataDir, 'sessions', body.user.id, 'carol.json');
  const saved = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(saved.username, 'carol');
  assert.equal(saved.source, 'manual-import');
  assert.equal(saved.cookieCount, 2);
  assert.ok(Number.isFinite(Date.parse(saved.savedAt)));
  assert.deepEqual(saved.origins, []);
  assert.deepEqual(saved.cookies, [
    { name: 'auth_token', value: values.auth_token, domain: '.x.com', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'ct0', value: values.ct0, domain: '.x.com', path: '/', expires: -1, secure: true, httpOnly: false, sameSite: 'Lax' },
  ]);
  const staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.deepEqual(staged, saved);
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  const status = await fetch(`${baseUrl}/api/auth`, { headers: { cookie } });
  const statusText = await status.text();
  const statusBody = JSON.parse(statusText);
  assert.equal(statusBody.authenticated, true);
  assert.equal(statusBody.username, 'carol');
  assert.deepEqual(statusBody.xAccounts, ['carol']);
  for (const secret of [values.auth_token, values.ct0]) {
    assert.equal(responseText.includes(secret), false);
    assert.equal(statusText.includes(secret), false);
    assert.equal(output().includes(secret), false);
    assert.equal((await readFile(join(dataDir, 'user-db.json'), 'utf8')).includes(secret), false);
  }
});

test('manual imports keep identical handles isolated between users and support account switching', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const owner = await register(baseUrl, 'import_owner');
  const other = await register(baseUrl, 'import_other');
  const first = await importSession(baseUrl, owner.cookie, { ...importPayload('alice', 'owner'), userId: other.body.user.id });
  assert.equal(first.status, 201);
  const destination = join(dataDir, 'sessions', owner.body.user.id, 'alice.json');
  const firstSave = await readFile(destination, 'utf8');
  const second = await importSession(baseUrl, other.cookie, importPayload('alice', 'other'));
  assert.equal(second.status, 201);
  assert.equal(await readFile(destination, 'utf8'), firstSave);
  const otherSave = JSON.parse(await readFile(join(dataDir, 'sessions', other.body.user.id, 'alice.json'), 'utf8'));
  assert.equal(otherSave.cookies[0].value, importPayload('alice', 'other').auth_token);
  assert.notEqual(otherSave.cookies[0].value, JSON.parse(firstSave).cookies[0].value);
  const switched = await fetch(`${baseUrl}/api/auth/switch-account`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ xUsername: 'alice' }),
  });
  assert.equal(switched.status, 200);
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), firstSave);
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  for (const user of users) {
    assert.deepEqual(user.xAccounts, ['alice']);
    assert.equal(user.preferences.defaultXAccount, 'alice');
  }
});

test('manual imports enforce the account limit under concurrency and allow refreshing a linked handle', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const owner = await register(baseUrl, 'import_limit');
  const responses = await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map((handle) =>
    importSession(baseUrl, owner.cookie, importPayload(handle))));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 201, 201, 409]);
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  const user = users.find((candidate) => candidate.id === owner.body.user.id);
  assert.equal(user.xAccounts.length, 3);
  const rejected = ['alpha', 'beta', 'gamma', 'delta'].find((handle) => !user.xAccounts.includes(handle));
  await assert.rejects(stat(join(dataDir, 'sessions', user.id, `${rejected}.json`)), { code: 'ENOENT' });
  const refreshedHandle = user.xAccounts[0];
  const refreshed = await importSession(baseUrl, owner.cookie, importPayload(`@${refreshedHandle.toUpperCase()}`, 'fresh'));
  assert.equal(refreshed.status, 201);
  const result = await refreshed.json();
  assert.equal(result.accounts.length, 3);
  assert.equal(result.activeXAccount, refreshedHandle);
  const state = JSON.parse(await readFile(join(dataDir, 'sessions', user.id, `${refreshedHandle}.json`), 'utf8'));
  assert.equal(state.cookies[0].value, importPayload(refreshedHandle, 'fresh').auth_token);
});

test('manual imports reject invalid handles, cookie values, and malformed bodies without saving or leaking secrets', async (t) => {
  const { baseUrl, dataDir, output } = await startServer(t);
  const owner = await register(baseUrl, 'import_invalid');
  const values = importPayload('alice');
  for (const invalid of [
    { handle: undefined }, { handle: null }, { handle: 123 }, { handle: ['alice'] },
    { handle: '../escape' }, { handle: 'a'.repeat(16) }, { handle: '@@alice' },
    { auth_token: undefined }, { ct0: undefined }, { auth_token: null }, { ct0: 12345678 },
    { auth_token: 'short' }, { ct0: 'x'.repeat(513) }, { ct0: 'embedded whitespace' },
    { auth_token: 'auth_token=unsafe; ct0=unsafe' },
  ]) {
    const response = await importSession(baseUrl, owner.cookie, { ...values, ...invalid });
    assert.equal(response.status, 400, await response.text());
  }
  const malformed = await fetch(`${baseUrl}/api/auth/import-session`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: `{"auth_token":"${values.auth_token}",`,
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes(values.auth_token), false);
  const oversized = await importSession(baseUrl, owner.cookie, { ...values, padding: 'x'.repeat(17_000) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.text()).includes(values.auth_token), false);
  await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(dataDir, 'sessions', owner.body.user.id, 'alice.json')), { code: 'ENOENT' });
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.deepEqual(users[0].xAccounts, []);
  for (const secret of [values.auth_token, values.ct0]) assert.equal(output().includes(secret), false);
});

test('import storage errors never expose existing or newly pasted cookie values', async (t) => {
  const { baseUrl, dataDir, output } = await startServer(t);
  const owner = await register(baseUrl, 'import_storage_error');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alice', 'saved'))).status, 201);
  const destination = join(dataDir, 'sessions', owner.body.user.id, 'alice.json');
  const corrupted = 'saved_cookie_secret:invalid-json';
  await writeFile(destination, corrupted);
  const before = await readFile(join(dataDir, 'user-db.json'), 'utf8');
  const values = importPayload('alice', 'newly_pasted');
  const response = await importSession(baseUrl, owner.cookie, values);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /Check persistent storage/);
  for (const secret of ['saved_cookie', values.auth_token, values.ct0]) {
    assert.equal(text.includes(secret), false);
    assert.equal(output().includes(secret), false);
  }
  assert.equal(await readFile(destination, 'utf8'), corrupted);
  assert.equal(await readFile(join(dataDir, 'user-db.json'), 'utf8'), before);
});

test('manual imports reject logged-out and rotated app-session tokens', async (t) => {
  const { baseUrl } = await startServer(t);
  const owner = await register(baseUrl, 'import_revoked');
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: owner.cookie } });
  assert.equal(logout.status, 200);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alice'))).status, 401);
  const login = async () => fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: owner.body.user.username, password: owner.password }),
  });
  const firstLogin = await login();
  const oldCookie = sessionCookie(firstLogin);
  const rotated = await login();
  const newCookie = sessionCookie(rotated);
  assert.equal((await importSession(baseUrl, oldCookie, importPayload('alice'))).status, 401);
  assert.equal((await importSession(baseUrl, newCookie, importPayload('alice'))).status, 201);
});

test('a failed import rolls back account metadata and session files, then permits a retry', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-write-retry-'));
  const marker = join(dataDir, 'stage-write-gate');
  const { baseUrl } = await startServer(t, { SESSION_TEST_WRITE_GATE: marker }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'storage_retry');
  const previousUsers = await readFile(join(dataDir, 'user-db.json'), 'utf8');
  const previousActive = `${JSON.stringify({ ...xStorageState('previous'), username: 'previous' })}\n`;
  await writeFile(join(dataDir, 'auth.json'), previousActive);
  await writeFile(marker, 'fail');
  const failure = await importSession(baseUrl, owner.cookie, importPayload('alice'));
  assert.equal(failure.status, 500);
  assert.equal(await readFile(join(dataDir, 'user-db.json'), 'utf8'), previousUsers);
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), previousActive);
  await assert.rejects(stat(join(dataDir, 'sessions', owner.body.user.id, 'alice.json')), { code: 'ENOENT' });
  const retry = await importSession(baseUrl, owner.cookie, importPayload('alice'));
  assert.equal(retry.status, 201, await retry.text());
  const saved = JSON.parse(await readFile(join(dataDir, 'sessions', owner.body.user.id, 'alice.json'), 'utf8'));
  assert.equal(saved.cookies[0].value, importPayload('alice').auth_token);
  const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.deepEqual(users.find((user) => user.id === owner.body.user.id).xAccounts, ['alice']);
  const paths = [join(dataDir, 'user-db.json'), join(dataDir, 'auth.json'), join(dataDir, 'sessions', owner.body.user.id, 'alice.json')];
  const beforeRefresh = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  await writeFile(marker, 'fail');
  const refreshFailure = await importSession(baseUrl, owner.cookie, importPayload('alice', 'updated'));
  assert.equal(refreshFailure.status, 500);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, 'utf8'))), beforeRefresh);
});

test('disconnecting during import rolls back the prior session and staging blocks browser starts', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-write-cancel-'));
  const marker = join(dataDir, 'stage-write-gate');
  t.after(() => unlink(marker).catch(() => {}));
  const { baseUrl } = await startServer(t, { SESSION_TEST_WRITE_GATE: marker }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
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
  await writeFile(marker, 'pause');
  // Use a dedicated HTTP socket rather than fetch abort. Undici may keep its
  // pooled connection open after abort, so the server would not always observe
  // the disconnect and the rollback assertion became flaky on Windows.
  const importBody = JSON.stringify(importPayload('alice', 'updated'));
  let importRequest;
  const saving = new Promise((resolve) => {
    importRequest = httpRequest(`${baseUrl}/api/auth/import-session`, {
      method: 'POST',
      headers: { ...jsonHeaders(owner.cookie), 'content-length': Buffer.byteLength(importBody) },
      agent: false,
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ completed: true, status: response.statusCode }));
    });
    importRequest.on('error', (error) => resolve({ completed: false, error }));
    importRequest.end(importBody);
  });
  await until(() => stat(`${marker}.entered`).then(() => true, () => false), 'The import did not reach session staging');
  const browserStart = await fetch(`${baseUrl}/auth/x`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: '{}',
  });
  assert.equal(browserStart.status, 409);
  const run = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alice/status/1', dryRun: true }),
  });
  assert.equal(run.status, 409);
  importRequest.destroy();
  const saved = await saving;
  assert.equal(saved.completed, false);
  await delay(100);
  await unlink(marker);
  await until(async () => (await readFile(paths[1], 'utf8')) === previous[1] &&
    (await readFile(paths[2], 'utf8')) === previous[2], 'Cancelled import did not restore the prior session');
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, 'utf8'))), previous);
});

test('imported sessions and active-account selection survive a server restart', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-import-restart-'));
  const first = await startServer(t, {}, { dataDir });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = await register(first.baseUrl, 'import_restart');
  assert.equal((await importSession(first.baseUrl, owner.cookie, importPayload('alice'))).status, 201);
  const previous = await readFile(join(dataDir, 'auth.json'), 'utf8');
  await first.stop();
  const second = await startServer(t, {}, { dataDir });
  const me = await fetch(`${second.baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } });
  assert.equal(me.status, 200);
  const status = await fetch(`${second.baseUrl}/api/auth`, { headers: { cookie: owner.cookie } });
  const result = await status.json();
  assert.equal(result.authenticated, true);
  assert.equal(result.activeXAccount, 'alice');
  assert.deepEqual(result.xAccounts, ['alice']);
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), previous);
});

test('automation restores imported cookies and rejects imports while the bot is running', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-import-run-'));
  const marker = join(dataDir, 'automation-gate');
  const { baseUrl } = await startServer(t, { SESSION_TEST_RUN_GATE: marker }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'import_run');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alice'))).status, 201);
  const key = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'test-only-groq-key-no-external-requests' }),
  });
  assert.equal(key.status, 200);
  await writeFile(marker, 'pause');
  const running = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ url: 'https://x.com/alice/status/1', dryRun: true }),
  });
  assert.equal(running.status, 200);
  await until(() => stat(`${marker}.entered`).then(() => true, () => false), 'The runner did not receive a staged session');
  const staged = JSON.parse(await readFile(`${marker}.entered`, 'utf8'));
  assert.equal(staged.username, 'alice');
  assert.equal(staged.state.cookies[0].value, importPayload('alice').auth_token);
  assert.equal(staged.state.cookies[1].value, importPayload('alice').ct0);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('bob'))).status, 409);
  await assert.rejects(stat(join(dataDir, 'sessions', owner.body.user.id, 'bob.json')), { code: 'ENOENT' });
  await unlink(marker);
  await running.text();
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('bob'))).status, 201);
});

test('automation retries a transient network failure before failing a target', { timeout: 25_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-retry-run-'));
  const runGate = join(dataDir, 'automation-gate');
  const retryState = join(dataDir, 'retry-state');
  const { baseUrl } = await startServer(t, {
    SESSION_TEST_RUN_GATE: runGate,
    SESSION_TEST_RETRY_STATE: retryState,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'retry_run');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alice'))).status, 201);
  const key = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'test-only-groq-key-no-external-requests' }),
  });
  assert.equal(key.status, 200);

  await writeFile(runGate, 'pause');
  const running = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ url: 'https://x.com/alice/status/1', dryRun: true }),
  });
  assert.equal(running.status, 200);

  await until(
    () => readFile(retryState, 'utf8').then((value) => value === '2', () => false),
    'The runner did not retry the transient network failure',
    10_000,
  );
  await until(
    () => stat(`${runGate}.entered`).then(() => true, () => false),
    'The retried run did not reach the automation process',
  );
  await unlink(runGate);
  const output = await running.text();
  assert.match(output, /"type":"batch-complete"/);
  assert.doesNotMatch(output, /"type":"failed"/);

  const history = await (await fetch(`${baseUrl}/api/history`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].ok, true);
  assert.equal(history.history[0].url, 'https://x.com/alice/status/1');
});

test('unconfirmed replies stop after three attempts and the queue continues to the next URL', { timeout: 90_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-reply-retry-'));
  const attemptsFile = join(dataDir, 'reply-attempts');
  const targetUrl = 'https://x.com/alice/status/1';
  const nextUrl = 'https://x.com/alice/status/2';
  const server = await startServer(t, {
    SESSION_TEST_RUN_GATE: join(dataDir, 'unused-run-gate'),
    SESSION_TEST_UNCONFIRMED_REPLY_STATE: attemptsFile,
    SESSION_TEST_UNCONFIRMED_REPLY_URL: targetUrl,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(server.baseUrl, 'reply_retry');
  assert.equal((await importSession(server.baseUrl, owner.cookie, importPayload('alice'))).status, 201);
  const key = await fetch(`${server.baseUrl}/api/config/groq`, {
    method: 'PUT',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ apiKey: 'test-only-groq-key-no-external-requests' }),
  });
  assert.equal(key.status, 200);

  const running = await fetch(`${server.baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ urls: [targetUrl, nextUrl], reply: true }),
  });
  assert.equal(running.status, 200);
  const output = await running.text();
  assert.equal(await readFile(attemptsFile, 'utf8'), '3');

  const events = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const starts = events.filter((event) => event.type === 'start');
  assert.equal(starts.filter((event) => event.url === targetUrl).length, 3);
  assert.equal(starts.filter((event) => event.url === nextUrl).length, 1);
  const failures = events.filter((event) => event.type === 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].attempts, 3);

  const items = events.filter((event) => event.type === 'item-complete');
  const item = items[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.url, targetUrl);
  assert.equal(item.failed, 1);
  assert.equal(item.succeeded, 0);
  assert.match(item.error, /Reply verification failed: Post was not confirmed on X/);
  assert.equal(items[1].url, nextUrl);
  assert.equal(items[1].status, 'succeeded');
  const nextProgress = events.find((event) => event.type === 'progress' && event.url === nextUrl);
  assert.equal(nextProgress.failed, 1);

  const batch = events.find((event) => event.type === 'batch-complete');
  assert.equal(batch.total, 2);
  assert.equal(batch.completed, 2);
  assert.equal(batch.succeeded, 1);
  assert.equal(batch.failed, 1);

  assert.match(
    server.output(),
    /\[QUEUE\] Hard failure for URL, skipping to next target/,
  );

  const history = await (await fetch(`${server.baseUrl}/api/history`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(history.history.length, 2);
  assert.equal(history.history[0].url, targetUrl);
  assert.equal(history.history[0].ok, false);
  assert.equal(history.history[0].error, 'Reply verification failed: Post was not confirmed on X');
  assert.deepEqual(history.history[0].actions, []);
  assert.equal(history.history[1].url, nextUrl);
  assert.equal(history.history[1].ok, true);
});

test('runner startup reserves its session before staging and blocks conflicting account changes', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-startup-reservation-'));
  const writeMarker = join(dataDir, 'write-gate');
  const runMarker = join(dataDir, 'run-gate');
  const { baseUrl } = await startServer(t, {
    SESSION_TEST_WRITE_GATE: writeMarker, SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'startup_owner');
  const other = await register(baseUrl, 'startup_other');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alice'))).status, 201);
  assert.equal((await importSession(baseUrl, other.cookie, importPayload('bob'))).status, 201);
  const key = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-for-runner-fixture' }),
  });
  assert.equal(key.status, 200);
  const runBody = JSON.stringify({ url: 'https://x.com/alice/status/1', dryRun: true });
  await writeFile(writeMarker, 'pause');
  await writeFile(runMarker, 'pause');
  const starting = fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: runBody,
  });
  await until(() => stat(`${writeMarker}.entered`).then(() => true, () => false), 'Runner did not reach session staging');
  const unchanged = await readFile(join(dataDir, 'auth.json'), 'utf8');
  assert.equal(JSON.parse(unchanged).username, 'bob');
  assert.equal((await importSession(baseUrl, other.cookie, importPayload('bob', 'replacement'))).status, 409);
  const overlap = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(other.cookie), body: runBody,
  });
  assert.equal(overlap.status, 409);
  const signIn = await fetch(`${baseUrl}/auth/x`, {
    method: 'POST', headers: jsonHeaders(other.cookie), body: '{}',
  });
  assert.equal(signIn.status, 409);
  const linked = await fetch(`${baseUrl}/api/auth/x-accounts`, {
    method: 'POST', headers: jsonHeaders(other.cookie), body: JSON.stringify({ xUsername: 'bob', storageState: xStorageState('bob') }),
  });
  assert.equal(linked.status, 409);
  const rotated = await fetch(`${baseUrl}/api/auth`, {
    method: 'PUT', headers: jsonHeaders(other.cookie), body: JSON.stringify({ auth_token: 'replacement_auth_token' }),
  });
  assert.equal(rotated.status, 409);
  const switching = await fetch(`${baseUrl}/api/auth/switch-account`, {
    method: 'POST', headers: jsonHeaders(other.cookie), body: JSON.stringify({ xUsername: 'bob' }),
  });
  assert.equal(switching.status, 409);
  const anonymousLogout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
  assert.equal(anonymousLogout.status, 409);
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), unchanged);
  await unlink(writeMarker);
  const running = await starting;
  assert.equal(running.status, 200);
  await until(() => stat(`${runMarker}.entered`).then(() => true, () => false), 'Runner did not receive the reserved session');
  const staged = JSON.parse(await readFile(`${runMarker}.entered`, 'utf8'));
  assert.equal(staged.username, 'alice');
  assert.equal(staged.state.cookies[0].value, importPayload('alice').auth_token);
  const switched = await fetch(`${baseUrl}/api/auth/switch-account`, {
    method: 'POST', headers: jsonHeaders(other.cookie), body: JSON.stringify({ xUsername: 'bob' }),
  });
  assert.equal(switched.status, 409);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8')).username, 'alice');
  await unlink(runMarker);
  await running.text();
  const afterRun = await fetch(`${baseUrl}/api/auth/switch-account`, {
    method: 'POST', headers: jsonHeaders(other.cookie), body: JSON.stringify({ xUsername: 'bob' }),
  });
  assert.equal(afterRun.status, 200);
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

test('local profile deletion purges all settings, X sessions, orphan files and history without deleting another user', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const owner = await register(baseUrl, 'delete_local');
  const other = await register(baseUrl, 'delete_local_other');
  const apiKey = `gsk_${'d'.repeat(48)}`;
  await saveGroqKey(baseUrl, owner.cookie, apiKey);
  await saveGroqKey(baseUrl, other.cookie, 'other-user-groq-key-must-survive');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha'))).status, 201);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('beta'))).status, 201);
  assert.equal((await importSession(baseUrl, other.cookie, importPayload('alpha', 'other_alpha'))).status, 201);
  const linked = await fetch(`${baseUrl}/api/auth/x-accounts`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ xUsername: 'gamma', storageState: xStorageState('gamma') }),
  });
  assert.equal(linked.status, 201);
  const ownerDirectory = join(dataDir, 'sessions', owner.body.user.id);
  const otherFile = join(dataDir, 'sessions', other.body.user.id, 'alpha.json');
  const otherSessionBefore = await readFile(otherFile, 'utf8');
  await mkdir(join(ownerDirectory, 'old-browser'), { recursive: true });
  await writeFile(join(ownerDirectory, 'orphan.json'), JSON.stringify(xStorageState('orphan')));
  await writeFile(join(ownerDirectory, 'broken.json'), 'malformed orphan cookie state');
  await writeFile(join(ownerDirectory, 'old-browser', 'auth.json'), JSON.stringify(xStorageState('orphan')));
  const otherHistory = { userId: other.body.user.id, url: 'https://x.com/alpha/status/2' };
  await writeFile(join(dataDir, 'history.json'), JSON.stringify([
    { userId: owner.body.user.id, url: 'https://x.com/beta/status/1' }, otherHistory,
  ]));
  const usersBefore = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  const ownerRecord = usersBefore.find((user) => user.id === owner.body.user.id);
  ownerRecord.settings = { groq_api_key: apiKey, theme: 'dark', tone: 'direct' };
  await writeFile(join(dataDir, 'user-db.json'), JSON.stringify(usersBefore));
  const otherRecordBefore = usersBefore.find((user) => user.id === other.body.user.id);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } });
  assert.equal(me.status, 200);
  const stagedBefore = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(stagedBefore.appUserId, owner.body.user.id);

  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { method: 'DELETE' })).status, 401);
  assert.equal((await deleteProfile(baseUrl, 'x_engine_session=expired-token')).status, 401);
  assert.equal(await readFile(otherFile, 'utf8'), otherSessionBefore);
  // IDs in a request body must never select somebody else's profile.
  const deleted = await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ userId: other.body.user.id }),
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(await deleted.json(), { success: true, message: PROFILE_DELETION_MESSAGE });
  const clearedCookie = deleted.headers.get('set-cookie');
  assert.match(clearedCookie, /^x_engine_session=;/);
  assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970/i);
  assert.match(clearedCookie, /HttpOnly/i);
  assert.match(clearedCookie, /SameSite=Strict/i);
  await assert.rejects(stat(ownerDirectory), { code: 'ENOENT' });
  await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
  const usersAfter = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
  assert.deepEqual(usersAfter, [otherRecordBefore]);
  assert.equal(JSON.stringify(usersAfter).includes(apiKey), false);
  assert.equal(await readFile(otherFile, 'utf8'), otherSessionBefore);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'history.json'), 'utf8')), [otherHistory]);
  await assertDeletedProfileCannotAuthenticate(baseUrl, owner);

  const surviving = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: other.cookie } });
  assert.equal(surviving.status, 200);
  const survivingBody = await surviving.json();
  assert.equal(survivingBody.groq.configured, true);
  assert.equal(survivingBody.xSession.auth_token, importPayload('alpha', 'other_alpha').auth_token);
  const replacement = await register(baseUrl, 'delete_local');
  assert.notEqual(replacement.body.user.id, owner.body.user.id);
  assert.deepEqual(replacement.body.user.xAccounts, []);
  assert.equal(replacement.body.user.groq.configured, false);
});

test('PostgreSQL profile deletion leaves no orphan rows or legacy disk copies and permits a clean registration', async (t) => {
  const { baseUrl, dataDir, child } = await startServer(t, { DATABASE_URL: 'pg-mem://' }, {
    ipc: true, nodeArgs: ['--import', new URL('./fixtures/profile-deletion-database.js', import.meta.url).href],
  });
  const owner = await register(baseUrl, 'delete_pg');
  const other = await register(baseUrl, 'delete_pg_other');
  const apiKey = `gsk_${'p'.repeat(48)}`;
  await saveGroqKey(baseUrl, owner.cookie, apiKey);
  await saveGroqKey(baseUrl, other.cookie, 'other-pg-groq-key-must-survive');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha'))).status, 201);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('beta'))).status, 201);
  assert.equal((await importSession(baseUrl, other.cookie, importPayload('alpha', 'other_pg'))).status, 201);
  assert.deepEqual(await profileDatabaseCommand(child, 'orphan', owner.body.user.id), { rowCount: 1 });
  const before = await profileDatabaseCommand(child, 'snapshot');
  assert.equal(before.users.find((user) => user.id === owner.body.user.id).groq_api_key, apiKey);
  assert.equal(before.sessions.filter((session) => session.user_id === owner.body.user.id).length, 3);

  const legacyOwnerId = crypto.randomUUID();
  const legacyOtherId = crypto.randomUUID();
  const legacyOther = {
    id: legacyOtherId, username: 'unrelated_legacy_user', email: 'unrelated@example.test',
    groqApiKey: 'unrelated-legacy-key-must-survive', xAccounts: ['alpha'],
  };
  await writeFile(join(dataDir, 'user-db.json'), JSON.stringify([
    { id: legacyOwnerId, username: owner.body.user.username, email: owner.body.user.email, groqApiKey: apiKey },
    legacyOther,
  ]));
  for (const id of [String(owner.body.user.id), legacyOwnerId, legacyOtherId]) {
    await mkdir(join(dataDir, 'sessions', id, 'browser'), { recursive: true });
    await writeFile(join(dataDir, 'sessions', id, '_trusted-login-profile.json'), JSON.stringify(xStorageState('alpha')));
    await writeFile(join(dataDir, 'sessions', id, 'browser', 'auth.json'), JSON.stringify(xStorageState('alpha')));
  }
  const remainingHistory = [
    { userId: other.body.user.id, url: 'https://x.com/alpha/status/2' },
    { userId: legacyOtherId, url: 'https://x.com/alpha/status/3' },
  ];
  await writeFile(join(dataDir, 'history.json'), JSON.stringify([
    { userId: owner.body.user.id, url: 'https://x.com/beta/status/1' },
    { userId: legacyOwnerId, url: 'https://x.com/alpha/status/4' }, ...remainingHistory,
  ]));
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).status, 200);
  // Exercise cleanup of auth.json files created before ownership metadata existed.
  const staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  delete staged.appUserId;
  await writeFile(join(dataDir, 'auth.json'), JSON.stringify(staged));

  const deleted = await deleteProfile(baseUrl, owner.cookie);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(await deleted.json(), { success: true, message: PROFILE_DELETION_MESSAGE });
  const after = await profileDatabaseCommand(child, 'snapshot');
  assert.deepEqual(after.users, before.users.filter((user) => user.id === other.body.user.id));
  assert.deepEqual(after.sessions, before.sessions.filter((session) => session.user_id === other.body.user.id));
  assert.equal(JSON.stringify(after).includes(apiKey), false);
  for (const id of [String(owner.body.user.id), legacyOwnerId]) {
    await assert.rejects(stat(join(dataDir, 'sessions', id)), { code: 'ENOENT' });
  }
  await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
  assert.equal((await stat(join(dataDir, 'sessions', legacyOtherId, 'browser', 'auth.json'))).isFile(), true);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8')), [legacyOther]);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'history.json'), 'utf8')), remainingHistory);
  await assertDeletedProfileCannotAuthenticate(baseUrl, owner);
  await assert.rejects(profileDatabaseCommand(child, 'orphan', owner.body.user.id), /foreign key constraint/i);

  const replacement = await register(baseUrl, 'delete_pg');
  assert.notEqual(replacement.body.user.id, owner.body.user.id);
  assert.deepEqual(replacement.body.user.xAccounts, []);
  assert.equal(replacement.body.user.groq.configured, false);
  const settings = await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: replacement.cookie } });
  assert.deepEqual(await settings.json(), { configured: false, source: 'none', preview: null });
  const final = await profileDatabaseCommand(child, 'snapshot');
  assert.equal(final.users.length, 2);
  assert.deepEqual(final.sessions, after.sessions);
  const cleanUser = final.users.find((user) => user.id === replacement.body.user.id);
  assert.equal(cleanUser.groq_api_key, null);
  assert.equal(cleanUser.default_handle, null);
  assert.equal(cleanUser.linked_handles, '');
});

for (const tagged of [true, false]) {
  test(`profile deletion removes ${tagged ? 'owned staged cookies with no linked accounts' : 'legacy staged cookies from nested orphan files'}`, async (t) => {
    const { baseUrl, dataDir } = await startServer(t);
    const owner = await register(baseUrl, 'delete_orphans');
    const other = await register(baseUrl, 'delete_orphans_other');
    await saveGroqKey(baseUrl, owner.cookie);
    const directory = join(dataDir, 'sessions', owner.body.user.id);
    await mkdir(join(directory, 'orphan-browser'), { recursive: true });
    await writeFile(join(directory, 'broken.json'), 'malformed orphan session file');
    const orphan = xStorageState('orphan');
    if (!tagged) await writeFile(join(directory, 'orphan-browser', 'auth.json'), JSON.stringify(orphan));
    await writeFile(join(dataDir, 'auth.json'), JSON.stringify(tagged ? { ...orphan, appUserId: owner.body.user.id } : orphan));
    await writeFile(join(dataDir, 'history.json'), JSON.stringify([{ userId: owner.body.user.id, url: 'https://x.com/orphan/status/1' }]));
    const deleted = await deleteProfile(baseUrl, owner.cookie);
    assert.equal(deleted.status, 200, await deleted.text());
    for (const path of [directory, join(dataDir, 'auth.json'), join(dataDir, 'history.json')]) {
      await assert.rejects(stat(path), { code: 'ENOENT' });
    }
    const users = JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8'));
    assert.deepEqual(users.map((user) => user.id), [other.body.user.id]);
    assert.equal((await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: owner.cookie } })).status, 401);
  });
}

for (const conflictingStorage of ['local', 'PostgreSQL']) {
  test(`PostgreSQL profile deletion refuses ambiguous legacy IDs instead of deleting another ${conflictingStorage} user`, async (t) => {
    const { baseUrl, dataDir, child } = await startServer(t, { DATABASE_URL: 'pg-mem://' }, {
      ipc: true, nodeArgs: ['--import', new URL('./fixtures/profile-deletion-database.js', import.meta.url).href],
    });
    const owner = await register(baseUrl, 'delete_conflict');
    const other = conflictingStorage === 'PostgreSQL' ? await register(baseUrl, 'delete_conflict_other') : null;
    await saveGroqKey(baseUrl, owner.cookie);
    assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha'))).status, 201);
    if (other) assert.equal((await importSession(baseUrl, other.cookie, importPayload('alpha', 'other_conflict'))).status, 201);
    const legacyUserFile = JSON.stringify([{
      id: other?.body.user.id ?? owner.body.user.id,
      username: other ? owner.body.user.username : 'different_legacy_user',
      email: other ? owner.body.user.email : 'different@example.test',
      groqApiKey: 'legacy-key-must-survive-ambiguous-ownership',
    }]);
    const directory = join(dataDir, 'sessions', String(other?.body.user.id ?? owner.body.user.id));
    await mkdir(directory, { recursive: true });
    const legacyCookies = JSON.stringify(xStorageState('legacy_other'));
    await writeFile(join(directory, 'alpha.json'), legacyCookies);
    await writeFile(join(dataDir, 'user-db.json'), legacyUserFile);
    const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
    const databaseBefore = await profileDatabaseCommand(child, 'snapshot');
    const deleted = await deleteProfile(baseUrl, owner.cookie);
    assert.equal(deleted.status, 503);
    assert.match((await deleted.json()).error, /ownership conflicts/);
    assert.equal(deleted.headers.get('set-cookie'), null);
    assert.equal(await readFile(join(directory, 'alpha.json'), 'utf8'), legacyCookies);
    assert.equal(await readFile(join(dataDir, 'user-db.json'), 'utf8'), legacyUserFile);
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);
    assert.deepEqual(await profileDatabaseCommand(child, 'snapshot'), databaseBefore);
    const settings = await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: owner.cookie } });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).configured, true);
  });
}

for (const [storage, databaseUrl] of [['local', ''], ['PostgreSQL', 'pg-mem://']]) {
  test(`${storage} profile deletion preserves another user's running bot and staged credentials`, { timeout: 20_000 }, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-delete-other-run-'));
    const gate = join(dataDir, 'automation-gate');
    const { baseUrl } = await startServer(t, { DATABASE_URL: databaseUrl, SESSION_TEST_RUN_GATE: gate }, {
      dataDir, cleanupData: true,
      nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
    });
    const owner = await register(baseUrl, 'delete_other_run');
    const other = await register(baseUrl, 'delete_running_user');
    assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha', 'owner'))).status, 201);
    assert.equal((await importSession(baseUrl, other.cookie, importPayload('alpha', 'other'))).status, 201);
    await saveGroqKey(baseUrl, other.cookie);
    const otherHistory = { userId: other.body.user.id, url: 'https://x.com/alpha/status/2' };
    await writeFile(join(dataDir, 'history.json'), JSON.stringify([
      { userId: owner.body.user.id, url: 'https://x.com/alpha/status/1' }, otherHistory,
    ]));
    await writeFile(gate, 'pause');
    const running = await fetch(`${baseUrl}/api/run`, {
      method: 'POST', headers: jsonHeaders(other.cookie),
      body: JSON.stringify({ url: 'https://x.com/alpha/status/3', dryRun: true }),
    });
    assert.equal(running.status, 200);
    await until(() => stat(`${gate}.entered`).then(() => true, () => false), 'Other user bot never started');
    const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
    assert.equal(JSON.parse(stagedBefore).appUserId, other.body.user.id);
    const deleted = await deleteProfile(baseUrl, owner.cookie);
    assert.equal(deleted.status, 200, await deleted.text());
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'history.json'), 'utf8')), [otherHistory]);
    const otherSettings = await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: other.cookie } });
    assert.equal(otherSettings.status, 200);
    assert.equal((await otherSettings.json()).configured, true);
    assert.equal((await importSession(baseUrl, other.cookie, importPayload('beta'))).status, 409);
    await unlink(gate);
    await running.text();
    assert.equal((await importSession(baseUrl, other.cookie, importPayload('beta'))).status, 201);
    assert.equal((await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: owner.cookie } })).status, 401);
  });

  test(`${storage} profile deletion stops its own bot before clearing keys, files and final history`, { timeout: 20_000 }, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-delete-own-run-'));
    const gate = join(dataDir, 'automation-gate');
    const { baseUrl } = await startServer(t, { DATABASE_URL: databaseUrl, SESSION_TEST_RUN_GATE: gate }, {
      dataDir, cleanupData: true,
      nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
    });
    const owner = await register(baseUrl, 'delete_own_run');
    const other = await register(baseUrl, 'delete_own_run_other');
    assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha'))).status, 201);
    assert.equal((await importSession(baseUrl, other.cookie, importPayload('beta'))).status, 201);
    await saveGroqKey(baseUrl, owner.cookie);
    const otherHistory = { userId: other.body.user.id, url: 'https://x.com/beta/status/2' };
    await writeFile(join(dataDir, 'history.json'), JSON.stringify([otherHistory]));
    await writeFile(gate, 'pause');
    const running = await fetch(`${baseUrl}/api/run`, {
      method: 'POST', headers: jsonHeaders(owner.cookie),
      body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
    });
    assert.equal(running.status, 200);
    await until(() => stat(`${gate}.entered`).then(() => true, () => false), 'Profile owner bot never started');
    const stream = running.text();
    const deleted = await deleteProfile(baseUrl, owner.cookie);
    assert.equal(deleted.status, 200, await deleted.text());
    await stream;
    assert.equal((await stat(gate)).isFile(), true, 'The paused runner must be stopped, not released');
    await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(dataDir, 'sessions', String(owner.body.user.id))), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'history.json'), 'utf8')), [otherHistory]);
    assert.equal((await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: owner.cookie } })).status, 401);
    assert.equal((await importSession(baseUrl, other.cookie, importPayload('gamma'))).status, 201);
  });

  test(`${storage} profile deletion is retryable after partial disk cleanup and never falsely reports success`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-delete-storage-failure-'));
    const marker = join(dataDir, 'profile-write-failure');
    const { baseUrl } = await startServer(t, { DATABASE_URL: databaseUrl, SESSION_TEST_USER_WRITE_GATE: marker }, {
      dataDir, cleanupData: true,
      nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
    });
    const owner = await register(baseUrl, 'delete_retry');
    await saveGroqKey(baseUrl, owner.cookie);
    assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha'))).status, 201);
    if (databaseUrl) {
      await writeFile(join(dataDir, 'user-db.json'), JSON.stringify([{
        id: crypto.randomUUID(), username: owner.body.user.username, email: owner.body.user.email,
        groqApiKey: 'test-only-groq-key-no-external-requests',
      }]));
    }
    const originalUserFile = await readFile(join(dataDir, 'user-db.json'), 'utf8');
    await writeFile(marker, 'fail');
    const failed = await deleteProfile(baseUrl, owner.cookie);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('set-cookie'), null);
    const failure = await failed.json();
    assert.equal(failure.success, undefined);
    assert.match(failure.error, /Retry to complete the cleanup/);
    assert.equal(failure.error.includes('Simulated'), false);
    assert.equal(await readFile(join(dataDir, 'user-db.json'), 'utf8'), originalUserFile);
    const settings = await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: owner.cookie } });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).configured, true);
    await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
    const retried = await deleteProfile(baseUrl, owner.cookie);
    assert.equal(retried.status, 200, await retried.clone().text());
    assert.deepEqual(await retried.json(), { success: true, message: PROFILE_DELETION_MESSAGE });
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8')), []);
    await assertDeletedProfileCannotAuthenticate(baseUrl, owner);
  });
}

test('profile deletion defers ambiguous legacy staging cleanup until another user’s run finishes', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-delete-legacy-run-'));
  const gate = join(dataDir, 'automation-gate');
  const { baseUrl } = await startServer(t, { SESSION_TEST_RUN_GATE: gate }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'delete_legacy_run');
  const other = await register(baseUrl, 'delete_legacy_other');
  const sharedCookies = importPayload('alpha', 'shared');
  assert.equal((await importSession(baseUrl, owner.cookie, sharedCookies)).status, 201);
  assert.equal((await importSession(baseUrl, other.cookie, sharedCookies)).status, 201);
  await saveGroqKey(baseUrl, other.cookie);
  await writeFile(gate, 'pause');
  const running = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(other.cookie),
    body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
  });
  assert.equal(running.status, 200);
  await until(() => stat(`${gate}.entered`).then(() => true, () => false), 'Legacy runner did not start');
  const staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  delete staged.appUserId;
  const legacyStaging = JSON.stringify(staged);
  await writeFile(join(dataDir, 'auth.json'), legacyStaging);
  const deferred = await deleteProfile(baseUrl, owner.cookie);
  assert.equal(deferred.status, 409);
  assert.match((await deferred.json()).error, /Retry deleting this profile after it finishes/);
  assert.equal(deferred.headers.get('set-cookie'), null);
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), legacyStaging);
  assert.equal((await stat(join(dataDir, 'sessions', owner.body.user.id, 'alpha.json'))).isFile(), true);
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: owner.cookie } })).status, 200);
  await unlink(gate);
  await running.text();
  const deleted = await deleteProfile(baseUrl, owner.cookie);
  assert.equal(deleted.status, 200, await deleted.text());
  await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
  const surviving = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: other.cookie } });
  assert.equal(surviving.status, 200);
  assert.equal((await surviving.json()).xSession.auth_token, sharedCookies.auth_token);
});

test('profile deletion prevents a pending cookie verification from recreating deleted user sessions', { timeout: 15_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-delete-pending-import-'));
  const gate = join(dataDir, 'health-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, SESSION_TEST_HEALTH_BROWSER_GATE: gate,
  }, { dataDir, cleanupData: true });
  const owner = await register(baseUrl, 'delete_pending_import');
  await writeFile(gate, 'pause');
  const pendingImport = importSession(baseUrl, owner.cookie, importPayload('alpha', 'browservalid_pending'));
  await until(() => stat(`${gate}.entered`).then(() => true, () => false), 'Import did not reach browser verification');
  const deleted = await deleteProfile(baseUrl, owner.cookie);
  assert.equal(deleted.status, 200, await deleted.text());
  await unlink(gate);
  const imported = await pendingImport;
  assert.equal(imported.status, 401);
  await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(dataDir, 'sessions', owner.body.user.id)), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8')), []);
});

test('profile deletion blocks login and mutations while stopping an in-flight browser verification', { timeout: 20_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-delete-pending-run-'));
  const gate = join(dataDir, 'health-gate');
  const runMarker = join(dataDir, 'unused-run-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url,
    SESSION_TEST_HEALTH_BROWSER_GATE: gate, SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'delete_pending_run');
  await saveGroqKey(baseUrl, owner.cookie);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha', 'browservalid_run'))).status, 201);
  await writeFile(gate, 'pause');
  const starting = fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
  });
  await until(() => stat(`${gate}.entered`).then(() => true, () => false), 'Run did not reach browser verification');
  const deleting = deleteProfile(baseUrl, owner.cookie);
  await until(async () => (await fetch(`${baseUrl}/api/config/groq`, { headers: { cookie: owner.cookie } })).status === 409,
    'The profile must be reserved while its browser stops');
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: owner.body.user.username, password: owner.password }),
  });
  assert.equal(login.status, 409);
  assert.equal((await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: owner.cookie } })).status, 409);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('beta'))).status, 409);
  const saved = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'cannot-replace-key-during-deletion' }),
  });
  assert.equal(saved.status, 409);
  await unlink(gate);
  assert.equal((await starting).status, 409);
  const deleted = await deleting;
  assert.equal(deleted.status, 200, await deleted.text());
  await assert.rejects(stat(`${runMarker}.entered`), { code: 'ENOENT' });
  await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
  await assertDeletedProfileCannotAuthenticate(baseUrl, owner);
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
  const { baseUrl } = await startServer(t, {
    NODE_ENV: 'production',
    DATABASE_URL: 'pg-mem://',
    HARVEST_API_TOKEN: '',
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
  const imported = await importSession(baseUrl, sessionCookie(response), importPayload('production_x'));
  assert.equal(imported.status, 201);
  const deleted = await deleteProfile(baseUrl, sessionCookie(response));
  assert.equal(deleted.status, 200);
  const clearedCookie = deleted.headers.get('set-cookie');
  assert.match(clearedCookie, /^x_engine_session=;/);
  assert.match(clearedCookie, /HttpOnly/i);
  assert.match(clearedCookie, /SameSite=Strict/i);
  assert.match(clearedCookie, /Secure/i);
});
test('PostgreSQL stores users and X sessions and restores them after login', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, { DATABASE_URL: 'pg-mem://' });
  const { cookie, password } = await register(baseUrl, 'pg');

  const imported = await importSession(baseUrl, cookie, importPayload('alpha'));
  assert.equal(imported.status, 201, await imported.text());

  const status = await fetch(`${baseUrl}/api/auth`, { headers: { cookie } });
  const statusBody = await status.json();
  assert.equal(statusBody.authenticated, true);
  assert.equal(statusBody.activeXAccount, 'alpha');
  assert.deepEqual(statusBody.xAccounts, ['alpha']);

  await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'user_pg', password }),
  });
  assert.equal(login.status, 200);
  const loginCookie = sessionCookie(login);
  const loginBody = await login.json();
  assert.equal(loginBody.activeXAccount, 'alpha');
  assert.deepEqual(accountIdentity(loginBody.accounts), [{ xUsername: 'alpha', active: true, status: 'ready' }]);

  const accounts = await fetch(`${baseUrl}/api/auth/x-accounts`, { headers: { cookie: loginCookie } });
  assert.deepEqual(accountIdentity(await accounts.json()), [{ xUsername: 'alpha', active: true, status: 'ready' }]);

  // Login restores the database session on this device.
  let staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(staged.username, 'alpha');
  assert.equal(staged.cookies.find((cookie) => cookie.name === 'auth_token').value, 'alpha_auth_token_value');

  // A new device may have no local staging file yet; /api/auth/me must restore
  // both auth.json and the credentials from the persisted session.
  await unlink(join(dataDir, 'auth.json'));
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: loginCookie } });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.authenticated, true);
  assert.equal(meBody.userAuthenticated, true);
  assert.equal(meBody.activeXAccount, 'alpha');
  assert.equal(meBody.xSession.handle, 'alpha');
  assert.equal(meBody.xSession.auth_token, 'alpha_auth_token_value');
  assert.equal(meBody.xSession.ct0, 'alpha_csrf_token_value');
  assert.equal(meBody.xSession.staged, true);
  assert.deepEqual(accountIdentity(meBody.accounts), [{ xUsername: 'alpha', active: true, status: 'ready' }]);

  staged = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(staged.username, 'alpha');
  assert.equal(staged.cookies.find((cookie) => cookie.name === 'ct0').value, 'alpha_csrf_token_value');

  // An expired app cookie behaves like a signed-out session instead of
  // interrupting dashboard bootstrap with a 401.
  const stale = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: 'x_engine_session=expired-session-token' },
  });
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), {
    authenticated: false,
    userAuthenticated: false,
    user: null,
    activeXAccount: null,
    xAccounts: [],
    accounts: [],
    xSessionValid: null,
    xSessionStatus: 'none',
    xSessionCheckedAt: null,
  });

  await assert.rejects(stat(join(dataDir, 'user-db.json')), { code: 'ENOENT' });
});

test('X session health rejects expired cookies, blocks live runs, and re-authenticates', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0',
    X_SESSION_CHECK_URL: x.url,
    X_SESSION_CHECK_TIMEOUT_MS: '2000',
    X_SESSION_CHECK_CACHE_MS: '0',
  });
  const owner = await register(baseUrl, 'health');
  const good = { handle: 'alpha', auth_token: 'good_auth_token_value', ct0: 'good_ct0_value' };
  const expired = { handle: 'alpha', auth_token: 'expired_auth_token_value', ct0: 'expired_ct0_value' };

  const imported = await importSession(baseUrl, owner.cookie, good);
  const importedText = await imported.text();
  assert.equal(imported.status, 201, importedText);
  const importedBody = JSON.parse(importedText);
  assert.equal(importedBody.xSessionValid, true);
  assert.equal(importedBody.xSessionStatus, 'valid');
  assert.ok(importedBody.xSessionCheckedAt);

  // The probe carries the cookies, CSRF header, and X web bearer.
  const probe = x.requests.at(-1);
  assert.match(probe.cookie, /auth_token=good_auth_token_value/);
  assert.match(probe.cookie, /ct0=good_ct0_value/);
  assert.equal(probe.csrf, 'good_ct0_value');
  assert.match(probe.authorization, /^Bearer /);
  assert.equal(probe.authType, 'OAuth2Session');
  assert.equal(probe.activeUser, 'yes');

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.xSessionValid, true);
  assert.equal(meBody.xSessionStatus, 'valid');

  const key = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ apiKey: 'test-only-groq-key-no-external-requests' }),
  });
  assert.equal(key.status, 200);

  // Rejected cookies never replace the working saved session.
  const rejected = await importSession(baseUrl, owner.cookie, expired);
  assert.equal(rejected.status, 422);
  assert.match((await rejected.json()).error, /rejected these cookies/);
  const stillGood = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(stillGood.xSession.auth_token, 'good_auth_token_value');
  assert.equal(stillGood.xSessionValid, true);

  // Rotate the saved session to rejected cookies and confirm a live run is blocked.
  const rotated = await fetch(`${baseUrl}/api/auth`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ auth_token: expired.auth_token, ct0: expired.ct0 }),
  });
  assert.equal(rotated.status, 200);
  const blocked = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ url: 'https://x.com/alpha/status/1' }),
  });
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.code, 'X_SESSION_EXPIRED');
  assert.equal(blockedBody.xSessionValid, false);
  assert.match(blockedBody.error, /Re-authenticate/);

  // Re-authentication with fresh cookies restores the verified badge.
  const restored = await importSession(baseUrl, owner.cookie, good);
  const restoredText = await restored.text();
  assert.equal(restored.status, 201, restoredText);
  const restoredBody = JSON.parse(restoredText);
  assert.equal(restoredBody.xSessionValid, true);
  assert.equal(restoredBody.xSessionStatus, 'valid');

  // Failed verification must not silently permit imports or live publishing.
  const flaky = await importSession(baseUrl, owner.cookie, {
    handle: 'beta', auth_token: 'flaky_auth_token_value', ct0: 'flaky_ct0_value',
  });
  const flakyText = await flaky.text();
  assert.equal(flaky.status, 503, flakyText);
  assert.equal(JSON.parse(flakyText).code, 'X_SESSION_CHECK_UNAVAILABLE');
  assert.equal(JSON.parse(flakyText).xSessionValid, null);
  assert.equal(JSON.parse(flakyText).xSessionStatus, 'unknown');
  const preserved = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(preserved.xSession.auth_token, good.auth_token);
  assert.equal(preserved.xSessionValid, true);
});

test('X health check confirms HTTP 401 with the browser rather than another HTTP endpoint', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0',
    X_SESSION_CHECK_URL: `${x.url},${x.url}?fallback=1`,
    X_SESSION_CHECK_CACHE_MS: '0',
  });
  const owner = await register(baseUrl, 'health_unauthorized');
  for (const prefix of ['unauthorized', 'expired']) {
    const requestCount = x.requests.length;
    const rejected = await importSession(baseUrl, owner.cookie, importPayload('alpha', prefix));
    assert.equal(rejected.status, 422, await rejected.text());
    assert.equal(x.requests.length, requestCount + 1, 'HTTP 401 must go to the browser rather than another HTTP endpoint');
    assert.equal(x.requests.at(-1).url, '/i/api/1.1/account/settings.json');
  }
});

test('X health check retries non-401 error responses on the authenticated fallback endpoint', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0',
    X_SESSION_CHECK_URL: `${x.url},${x.url}?fallback=1`,
    X_SESSION_CHECK_CACHE_MS: '0',
  });
  const owner = await register(baseUrl, 'health_non401');
  for (const prefix of ['autherror', 'forbidden']) {
    const requestCount = x.requests.length;
    const imported = await importSession(baseUrl, owner.cookie, importPayload('alpha', prefix));
    const body = await imported.json();
    assert.equal(imported.status, 201, JSON.stringify(body));
    assert.equal(body.xSessionValid, true);
    assert.equal(body.xSessionStatus, 'valid');
    assert.equal(x.requests.length, requestCount + 2, 'A non-401 error must allow endpoint fallback');
    assert.equal(x.requests.at(-1).url, '/i/api/1.1/account/settings.json?fallback=1');
  }
});

test('settings JSON with an unexpected errors field must still fall back instead of confirming cookies', async (t) => {
  const x = await startXHealthFixture(t);
  const { baseUrl, dataDir } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '0',
  });
  const owner = await register(baseUrl, 'health_error_shape');
  const values = importPayload('alpha', 'good');
  for (const errors of [{ message: 'Unexpected authentication error' }, 'Unexpected authentication error']) {
    x.setResponse({ status: 200, body: { screen_name: 'alpha', errors } });
    const response = await importSession(baseUrl, owner.cookie, values);
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.code, 'X_SESSION_CHECK_UNAVAILABLE');
    assert.equal(body.xSessionValid, null);
    await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
  }
  x.setResponse({ status: 200, body: { screen_name: 'alpha', errors: [] } });
  const confirmed = await importSession(baseUrl, owner.cookie, values);
  assert.equal(confirmed.status, 201);
  assert.equal((await confirmed.json()).xSessionValid, true);
});

test('X health check falls back after 404 and reports unknown failures without staging or spawn', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-health-failures-'));
  const stageMarker = join(dataDir, 'stage-gate');
  const runMarker = join(dataDir, 'run-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0',
    X_SESSION_CHECK_URL: `${x.missingUrl},${x.url}`,
    X_SESSION_CHECK_TIMEOUT_MS: '500',
    X_SESSION_CHECK_CACHE_MS: '0',
    SESSION_TEST_WRITE_GATE: stageMarker,
    SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'healthfallback');

  // A missing route is inconclusive; an authenticated fallback can still
  // confirm the session instead of marking the cookies expired.
  const good = { handle: 'gamma', auth_token: 'good_gamma_auth_token', ct0: 'good_gamma_ct0' };
  const imported = await importSession(baseUrl, owner.cookie, good);
  const importedText = await imported.text();
  assert.equal(imported.status, 201, importedText);
  assert.equal(JSON.parse(importedText).xSessionStatus, 'valid');
  const requestedPaths = x.requests.map((request) => request.url);
  assert.ok(requestedPaths.includes('/missing/1.1/account/settings.json'));
  assert.ok(requestedPaths.includes('/i/api/1.1/account/settings.json'));

  const key = await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ apiKey: 'test-only-groq-key-no-external-requests' }),
  });
  assert.equal(key.status, 200);

  for (const prefix of ['notfound', 'notfoundautherror', 'gone', 'unauthorized', 'autherror', 'forbidden', 'ratelimited', 'html', 'malformed', 'flaky', 'timeout', 'network']) {
    const invalid = prefix === 'unauthorized';
    const expectedStatus = invalid ? 'invalid' : 'unknown';
    const expectedValid = invalid ? false : null;
    const expectedCode = invalid ? 'X_SESSION_EXPIRED' : 'X_SESSION_CHECK_UNAVAILABLE';
    const failed = importPayload('gamma', prefix);
    const savedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
    const rejected = await importSession(baseUrl, owner.cookie, failed);
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, invalid ? 422 : 503, `${prefix}: ${JSON.stringify(rejectedBody)}`);
    if (!invalid) {
      assert.equal(rejectedBody.code, 'X_SESSION_CHECK_UNAVAILABLE', prefix);
      assert.equal(rejectedBody.xSessionValid, null, prefix);
      assert.equal(rejectedBody.xSessionStatus, 'unknown', prefix);
      assert.doesNotMatch(rejectedBody.error, /expired|rejected|re-authenticate/i, prefix);
    }
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), savedBefore, 'An unverified import must preserve the saved session');

    // The legacy editor simulates cookies that expired after they were saved.
    const rotated = await fetch(`${baseUrl}/api/auth`, {
      method: 'PUT', headers: jsonHeaders(owner.cookie),
      body: JSON.stringify({ auth_token: failed.auth_token, ct0: failed.ct0 }),
    });
    assert.equal(rotated.status, 200, prefix);
    const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
    assert.equal(me.xSessionValid, expectedValid, prefix);
    assert.equal(me.xSessionStatus, expectedStatus, prefix);
    assert.equal(me.xSession.auth_token, failed.auth_token, prefix);
    if (prefix === 'notfound') {
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: owner.body.user.username, password: owner.password }),
      });
      const loginBody = await login.json();
      assert.equal(login.status, 200, JSON.stringify(loginBody));
      assert.equal(loginBody.xSessionValid, null);
      assert.equal(loginBody.xSessionStatus, 'unknown');
      assert.equal(loginBody.activeXAccount, 'gamma');
      owner.cookie = sessionCookie(login);
    }

    const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
    await writeFile(stageMarker, 'fail');
    const blocked = await fetch(`${baseUrl}/api/run`, {
      method: 'POST', headers: jsonHeaders(owner.cookie),
      body: JSON.stringify({ url: 'https://x.com/gamma/status/1' }),
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, invalid ? 409 : 503, `${prefix}: ${JSON.stringify(blockedBody)}`);
    assert.equal(blockedBody.code, expectedCode, prefix);
    assert.equal(blockedBody.xSessionValid, expectedValid, prefix);
    assert.equal(blockedBody.xSessionStatus, expectedStatus, prefix);
    if (!invalid) assert.doesNotMatch(blockedBody.error, /expired|rejected|re-authenticate/i, prefix);
    assert.equal(await readFile(stageMarker, 'utf8'), 'fail', 'Rejected runs must not stage auth.json');
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);
    await assert.rejects(stat(`${runMarker}.entered`), { code: 'ENOENT' });
    await unlink(stageMarker);

    // A blocked run must release its lock so fresh cookies can be imported.
    const restored = await importSession(baseUrl, owner.cookie, good);
    assert.equal(restored.status, 201, await restored.text());
  }
});

test('X browser fallback validates cookies after HTTP failures and permits a verified run', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-browser-fallback-'));
  const log = join(dataDir, 'health-browser.log');
  const runMarker = join(dataDir, 'run-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url,
    X_SESSION_CHECK_TIMEOUT_MS: '500', X_SESSION_CHECK_CACHE_MS: '0',
    SESSION_TEST_HEALTH_BROWSER_LOG: log, SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'browser_fallback');
  const failures = ['notfound', 'gone', 'unauthorized', 'autherror', 'forbidden', 'ratelimited', 'html', 'malformed', 'flaky', 'timeout', 'network'];
  for (const prefix of failures) {
    const values = importPayload('alpha', `${prefix}_browservalid`);
    const imported = await importSession(baseUrl, owner.cookie, values);
    const text = await imported.text();
    assert.equal(imported.status, 201, `${prefix}: ${text}`);
    assert.equal(JSON.parse(text).xSessionValid, true, prefix);
    assert.equal(JSON.parse(text).xSessionStatus, 'valid', prefix);
    assert.equal(text.includes(values.auth_token), false, prefix);
  }
  let events = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
  assert.equal(events.filter((event) => event === 'launch').length, failures.length);
  assert.equal(events.filter((event) => event === 'close').length, failures.length);

  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(me.xSessionValid, true);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: owner.body.user.username, password: owner.password }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).xSessionValid, true);
  owner.cookie = sessionCookie(login);
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-browser-fallback' }),
  })).status, 200);
  const running = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
  });
  assert.equal(running.status, 200);
  assert.match(await running.text(), /"type":"batch-complete"/);
  const staged = JSON.parse(await readFile(`${runMarker}.entered`, 'utf8'));
  assert.equal(staged.username, 'alpha');
  assert.equal(staged.state.cookies.find((cookie) => cookie.name === 'auth_token').value, 'network_browservalid_auth_token_value');
  events = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
  assert.equal(events.filter((event) => event === 'launch').length, failures.length + 3);
  assert.equal(events.filter((event) => event === 'close').length, failures.length + 3);
});

test('X browser errors after HTTP 401 or 404 return unavailable without changing saved sessions', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-browser-errors-'));
  const log = join(dataDir, 'health-browser.log');
  const stageMarker = join(dataDir, 'stage-gate');
  const runMarker = join(dataDir, 'run-gate');
  const { baseUrl, output } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '0',
    SESSION_TEST_HEALTH_BROWSER_LOG: log, SESSION_TEST_WRITE_GATE: stageMarker, SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'browser_errors');
  const good = importPayload('alpha', 'good');
  assert.equal((await importSession(baseUrl, owner.cookie, good)).status, 201);
  await assert.rejects(stat(log), { code: 'ENOENT' }, 'Authenticated settings JSON should not launch Chromium');
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-browser-errors' }),
  })).status, 200);
  for (const prefix of ['browsererror', 'unauthorized_browsererror']) {
    const failed = importPayload('alpha', prefix);
    const sessionPath = join(dataDir, 'sessions', owner.body.user.id, 'alpha.json');
    const savedBefore = await readFile(sessionPath, 'utf8');
    const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
    const rejected = await importSession(baseUrl, owner.cookie, failed);
    const text = await rejected.text();
    assert.equal(rejected.status, 503, text);
    assert.equal(JSON.parse(text).code, 'X_SESSION_CHECK_UNAVAILABLE');
    assert.equal(JSON.parse(text).xSessionValid, null);
    assert.equal(JSON.parse(text).xSessionStatus, 'unknown');
    assert.equal(text.includes(failed.auth_token), false);
    assert.equal(await readFile(sessionPath, 'utf8'), savedBefore);
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);

    assert.equal((await fetch(`${baseUrl}/api/auth`, {
      method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ auth_token: failed.auth_token, ct0: failed.ct0 }),
    })).status, 200);
    const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
    assert.equal(me.xSessionStatus, 'unknown');
    assert.equal(me.xSessionValid, null);
    const beforeRun = await readFile(join(dataDir, 'auth.json'), 'utf8');
    await writeFile(stageMarker, 'fail');
    const blocked = await fetch(`${baseUrl}/api/run`, {
      method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alpha/status/1' }),
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 503, JSON.stringify(blockedBody));
    assert.equal(blockedBody.code, 'X_SESSION_CHECK_UNAVAILABLE');
    assert.equal(blockedBody.xSessionValid, null);
    assert.equal(await readFile(stageMarker, 'utf8'), 'fail');
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), beforeRun);
    await assert.rejects(stat(`${runMarker}.entered`), { code: 'ENOENT' });
    assert.equal(output().includes(failed.auth_token), false, 'Browser error logs must not expose cookies');
    await unlink(stageMarker);
    assert.equal((await importSession(baseUrl, owner.cookie, good)).status, 201);
  }
  const events = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
  assert.equal(events.filter((event) => event === 'launch').length, 6);
  assert.equal(events.filter((event) => event === 'close').length, 6);
});

test('PostgreSQL keeps the saved cookie row intact when browser verification is unavailable', async (t) => {
  const x = await startXHealthFixture(t);
  const { baseUrl, dataDir } = await startServer(t, {
    DATABASE_URL: 'pg-mem://',
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '0',
  });
  const owner = await register(baseUrl, 'pg_browser_error');
  const good = importPayload('alpha', 'good');
  assert.equal((await importSession(baseUrl, owner.cookie, good)).status, 201);
  const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
  for (const handle of ['alpha', 'beta']) {
    const unavailable = await importSession(baseUrl, owner.cookie, importPayload(handle, 'unauthorized_browsererror'));
    const body = await unavailable.json();
    assert.equal(unavailable.status, 503, JSON.stringify(body));
    assert.equal(body.code, 'X_SESSION_CHECK_UNAVAILABLE');
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);
  }
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(me.activeXAccount, 'alpha');
  assert.deepEqual(me.xAccounts, ['alpha']);
  assert.equal(me.xSession.auth_token, good.auth_token);
  assert.equal(me.xSession.ct0, good.ct0);
  assert.equal(me.xSessionValid, true);
});

test('explicit imports retry verification instead of reusing a cached availability error', async (t) => {
  const x = await startXHealthFixture(t);
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '60000',
  });
  const owner = await register(baseUrl, 'health_import_retry');
  const values = importPayload('alpha', 'browsererror');
  const failed = await importSession(baseUrl, owner.cookie, values);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, 'X_SESSION_CHECK_UNAVAILABLE');
  const count = x.requests.length;
  x.setResponse({ status: 200, body: { screen_name: 'alpha' } });
  const retried = await importSession(baseUrl, owner.cookie, values);
  const body = await retried.json();
  assert.equal(retried.status, 201, JSON.stringify(body));
  assert.equal(body.xSessionValid, true);
  assert.equal(x.requests.length, count + 1);
});

test('X account summaries retain the verified expired state of inactive accounts and clear it after re-authentication', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '0',
  });
  const owner = await register(baseUrl, 'health_accounts');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha', 'good_alpha'))).status, 201);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('beta', 'good_beta'))).status, 201);
  assert.equal((await fetch(`${baseUrl}/api/auth`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ auth_token: 'expired_beta_auth_token', ct0: 'expired_beta_ct0' }),
  })).status, 200);
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(me.xSessionValid, false);
  assert.equal(me.accounts.find((account) => account.xUsername === 'beta').status, 'expired');

  const switched = await fetch(`${baseUrl}/api/auth/switch-account`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ xUsername: 'alpha' }),
  });
  assert.equal(switched.status, 200);
  const switchedBody = await switched.json();
  assert.equal(switchedBody.xSessionValid, true);
  const expired = switchedBody.accounts.find((account) => account.xUsername === 'beta');
  assert.equal(expired.active, false);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.xSessionValid, false);
  assert.equal(expired.xSessionStatus, 'invalid');
  assert.ok(expired.xSessionCheckedAt);
  const accounts = await (await fetch(`${baseUrl}/api/auth/x-accounts`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(accounts.find((account) => account.xUsername === 'beta').xSessionValid, false);

  const restored = await importSession(baseUrl, owner.cookie, importPayload('beta', 'fresh_beta'));
  assert.equal(restored.status, 201);
  const restoredBody = await restored.json();
  const active = restoredBody.accounts.find((account) => account.xUsername === 'beta');
  assert.equal(restoredBody.activeXAccount, 'beta');
  assert.equal(active.active, true);
  assert.equal(active.status, 'ready');
  assert.equal(active.xSessionValid, true);
  assert.equal(active.xSessionStatus, 'valid');
});

test('run staging refuses cookies changed by a previously queued edit after verification', { timeout: 20_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-staging-recheck-'));
  const writeMarker = join(dataDir, 'session-gate');
  const runMarker = join(dataDir, 'run-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '0',
    SESSION_TEST_SESSION_WRITE_GATE: writeMarker, SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'staging_recheck');
  const good = importPayload('alpha', 'good');
  assert.equal((await importSession(baseUrl, owner.cookie, good)).status, 201);
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-staging-recheck' }),
  })).status, 200);
  t.after(() => unlink(writeMarker).catch(() => {}));
  await writeFile(writeMarker, 'pause');
  const rotating = fetch(`${baseUrl}/api/auth`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ auth_token: 'expired_auth_token_value', ct0: 'expired_ct0_value' }),
  });
  await until(() => stat(`${writeMarker}.entered`).then(() => true, () => false));
  const count = x.requests.length;
  const starting = fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
  });
  await until(() => x.requests.length === count + 1, 'The run did not verify the original cookies');
  await unlink(writeMarker);
  assert.equal((await rotating).status, 200);
  const blocked = await starting;
  const text = await blocked.text();
  assert.equal(blocked.status, 409, text);
  const body = JSON.parse(text);
  assert.match(body.error, /session changed during verification/i);
  await assert.rejects(stat(`${runMarker}.entered`), { code: 'ENOENT' });
  const retried = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alpha/status/1' }),
  });
  assert.equal(retried.status, 409);
  assert.equal((await retried.json()).code, 'X_SESSION_EXPIRED');
});

test('queued cookie edits and logout recheck the app token after a concurrent login rotates it', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-cookie-edit-token-'));
  const marker = join(dataDir, 'user-gate');
  const { baseUrl } = await startServer(t, { SESSION_TEST_USER_WRITE_GATE: marker }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'cookie_edit_token');
  const values = importPayload('alpha');
  assert.equal((await importSession(baseUrl, owner.cookie, values)).status, 201);
  const sessionPath = join(dataDir, 'sessions', owner.body.user.id, 'alpha.json');
  const savedBefore = await readFile(sessionPath, 'utf8');
  t.after(() => unlink(marker).catch(() => {}));
  await writeFile(marker, 'pause');
  const loggingIn = fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: owner.body.user.username, password: owner.password }),
  });
  await until(() => stat(`${marker}.entered`).then(() => true, () => false));
  let editReturned = false;
  const staleEdit = fetch(`${baseUrl}/api/auth`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ auth_token: 'replacement_auth_token_value' }),
  }).then((response) => { editReturned = true; return response; });
  const staleLogout = fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: owner.cookie } });
  await delay(100);
  assert.equal(editReturned, false, 'The edit must wait for the login write to settle');
  await unlink(marker);
  const login = await loggingIn;
  assert.equal(login.status, 200);
  const rejected = await staleEdit;
  assert.equal(rejected.status, 401);
  assert.equal((await staleLogout).status, 401);
  assert.equal(await readFile(sessionPath, 'utf8'), savedBefore);
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: sessionCookie(login) } })).json();
  assert.equal(me.xSession.auth_token, values.auth_token);
});

test('X run verification bypasses cached health and confirms expiration before staging or automation', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  x.setResponse({ status: 200, body: { screen_name: 'alpha' } });
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-health-cache-'));
  const stageMarker = join(dataDir, 'stage-gate');
  const runMarker = join(dataDir, 'run-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '60000',
    SESSION_TEST_WRITE_GATE: stageMarker, SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'health_cache');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha', 'expired'))).status, 201);
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-health-cache' }),
  })).status, 200);
  const count = x.requests.length;
  x.setResponse({ status: 401, body: { errors: [{ code: 32 }] } });
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(me.xSessionValid, true, 'Ordinary bootstrap may reuse the short-lived cache');
  assert.equal(x.requests.length, count);
  const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
  await writeFile(stageMarker, 'fail');
  const blocked = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alpha/status/1' }),
  });
  const body = await blocked.json();
  assert.equal(blocked.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'X_SESSION_EXPIRED');
  assert.equal(body.xSessionValid, false);
  assert.equal(x.requests.length, count + 1);
  assert.equal(await readFile(stageMarker, 'utf8'), 'fail');
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);
  await assert.rejects(stat(`${runMarker}.entered`), { code: 'ENOENT' });

  await unlink(stageMarker);
  x.setResponse({ status: 200, body: { screen_name: 'alpha' } });
  const retry = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
  });
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /"type":"batch-complete"/);
  assert.equal(x.requests.length, count + 2, 'A forced retry must not reuse a cached rejection either');
});

test('X forced run checks share an in-flight browser probe for the same cookies', { timeout: 30_000 }, async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-health-singleflight-'));
  const gate = join(dataDir, 'health-gate');
  const log = join(dataDir, 'health-browser.log');
  const runMarker = join(dataDir, 'run-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url, X_SESSION_CHECK_CACHE_MS: '0',
    SESSION_TEST_HEALTH_BROWSER_GATE: gate, SESSION_TEST_HEALTH_BROWSER_LOG: log, SESSION_TEST_RUN_GATE: runMarker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'health_singleflight');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha', 'browservalid'))).status, 201);
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-health-singleflight' }),
  })).status, 200);
  t.after(() => unlink(gate).catch(() => {}));
  await writeFile(gate, 'pause');
  const probes = Array.from({ length: 3 }, () => fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } }));
  await until(() => stat(`${gate}.entered`).then(() => true, () => false));
  let runReturned = false;
  const running = fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
  }).then((response) => { runReturned = true; return response; });
  await delay(100);
  assert.equal(runReturned, false, 'A forced check must await the shared verification rather than return browser-busy');
  await unlink(gate);
  for (const response of await Promise.all(probes)) assert.equal((await response.json()).xSessionValid, true);
  const response = await running;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"type":"batch-complete"/);
  const events = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
  assert.equal(events.filter((event) => event === 'launch').length, 2, 'Only import and one shared refresh should launch');
  assert.equal(events.filter((event) => event === 'close').length, 2);
  assert.equal(x.requests.length, 2);
});

test('bootstrap storage failures remain unknown and cannot falsely expire saved cookies', async (t) => {
  const x = await startXHealthFixture(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-hydration-failure-'));
  const marker = join(dataDir, 'stage-gate');
  const { baseUrl } = await startServer(t, {
    X_SESSION_CHECK_DISABLED: '0', X_SESSION_CHECK_URL: x.url,
    SESSION_TEST_WRITE_GATE: marker,
  }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'hydration_failure');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha'))).status, 201);
  const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
  await writeFile(marker, 'fail');
  const response = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.authenticated, true);
  assert.equal(body.activeXAccount, 'alpha');
  assert.equal(body.xSessionValid, null);
  assert.equal(body.xSessionStatus, 'unknown');
  assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);
  const recovered = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } })).json();
  assert.equal(recovered.xSessionValid, true);
});

test('unlinking another user’s active accounts cannot replace or delete the running job’s staged cookies', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-unlink-isolation-'));
  const gate = join(dataDir, 'run-gate');
  const { baseUrl } = await startServer(t, { SESSION_TEST_RUN_GATE: gate }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'unlink_owner');
  const other = await register(baseUrl, 'unlink_other');
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alpha'))).status, 201);
  assert.equal((await importSession(baseUrl, other.cookie, importPayload('beta'))).status, 201);
  assert.equal((await importSession(baseUrl, other.cookie, importPayload('gamma'))).status, 201);
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-unlink-isolation' }),
  })).status, 200);
  await writeFile(gate, 'pause');
  const running = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alpha/status/1', dryRun: true }),
  });
  assert.equal(running.status, 200);
  await until(() => stat(`${gate}.entered`).then(() => true, () => false));
  const stagedBefore = await readFile(join(dataDir, 'auth.json'), 'utf8');
  for (const handle of ['gamma', 'beta']) {
    const unlinked = await fetch(`${baseUrl}/api/auth/x-accounts/${handle}`, { method: 'DELETE', headers: { cookie: other.cookie } });
    const body = await unlinked.json();
    assert.equal(unlinked.status, 200, JSON.stringify(body));
    assert.equal(body.wasActive, true);
    assert.equal(body.activeSessionStaged, false);
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), stagedBefore);
  }
  await unlink(gate);
  assert.match(await running.text(), /"type":"batch-complete"/);
});

test('production allows Render origins and rejects unknown origins', async (t) => {
  const { baseUrl } = await startServer(t, {
    NODE_ENV: 'production',
    DATABASE_URL: 'pg-mem://',
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

test('connectBrowser launches local headless Chromium without any remote connection', async (t) => {
  let launches = 0;
  let closes = 0;
  const browser = { close: async () => { closes += 1; } };
  t.mock.method(chromium, 'launch', async (options) => {
    launches += 1;
    assert.deepEqual(options, { headless: true, args: ['--no-sandbox'] });
    return browser;
  });
  t.mock.method(chromium, 'connectOverCDP', () => {
    assert.fail('Local automation must not connect to a remote browser');
  });

  assert.equal(await connectBrowser(), browser);
  assert.equal(launches, 1);
  await closeBrowser(browser);
  assert.equal(closes, 1);
});

test('local launch failures propagate without falling back to a remote browser', async (t) => {
  const failure = new Error('Synthetic Chromium launch failure');
  t.mock.method(chromium, 'launch', async () => { throw failure; });
  t.mock.method(chromium, 'connectOverCDP', () => {
    assert.fail('Launch failures must not fall back to a remote browser');
  });
  await assert.rejects(connectBrowser(), (error) => error === failure);
});

test('local browser cleanup tolerates absent and already-closed processes', async () => {
  await closeBrowser(null);
  await closeBrowser({ close: async () => { throw new Error('Browser has been closed'); } });
});

test('a fresh local browser awaits context creation before profiling and cookie restoration', async () => {
  const operations = [];
  const contexts = [];
  const context = {
    browser: () => browser,
    pages: () => [],
    addInitScript: async () => operations.push('profile'),
    clearCookies: async () => operations.push('clearCookies'),
    addCookies: async (cookies) => operations.push({ cookies }),
  };
  const browser = {
    contexts: () => contexts,
    isConnected: () => true,
    async newContext() {
      await delay(1);
      operations.push('newContext');
      contexts.push(context);
      return context;
    },
  };
  const state = { cookies: xStorageState('alice').cookies, origins: [] };

  assert.equal(await getDefaultContext(browser), context);
  const restored = await safeContextCall(context, () => restoreStorageState(context, state, { clearCookies: true }));
  assert.equal(restored.ok, true);
  assert.deepEqual(operations, ['newContext', 'profile', 'clearCookies', { cookies: state.cookies }]);
  assert.equal(await getDefaultContext(browser), context);
  assert.equal(contexts.length, 1, 'The same run must reuse its context');
  assert.equal(operations.filter((operation) => operation === 'profile').length, 1);
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

test('X session detection recognizes home and both required cookies', () => {
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

test('Chromium contexts and pages use a realistic Chrome identity and stealth profile', async () => {
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

test('retired sign-in cancellation is authenticated and idempotent', async (t) => {
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

test('retired interactive sign-in does not block cookie imports or interfere with automation', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-local-login-'));
  const runGate = join(dataDir, 'automation-gate');
  t.after(() => unlink(runGate).catch(() => {}));
  const { baseUrl } = await startServer(t, { SESSION_TEST_RUN_GATE: runGate }, {
    dataDir, cleanupData: true,
    nodeArgs: ['--require', join(ROOT, 'test', 'fixtures', 'session-runtime-gate.cjs')],
  });
  const owner = await register(baseUrl, 'local_login');
  const anonymous = await fetch(`${baseUrl}/auth/x`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(anonymous.status, 401);
  const retired = await fetch(`${baseUrl}/auth/x`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: '{}',
  });
  assert.equal(retired.status, 410);
  assert.match((await retired.json()).error, /local headless Chromium.*\/api\/auth\/import-session/);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alice'))).status, 201);
  assert.equal((await fetch(`${baseUrl}/api/config/groq`, {
    method: 'PUT', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ apiKey: 'synthetic-groq-key-for-local-fixture' }),
  })).status, 200);

  await writeFile(runGate, 'pause');
  const runBody = JSON.stringify({ url: 'https://x.com/alice/status/1', dryRun: true, headless: false });
  const running = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: runBody,
  });
  assert.equal(running.status, 200);
  await until(() => stat(`${runGate}.entered`).then(() => true, () => false));
  const cancel = await fetch(`${baseUrl}/auth/x/cancel`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: '{}',
  });
  assert.deepEqual(await cancel.json(), { ok: true, cancelled: false });
  const overlapping = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: runBody,
  });
  assert.equal(overlapping.status, 409, 'The compatibility no-op must not release the automation lock');
  await unlink(runGate);
  const output = await running.text();
  assert.match(output, /"type":"batch-complete".*"succeeded":1,"failed":0/);
  assert.equal((await importSession(baseUrl, owner.cookie, importPayload('alice', 'refreshed'))).status, 201);
});

test('desktop login helper refuses production before launching a browser or saving cookies', { timeout: 10_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-local-auth-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['auth.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 1);
  assert.match(output, /Manual X login requires a local desktop/);
  await assert.rejects(stat(join(dataDir, 'auth.json')), { code: 'ENOENT' });
});

test('native service uses the platform port and delegates browser execution to main.js', async () => {
  const server = await readFile(join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /process\.env\.PORT \|\| 3000/);
  assert.match(server, /app\.listen\(PORT, '0\.0\.0\.0'/);
  assert.match(server, /Server listening on port/);

  assert.match(server, /const args = \['main\.js', targetUrl, '--yes'\]/);
  assert.match(server, /AUTH_FILE_PATH: AUTH_FILE/);
  assert.doesNotMatch(server, /connectBrowser|createLiveInspection|runBrowserLogin|Browserbase/);
  assert.equal(server.includes('/auth/x/credentials'), false);
  assert.doesNotMatch(server, /HARVEST_|INTERACTIVE_LOGIN_|remote-desktop-http|desktop-browser/);
});

test('production preflight and Render image require local Playwright instead of a browser-service key', async () => {
  const [checkProd, envExample, readme, dockerfile, packageJson, browserSource, healthSource] = await Promise.all([
    readFile(join(ROOT, 'scripts', 'check-prod.js'), 'utf8'),
    readFile(join(ROOT, '.env.example'), 'utf8'),
    readFile(join(ROOT, 'README.md'), 'utf8'),
    readFile(join(ROOT, 'Dockerfile'), 'utf8'),
    readFile(join(ROOT, 'package.json'), 'utf8'),
    readFile(join(ROOT, 'lib', 'browser.js'), 'utf8'),
    readFile(join(ROOT, 'lib', 'x-session-health.js'), 'utf8'),
  ]);

  assert.doesNotMatch(checkProd, /BROWSERBASE_|BROWSERLESS_/);
  assert.doesNotMatch(envExample, /BROWSERBASE_|BROWSERLESS_/);
  assert.doesNotMatch(browserSource, /Browserbase|browserbase|connectOverCDP/);
  assert.doesNotMatch(healthSource, /Browserbase|browserbase|connectOverCDP|writeFile|storageState\(/);
  assert.match(healthSource, /connectBrowser\(/);
  assert.match(checkProd, /SESSION_SECRET/);
  assert.match(checkProd, /DATABASE_URL/);
  assert.match(envExample, /DATABASE_URL/);
  assert.match(readme, /Supabase PostgreSQL/);
  assert.match(readme, /POST \/api\/auth\/import-session/);
  assert.match(readme, /local headless Chromium/);
  const manifest = JSON.parse(packageJson);
  const imageVersion = dockerfile.match(/^FROM mcr\.microsoft\.com\/playwright:v([\d.]+)-jammy$/m)?.[1];
  assert.equal(manifest.dependencies.playwright, imageVersion, 'Pin Playwright to the container browser version');
  assert.equal(Object.hasOwn(manifest.dependencies, '@browserbasehq/sdk'), false);
  assert.match(dockerfile, /RUN node --input-type=module -e.*await connectBrowser\(\).*await closeBrowser\(browser\)/);
  for (const contents of [checkProd, envExample, readme]) {
    assert.doesNotMatch(contents, /HARVEST_|INTERACTIVE_LOGIN_|fly\.dev|noVNC|Xvfb/);
  }
});

test('dashboard imports X sessions with masked inputs instead of asking for X credentials', async () => {
  const html = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal(html.includes('id="x-credentials-form"'), false);
  assert.equal(html.includes('id="x-password"'), false);
  assert.match(html, /\/api\/auth\/import-session/);
  assert.match(html, /id="session-auth-token"[^>]*type="password"/);
  assert.match(html, /id="session-ct0"[^>]*type="password"/);
  assert.doesNotMatch(html, /remote-login|\/x-accounts\/interactive|window\.open|(?:local|session)Storage\.setItem/);
});

test('root serves the dashboard and retired desktop and harvest routes are unavailable', async (t) => {
  const { baseUrl } = await startServer(t);

  const root = await fetch(`${baseUrl}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await root.text(), /<title>X automation console<\/title>/);

  const index = await fetch(`${baseUrl}/index.html`);
  assert.equal(index.status, 200);

  const missingApi = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { error: 'No route for GET /api/does-not-exist' });

  for (const path of [
    '/api/harvest-token', '/api/auth/x-accounts/harvest',
    '/api/auth/x-accounts/interactive', '/api/auth/x-accounts/interactive/callback',
    '/api/interactive-login/sessions',
  ]) {
    const retired = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(retired.status, 404, path);
  }
  const viewer = await fetch(`${baseUrl}/remote-login/viewer.html`);
  assert.equal(viewer.status, 404);
});

test('retired deployment and desktop worker files have been removed', async () => {
  for (const path of [
    'fly.toml', 'docker/openbox.xml',
    'scripts/desktop-browser-server.cjs', 'scripts/start-desktop.sh',
    'lib/desktop-browser.js', 'lib/harvest-client.js', 'lib/interactive-login.js',
    'lib/interactive-login-client.js', 'lib/remote-desktop-http.js',
    'public/remote-login/viewer.html', 'public/remote-login/viewer.js', 'public/remote-login/viewer.css',
  ]) {
    await assert.rejects(stat(join(ROOT, path)), { code: 'ENOENT' });
  }
});

test('Docker excludes ignored credentials, local browser data, and the obsolete debug script', async () => {
  const ignores = (await readFile(join(ROOT, '.dockerignore'), 'utf8')).split(/\r?\n/);
  for (const path of ['.env', '.env.*', 'auth.json', 'tokens.json', 'user-db.json', 'history.json', 'sessions', 'user-data', 'node_modules', 'test-browserbase.cjs']) {
    assert.ok(ignores.includes(path), `${path} must not enter the Docker build context`);
  }
});
