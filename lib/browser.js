import { chromium } from 'playwright';

export const X_LOGIN_URL = 'https://x.com/i/flow/login';
export const X_REFERER = 'https://x.com/';
export const X_AUTH_COOKIE = 'auth_token';
export const X_CSRF_COOKIE = 'ct0';

/** True only when X has issued both cookies required for a reusable session. */
export function hasXSessionCookies(cookies) {
  const byName = new Map(
    (Array.isArray(cookies) ? cookies : [])
      .filter((cookie) => cookie?.name)
      .map((cookie) => [cookie.name, cookie]),
  );
  const hasAuthCookie = Boolean(byName.get(X_AUTH_COOKIE)?.value);
  const hasCsrfCookie = Boolean(byName.get(X_CSRF_COOKIE)?.value);
  return hasAuthCookie && hasCsrfCookie;
}

/** Matches X's authenticated home timeline, including mobile/Twitter hosts. */
export function isXHomeURL(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (!/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) return false;
    return url.pathname === '/home' || url.pathname === '/home/';
  } catch {
    return false;
  }
}
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
 * Matches the advertised Chrome identity to the Chromium build actually being
 * driven. A stale UA is itself a headless/automation signal, so callers with a
 * real browser version should use this instead of the static default.
 */
export function chromeIdentityForVersion(version) {
  const fullVersion = String(version ?? '').trim();
  const match = /^(\d+)\.\d+\.\d+\.\d+$/.exec(fullVersion);
  if (!match) {
    return { userAgent: CHROME_USER_AGENT, userAgentMetadata: CHROME_USER_AGENT_METADATA };
  }

  const major = match[1];
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not(A:Brand', version: '24' },
      ],
      fullVersion,
      fullVersionList: [
        { brand: 'Chromium', version: fullVersion },
        { brand: 'Google Chrome', version: fullVersion },
        { brand: 'Not(A:Brand', version: '24.0.0.0' },
      ],
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
    },
  };
}

/**
 * Runs before any page script so the browser does not advertise the usual
 * headless/automation fingerprint. Applied to each local Chromium context.
 */
function stealthInitScript({ hideWebdriver = false } = {}) {
  const defineGetter = (target, property, valueOrGetter) => {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: true,
        get: typeof valueOrGetter === 'function' ? valueOrGetter : () => valueOrGetter,
      });
    } catch {
      // Some browser builds expose non-configurable descriptors.
    }
  };

  defineGetter(Navigator.prototype, 'webdriver', hideWebdriver ? undefined : false);
  defineGetter(Navigator.prototype, 'platform', 'Win32');
  defineGetter(Navigator.prototype, 'languages', Object.freeze(['en-US', 'en']));
  defineGetter(Navigator.prototype, 'hardwareConcurrency', 8);
  defineGetter(Navigator.prototype, 'deviceMemory', 8);
  defineGetter(Navigator.prototype, 'vendor', 'Google Inc.');
  defineGetter(Navigator.prototype, 'pdfViewerEnabled', true);
  defineGetter(window, 'outerWidth', () => window.innerWidth || 1366);
  defineGetter(window, 'outerHeight', () => window.innerHeight || 768);
  defineGetter(window, 'screenX', 0);
  defineGetter(window, 'screenY', 0);

  try {
    // Headless Chromium exposes no PDF plugins, which is a common automation
    // signal. Keep the native plugin objects when a headed build provides them.
    if (navigator.plugins.length === 0 && window.Plugin && window.PluginArray && window.MimeType && window.MimeTypeArray) {
      const arrayLike = (prototype, items) => {
        const target = Object.create(prototype);
        items.forEach((item, index) => {
          Object.defineProperty(target, index, {
            configurable: true,
            enumerable: true,
            value: item,
          });
        });
        Object.defineProperties(target, {
          length: { configurable: true, value: items.length },
          item: { configurable: true, value: (index) => items[index] ?? null },
          namedItem: {
            configurable: true,
            value: (name) => items.find((item) => item.name === name || item.type === name) ?? null,
          },
          [Symbol.iterator]: { configurable: true, value: Array.prototype[Symbol.iterator] },
        });
        return target;
      };

      const pluginNames = [
        'PDF Viewer',
        'Chrome PDF Viewer',
        'Chromium PDF Viewer',
        'Microsoft Edge PDF Viewer',
        'WebKit built-in PDF',
      ];
      const plugins = pluginNames.map((name) => {
        const plugin = Object.create(window.Plugin.prototype);
        Object.defineProperties(plugin, {
          name: { enumerable: true, value: name },
          filename: { enumerable: true, value: 'internal-pdf-viewer' },
          description: { enumerable: true, value: 'Portable Document Format' },
        });
        return plugin;
      });
      const mimeTypes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ].map((data) => {
        const mimeType = Object.create(window.MimeType.prototype);
        Object.defineProperties(mimeType, {
          type: { enumerable: true, value: data.type },
          suffixes: { enumerable: true, value: data.suffixes },
          description: { enumerable: true, value: data.description },
          enabledPlugin: { enumerable: true, value: plugins[1] },
        });
        return mimeType;
      });

      const mimeTypeArray = arrayLike(window.MimeTypeArray.prototype, mimeTypes);
      for (const plugin of plugins) {
        Object.defineProperties(plugin, {
          length: { value: mimeTypes.length },
          item: { configurable: true, value: (index) => mimeTypes[index] ?? null },
          namedItem: {
            configurable: true,
            value: (name) => mimeTypes.find((mimeType) => mimeType.type === name) ?? null,
          },
          mimeTypes: { value: mimeTypeArray },
        });
      }
      const pluginArray = arrayLike(window.PluginArray.prototype, plugins);
      Object.defineProperty(pluginArray, 'refresh', {
        configurable: true,
        value: () => {},
      });
      defineGetter(Navigator.prototype, 'plugins', pluginArray);
      defineGetter(Navigator.prototype, 'mimeTypes', mimeTypeArray);
    }
  } catch {
    // Preserve native plugin data when the browser exposes a sealed implementation.
  }

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

export async function applyStealthProfile(context, { hideWebdriver = false } = {}) {
  if (stealthContexts.has(context)) return;
  try {
    await context.addInitScript(stealthInitScript, { hideWebdriver });
    const profilePage = (page) => applyChromeUserAgent(context, page);
    context.on?.('page', (page) =>
      profilePage(page).catch((error) => console.warn(`[browser] ${error.message}`)),
    );
    await Promise.all(
      context.pages().filter((page) => !page.isClosed()).map((page) => profilePage(page)),
    );
    stealthContexts.add(context);
  } catch (error) {
    throw new Error(`Could not initialize the browser stealth profile: ${error.message}`);
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

function contextBrowserVersion(context) {
  try {
    return context.browser?.()?.version?.() ?? null;
  } catch {
    return null;
  }
}

async function applyChromeUserAgent(context, page) {
  if (pageIdentitySessions.has(page)) return;

  const identity = chromeIdentityForVersion(contextBrowserVersion(context));
  let cdpSession;
  try {
    cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Network.setUserAgentOverride', {
      userAgent: identity.userAgent,
      acceptLanguage: CHROME_ACCEPT_LANGUAGE,
      platform: 'Win32',
      userAgentMetadata: identity.userAgentMetadata,
    });
    pageIdentitySessions.set(page, cdpSession);
  } catch (error) {
    await detachCdpSession(cdpSession);
    throw new Error(`Could not apply the Chrome user agent: ${error.message}`);
  }
}

/** Launches Chromium in this process's container; no remote browser service. */
export async function connectBrowser({ timeout } = {}) {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(timeout === undefined ? {} : { timeout }),
  });
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

/** Reuses this run's context, or creates one before restoring session cookies. */
export async function getDefaultContext(browser) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
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
    // The CDP session may already be gone with the browser.
  }
}

/** Closes the local Chromium process; cleanup remains safe after cancellation. */
export async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // The local process may already be gone; cleanup must not throw.
  }
}
