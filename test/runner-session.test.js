import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isXLoginURL, normalizeXSessionCookies } from '../lib/browser.js';
import { loadRunnerSession, redactRunnerDiagnostic, reportRunnerPageFailure, waitForRunnerContent } from '../lib/runner-session.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUTH = 'synthetic_runner_auth%2B_token+value/=';
const CSRF = 'synthetic_runner_ct0%2F_value+test/=';
const GROQ = 'synthetic_runner_groq_key_no_external_requests';
const READY = 'article[data-testid="tweet"]';

function storageState() {
  return {
    username: '@zuckyeu',
    cookies: [
      { name: 'auth_token', value: AUTH, domain: '.twitter.com', path: '/legacy', expires: 1, secure: false, httpOnly: false, sameSite: 'None' },
      { name: 'ct0', value: CSRF, url: 'http://twitter.com/legacy', secure: false, httpOnly: true, sameSite: 'Strict' },
    ],
    origins: [],
  };
}

async function dataDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'x-engine-runner-session-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function captureLogs(t) {
  const log = t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  return () => [...log.mock.calls, ...warn.mock.calls].map((call) => call.arguments.join(' ')).join('\n');
}

function assertNoSecrets(text) {
  for (const secret of [AUTH, CSRF, GROQ, 'synthetic_refreshed_ct0_value']) {
    assert.equal(text.includes(secret), false, 'Runner logs must not contain credentials');
    assert.equal(text.includes(encodeURIComponent(secret)), false, 'Runner logs must not contain encoded credentials');
  }
}

async function runCLI(t, scenario, state = storageState(), extraEnv = {}) {
  const dataDir = await dataDirectory(t);
  const authFile = join(dataDir, 'auth.json');
  const recordFile = join(dataDir, 'browser-record.jsonl');
  await writeFile(authFile, JSON.stringify(state), 'utf8');
  const child = spawn(process.execPath, ['--require', join(ROOT, 'test', 'fixtures', 'runner-browser.cjs'),
    'main.js', 'https://x.com/zuckyeu/status/1', '--dry-run', '--yes'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL: '', DATA_DIR: dataDir, AUTH_FILE_PATH: authFile,
      // Do not load a developer's .env or make real Groq/X requests.
      DOTENV_CONFIG_PATH: join(dataDir, 'absent.env'), GROQ_API_KEY: GROQ,
      X_ACCOUNT_USERNAME: 'zuckyeu',
      SESSION_TEST_RUNNER_RECORD: recordFile, SESSION_TEST_RUNNER_SCENARIO: scenario,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const record = await readFile(recordFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return { code, output, events: record.trim() ? record.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [] };
}

test('canonical X cookies preserve opaque values and the verified first pair without mutating input', () => {
  const state = storageState();
  const guest = { name: 'guest_id', value: 'synthetic_guest', domain: '.x.com', path: '/', secure: true };
  state.cookies.push({ name: 'auth_token', value: 'unverified_duplicate', domain: '.x.com', path: '/' }, guest);
  const original = structuredClone(state);
  const cookies = normalizeXSessionCookies(state.cookies);
  assert.deepEqual(cookies, [
    { name: 'auth_token', value: AUTH, domain: '.x.com', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'ct0', value: CSRF, domain: '.x.com', path: '/', expires: -1, secure: true, httpOnly: false, sameSite: 'Lax' },
    guest,
  ]);
  assert.deepEqual(state, original);
});

test('runner loading accepts Windows BOMs and logs exact cookie presence without values', async (t) => {
  const dataDir = await dataDirectory(t);
  const path = join(dataDir, 'auth.json');
  const output = captureLogs(t);
  await writeFile(path, `\uFEFF${JSON.stringify(storageState())}`, 'utf8');
  const state = await loadRunnerSession(path);
  assert.equal(state.username, 'zuckyeu');
  assert.deepEqual(state.cookies, normalizeXSessionCookies(storageState().cookies));
  assert.equal(output(), '[RUNNER] Loaded cookies for @zuckyeu: auth_token=present, ct0=present');
  assertNoSecrets(output());
});

test('legacy bare-cookie files use the selected handle for presence diagnostics', async (t) => {
  const dataDir = await dataDirectory(t);
  const path = join(dataDir, 'auth.json');
  const output = captureLogs(t);
  await writeFile(path, JSON.stringify(storageState().cookies), 'utf8');
  assert.equal((await loadRunnerSession(path, { username: '@zuckyeu' })).username, 'zuckyeu');
  assert.match(output(), /Loaded cookies for @zuckyeu: auth_token=present, ct0=present/);
});

for (const missing of ['auth_token', 'ct0', 'both']) {
  test(`runner loading reports missing ${missing} and refuses to start`, async (t) => {
    const dataDir = await dataDirectory(t);
    const path = join(dataDir, 'auth.json');
    const output = captureLogs(t);
    const state = storageState();
    state.cookies = missing === 'both' ? [] : state.cookies.filter((cookie) => cookie.name !== missing);
    await writeFile(path, JSON.stringify(state), 'utf8');
    await assert.rejects(loadRunnerSession(path), /must contain both auth_token and ct0/);
    assert.match(output(), new RegExp(`auth_token=${missing === 'ct0' ? 'present' : 'missing'}, ct0=${missing === 'auth_token' ? 'present' : 'missing'}`));
    assertNoSecrets(output());
  });
}

test('malformed and missing session files never leak parser excerpts or credentials', async (t) => {
  const dataDir = await dataDirectory(t);
  const path = join(dataDir, 'auth.json');
  const output = captureLogs(t);
  await assert.rejects(loadRunnerSession(path), /auth.json not found/);
  await writeFile(path, `{"cookies": [${AUTH}`, 'utf8');
  await assert.rejects(loadRunnerSession(path), (error) => {
    assert.equal(error.message, 'auth.json is not valid JSON. Re-import your X session.');
    assertNoSecrets(error.message);
    return true;
  });
  assert.equal(output(), '');
});

test('diagnostic titles redact raw and encoded credentials before truncating or printing controls', (t) => {
  const originalGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = GROQ;
  t.after(() => {
    if (originalGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroq;
  });
  const safe = redactRunnerDiagnostic(`Error\n${AUTH} ${encodeURIComponent(AUTH)} ${CSRF} ${GROQ}\u001b[31m ${'x'.repeat(600)}`, storageState().cookies);
  assertNoSecrets(safe);
  assert.ok(safe.includes('[REDACTED]'));
  assert.equal(/[\u0000-\u001f\u007f]/.test(safe), false);
  assert.equal(safe.length, 512);
});

test('login URL diagnostics recognize X login routes but not lookalike domains or tweet paths', () => {
  for (const path of ['/login', '/i/flow/login', '/login/?next=%2Fhome']) {
    assert.equal(isXLoginURL(`https://x.com${path}`), true);
    assert.equal(isXLoginURL(`https://mobile.twitter.com${path}`), true);
  }
  for (const url of ['https://notx.com/login', 'https://x.com.attacker.test/login', 'https://x.com/author/status/1', 'not a URL']) {
    assert.equal(isXLoginURL(url), false);
  }
});

test('hidden errors and ordinary success alerts do not block visible runner content', { timeout: 15_000 }, async (t) => {
  const output = captureLogs(t);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<div data-testid="error-detail" style="display:none">Failed</div><div role="alert">Your post was sent.</div><article data-testid="tweet">Fixture</article>');
  await waitForRunnerContent(page, READY, { timeoutMs: 2_000 });
  assert.equal(output(), '');
});

test('page-title diagnostics are best-effort and not duplicated after a closed browser', async (t) => {
  const output = captureLogs(t);
  const page = { url: () => 'https://x.com/login', context: () => ({ cookies: async () => [] }), title: async () => { throw new Error(AUTH); } };
  await reportRunnerPageFailure(page, storageState().cookies);
  await reportRunnerPageFailure(page, storageState().cookies);
  assert.equal(output().split('\n').length, 2);
  assert.match(output(), /Redirected to login page - cookies rejected by X/);
  assert.match(output(), /Page diagnostics unavailable/);
  assertNoSecrets(output());
});

for (const scenario of ['success', 'navigation-warning']) {
  test(`real runner CLI restores canonical cookies before navigation (${scenario})`, { timeout: 20_000 }, async (t) => {
    const result = await runCLI(t, scenario);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /\[RUNNER\] Loaded cookies for @zuckyeu: auth_token=present, ct0=present/);
    assert.match(result.output, /Dry run — nothing was posted or liked/);
    assertNoSecrets(result.output);
    assert.deepEqual(result.events.find((event) => event.type === 'cookies').cookies, normalizeXSessionCookies(storageState().cookies));
    assert.ok(result.events.findIndex((event) => event.type === 'cookies') < result.events.findIndex((event) => event.type === 'request'));
    assert.equal(result.events.at(-1).type, 'close');
    assert.equal(result.events.filter((event) => event.type === 'fetch').length, 2);
    if (scenario === 'navigation-warning') assert.match(result.output, /Navigation warning: net::ERR_CONNECTION_RESET \[REDACTED\]/);
  });
}

for (const scenario of ['home-login', 'target-login', 'target-flow-login', 'delayed-login', 'error-element', 'error-alert']) {
  test(`real runner CLI logs ${scenario} and stops before reply generation`, { timeout: 20_000 }, async (t) => {
    const result = await runCLI(t, scenario);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /\[RUNNER\] Loaded cookies for @zuckyeu: auth_token=present, ct0=present/);
    if (scenario.startsWith('error-')) {
      assert.match(result.output, /\[RUNNER\] Visible error element; page title: "X error \[REDACTED\]/);
      assert.match(result.output, /Failed: X displayed an error page/);
    } else {
      assert.match(result.output, /\[RUNNER\] Redirected to login page - cookies rejected by X/);
      assert.match(result.output, /Failed: X rejected the saved cookies/);
    }
    assert.equal((result.output.match(/page title:/g) ?? []).length, 1);
    assertNoSecrets(result.output);
    assert.equal(result.events.filter((event) => event.type === 'fetch').length, 0, 'A login/error page must never generate or publish a reply');
    assert.equal(result.events.at(-1).type, 'close');
    if (scenario !== 'home-login') assert.ok(result.events.some((event) => event.url === 'https://x.com/zuckyeu/status/1'));
  });
}

test('runner reuses a saved persistent profile headlessly and exports the refreshed state', { timeout: 30_000 }, async (t) => {
  const dataDir = await dataDirectory(t);
  const authFile = join(dataDir, 'auth.json');
  const recordFile = join(dataDir, 'browser-record.jsonl');
  const profileDir = join(dataDir, 'user_data', 'user-1', 'zuckyeu');
  const exportFile = join(dataDir, 'profile-export.json');
  await writeFile(authFile, JSON.stringify(storageState()), 'utf8');

  const child = spawn(process.execPath, ['--require', join(ROOT, 'test', 'fixtures', 'runner-browser.cjs'),
    'main.js', 'https://x.com/zuckyeu/status/1', '--dry-run', '--yes'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL: '', DATA_DIR: dataDir, AUTH_FILE_PATH: authFile,
      DOTENV_CONFIG_PATH: join(dataDir, 'absent.env'), GROQ_API_KEY: GROQ,
      X_ACCOUNT_USERNAME: 'zuckyeu',
      X_PROFILE_DIR: profileDir,
      X_PROFILE_HEADLESS: '1',
      X_SESSION_EXPORT_PATH: exportFile,
      SESSION_TEST_RUNNER_RECORD: recordFile,
      SESSION_TEST_RUNNER_SCENARIO: 'normal',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const record = await readFile(recordFile, 'utf8');
  const events = record.trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(code, 0, output);
  assert.match(output, /\[RUNNER\] Loaded cookies for @zuckyeu: auth_token=present, ct0=present/);
  assertNoSecrets(output);

  const launch = events.find((event) => event.type === 'persistent-launch');
  assert.ok(launch, 'the runner must launch the persistent profile');
  assert.equal(launch.directory, profileDir);
  assert.equal(launch.headless, true);
  assert.equal(events.some((event) => event.type === 'launch'), false);
  assert.ok(events.some((event) => event.type === 'request' && event.url === 'https://x.com/home'));
  assert.ok(events.some((event) => event.type === 'request' && event.url === 'https://x.com/zuckyeu/status/1'));
  await stat(profileDir);

  const exported = JSON.parse(await readFile(exportFile, 'utf8'));
  const cookies = new Map(exported.cookies.map((cookie) => [cookie.name, cookie]));
  assert.equal(cookies.get('auth_token').value, AUTH);
  assert.equal(cookies.get('ct0').value, CSRF);
});

test('real runner CLI fails safely on restoration errors and missing ct0 without navigating', { timeout: 20_000 }, async (t) => {
  const failure = await runCLI(t, 'restore-error');
  assert.equal(failure.code, 1);
  assert.match(failure.output, /Synthetic restoration error: \[REDACTED\]/);
  assertNoSecrets(failure.output);
  assert.equal(failure.events.filter((event) => event.type === 'request').length, 0);
  assert.equal(failure.events.at(-1).type, 'close');
  const missing = storageState();
  missing.cookies = missing.cookies.filter((cookie) => cookie.name !== 'ct0');
  const result = await runCLI(t, 'success', missing);
  assert.equal(result.code, 1);
  assert.match(result.output, /auth_token=present, ct0=missing/);
  assertNoSecrets(result.output);
  assert.equal(result.events.length, 0, 'Missing cookies must fail before launching Chromium');
});
