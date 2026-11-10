import { applyStealthProfile, closeBrowser, connectBrowser, getOrCreatePage } from './browser.js';

const X_HOME_URL = 'https://x.com/home';
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
let browserProbeActive = false;

/** Executed in the page: a home URL alone, public shell, or challenge is not authentication. */
function authenticatedPageState() {
  if (!/(^|\.)(x|twitter)\.com$/i.test(window.location.hostname)) return null;
  if (/^\/(?:login|i\/flow\/login)\/?$/.test(window.location.pathname)) return 'invalid';
  if (!/^\/home\/?$/.test(window.location.pathname)) return null;

  const visible = (selector) => [...document.querySelectorAll(selector)].some((element) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  });
  const accountMenu = visible('[data-testid="SideNav_AccountSwitcher_Button"]');
  const homeLink = visible('[data-testid="AppTabBar_Home_Link"]');
  const feed = visible('[data-testid="primaryColumn"] [data-testid="tweet"], [data-testid="primaryColumn"] [data-testid="tweetTextarea_0"], [data-testid="primaryColumn"] [role="region"]');
  return accountMenu && homeLink && feed ? 'valid' : null;
}

/** Read-only fallback: a fresh local browser/context never writes or refreshes saved cookies. */
export async function verifyXSessionInBrowser(credentials, { timeoutMs = 15_000 } = {}) {
  const unavailable = (reason) => ({ status: 'unknown', httpStatus: 503, reason, url: X_HOME_URL });
  if (!credentials?.auth_token || !credentials?.ct0) {
    return { status: 'invalid', httpStatus: 401, reason: 'missing-cookies', url: X_HOME_URL };
  }
  // Keep health probes from exhausting a small container. Same-cookie callers
  // are deduplicated by the server; other callers can retry rather than queue forever.
  if (browserProbeActive) return unavailable('browser-busy');
  browserProbeActive = true;

  let browser = null;
  let closing = null;
  let timer;
  let expired = false;
  const close = () => browser ? (closing ??= closeBrowser(browser)) : Promise.resolve();
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (expired || milliseconds <= 0) {
      const error = new Error('X browser verification timed out');
      error.name = 'TimeoutError';
      throw error;
    }
    return milliseconds;
  };
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      void close();
      resolve(unavailable('browser-timeout'));
    }, timeoutMs);
    timer.unref?.();
  });

  const probe = (async () => {
    try {
      browser = await connectBrowser({ timeout: remaining() });
      // A launch can finish after the outer deadline. Close late arrivals too.
      remaining();
      const context = await browser.newContext({ serviceWorkers: 'block' });
      remaining();
      await applyStealthProfile(context);
      remaining();
      await context.addCookies(['auth_token', 'ct0'].map((name) => ({
        name,
        value: credentials[name],
        domain: '.x.com',
        path: '/',
        expires: -1,
        secure: true,
        httpOnly: name === 'auth_token',
        sameSite: 'Lax',
      })));
      await context.route('**/*', (route) => BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())
        ? route.abort()
        : route.fallback());
      remaining();
      const page = await getOrCreatePage(context);
      const response = await page.goto(X_HOME_URL, { waitUntil: 'domcontentloaded', timeout: remaining() });
      if (response?.status() !== 200) return unavailable('browser-http-error');
      const state = await page.waitForFunction(authenticatedPageState, undefined, {
        polling: 100,
        timeout: remaining(),
      });
      const status = await state.jsonValue();
      await state.dispose();
      remaining();
      return {
        status,
        httpStatus: status === 'valid' ? 200 : 401,
        reason: status === 'valid' ? 'authenticated-home' : 'login-redirect',
        url: page.url(),
      };
    } catch (error) {
      // Browser errors can contain request details. Expose only a safe classification.
      return unavailable(expired || error?.name === 'TimeoutError' ? 'browser-timeout' : 'browser-error');
    } finally {
      await close();
      // Retain the reservation until even a late launch has finished cleanup.
      browserProbeActive = false;
    }
  })();

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
    await close();
  }
}
