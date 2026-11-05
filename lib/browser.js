import { chromium } from 'playwright';

const CONNECT_TIMEOUT_MS = 60_000;
const FALLBACK_ENDPOINT = 'wss://production-sfo.browserless.io?token=YOUR_API_KEY';
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CHROME_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const CHROME_EXTRA_HTTP_HEADERS = Object.freeze({
  'accept-language': CHROME_ACCEPT_LANGUAGE,
  'upgrade-insecure-requests': '1',
});
const CHROME_USER_AGENT_METADATA = Object.freeze({
  brands: [
    { brand: 'Chromium', version: '122' },
    { brand: 'Google Chrome', version: '122' },
    { brand: 'Not(A:Brand', version: '24' },
  ],
  fullVersion: '122.0.0.0',
  fullVersionList: [
    { brand: 'Chromium', version: '122.0.0.0' },
    { brand: 'Google Chrome', version: '122.0.0.0' },
    { brand: 'Not(A:Brand', version: '24.0.0.0' },
  ],
  platform: 'Windows',
  platformVersion: '10.0.0',
  architecture: 'x86',
  bitness: '64',
  model: '',
  mobile: false,
  wow64: false,
});
const pageIdentitySessions = new WeakMap();

async function applyChromeHeaders(context) {
  try {
    await context.setExtraHTTPHeaders(CHROME_EXTRA_HTTP_HEADERS);
  } catch (error) {
    console.warn(`[browser] Could not apply Chrome request headers: ${error.message}`);
  }
}

async function applyChromeUserAgent(context, page) {
  if (pageIdentitySessions.has(page)) return;

  let cdpSession;
  try {
    cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Network.setUserAgentOverride', {
      userAgent: CHROME_USER_AGENT,
      acceptLanguage: CHROME_ACCEPT_LANGUAGE,
      platform: 'Win32',
      userAgentMetadata: CHROME_USER_AGENT_METADATA,
    });
    pageIdentitySessions.set(page, cdpSession);
  } catch (error) {
    await detachCdpSession(cdpSession);
    console.warn(`[browser] Could not apply the Chrome user agent: ${error.message}`);
  }
}

/**
 * Optional Browserless session lifetime. Not set by default because it must not
 * exceed the account's plan limit; operators on paid plans can raise it.
 */
export function withSessionTimeout(endpoint, timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value < 30_000) return endpoint;
  try {
    const url = new URL(endpoint);
    url.searchParams.set('timeout', String(Math.round(value)));
    return url.toString();
  } catch {
    return endpoint;
  }
}

/** Connects Playwright to the remote Browserless Chromium instance. */
export async function connectBrowser() {
  const configuredEndpoint = process.env.BROWSERLESS_WS_ENDPOINT || FALLBACK_ENDPOINT;
  const endpoint = withSessionTimeout(configuredEndpoint, process.env.BROWSERLESS_SESSION_TIMEOUT_MS);
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
  const context = browser.contexts()[0] ?? browser.newContext();
  await applyChromeHeaders(context);
  return context;
}

/** Reuses an open tab when possible so sessions do not accumulate blank pages. */
export async function getOrCreatePage(context) {
  const page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
  await applyChromeUserAgent(context, page);
  return page;
}

async function detachCdpSession(session) {
  try {
    await session?.detach?.();
  } catch {
    // The CDP session may already be gone with the remote browser.
  }
}

/**
 * Mints a Browserless Live URL for an interactive hand-off. The returned link
 * is a short-lived bearer credential: send it only to the authenticated user and
 * keep the Playwright connection open while they use it.
 */
export async function createLiveInspection(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let cdpSession;

  try {
    cdpSession = await page.context().newCDPSession(page);
  } catch (error) {
    throw new Error(`Could not create a Browserless inspection session: ${error.message}`);
  }

  let live;
  try {
    const payload = {
      timeout: timeoutMs,
      interactable: true,
      resizable: true,
      showBrowserInterface: true,
    };
    if (options.instructions) payload.instructions = options.instructions;
    if (options.doneLabel) payload.doneLabel = options.doneLabel;
    if (options.requesterName) payload.requesterName = options.requesterName;

    live = await cdpSession.send('Browserless.liveURL', payload);
  } catch (error) {
    await detachCdpSession(cdpSession);
    throw new Error(`Browserless could not create a live inspection link: ${error.message}`);
  }

  if (live?.error) {
    await detachCdpSession(cdpSession);
    throw new Error(`Browserless could not create a live inspection link: ${live.error}`);
  }
  if (!live?.liveURL) {
    await detachCdpSession(cdpSession);
    throw new Error('Browserless did not return a live inspection URL');
  }

  const onComplete = (event) => options.onComplete?.(event);
  const onViewerConnected = (event) => options.onViewerConnected?.(event);
  cdpSession.on('Browserless.liveComplete', onComplete);
  cdpSession.on('Browserless.liveViewerConnected', onViewerConnected);

  const appliedTimeout = Number(live.timeout);
  const expiresAt = Date.now() + (Number.isFinite(appliedTimeout) && appliedTimeout > 0 ? appliedTimeout : timeoutMs);

  return {
    liveURL: live.liveURL,
    liveURLId: live.liveURLId,
    expiresAt,
    async close() {
      // Remove listeners first so our own close does not arrive as a late event.
      try {
        cdpSession.off?.('Browserless.liveComplete', onComplete);
        cdpSession.off?.('Browserless.liveViewerConnected', onViewerConnected);
      } catch {
        // Listener cleanup is best-effort.
      }
      try {
        if (live.liveURLId) {
          await cdpSession.send('Browserless.closeLiveURL', { liveURLId: live.liveURLId });
        }
      } catch {
        // The link may already be closed, expired, or outlived the browser.
      }
      await detachCdpSession(cdpSession);
    },
  };
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
