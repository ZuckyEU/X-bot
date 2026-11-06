import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const dashboard = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

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
    authenticated: true, accounts: [], status: 'waiting',
    groqConfigured: options.groqConfigured ?? false,
    starts: [], polls: [], cancels: [], logouts: 0,
  };
  const errors = [];
  let baseUrl;
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, baseUrl);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(dashboard);
    }
    if (url.pathname.startsWith('/mock-viewer/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<title>Remote viewer fixture</title><p>Credential-free remote window fixture</p>');
    }
    if (url.pathname === '/api/auth/logout') {
      state.authenticated = false;
      state.logouts += 1;
      return json({ ok: true, authenticated: false });
    }
    if (url.pathname === '/api/auth') {
      return json(state.authenticated ? {
        userAuthenticated: true, authenticated: state.accounts.length > 0,
        user: { username: 'dashboard_user', email: 'dashboard@example.test' },
        username: state.accounts[0]?.xUsername ?? null,
        activeXAccount: state.accounts[0]?.xUsername ?? null,
      } : { authenticated: false, username: null });
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
    if (url.pathname === '/api/auth/x-accounts/interactive' && req.method === 'POST') {
      const body = JSON.parse(raw);
      state.starts.push(body);
      await options.startGate?.promise;
      return json({
        requestId: body.requestId, status: 'starting',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        viewerUrl: `${baseUrl}/mock-viewer/${body.requestId}#token=${'v'.repeat(43)}`,
      }, 201);
    }
    if (url.pathname.startsWith('/api/auth/x-accounts/interactive/')) {
      state.polls.push(url.pathname);
      await options.pollGate?.promise;
      return json({
        requestId: url.pathname.split('/').pop(), status: state.status,
        ...(state.status === 'completed' ? {
          username: 'alice', activeXAccount: 'alice', accounts: state.accounts,
        } : {}),
      });
    }
    if (url.pathname === '/auth/x/cancel') {
      state.cancels.push(raw ? JSON.parse(raw) : {});
      state.status = 'cancelled';
      return json({ ok: true, cancelled: true, closed: options.cancelClosed !== false, status: 'cancelled' });
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
    for (const gate of [options.startGate, options.pollGate, options.groqGate]) gate?.resolve();
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  if (options.popupBlocked) await context.addInitScript(() => { window.open = () => null; });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.getElementById('menu-username').textContent === 'dashboard_user');
  await page.locator('#auth-close').click();
  await page.locator('#auth-modal').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  const connect = async () => {
    await page.locator('#account-chip').click();
    await page.locator('#add-x-account').click();
    await until(() => state.starts.length === 1);
  };
  return { page, context, state, errors, baseUrl, connect };
}

test('dashboard opens an opener-isolated viewer and automatically reflects the saved account', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, baseUrl, connect } = await fixture(t);
  const popupReady = page.waitForEvent('popup');
  await connect();
  const popup = await popupReady;
  await popup.waitForURL((url) => url.origin === baseUrl && url.pathname.startsWith('/mock-viewer/'));
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.deepEqual(Object.keys(state.starts[0]), ['requestId']);
  assert.match(state.starts[0].requestId, /^[a-f0-9-]{36}$/i);
  assert.equal(await page.locator('#x-password').count(), 0);
  await until(() => state.polls.length > 0);
  state.accounts = [{ xUsername: 'alice', active: true, status: 'ready' }];
  state.status = 'completed';
  await page.waitForFunction(() => document.getElementById('who').textContent === '@alice');
  await page.locator('#remote-login-modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#add-x-account').isEnabled(), true);
  assert.match(await page.locator('#auth-msg').textContent(), /Connected @alice/);
  assert.deepEqual(errors, []);
});

test('dashboard cancels a pending START by request ID without launching a late viewer', { timeout: 20_000 }, async (t) => {
  const startGate = deferred();
  const { page, state, errors, connect } = await fixture(t, { startGate });
  const popupReady = page.waitForEvent('popup');
  await connect();
  const popup = await popupReady;
  assert.equal(popup.url(), 'about:blank');
  await page.locator('#remote-login-cancel').click();
  await page.locator('#remote-login-modal').waitFor({ state: 'hidden' });
  assert.deepEqual(state.cancels, [{ requestId: state.starts[0].requestId }]);
  assert.equal(await page.locator('#add-x-account').isEnabled(), true);
  startGate.resolve();
  await until(() => popup.isClosed());
  assert.match(await page.locator('#auth-msg').textContent(), /remote sign-in was stopped/i);
  assert.deepEqual(errors, []);
});

test('dashboard retains a private-link fallback when popups are blocked', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, connect } = await fixture(t, { popupBlocked: true });
  await connect();
  await page.waitForFunction(() => document.getElementById('remote-login-status').textContent.includes('Popup blocked'));
  const link = page.locator('#remote-login-open');
  assert.equal(await link.getAttribute('aria-disabled'), 'false');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await link.getAttribute('rel'), /noopener/);
  assert.match(await link.getAttribute('href'), new RegExp(`/mock-viewer/${state.starts[0].requestId}#token=`));
  await page.locator('#remote-login-cancel').click();
  await page.locator('#remote-login-modal').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});

test('dashboard preserves the warning when Fly cleanup cannot be confirmed', { timeout: 20_000 }, async (t) => {
  const { page, state, errors, connect } = await fixture(t, { popupBlocked: true, cancelClosed: false });
  await connect();
  await until(() => state.polls.length > 0);
  await page.locator('#remote-login-cancel').click();
  await page.locator('#remote-login-modal').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#auth-msg').textContent(), /Close could not be confirmed/);
  assert.equal(await page.locator('#add-x-account').isEnabled(), true);
  assert.deepEqual(errors, []);
});

test('dashboard ignores a stale completed poll after app logout', { timeout: 20_000 }, async (t) => {
  const pollGate = deferred();
  const { page, state, errors, connect } = await fixture(t, { popupBlocked: true, pollGate });
  await connect();
  await until(() => state.polls.length > 0);
  await page.evaluate(() => document.getElementById('signout').click());
  await page.waitForFunction(() => document.getElementById('who').textContent === 'Not connected');
  assert.equal(state.logouts, 1);
  state.accounts = [{ xUsername: 'alice', active: true, status: 'ready' }];
  state.status = 'completed';
  pollGate.resolve();
  await delay(100);
  assert.equal(await page.locator('#who').textContent(), 'Not connected');
  assert.equal(await page.locator('.linked-account-item').count(), 0);
  assert.equal(await page.locator('#groq-api-key').inputValue(), '');
  assert.equal(await page.locator('#add-x-account').isEnabled(), true);
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
