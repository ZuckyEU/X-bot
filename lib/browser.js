import { chromium } from 'playwright';

const CONNECT_TIMEOUT_MS = 60_000;
const BROWSERLESS_STEALTH_ENDPOINT = 'wss://production-sfo.browserless.io/stealth';
export const X_LOGIN_URL = 'https://x.com/i/flow/login';
export const X_REFERER = 'https://x.com/';
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
// CDP expands the secondary language with q=0.9 in the outgoing header.
const CHROME_ACCEPT_LANGUAGE = 'en-US,en';
// Chromium derives sec-ch-ua* from this metadata. Do not force those headers
// through setExtraHTTPHeaders: they would be copied to X's cross-origin API
// requests, trigger CORS preflights, and break the onboarding flow.
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
const stealthContexts = new WeakSet();

/**
 * Runs before any page script so the browser does not advertise the usual
 * headless/automation fingerprint. Kept dependency-free so it also works with
 * Browserless' existing CDP context, where launcher plugins cannot run.
 */
function stealthInitScript() {
  const defineGetter = (target, property, value) => {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: true,
        get: () => value,
      });
    } catch {
      // Some browser builds expose non-configurable descriptors.
    }
  };

  defineGetter(Navigator.prototype, 'webdriver', false);
  defineGetter(Navigator.prototype, 'platform', 'Win32');
  defineGetter(Navigator.prototype, 'languages', Object.freeze(['en-US', 'en']));
  defineGetter(Navigator.prototype, 'hardwareConcurrency', 8);
  defineGetter(Navigator.prototype, 'deviceMemory', 8);
  defineGetter(Navigator.prototype, 'vendor', 'Google Inc.');

  const permissionStatus = (state) => ({
    state,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
  const permissionsPrototype = window.navigator.permissions
    ? Object.getPrototypeOf(window.navigator.permissions)
    : null;
  const originalPermissionQuery = permissionsPrototype?.query;
  if (typeof originalPermissionQuery === 'function') {
    try {
      Object.defineProperty(permissionsPrototype, 'query', {
        configurable: true,
        writable: true,
        value: function query(descriptor) {
          if (descriptor?.name === 'notifications') {
            const permission = typeof Notification === 'undefined' ? 'default' : Notification.permission;
            return Promise.resolve(permissionStatus(permission === 'default' ? 'prompt' : permission));
          }
          return originalPermissionQuery.apply(this, arguments);
        },
      });
    } catch {
      // Preserve the browser's native permissions implementation when sealed.
    }
  }

  const runtime = {
    OnInstalledReason: {
      CHROME_UPDATE: 'chrome_update',
      INSTALL: 'install',
      SHARED_MODULE_UPDATE: 'shared_module_update',
      UPDATE: 'update',
    },
    OnRestartRequiredReason: {
      APP_UPDATE: 'app_update',
      OS_UPDATE: 'os_update',
      PERIODIC: 'periodic',
    },
    PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
    PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
    connect() {
      throw new TypeError('Error in invocation of runtime.connect: No matching signature.');
    },
    sendMessage() {
      throw new TypeError('Error in invocation of runtime.sendMessage: No matching signature.');
    },
    id: undefined,
  };
  let chrome = window.chrome;
  if (!chrome) {
    try {
      chrome = {};
      Object.defineProperty(window, 'chrome', { configurable: true, value: chrome });
    } catch {
      // A page may define this first; either way it is present.
    }
  }
  if (chrome && !chrome.runtime) {
    try {
      Object.defineProperty(chrome, 'runtime', { configurable: true, enumerable: true, value: runtime });
    } catch {
      // Preserve a native runtime implementation when it is non-configurable.
    }
  }

  const patchWebGL = (prototype) => {
    if (!prototype || typeof prototype.getParameter !== 'function') return;
    const originalGetParameter = prototype.getParameter;
    try {
      prototype.getParameter = function getParameter(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel(R) UHD Graphics 630';
        return originalGetParameter.apply(this, arguments);
      };
    } catch {
      // Leave the native WebGL implementation intact when patching is blocked.
    }
  };
  patchWebGL(window.WebGLRenderingContext?.prototype);
  patchWebGL(window.WebGL2RenderingContext?.prototype);

  const patchCanvasReadback = (prototype, method) => {
    const original = prototype?.[method];
    if (typeof original !== 'function') return;
    try {
      prototype[method] = function patchedCanvasReadback() {
        try {
          const context = this.getContext('2d');
          if (context) {
            const pixel = context.getImageData(0, 0, 1, 1);
            if (pixel?.data?.length >= 4) {
              pixel.data[3] = pixel.data[3] === 0 ? 1 : pixel.data[3];
              context.putImageData(pixel, 0, 0);
            }
          }
        } catch {
          // Tainted or zero-sized canvases cannot be adjusted.
        }
        return original.apply(this, arguments);
      };
    } catch {
      // Leave the native canvas implementation intact when patching is blocked.
    }
  };
  patchCanvasReadback(window.HTMLCanvasElement?.prototype, 'toDataURL');
  patchCanvasReadback(window.HTMLCanvasElement?.prototype, 'toBlob');
}

async function applyStealthProfile(context) {
  if (stealthContexts.has(context)) return;
  try {
    await context.addInitScript(stealthInitScript);
    const profilePage = (page) => applyChromeUserAgent(context, page);
    context.on?.('page', (page) =>
      profilePage(page).catch((error) => console.warn(`[browser] ${error.message}`)),
    );
    await Promise.all(
      context.pages().filter((page) => !page.isClosed()).map((page) => profilePage(page)),
    );
    stealthContexts.add(context);
  } catch (error) {
    throw new Error(`Could not initialize the Browserless stealth profile: ${error.message}`);
  }
}

function restoreLocalStorageInitScript(originSnapshots) {
  const snapshot = originSnapshots.find((candidate) => candidate.origin === window.location.origin);
  if (!snapshot) return;

  try {
    for (const entry of snapshot.localStorage) {
      // Do not overwrite values that X has already refreshed during this run.
      if (window.localStorage.getItem(entry.name) === null) {
        window.localStorage.setItem(entry.name, entry.value);
      }
    }
  } catch {
    // Storage can be unavailable in opaque or sandboxed documents.
  }
}

/** Restores cookies and localStorage from a Playwright storage-state object. */
export async function restoreStorageState(context, storageState, { clearCookies = false } = {}) {
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  const origins = (Array.isArray(storageState?.origins) ? storageState.origins : [])
    .filter((entry) => {
      try {
        const url = new URL(entry?.origin);
        return (url.protocol === 'https:' || url.protocol === 'http:') && Array.isArray(entry.localStorage);
      } catch {
        return false;
      }
    })
    .map((entry) => ({
      origin: new URL(entry.origin).origin,
      localStorage: entry.localStorage
        .filter((item) => typeof item?.name === 'string' && typeof item?.value === 'string')
        .map(({ name, value }) => ({ name, value })),
    }));

  if (clearCookies) await context.clearCookies();
  if (cookies.length > 0) await context.addCookies(cookies);
  if (origins.length > 0) await context.addInitScript(restoreLocalStorageInitScript, origins);

  return {
    cookieCount: cookies.length,
    originCount: origins.length,
    localStorageCount: origins.reduce((total, origin) => total + origin.localStorage.length, 0),
  };
}

const X_ACCOUNT_COOKIE_NAMES = new Set(['auth_token', 'auth_multi', 'ct0', 'twid', '_twitter_sess']);

function isXHostname(value) {
  const hostname = String(value ?? '').trim().replace(/^\./, '').toLowerCase();
  return hostname === 'x.com' || hostname.endsWith('.x.com') ||
    hostname === 'twitter.com' || hostname.endsWith('.twitter.com');
}

/**
 * Keeps X's device/guest reputation while removing account-authentication
 * cookies. This profile can safely bootstrap a fresh account login for the
 * same app tenant without silently signing in as another linked X account.
 */
export function createTrustedLoginProfile(storageState) {
  const cookies = (Array.isArray(storageState?.cookies) ? storageState.cookies : [])
    .filter(
      (cookie) =>
        isXHostname(cookie?.domain) &&
        !X_ACCOUNT_COOKIE_NAMES.has(String(cookie?.name ?? '').toLowerCase()),
    )
    .map((cookie) => ({ ...cookie }));
  const origins = (Array.isArray(storageState?.origins) ? storageState.origins : [])
    .filter((entry) => {
      try {
        return isXHostname(new URL(entry?.origin).hostname) && Array.isArray(entry.localStorage);
      } catch {
        return false;
      }
    })
    .map((entry) => ({
      origin: new URL(entry.origin).origin,
      localStorage: entry.localStorage
        .filter((item) => typeof item?.name === 'string' && typeof item?.value === 'string')
        .map(({ name, value }) => ({ name, value })),
    }));

  return { cookies, origins };
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
    throw new Error(`Could not apply the Chrome user agent: ${error.message}`);
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

function tokenFromLegacyEndpoint(endpoint) {
  try {
    return new URL(String(endpoint ?? '')).searchParams.get('token')?.trim() || null;
  } catch {
    return null;
  }
}

/** Resolves the secret without ever logging or embedding it in source. */
export function resolveBrowserlessToken(environment = process.env) {
  return String(environment.BROWSERLESS_TOKEN || environment.BROWSERLESS_API_KEY || '').trim() ||
    tokenFromLegacyEndpoint(environment.BROWSERLESS_WS_ENDPOINT);
}

/** Builds Browserless' managed stealth route with a US residential proxy. */
export function buildBrowserlessEndpoint(token, timeoutMs) {
  const value = String(token ?? '').trim();
  if (!value) throw new Error('BROWSERLESS_TOKEN or BROWSERLESS_API_KEY is required');

  const url = new URL(BROWSERLESS_STEALTH_ENDPOINT);
  url.searchParams.set('token', value);
  url.searchParams.set('proxy', 'residential');
  url.searchParams.set('proxyCountry', 'us');
  return withSessionTimeout(url.toString(), timeoutMs);
}

/** Connects Playwright to the remote Browserless Chromium instance. */
export async function connectBrowser() {
  const endpoint = buildBrowserlessEndpoint(
    resolveBrowserlessToken(),
    process.env.BROWSERLESS_SESSION_TIMEOUT_MS,
  );
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
  await applyStealthProfile(context);
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
