import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const dashboard = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const PROFILE_DELETION_MESSAGE = 'User profile, Groq API key, and associated X sessions completely deleted.';
const PROFILE_DELETION_WARNING = 'Are you sure you want to permanently delete your app profile? This will permanently remove your saved Groq API Key, X accounts, and all dashboard settings.';
const cookieValues = (handle = 'alice') => ({
  handle,
  auth_token: `${handle.replace(/^@/, '')}_synthetic_auth_token`,
  ct0: `${handle.replace(/^@/, '')}_synthetic_csrf_token`,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Dashboard condition did not become true');
}

async function fixture(t, options = {}) {
  const state = {
    authenticated: true,
    accounts: options.accounts ?? [],
    groqConfigured: options.groqConfigured ?? false,
    importStatus: options.importStatus ?? 201,
    xSessionStatus: options.xSessionStatus ?? 'valid',
    runStatus: options.runStatus ?? 200,
    deletionStatus: options.deletionStatus ?? 200,
    runs: [],
    imports: [], switches: [], requests: [], deletions: [], replies: 0, logouts: 0, authReplies: 0,
  };
  const health = () => ({
    xSessionValid: state.xSessionStatus === 'valid' ? true
      : state.xSessionStatus === 'invalid' ? false : null,
    xSessionStatus: state.xSessionStatus,
    xSessionCheckedAt: new Date().toISOString(),
  });
  const errors = [];
  let baseUrl;
  const activate = (handle) => {
    state.accounts = state.accounts.map((account) => ({ ...account, active: account.xUsername === handle }));
  };
  const activeHandle = () => state.accounts.find((account) => account.active)?.xUsername ?? null;
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, baseUrl);
    state.requests.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(dashboard);
    }
    if (url.pathname === '/api/auth/me' && req.method === 'DELETE') {
      state.deletions.push({ cookie: req.headers.cookie, body: raw });
      await options.profileDeletionGate?.promise;
      if (state.deletionStatus !== 200) {
        if (state.deletionStatus === 401) state.authenticated = false;
        return json({ error: options.deletionError ?? 'User profile deletion could not finish. Retry to complete the cleanup.' }, state.deletionStatus);
      }
      state.authenticated = false;
      state.groqConfigured = false;
      state.accounts = [];
      res.setHeader('set-cookie', 'x_engine_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
      return json({ success: true, message: PROFILE_DELETION_MESSAGE });
    }
    if (url.pathname === '/api/auth/logout') {
      state.logouts += 1;
      await options.logoutGate?.promise;
      state.authenticated = false;
      return json({ ok: true, authenticated: false });
    }
    if (url.pathname === '/api/auth' || url.pathname === '/api/auth/me') {
      const body = state.authenticated ? {
        userAuthenticated: true, authenticated: state.accounts.length > 0,
        user: { username: 'dashboard_user', email: 'dashboard@example.test' },
        username: activeHandle(), activeXAccount: activeHandle(),
        xAccounts: state.accounts.map((account) => account.xUsername),
        accounts: structuredClone(state.accounts),
        ...health(),
      } : {
        authenticated: false, userAuthenticated: false, user: null, username: null,
        activeXAccount: null, xAccounts: [], accounts: [],
        xSessionValid: null, xSessionStatus: 'none', xSessionCheckedAt: null,
      };
      await options.authGate?.promise;
      state.authReplies += 1;
      return json(body);
    }
    if (!state.authenticated && ['/api/config/groq', '/api/auth/x-accounts', '/api/history'].includes(url.pathname)) {
      return json({ error: 'Authentication required' }, 401);
    }
    if (url.pathname === '/api/config/groq') {
      if (req.method === 'DELETE') {
        state.groqConfigured = false;
        await options.groqGate?.promise;
      }
      return json({
        configured: state.groqConfigured,
        source: state.groqConfigured ? 'account' : 'none',
        preview: state.groqConfigured ? 'gsk_…test (52 chars)' : null,
      });
    }
    if (url.pathname === '/api/history') return json([]);
    if (url.pathname === '/api/auth/x-accounts') return json(state.accounts);
    if (url.pathname === '/api/run' && req.method === 'POST') {
      state.runs.push(JSON.parse(raw || '{}'));
      await options.runGate?.promise;
      return json(options.runBody ?? {
        error: 'X connection expired for @alice. Re-authenticate the account before publishing.',
        code: 'X_SESSION_EXPIRED',
        xSessionValid: false,
        xSessionStatus: 'invalid',
      }, state.runStatus);
    }
    if (url.pathname === '/api/auth/import-session' && req.method === 'POST') {
      const body = JSON.parse(raw);
      const index = state.imports.length;
      state.imports.push({ body, cookie: req.headers.cookie });
      await (options.importGates?.[index] ?? options.importGate)?.promise;
      state.replies += 1;
      if (state.importStatus !== 201) {
        if (state.importStatus === 401) state.authenticated = false;
        return json({ error: options.importError ?? 'A run is already in progress' }, state.importStatus);
      }
      const handle = body.handle.trim().replace(/^@/, '').toLowerCase();
      if (!state.accounts.some((account) => account.xUsername === handle)) {
        state.accounts.push({ xUsername: handle, active: false, status: 'ready' });
      }
      activate(handle);
      state.xSessionStatus = options.importSessionStatus ?? 'valid';
      return json({
        ok: true, username: handle, activeXAccount: handle, accounts: state.accounts, ...health(),
      }, 201);
    }
    if (url.pathname === '/api/auth/switch-account' && req.method === 'POST') {
      const { xUsername } = JSON.parse(raw);
      state.switches.push(xUsername);
      activate(xUsername);
      if (options.switchSessionStatus) state.xSessionStatus = options.switchSessionStatus;
      return json({
        ok: true, activeXAccount: xUsername, accounts: state.accounts,
        ...(options.switchSessionStatus ? health() : {}),
      });
    }
    if (url.pathname.startsWith('/api/auth/x-accounts/') && req.method === 'DELETE') {
      const handle = decodeURIComponent(url.pathname.split('/').pop());
      const wasActive = activeHandle() === handle;
      state.accounts = state.accounts.filter((account) => account.xUsername !== handle);
      if (wasActive) activate(state.accounts[0]?.xUsername ?? null);
      return json({ ok: true, activeXAccount: activeHandle(), accounts: state.accounts });
    }
    return json({ error: 'Unknown fixture route' }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    for (const gate of [options.importGate, ...(options.importGates ?? []), options.groqGate, options.profileDeletionGate, options.authGate, options.logoutGate, options.runGate]) gate?.resolve();
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'x_engine_session', value: 'synthetic-app-session', url: baseUrl, httpOnly: true }]);
  await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.getElementById('menu-username').textContent === 'dashboard_user');
  await page.locator('#auth-close').click();
  await page.locator('#auth-modal').waitFor({ state: 'hidden' });
  await until(async () => await page.locator('.linked-account-item').count() === state.accounts.length);
  assert.deepEqual(errors, []);
  const open = async () => {
    await page.locator('#account-chip').click();
    await page.locator('#add-x-account').click();
    await page.locator('#session-import-modal').waitFor({ state: 'visible' });
  };
  const fill = async (values = cookieValues()) => {
    await page.locator('#session-handle').fill(values.handle);
    await page.locator('#session-auth-token').fill(values.auth_token);
    await page.locator('#session-ct0').fill(values.ct0);
  };
  const submit = async () => {
    const count = state.imports.length;
    await page.locator('#session-import-submit').click();
    await until(() => state.imports.length === count + 1);
  };
  const openDeletion = async () => {
    await page.locator('#account-chip').click();
    await page.locator('#delete-profile').click();
    await page.locator('#delete-profile-dialog').waitFor({ state: 'visible' });
  };
  const deletionLanding = async () => {
    await page.waitForFunction(() => document.getElementById('signup-tab').classList.contains('active')
      && !document.getElementById('profile-toast').classList.contains('hidden'));
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).search, '');
  };
  return { page, context, state, errors, open, fill, submit, openDeletion, deletionLanding };
}

test('profile deletion has a red menu option, an explicit warning, and safe cancellation', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, openDeletion } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }], groqConfigured: true,
  });
  await page.evaluate(() => localStorage.setItem('cached-groq-key', 'synthetic-key-must-survive-cancel'));
  await openDeletion();
  assert.equal(await page.locator('#delete-profile').textContent(), 'Delete Profile');
  assert.equal(await page.locator('#delete-profile').evaluate((button) => getComputedStyle(button).color), 'rgb(255, 116, 126)');
  assert.equal(await page.locator('#delete-profile-warning').textContent(), PROFILE_DELETION_WARNING);
  assert.match(await page.locator('#delete-profile-dialog').textContent(), /Your actual X accounts will not be deleted/);
  assert.equal(await page.locator('#cancel-delete-profile').evaluate((button) => document.activeElement === button), true);
  await page.locator('#cancel-delete-profile').click();
  await page.locator('#delete-profile-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement.id === 'account-chip');
  await openDeletion();
  await page.keyboard.press('Escape');
  await page.locator('#delete-profile-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(state.deletions, []);
  assert.equal(state.authenticated, true);
  assert.equal(state.groqConfigured, true);
  assert.equal(await page.locator('#who').textContent(), '@alice');
  assert.equal(await page.evaluate(() => localStorage.getItem('cached-groq-key')), 'synthetic-key-must-survive-cancel');
  assert.deepEqual(errors, []);
});

test('profile deletion confirmation fits mobile screens and keeps keyboard focus in the dialog', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, openDeletion } = await fixture(t, { viewport: { width: 390, height: 844 } });
  await openDeletion();
  const bounds = await page.locator('#delete-profile-dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#confirm-delete-profile').evaluate((button) => document.activeElement === button), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#delete-profile-dialog').evaluate((dialog) => dialog.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await page.locator('#delete-profile-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(state.deletions, []);
  assert.deepEqual(errors, []);
});

test('profile deletion clears all cached keys and settings, expires the cookie, and redirects with a success toast', { timeout: 20_000 }, async (t) => {
  const { page, context, state, errors, openDeletion, deletionLanding } = await fixture(t, {
    accounts: [
      { xUsername: 'alice', active: true, status: 'ready' },
      { xUsername: 'bob', active: false, status: 'ready' },
    ], groqConfigured: true,
  });
  await page.evaluate(() => {
    localStorage.setItem('groq_api_key', 'gsk_synthetic_deleted_profile_key');
    localStorage.setItem('x-engine-session-token', 'legacy-app-token');
    localStorage.setItem('dashboard-settings', JSON.stringify({ tone: 'direct', theme: 'dark' }));
    sessionStorage.setItem('groqApiKey', 'gsk_synthetic_deleted_profile_key');
    sessionStorage.setItem('draft', 'private draft');
  });
  await page.locator('#groq-api-key').fill('gsk_synthetic_unsaved_key');
  await page.locator('#run-url').fill('https://x.com/alice/status/1');
  await openDeletion();
  await page.locator('#confirm-delete-profile').click();
  await deletionLanding();
  assert.equal(state.deletions.length, 1);
  assert.match(state.deletions[0].cookie, /x_engine_session=synthetic-app-session/);
  assert.equal(state.deletions[0].body, '');
  assert.equal(state.requests.filter((request) => request.method === 'DELETE' && request.path === '/api/auth/me').length, 1);
  assert.equal(state.authenticated, false);
  assert.equal(state.groqConfigured, false);
  assert.deepEqual(state.accounts, []);
  assert.equal((await context.cookies()).some((cookie) => cookie.name === 'x_engine_session'), false);
  assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), { local: {}, session: {} });
  assert.equal(await page.locator('#auth-modal').isVisible(), true);
  assert.equal(await page.locator('#auth-title').textContent(), 'Create your account');
  assert.equal(await page.locator('#profile-toast').textContent(), PROFILE_DELETION_MESSAGE);
  assert.equal(await page.locator('#groq-api-key').inputValue(), '');
  assert.equal(await page.locator('#run-url').inputValue(), '');
  assert.equal(await page.locator('.linked-account-item').count(), 0);
  assert.match(await page.locator('#history-list').textContent(), /Sign in/);
  const rendered = await page.locator('body').innerText();
  for (const secret of ['gsk_synthetic_deleted_profile_key', 'gsk_synthetic_unsaved_key', 'legacy-app-token', 'private draft']) {
    assert.equal(rendered.includes(secret), false);
  }
  assert.deepEqual(errors, []);
});

test('pending profile deletion suppresses duplicate requests and prevents cancellation or conflicting actions', { timeout: 20_000 }, async (t) => {
  const profileDeletionGate = deferred();
  const { page, state, errors, openDeletion, deletionLanding } = await fixture(t, {
    profileDeletionGate, groqConfigured: true,
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
  });
  await openDeletion();
  await page.locator('#confirm-delete-profile').click();
  await until(() => state.deletions.length === 1);
  assert.equal(await page.locator('#delete-profile-dialog').getAttribute('aria-busy'), 'true');
  for (const id of ['confirm-delete-profile', 'cancel-delete-profile', 'delete-profile', 'signout', 'run', 'dry-run-btn', 'add-x-account', 'save-groq-key', 'clear-groq-key']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#delete-profile-dialog').isVisible(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#delete-profile-dialog').evaluate((dialog) => dialog.contains(document.activeElement)), true);
  await page.evaluate(() => {
    void deleteProfile();
    void deleteProfile();
    void startRun(false);
    void saveGroqApiKey();
    void switchXAccount('bob');
    void unlinkXAccount('alice');
  });
  assert.equal(state.deletions.length, 1);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.switches, []);
  assert.equal(state.logouts, 0);
  profileDeletionGate.resolve();
  await deletionLanding();
  assert.equal(state.deletions.length, 1);
  assert.deepEqual(errors, []);
});

for (const status of [409, 503]) {
  test(`a ${status} profile deletion failure preserves saved data and permits an explicit retry`, { timeout: 20_000 }, async (t) => {
    const { page, state, errors, openDeletion, deletionLanding } = await fixture(t, {
      deletionStatus: status, groqConfigured: true,
      accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    });
    await page.evaluate(() => {
      localStorage.setItem('cached-key', 'synthetic-saved-key');
      sessionStorage.setItem('dashboard-settings', 'must-survive-failure');
    });
    await openDeletion();
    await page.locator('#confirm-delete-profile').click();
    await page.waitForFunction(() => document.getElementById('delete-profile-error').textContent.includes('Retry to complete the cleanup'));
    assert.equal(await page.locator('#delete-profile-dialog').isVisible(), true);
    assert.equal(await page.locator('#confirm-delete-profile').isEnabled(), true);
    assert.equal(await page.locator('#cancel-delete-profile').isEnabled(), true);
    assert.equal(await page.locator('#delete-profile-dialog').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#who').textContent(), '@alice');
    assert.equal(await page.locator('#profile-toast').isVisible(), false);
    assert.equal(state.authenticated, true);
    assert.equal(state.groqConfigured, true);
    assert.equal(state.accounts.length, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('cached-key')), 'synthetic-saved-key');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('dashboard-settings')), 'must-survive-failure');
    state.deletionStatus = 200;
    await page.locator('#confirm-delete-profile').click();
    await deletionLanding();
    assert.equal(state.deletions.length, 2);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    assert.deepEqual(errors, []);
  });
}

test('an unauthenticated profile deletion returns to sign-in without claiming a successful deletion', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, openDeletion } = await fixture(t, {
    deletionStatus: 401, groqConfigured: true, accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
  });
  await page.evaluate(() => localStorage.setItem('saved-setting', 'not-confirmed-deleted'));
  await openDeletion();
  await page.locator('#confirm-delete-profile').click();
  await page.locator('#auth-modal').waitFor({ state: 'visible' });
  assert.match(await page.locator('#auth-error').textContent(), /Your app session expired/);
  assert.equal(await page.locator('#delete-profile-dialog').isVisible(), false);
  assert.equal(await page.locator('#profile-toast').isVisible(), false);
  assert.equal(await page.locator('#who').textContent(), 'Not connected');
  assert.equal(await page.locator('#groq-api-key').inputValue(), '');
  assert.equal(await page.locator('.linked-account-item').count(), 0);
  assert.equal(await page.locator('#signin-tab').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('saved-setting')), 'not-confirmed-deleted');
  assert.equal(state.deletions.length, 1);
  assert.deepEqual(errors, []);
});

test('profile deletion cannot race an app logout already in progress', { timeout: 20_000 }, async (t) => {
  const logoutGate = deferred();
  const { page, state, errors } = await fixture(t, { logoutGate });
  await page.locator('#account-chip').click();
  await page.locator('#signout').click();
  await until(() => state.logouts === 1);
  assert.equal(await page.locator('#delete-profile').isDisabled(), true);
  await page.evaluate(() => {
    openProfileDeletion();
    void deleteProfile();
  });
  assert.equal(await page.locator('#delete-profile-dialog').isVisible(), false);
  assert.deepEqual(state.deletions, []);
  logoutGate.resolve();
  await page.waitForFunction(() => document.getElementById('who').textContent === 'Not connected');
  assert.equal(await page.locator('#delete-profile').isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('aborting a run for profile deletion cannot overwrite deletion status or re-enable its controls', { timeout: 20_000 }, async (t) => {
  const runGate = deferred();
  const profileDeletionGate = deferred();
  const { page, state, errors, openDeletion, deletionLanding } = await fixture(t, {
    runGate, profileDeletionGate, runStatus: 409, groqConfigured: true,
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
  });
  await page.locator('#run-url').fill('https://x.com/alice/status/1');
  await page.evaluate(() => { window.pendingRun = startRun(false); });
  await until(() => state.runs.length === 1);
  await openDeletion();
  await page.locator('#confirm-delete-profile').click();
  await until(() => state.deletions.length === 1);
  await page.evaluate(() => window.pendingRun);
  assert.equal(await page.locator('#status').textContent(), 'Deleting profile');
  assert.equal(await page.locator('#x-session-warning').isVisible(), false);
  for (const id of ['run', 'dry-run-btn', 'save-groq-key', 'delete-profile']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
  }
  runGate.resolve();
  profileDeletionGate.resolve();
  await deletionLanding();
  assert.equal(await page.locator('#who').textContent(), 'Not connected');
  assert.deepEqual(errors, []);
});

test('profile deletion is unavailable after app logout', { timeout: 20_000 }, async (t) => {
  const { page, state, errors } = await fixture(t);
  await page.locator('#account-chip').click();
  await page.locator('#signout').click();
  await page.waitForFunction(() => document.getElementById('who').textContent === 'Not connected');
  await page.locator('#account-chip').click();
  assert.equal(await page.locator('#delete-profile').isDisabled(), true);
  await page.evaluate(() => openProfileDeletion());
  assert.equal(await page.locator('#auth-modal').isVisible(), true);
  assert.equal(await page.locator('#delete-profile-dialog').isVisible(), false);
  assert.deepEqual(state.deletions, []);
  assert.deepEqual(errors, []);
});

test('a stale bootstrap cannot unlock controls or restore a profile during deletion', { timeout: 20_000 }, async (t) => {
  const options = {
    profileDeletionGate: deferred(), groqConfigured: true,
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
  };
  const { page, state, errors, openDeletion, deletionLanding } = await fixture(t, options);
  options.authGate = deferred();
  const repliesBefore = state.authReplies;
  const requestsBefore = state.requests.filter((request) => request.path === '/api/auth/me').length;
  await page.evaluate(() => { window.pendingBootstrap = loadAuth(); });
  await until(() => state.requests.filter((request) => request.path === '/api/auth/me').length === requestsBefore + 1);
  await openDeletion();
  await page.locator('#confirm-delete-profile').click();
  await until(() => state.deletions.length === 1);
  options.authGate.resolve();
  await until(() => state.authReplies === repliesBefore + 1);
  await page.evaluate(() => window.pendingBootstrap);
  for (const id of ['delete-profile', 'run', 'dry-run-btn', 'save-groq-key']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
  }
  options.profileDeletionGate.resolve();
  await deletionLanding();
  assert.equal(await page.locator('#who').textContent(), 'Not connected');
  assert.equal(await page.locator('.linked-account-item').count(), 0);
  assert.deepEqual(errors, []);
});

test('dashboard imports only masked cookie values and immediately activates the account without opening a viewer', { timeout: 20_000 }, async (t) => {
  const { page, context, state, errors, open, fill, submit } = await fixture(t);
  const values = cookieValues('@Alice');
  await open();
  assert.equal(await page.locator('#session-handle').evaluate((input) => document.activeElement === input), true);
  await fill(values);
  for (const id of ['session-auth-token', 'session-ct0']) {
    assert.equal(await page.locator(`#${id}`).getAttribute('type'), 'password');
  }
  assert.equal(await page.locator('#x-password').count(), 0);
  await submit();
  await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  assert.deepEqual(state.imports[0].body, values);
  assert.match(state.imports[0].cookie, /x_engine_session=synthetic-app-session/);
  assert.equal(await page.locator('#who').textContent(), '@alice');
  assert.match(await page.locator('#auth-msg').textContent(), /Imported session for @alice/);
  assert.match(await page.locator('#status-detail').textContent(), /connection is active/);
  assert.equal(await page.locator('.linked-account-item.active').count(), 1);
  assert.equal(await page.locator('#session-import-modal').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#session-handle').inputValue(), '');
  assert.equal(await page.locator('#session-auth-token').inputValue(), '');
  assert.equal(await page.locator('#session-ct0').inputValue(), '');
  assert.equal(context.pages().length, 1);
  assert.equal(state.requests.some((request) => /interactive|remote-login|harvest/.test(request.path)), false);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  const rendered = await page.locator('body').innerText();
  for (const secret of [values.auth_token, values.ct0]) {
    assert.equal(storage.includes(secret), false);
    assert.equal(rendered.includes(secret), false);
  }
  assert.equal(await page.locator('#add-x-account').isEnabled(), true);
  assert.deepEqual(errors, []);
});

test('pending imports clear secret inputs, disable conflicting controls, and suppress duplicate submissions', { timeout: 20_000 }, async (t) => {
  const importGate = deferred();
  const { page, state, errors, open, fill, submit } = await fixture(t, { importGate });
  await open();
  await fill();
  await submit();
  assert.equal(await page.locator('#session-auth-token').inputValue(), '');
  assert.equal(await page.locator('#session-ct0').inputValue(), '');
  assert.equal(await page.locator('#session-import-form').getAttribute('aria-busy'), 'true');
  for (const id of ['session-handle', 'session-auth-token', 'session-ct0', 'session-import-submit', 'run', 'dry-run-btn', 'add-x-account']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
  }
  await page.evaluate(() => document.getElementById('session-import-form').requestSubmit());
  assert.equal(state.imports.length, 1);
  importGate.resolve();
  await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#session-import-form').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#run').isEnabled(), true);
  assert.deepEqual(errors, []);
});

test('a failed import leaves linked accounts intact and requires repasting cookies for a retry', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, open, fill, submit } = await fixture(t, {
    importStatus: 409, accounts: [{ xUsername: 'bob', active: true, status: 'ready' }],
  });
  await open();
  await fill();
  await submit();
  await page.waitForFunction(() => document.getElementById('session-import-error').textContent.includes('A run is already in progress'));
  assert.equal(await page.locator('#who').textContent(), '@bob');
  assert.equal(await page.locator('.linked-account-item').count(), 1);
  assert.equal(await page.locator('#session-import-modal').isVisible(), true);
  assert.equal(await page.locator('#session-handle').inputValue(), 'alice');
  assert.equal(await page.locator('#session-auth-token').inputValue(), '');
  assert.equal(await page.locator('#session-ct0').inputValue(), '');
  assert.equal(await page.locator('#session-import-submit').isEnabled(), true);
  state.importStatus = 201;
  await fill();
  await submit();
  await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#who').textContent(), '@alice');
  assert.equal(await page.locator('.linked-account-item').count(), 2);
  assert.deepEqual(errors, []);
});

test('closing or leaving the dialog clears cookies and keyboard navigation stays inside it', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, open, fill } = await fixture(t, { viewport: { width: 390, height: 844 } });
  for (const action of ['close', 'escape', 'navigation']) {
    await open();
    await fill();
    await page.locator('#session-import-submit').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#session-import-close').evaluate((button) => document.activeElement === button), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#session-import-submit').evaluate((button) => document.activeElement === button), true);
    if (action === 'close') await page.locator('#session-import-close').click();
    else if (action === 'escape') await page.keyboard.press('Escape');
    else await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
    for (const id of ['session-handle', 'session-auth-token', 'session-ct0']) {
      assert.equal(await page.locator(`#${id}`).inputValue(), '');
    }
    if (action !== 'navigation') {
      assert.equal(await page.locator('#account-chip').evaluate((button) => document.activeElement === button), true);
    }
    assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('import-open')), false);
  }
  assert.equal(state.imports.length, 0);
  assert.deepEqual(errors, []);
});

test('native form validation prevents missing cookies and invalid handles from reaching the import endpoint', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, open, fill } = await fixture(t);
  await open();
  await fill({ ...cookieValues(), handle: '../escape' });
  await page.locator('#session-import-submit').click();
  assert.equal(await page.locator('#session-handle').evaluate((input) => input.validity.patternMismatch), true);
  await page.locator('#session-handle').fill('alice');
  await page.locator('#session-ct0').fill('');
  await page.locator('#session-import-submit').click();
  assert.equal(await page.locator('#session-ct0').evaluate((input) => input.validity.valueMissing), true);
  assert.equal(state.imports.length, 0);
  assert.equal(await page.locator('#session-import-modal').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('a response from a closed import cannot update or unlock a newer import', { timeout: 20_000 }, async (t) => {
  const oldGate = deferred();
  const newGate = deferred();
  const { page, state, errors, open, fill, submit } = await fixture(t, { importGates: [oldGate, newGate] });
  await open();
  await fill(cookieValues('alice'));
  await submit();
  await page.locator('#session-import-close').click();
  await open();
  await fill(cookieValues('bob'));
  await submit();
  oldGate.resolve();
  await until(() => state.replies === 1);
  assert.equal(await page.locator('#session-import-modal').isVisible(), true);
  assert.equal(await page.locator('#session-import-form').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#session-import-submit').isDisabled(), true);
  assert.equal(await page.locator('#who').textContent(), 'dashboard_user');
  newGate.resolve();
  await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#who').textContent(), '@bob');
  assert.deepEqual(errors, []);
});

test('dashboard ignores a late import response after app logout and clears all pasted cookies', { timeout: 20_000 }, async (t) => {
  const importGate = deferred();
  const { page, state, errors, open, fill, submit } = await fixture(t, { importGate });
  await open();
  await fill();
  await submit();
  await page.evaluate(() => document.getElementById('signout').click());
  await page.waitForFunction(() => document.getElementById('who').textContent === 'Not connected');
  assert.equal(state.logouts, 1);
  importGate.resolve();
  await until(() => state.replies === 1);
  assert.equal(await page.locator('#who').textContent(), 'Not connected');
  assert.equal(await page.locator('.linked-account-item').count(), 0);
  assert.equal(await page.locator('#session-import-modal').isVisible(), false);
  assert.equal(await page.locator('#session-auth-token').inputValue(), '');
  assert.equal(await page.locator('#session-ct0').inputValue(), '');
  assert.equal(await page.locator('#groq-api-key').inputValue(), '');
  assert.deepEqual(errors, []);
});

test('an expired app session closes the importer and asks the user to sign in again', { timeout: 20_000 }, async (t) => {
  const { page, errors, open, fill, submit } = await fixture(t, { importStatus: 401, importError: 'Invalid or expired session' });
  await open();
  await fill();
  await submit();
  await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  await page.locator('#auth-modal').waitFor({ state: 'visible' });
  assert.match(await page.locator('#auth-msg').textContent(), /Your app session expired/);
  assert.equal(await page.locator('#who').textContent(), 'Not connected');
  assert.equal(await page.locator('#session-auth-token').inputValue(), '');
  assert.equal(await page.locator('#session-ct0').inputValue(), '');
  assert.deepEqual(errors, []);
});

test('imported accounts remain switchable and unlinking the active account selects the remaining account', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, open, fill, submit } = await fixture(t);
  for (const handle of ['alice', 'bob']) {
    await open();
    await fill(cookieValues(handle));
    await submit();
    await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  }
  assert.equal(await page.locator('#who').textContent(), '@bob');
  await page.locator('#account-chip').click();
  await page.getByRole('menuitem', { name: 'Switch to @alice', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('who').textContent === '@alice');
  assert.deepEqual(state.switches, ['alice']);
  await page.locator('#account-chip').click();
  await page.getByRole('button', { name: 'Unlink @alice', exact: true }).click();
  await until(() => state.accounts.length === 1);
  await page.waitForFunction(() => document.getElementById('auth-msg').textContent.includes('Unlinked @alice'));
  assert.equal(await page.locator('#who').textContent(), '@bob');
  assert.equal(await page.locator('.linked-account-item').count(), 1);
  assert.deepEqual(errors, []);
});

test('dashboard clears a Groq key without retaining a late response after logout', { timeout: 20_000 }, async (t) => {
  const groqGate = deferred();
  const { page, state, errors } = await fixture(t, { groqConfigured: true, groqGate });
  await page.waitForFunction(() => !document.getElementById('clear-groq-key').disabled);
  await page.locator('#clear-groq-key').click();
  await until(() => state.groqConfigured === false);
  await page.locator('#account-chip').click();
  await page.locator('#signout').click();
  await page.waitForFunction(() => document.getElementById('who').textContent === 'Not connected');
  groqGate.resolve();
  await delay(100);
  assert.match(await page.locator('#groq-key-status').textContent(), /Sign in to configure/);
  assert.equal(await page.locator('#clear-groq-key').isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('expired X session shows the reconnection badge, disables publishing, and re-authenticates', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, submit } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    xSessionStatus: 'invalid',
  });

  assert.equal(await page.locator('#x-session-warning').isVisible(), true);
  assert.match(await page.locator('#x-session-warning').innerText(), /X Connection Expired — Reconnection Needed/);
  assert.match(await page.locator('#x-session-warning-detail').textContent(), /@alice/);
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#dry-run-btn').isEnabled(), true);
  assert.equal(await page.locator('#active-account-label').textContent(), 'X session expired');
  assert.equal(await page.locator('#account-chip').evaluate((chip) => chip.classList.contains('expired')), true);

  await page.locator('#account-chip').click();
  const account = page.locator('.linked-account-item[data-x-username="alice"]');
  assert.equal(await account.locator('.session-expired').textContent(), 'Session Expired');
  assert.equal(await account.locator('.account-check').count(), 0);
  assert.equal(await account.getByRole('button', { name: 'Update session for @alice', exact: true }).isVisible(), true);
  await page.locator('#account-chip').click();

  await page.locator('#x-session-reconnect').click();
  await page.locator('#session-import-modal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#session-import-title').textContent(), 'Re-authenticate X account');
  assert.equal(
    await page.locator('#session-import-subtitle').textContent(),
    'Update the cookies for @alice to restore publishing.',
  );
  assert.equal(await page.locator('#session-handle').inputValue(), 'alice');
  assert.equal(await page.locator('#session-handle').evaluate((input) => input.readOnly), true);
  assert.equal(await page.locator('#session-import-submit').textContent(), 'Re-authenticate account');
  assert.equal(
    await page.locator('#session-auth-token').evaluate((input) => document.activeElement === input),
    true,
  );

  const values = cookieValues('alice');
  await page.locator('#session-auth-token').fill(values.auth_token);
  await page.locator('#session-ct0').fill(values.ct0);
  await submit();
  await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  assert.equal(state.imports[0].body.handle, 'alice');
  assert.equal(await page.locator('#x-session-warning').isVisible(), false);
  assert.equal(await page.locator('#run').isEnabled(), true);
  assert.equal(await page.locator('#active-account-label').textContent(), 'X connection verified');
  assert.match(await page.locator('#auth-msg').textContent(), /Re-authenticated @alice/);
  assert.equal(await page.locator('#session-handle').evaluate((input) => input.readOnly), false);
  await page.locator('#account-chip').click();
  assert.equal(await account.locator('.linked-account-copy span').textContent(), 'Active');
  assert.equal(await account.locator('.update-x-session').count(), 0);
  assert.equal(await account.locator('.account-check').textContent(), '✓');
  assert.deepEqual(errors, []);
});

for (const [source, accountState] of [
  ['xSessionValid=false', { status: 'ready', xSessionValid: false }],
  ['status=expired', { status: 'expired' }],
]) {
  test(`the account dropdown offers Update Session for ${source} and restores Active after validation`, { timeout: 20_000 }, async (t) => {
    const importGate = deferred();
    const { page, state, errors, submit } = await fixture(t, {
      accounts: [{ xUsername: 'zuckyeu', active: true, ...accountState }],
      xSessionStatus: 'unknown',
      importGate,
    });
    await page.locator('#account-chip').click();
    const account = page.locator('.linked-account-item[data-x-username="zuckyeu"]');
    const update = account.getByRole('button', { name: 'Update session for @zuckyeu', exact: true });
    assert.equal(await account.locator('.session-expired').textContent(), 'Session Expired');
    assert.equal(await account.locator('.session-expired').evaluate((tag) => getComputedStyle(tag).color), 'rgb(255, 116, 126)');
    assert.equal(await account.locator('.account-check').count(), 0);
    assert.equal(await update.textContent(), 'Update Session');
    assert.equal(await page.locator('#run').isDisabled(), true);

    await update.click();
    await page.locator('#session-import-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#account-dropdown').isVisible(), false);
    assert.equal(await page.locator('#session-import-title').textContent(), 'Re-authenticate X account');
    assert.equal(await page.locator('#session-handle').inputValue(), 'zuckyeu');
    assert.equal(await page.locator('#session-handle').evaluate((input) => input.readOnly), true);
    assert.match(await page.locator('#session-import-subtitle').textContent(), /@zuckyeu/);
    assert.equal(await page.locator('#session-auth-token').inputValue(), '');
    assert.equal(await page.locator('#session-ct0').inputValue(), '');
    assert.equal(await page.locator('#session-auth-token').evaluate((input) => document.activeElement === input), true);
    assert.deepEqual(state.switches, []);
    assert.equal(state.imports.length, 0);

    const values = cookieValues('zuckyeu');
    await page.locator('#session-auth-token').fill(values.auth_token);
    await page.locator('#session-ct0').fill(values.ct0);
    await submit();
    assert.equal(await account.locator('.update-x-session').isDisabled(), true);
    assert.equal(await account.locator('.session-expired').textContent(), 'Session Expired');
    assert.equal(await account.locator('.account-check').count(), 0);
    importGate.resolve();
    await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
    assert.deepEqual(state.imports[0].body, values);
    assert.deepEqual(state.switches, []);
    assert.equal(await page.locator('#account-chip').evaluate((button) => document.activeElement === button), true);
    await page.locator('#account-chip').click();
    assert.equal(await account.locator('.linked-account-copy span').textContent(), 'Active');
    assert.equal(await account.locator('.session-expired').count(), 0);
    assert.equal(await account.locator('.update-x-session').count(), 0);
    assert.equal(await account.locator('.account-check').textContent(), '✓');
    assert.equal(await account.locator('.account-check').evaluate((check) => getComputedStyle(check).color), 'rgb(77, 141, 255)');
    assert.equal(await page.locator('#run').isEnabled(), true);
    assert.deepEqual(errors, []);
  });
}

test('Update Session targets an inactive account without switching before cookie submission', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, submit } = await fixture(t, {
    accounts: [
      { xUsername: 'alice', active: true, status: 'ready' },
      { xUsername: 'zuckyeu', active: false, status: 'expired' },
      { xUsername: 'bob', active: false, status: 'ready', xSessionValid: false },
    ],
    viewport: { width: 390, height: 844 },
  });
  const account = page.locator('.linked-account-item[data-x-username="zuckyeu"]');
  const otherExpired = page.locator('.linked-account-item[data-x-username="bob"]');
  await page.locator('#account-chip').click();
  const update = account.getByRole('button', { name: 'Update session for @zuckyeu', exact: true });
  assert.equal(await account.locator('.session-expired').textContent(), 'Session Expired');
  assert.equal(await page.locator('#run').isEnabled(), true);
  const menuBounds = await page.locator('#account-dropdown').boundingBox();
  const updateBounds = await update.boundingBox();
  assert.ok(updateBounds.x >= menuBounds.x && updateBounds.x + updateBounds.width <= menuBounds.x + menuBounds.width);
  await update.click();
  await page.locator('#session-import-modal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#session-handle').inputValue(), 'zuckyeu');
  assert.equal(await page.locator('#who').textContent(), '@alice');
  assert.deepEqual(state.switches, []);

  await page.locator('#session-import-close').click();
  assert.equal(await page.locator('#account-chip').evaluate((button) => document.activeElement === button), true);
  await page.locator('#account-chip').click();
  await update.click();
  const values = cookieValues('zuckyeu');
  await page.locator('#session-auth-token').fill(values.auth_token);
  await page.locator('#session-ct0').fill(values.ct0);
  await submit();
  await page.locator('#session-import-modal').waitFor({ state: 'hidden' });
  assert.deepEqual(state.imports[0].body, values);
  assert.equal(await page.locator('#who').textContent(), '@zuckyeu');
  assert.deepEqual(state.switches, []);
  await page.locator('#account-chip').click();
  assert.equal(await account.locator('.linked-account-copy span').textContent(), 'Active');
  assert.equal(await account.locator('.account-check').textContent(), '✓');
  assert.equal(await account.locator('.update-x-session').count(), 0);
  assert.equal(await otherExpired.locator('.session-expired').textContent(), 'Session Expired');
  assert.equal(await otherExpired.locator('.update-x-session').count(), 1);
  assert.deepEqual(errors, []);
});

test('a rejected re-authentication keeps the expired badge and the dialog open', { timeout: 20_000 }, async (t) => {
  const { page, state, errors } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    xSessionStatus: 'invalid',
    importStatus: 422,
    importError: 'X rejected these cookies. Sign in to X again and copy fresh auth_token and ct0 values.',
  });

  await page.locator('#account-chip').click();
  const account = page.locator('.linked-account-item[data-x-username="alice"]');
  await account.getByRole('button', { name: 'Update session for @alice', exact: true }).click();
  await page.locator('#session-import-modal').waitFor({ state: 'visible' });
  const values = cookieValues('alice');
  await page.locator('#session-auth-token').fill(values.auth_token);
  await page.locator('#session-ct0').fill(values.ct0);
  const count = state.imports.length;
  await page.locator('#session-import-submit').click();
  await until(() => state.imports.length === count + 1);
  await page.waitForFunction(() =>
    document.getElementById('session-import-error').textContent.includes('X rejected these cookies'),
  );

  assert.equal(await page.locator('#session-import-modal').isVisible(), true);
  assert.equal(await page.locator('#x-session-warning').isVisible(), true);
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#session-import-submit').isEnabled(), true);
  assert.equal(await account.locator('.session-expired').textContent(), 'Session Expired');
  assert.equal(await account.locator('.account-check').count(), 0);
  assert.equal(await account.locator('.update-x-session').isEnabled(), true);
  assert.deepEqual(errors, []);
});

test('switching away from an expired account preserves its Update Session action without expiring the selected account', { timeout: 20_000 }, async (t) => {
  const { page, state, errors } = await fixture(t, {
    accounts: [
      { xUsername: 'alice', active: true, status: 'expired', xSessionValid: false, xSessionStatus: 'invalid' },
      { xUsername: 'bob', active: false, status: 'ready', xSessionValid: true, xSessionStatus: 'valid' },
    ],
    xSessionStatus: 'invalid', switchSessionStatus: 'valid',
  });
  assert.equal(await page.locator('#run').isDisabled(), true);
  await page.locator('#account-chip').click();
  await page.getByRole('menuitem', { name: 'Switch to @bob', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('who').textContent === '@bob');
  assert.equal(await page.locator('#x-session-warning').isVisible(), false);
  assert.equal(await page.locator('#run').isEnabled(), true);
  assert.equal(await page.locator('#active-account-label').textContent(), 'X connection verified');
  await page.locator('#account-chip').click();
  const expired = page.locator('.linked-account-item[data-x-username="alice"]');
  const active = page.locator('.linked-account-item[data-x-username="bob"]');
  assert.equal(await expired.locator('.session-expired').textContent(), 'Session Expired');
  assert.equal(await expired.locator('.update-x-session').count(), 1);
  assert.equal(await active.locator('.session-expired').count(), 0);
  assert.equal(await active.locator('.account-check').textContent(), '✓');
  await expired.locator('.update-x-session').click();
  await page.locator('#session-import-modal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#session-handle').inputValue(), 'alice');
  assert.equal(await page.locator('#who').textContent(), '@bob');
  assert.deepEqual(state.switches, ['bob']);
  assert.deepEqual(errors, []);
});

test('an unknown X health result does not mark the session expired', { timeout: 20_000 }, async (t) => {
  const { page, errors } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    xSessionStatus: 'unknown',
  });

  assert.equal(await page.locator('#x-session-warning').isVisible(), false);
  assert.equal(await page.locator('#run').isEnabled(), true);
  assert.equal(await page.locator('#active-account-label').textContent(), 'Active X account');
  assert.equal(await page.locator('#account-chip').evaluate((chip) => chip.classList.contains('expired')), false);

  await page.locator('#account-chip').click();
  await page.waitForFunction(() => document.getElementById('who').textContent === '@alice');
  const account = page.locator('.linked-account-item[data-x-username="alice"]');
  assert.equal(await account.locator('.linked-account-copy span').textContent(), 'Active');
  assert.equal(await account.locator('.account-check').count(), 1);
  assert.equal(await account.locator('.update-x-session').count(), 0);
  assert.deepEqual(errors, []);
});

test('an unavailable X check keeps the importer open without marking the saved account expired', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, open, fill, submit } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    importStatus: 503,
    importError: 'X session verification is unavailable. Retry shortly; your saved session has not been changed.',
  });
  await open();
  await fill(cookieValues('bob'));
  await submit();
  await page.waitForFunction(() => document.getElementById('session-import-error').textContent.includes('verification is unavailable'));
  assert.equal(await page.locator('#session-import-modal').isVisible(), true);
  assert.equal(await page.locator('#session-import-submit').isEnabled(), true);
  assert.equal(await page.locator('#session-auth-token').inputValue(), '');
  assert.equal(await page.locator('#session-ct0').inputValue(), '');
  assert.equal(await page.locator('#who').textContent(), '@alice');
  assert.equal(await page.locator('#x-session-warning').isVisible(), false);
  assert.equal(await page.locator('#account-chip').evaluate((chip) => chip.classList.contains('expired')), false);
  assert.deepEqual(state.accounts, [{ xUsername: 'alice', active: true, status: 'ready' }]);
  assert.deepEqual(errors, []);
});

test('an unavailable X check is retryable and does not trigger session-expired UI', { timeout: 20_000 }, async (t) => {
  const { page, state, errors } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    xSessionStatus: 'valid',
    groqConfigured: true,
    runStatus: 503,
    runBody: {
      error: 'X could not confirm the session through its settings endpoint. Retry shortly; publishing has not started.',
      code: 'X_SESSION_CHECK_UNAVAILABLE',
      xSessionValid: null,
      xSessionStatus: 'unknown',
    },
  });
  await page.locator('#run-url').fill('https://x.com/alice/status/1');
  await page.locator('#run').click();
  await until(() => state.runs.length === 1);
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Run failed' && !document.getElementById('run').disabled);
  assert.match(await page.locator('#status-detail').textContent(), /Retry shortly/);
  assert.equal(await page.locator('#x-session-warning').isVisible(), false);
  assert.equal(await page.locator('#active-account-label').textContent(), 'Active X account');
  assert.equal(await page.locator('#account-chip').evaluate((chip) => chip.classList.contains('expired')), false);
  await page.locator('#run').click();
  await until(() => state.runs.length === 2);
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Run failed' && !document.getElementById('run').disabled);
  await page.locator('#account-chip').click();
  const account = page.locator('.linked-account-item[data-x-username="alice"]');
  assert.equal(await account.locator('.linked-account-copy span').textContent(), 'Active');
  assert.equal(await account.locator('.session-expired').count(), 0);
  assert.equal(await account.locator('.update-x-session').count(), 0);
  assert.deepEqual(errors, []);
});

test('a backend X_SESSION_EXPIRED response switches the dashboard to reconnection mode', { timeout: 20_000 }, async (t) => {
  const { page, state, errors } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    xSessionStatus: 'valid',
    groqConfigured: true,
    runStatus: 409,
  });

  await page.locator('#run-url').fill('https://x.com/alice/status/1');
  await page.locator('#run').click();
  await until(() => state.runs.length === 1);
  await page.waitForFunction(() => document.getElementById('x-session-warning').classList.contains('hidden') === false);

  assert.equal(await page.locator('#status').textContent(), 'Reconnection needed');
  assert.match(await page.locator('#status-detail').textContent(), /Re-authenticate the account/);
  assert.match(await page.locator('#auth-msg').textContent(), /X connection expired/);
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#active-account-label').textContent(), 'X session expired');
  await page.locator('#account-chip').click();
  const account = page.locator('.linked-account-item[data-x-username="alice"]');
  assert.equal(await account.locator('.session-expired').textContent(), 'Session Expired');
  assert.equal(await account.locator('.account-check').count(), 0);
  assert.equal(await account.locator('.update-x-session').isEnabled(), true);
  assert.deepEqual(errors, []);
});
