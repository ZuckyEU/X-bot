import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { verifyXSessionInBrowser } from '../lib/x-session-health.js';

const credentials = { auth_token: 'synthetic_health_auth_token', ct0: 'synthetic_health_ct0' };
const home = `<!doctype html><html><body>
  <button data-testid="SideNav_AccountSwitcher_Button">Account</button>
  <a data-testid="AppTabBar_Home_Link" href="/home">Home</a>
  <main data-testid="primaryColumn"><article data-testid="tweet">Fixture home feed</article></main>
</body></html>`;

async function browserFixture(t, { html = home, redirect = null, status = 200, abort = false } = {}) {
  const launch = chromium.launch.bind(chromium);
  const state = { launches: [], browsers: [], cookies: [], requests: [], blocked: [], closed: 0 };
  t.mock.method(chromium, 'launch', async (options) => {
    state.launches.push(options);
    const browser = await launch(options);
    state.browsers.push(browser);
    browser.once('disconnected', () => { state.closed += 1; });
    const newContext = browser.newContext.bind(browser);
    t.mock.method(browser, 'newContext', async (options) => {
      const context = await newContext(options);
      context.on('requestfailed', (request) => state.blocked.push(request.resourceType()));
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        state.requests.push(url.href);
        if (url.hostname !== 'x.com' || abort) return route.abort();
        state.cookies = await context.cookies('https://x.com');
        if (url.pathname === '/home' && redirect) {
          return route.fulfill({ status: 302, headers: { location: `https://x.com${redirect}` }, body: '' });
        }
        return route.fulfill({
          status: url.pathname === '/home' ? status : 200,
          contentType: 'text/html',
          body: url.pathname === '/home' ? html : '<html><body>Sign in</body></html>',
        });
      });
      return context;
    });
    return browser;
  });
  t.after(async () => { await Promise.all(state.browsers.map((browser) => browser.close().catch(() => {}))); });
  return state;
}

test('the local browser validates a rendered home feed with isolated cookies and closes Chromium', { timeout: 15_000 }, async (t) => {
  const state = await browserFixture(t, { html: home.replace('</body>', '<img src="https://x.com/unused-image.png"></body>') });
  const original = structuredClone(credentials);
  const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 5_000 });
  assert.equal(result.status, 'valid');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.reason, 'authenticated-home');
  assert.deepEqual(credentials, original);
  assert.equal(state.launches.length, 1);
  assert.equal(state.launches[0].headless, true);
  assert.deepEqual(state.launches[0].args, ['--no-sandbox']);
  assert.ok(state.launches[0].timeout > 0 && state.launches[0].timeout <= 5_000);
  assert.deepEqual(state.cookies.map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'auth_token', value: credentials.auth_token }, { name: 'ct0', value: credentials.ct0 },
  ]);
  assert.ok(state.cookies.every((cookie) => cookie.domain === '.x.com' && cookie.secure));
  assert.ok(state.blocked.includes('image'));
  assert.equal(state.closed, 1);
  assert.equal(state.browsers[0].isConnected(), false);
});

for (const redirect of ['/login', '/i/flow/login']) {
  test(`a browser redirect to ${redirect} explicitly rejects the session`, { timeout: 15_000 }, async (t) => {
    const state = await browserFixture(t, { redirect });
    const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 5_000 });
    assert.equal(result.status, 'invalid');
    assert.equal(result.httpStatus, 401);
    assert.equal(result.reason, 'login-redirect');
    assert.equal(result.url, `https://x.com${redirect}`);
    assert.equal(state.closed, 1);
  });
}

test('the browser waits for the feed instead of accepting an initial home shell', { timeout: 15_000 }, async (t) => {
  await browserFixture(t, { html: `<html><body><script>
    setTimeout(() => { document.body.innerHTML = ${JSON.stringify(home.match(/<body>([\s\S]*)<\/body>/)[1])}; }, 150);
  </script></body></html>` });
  const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 5_000 });
  assert.equal(result.status, 'valid');
});

test('a client-side login redirect is detected while the page is loading', { timeout: 15_000 }, async (t) => {
  await browserFixture(t, { html: '<html><body><script>setTimeout(() => history.replaceState(null, "", "/i/flow/login"), 150)</script></body></html>' });
  const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 5_000 });
  assert.equal(result.status, 'invalid');
  assert.equal(result.httpStatus, 401);
});

for (const [name, html] of [
  ['an empty home shell', '<html><body>Loading…</body></html>'],
  ['a public home link', '<html><body><a data-testid="AppTabBar_Home_Link">Home</a></body></html>'],
  ['a hidden authenticated shell', home.replace('<body>', '<body style="display:none">')],
  ['an account-access challenge', '<html><body><script>history.replaceState(null, "", "/account/access")</script>Check your browser</body></html>'],
]) {
  test(`${name} remains unknown rather than valid or expired`, { timeout: 15_000 }, async (t) => {
    const state = await browserFixture(t, { html });
    const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 1_500 });
    assert.equal(result.status, 'unknown');
    assert.equal(result.httpStatus, 503);
    assert.equal(result.reason, 'browser-timeout');
    assert.equal(state.closed, 1);
  });
}

test('a missing home endpoint cannot validate even if its HTML contains feed markers', { timeout: 15_000 }, async (t) => {
  const state = await browserFixture(t, { status: 404 });
  const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 5_000 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.httpStatus, 503);
  assert.equal(state.closed, 1);
});

test('browser navigation failures return unavailable and preserve the input cookies', { timeout: 15_000 }, async (t) => {
  const state = await browserFixture(t, { abort: true });
  const original = structuredClone(credentials);
  const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 5_000 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.httpStatus, 503);
  assert.equal(result.reason, 'browser-error');
  assert.deepEqual(credentials, original);
  assert.equal(state.closed, 1);
});

test('launch errors expose no cookies and never become an expired-session result', async (t) => {
  t.mock.method(chromium, 'launch', async () => { throw new Error(`Launch failed: ${credentials.auth_token}`); });
  const result = await verifyXSessionInBrowser(credentials);
  assert.equal(result.status, 'unknown');
  assert.equal(result.httpStatus, 503);
  assert.equal(result.reason, 'browser-error');
  assert.equal(JSON.stringify(result).includes(credentials.auth_token), false);
});

test('a browser arriving after the overall deadline is still closed', async (t) => {
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  let contexts = 0;
  t.mock.method(chromium, 'launch', async () => {
    await delay(150);
    return { close: async () => close(), newContext: async () => { contexts += 1; } };
  });
  const result = await verifyXSessionInBrowser(credentials, { timeoutMs: 50 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'browser-timeout');
  await closed;
  assert.equal(contexts, 0);
});

test('a timed-out launch keeps the browser reservation until its late arrival is closed', async (t) => {
  let launches = 0;
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  t.mock.method(chromium, 'launch', async () => {
    launches += 1;
    await delay(150);
    return { close: async () => close() };
  });
  const first = await verifyXSessionInBrowser(credentials, { timeoutMs: 50 });
  assert.equal(first.reason, 'browser-timeout');
  const busy = await verifyXSessionInBrowser({ auth_token: 'other_auth', ct0: 'other_ct0' });
  assert.equal(busy.reason, 'browser-busy');
  await closed;
  await delay(0);
  assert.equal(launches, 1);
});

test('overlapping different-cookie browser probes return retryable busy instead of launching twice', { timeout: 15_000 }, async (t) => {
  const state = await browserFixture(t, { html: '<html><body>Loading</body></html>' });
  const first = verifyXSessionInBrowser(credentials, { timeoutMs: 1_500 });
  const busy = await verifyXSessionInBrowser({ auth_token: 'other_synthetic_auth', ct0: 'other_synthetic_ct0' });
  assert.equal(busy.status, 'unknown');
  assert.equal(busy.httpStatus, 503);
  assert.equal(busy.reason, 'browser-busy');
  assert.equal((await first).status, 'unknown');
  assert.equal(state.launches.length, 1);
  assert.equal(state.closed, 1);
});

test('missing cookies are rejected without launching Chromium', async (t) => {
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => { launches += 1; });
  const result = await verifyXSessionInBrowser({ auth_token: 'synthetic' });
  assert.equal(result.status, 'invalid');
  assert.equal(result.httpStatus, 401);
  assert.equal(launches, 0);
});
