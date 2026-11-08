import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const dashboard = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
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
    runs: [],
    imports: [], switches: [], requests: [], replies: 0, logouts: 0,
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
    if (url.pathname === '/api/auth/logout') {
      state.authenticated = false;
      state.logouts += 1;
      return json({ ok: true, authenticated: false });
    }
    if (url.pathname === '/api/auth' || url.pathname === '/api/auth/me') {
      return json(state.authenticated ? {
        userAuthenticated: true, authenticated: state.accounts.length > 0,
        user: { username: 'dashboard_user', email: 'dashboard@example.test' },
        username: activeHandle(), activeXAccount: activeHandle(),
        xAccounts: state.accounts.map((account) => account.xUsername),
        accounts: state.accounts,
        ...health(),
      } : {
        authenticated: false, userAuthenticated: false, user: null, username: null,
        activeXAccount: null, xAccounts: [], accounts: [],
        xSessionValid: null, xSessionStatus: 'none', xSessionCheckedAt: null,
      });
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
      return json({ ok: true, activeXAccount: xUsername, accounts: state.accounts });
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
    for (const gate of [options.importGate, ...(options.importGates ?? []), options.groqGate]) gate?.resolve();
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
  return { page, context, state, errors, open, fill, submit };
}

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
  assert.deepEqual(errors, []);
});

test('a rejected re-authentication keeps the expired badge and the dialog open', { timeout: 20_000 }, async (t) => {
  const { page, state, errors } = await fixture(t, {
    accounts: [{ xUsername: 'alice', active: true, status: 'ready' }],
    xSessionStatus: 'invalid',
    importStatus: 422,
    importError: 'X rejected these cookies. Sign in to X again and copy fresh auth_token and ct0 values.',
  });

  await page.locator('#x-session-reconnect').click();
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
  assert.deepEqual(errors, []);
});
