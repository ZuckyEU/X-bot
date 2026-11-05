import { chromium } from 'playwright';

const CONNECT_TIMEOUT_MS = 60_000;
const FALLBACK_ENDPOINT = 'wss://production-sfo.browserless.io?token=YOUR_API_KEY';

/** Connects Playwright to the remote Browserless Chromium instance. */
export async function connectBrowser() {
  const endpoint = process.env.BROWSERLESS_WS_ENDPOINT || FALLBACK_ENDPOINT;
  if (endpoint.includes('YOUR_API_KEY')) {
    console.warn(
      '[browser] BROWSERLESS_WS_ENDPOINT is not configured; using the placeholder endpoint. Set the real token in .env or the deployment environment.',
    );
  }
  return chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
}

const RECOVERABLE_NAVIGATION_ERROR =
  /net::ERR_(?:HTTP_RESPONSE_CODE_FAILURE|ABORTED|CONNECTION_(?:CLOSED|RESET|REFUSED)|NAME_NOT_RESOLVED|TIMED_OUT)/i;
const CLOSED_CONTEXT_ERROR =
  /Target page, context or browser has been closed|browser has been closed|browser has disconnected|Target closed/i;

/** Best-effort check for a browser context that is still attached and tracked. */
export function isContextOpen(context) {
  try {
    const browser = context?.browser?.();
    if (!browser?.isConnected()) return false;
    return browser.contexts().includes(context);
  } catch {
    return false;
  }
}

/**
 * Runs a context operation only while the browser is connected. Closed targets
 * are reported as a recoverable result instead of throwing Playwright errors.
 */
export async function safeContextCall(context, operation, label = 'Browser context operation') {
  if (!isContextOpen(context)) {
    return {
      ok: false,
      value: undefined,
      error: new Error(`${label} skipped because the browser context is closed or disconnected`),
    };
  }

  try {
    return { ok: true, value: await operation(), error: null };
  } catch (error) {
    if (CLOSED_CONTEXT_ERROR.test(String(error?.message ?? error))) {
      return {
        ok: false,
        value: undefined,
        error: new Error(`${label} failed because the browser context was closed: ${error.message}`),
      };
    }
    throw error;
  }
}

export function isRecoverableNavigationError(error) {
  return error?.name === 'TimeoutError' || RECOVERABLE_NAVIGATION_ERROR.test(String(error?.message ?? error));
}

/**
 * Navigates without letting bot challenges or non-2xx responses abort the
 * surrounding flow. Callers can inspect the returned error/status and continue.
 */
export async function safeGoto(page, url, options = {}) {
  try {
    const response = await page.goto(url, { waitUntil: 'commit', ...options });
    return { response, error: null };
  } catch (error) {
    if (!isRecoverableNavigationError(error)) throw error;
    return { response: null, error };
  }
}

/**
 * Browserless exposes one default context. Reuse it so proxy, profile and launch
 * settings from the remote browser are preserved; only create one if absent.
 */
export async function getDefaultContext(browser) {
  return browser.contexts()[0] ?? browser.newContext();
}

/** Reuses an open tab when possible so sessions do not accumulate blank pages. */
export async function getOrCreatePage(context) {
  const page = context.pages().find((candidate) => !candidate.isClosed());
  return page ?? context.newPage();
}

/** Closes the remote browser/session and never masks the caller's original error. */
export async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // The remote session may already be gone; cleanup must not throw.
  }
}
