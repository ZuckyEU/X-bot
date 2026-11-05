import { chromium } from 'playwright';

const ENDPOINT_ENV = 'BROWSERLESS_WS_ENDPOINT';
const CONNECT_TIMEOUT_MS = 60_000;

/** Returns the configured Browserless CDP endpoint without ever logging the token. */
export function browserlessEndpoint() {
  const endpoint = String(process.env[ENDPOINT_ENV] ?? '').trim();
  if (!endpoint) {
    throw new Error(
      `${ENDPOINT_ENV} is not configured. Add your Browserless WebSocket endpoint to .env or the deployment environment.`,
    );
  }
  if (!/^wss?:\/\//i.test(endpoint)) {
    throw new Error(`${ENDPOINT_ENV} must start with ws:// or wss://`);
  }
  return endpoint;
}

/** Connects Playwright to the remote Browserless Chromium instance. */
export async function connectBrowser() {
  return chromium.connectOverCDP(browserlessEndpoint(), { timeout: CONNECT_TIMEOUT_MS });
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
