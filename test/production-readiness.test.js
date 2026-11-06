import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import bcrypt from 'bcrypt';
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

function importPayload(handle, prefix = handle) {
  return { handle, auth_token: `${prefix}_auth_token_value`, ct0: `${prefix}_csrf_token_value` };
}

function importSession(baseUrl, cookie, body) {
  return fetch(`${baseUrl}/api/auth/import-session`, {
    method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify(body),
  });
}

async function until(check, message = 'condition did not become true') {
  const deadline = Date.now() + 5_000;
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
  const { baseUrl, dataDir, output } = await startServer(t, { BROWSERBASE_API_KEY: '' });
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
  assert.deepEqual(result.accounts, [{ xUsername: 'carol', active: true, status: 'ready' }]);
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
  const request = new AbortController();
  const saving = fetch(`${baseUrl}/api/auth/import-session`, {
    method: 'POST', headers: jsonHeaders(owner.cookie),
    body: JSON.stringify(importPayload('alice', 'updated')), signal: request.signal,
  }).catch((error) => error);
  await until(() => stat(`${marker}.entered`).then(() => true, () => false), 'The import did not reach session staging');
  const browserStart = await fetch(`${baseUrl}/auth/x`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: '{}',
  });
  assert.equal(browserStart.status, 409);
  const run = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: jsonHeaders(owner.cookie), body: JSON.stringify({ url: 'https://x.com/alice/status/1', dryRun: true }),
  });
  assert.equal(run.status, 409);
  request.abort();
  assert.equal((await saving).name, 'AbortError');
  await delay(50);
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
  assert.equal(login.status, 200, await login.text());
  const loginCookie = sessionCookie(login);

  const accounts = await fetch(`${baseUrl}/api/auth/x-accounts`, { headers: { cookie: loginCookie } });
  assert.deepEqual(await accounts.json(), [{ xUsername: 'alpha', active: true, status: 'ready' }]);

  await assert.rejects(stat(join(dataDir, 'user-db.json')), { code: 'ENOENT' });
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

test('native service uses the platform port and retains optional Browserbase sign-in', async () => {
  const server = await readFile(join(ROOT, 'server.js'), 'utf8');
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
  assert.doesNotMatch(server, /HARVEST_|INTERACTIVE_LOGIN_|remote-desktop-http|desktop-browser/);
});

test('production preflight and docs describe manual imports without the retired service configuration', async () => {
  const [checkProd, envExample, readme] = await Promise.all([
    readFile(join(ROOT, 'scripts', 'check-prod.js'), 'utf8'),
    readFile(join(ROOT, '.env.example'), 'utf8'),
    readFile(join(ROOT, 'README.md'), 'utf8'),
  ]);

  assert.match(checkProd, /BROWSERBASE_API_KEY/);
  assert.match(checkProd, /SESSION_SECRET/);
  assert.match(checkProd, /DATABASE_URL/);
  assert.match(envExample, /DATABASE_URL/);
  assert.match(readme, /Supabase PostgreSQL/);
  assert.match(readme, /POST \/api\/auth\/import-session/);
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
    'fly.toml', '.dockerignore', 'docker/openbox.xml',
    'scripts/desktop-browser-server.cjs', 'scripts/start-desktop.sh',
    'lib/desktop-browser.js', 'lib/harvest-client.js', 'lib/interactive-login.js',
    'lib/interactive-login-client.js', 'lib/remote-desktop-http.js',
    'public/remote-login/viewer.html', 'public/remote-login/viewer.js', 'public/remote-login/viewer.css',
  ]) {
    await assert.rejects(stat(join(ROOT, path)), { code: 'ENOENT' });
  }
});
