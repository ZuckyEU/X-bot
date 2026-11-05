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

async function startServer(t, extraEnv = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'x-engine-test-'));
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
    await rm(dataDir, { recursive: true, force: true });
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
    ],
    origins: [],
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

test('UI Clear All and sign-out flush backing state and dropdown entries', async (t) => {
  const { baseUrl } = await startServer(t);
  const browser = await chromium.launch({ headless: true });
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
  }));
  assert.deepEqual(state, {
    currentUser: null,
    currentAppUsername: null,
    currentUserEmail: '',
    activeXAccount: null,
    linkedAccounts: 0,
    targetUrls: 0,
    controllerIsNull: true,
  });
  assert.equal(await page.locator('.linked-account-item').count(), 0);
  assert.equal(await page.locator('#run-url').inputValue(), '');
  assert.deepEqual(pageErrors, []);
});
