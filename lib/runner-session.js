import { readFile } from 'node:fs/promises';
import { isXLoginURL, normalizeXSessionCookies } from './browser.js';

const reportedPages = new WeakSet();

/** Page text is untrusted: redact credentials before trimming or printing it. */
export function redactRunnerDiagnostic(text, cookies = []) {
  let safe = String(text ?? '');
  const secrets = [...cookies.map((cookie) => cookie?.value), process.env.GROQ_API_KEY]
    .filter((value) => typeof value === 'string' && value);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    for (const value of new Set([secret, encodeURIComponent(secret)])) {
      safe = safe.split(value).join('[REDACTED]');
    }
  }
  return safe.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
}

export async function loadRunnerSession(path, { username = null } = {}) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('auth.json not found. Re-import your X session before running automation.');
    throw new Error('Could not read auth.json. Check the session file permissions.');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    // JSON parser messages can contain the saved cookie values.
    throw new Error('auth.json is not valid JSON. Re-import your X session.');
  }
  const cookies = normalizeXSessionCookies(Array.isArray(parsed) ? parsed : parsed?.cookies);
  const savedUsername = Array.isArray(parsed) ? null : parsed?.username;
  const handle = [savedUsername, username].map((value) => String(value ?? '').trim().match(/^@?([A-Za-z0-9_]{1,15})$/)?.[1])
    .find(Boolean) ?? null;
  const present = (name) => cookies.some((cookie) => cookie?.name === name && typeof cookie.value === 'string' && cookie.value);
  const authPresent = present('auth_token');
  const csrfPresent = present('ct0');
  console.log(`[RUNNER] Loaded cookies for @${handle ?? 'unknown'}: auth_token=${authPresent ? 'present' : 'missing'}, ct0=${csrfPresent ? 'present' : 'missing'}`);
  if (!authPresent || !csrfPresent) {
    throw new Error('auth.json must contain both auth_token and ct0. Re-import fresh X cookies.');
  }
  return {
    cookies,
    origins: Array.isArray(parsed?.origins) ? parsed.origins : [],
    username: handle,
  };
}

/** Executed in the page; distinguish a login/error page from a slow render. */
function runnerPageState({ readySelector }) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  if (/(^|\.)(x|twitter)\.com$/i.test(window.location.hostname)
    && /^\/(?:login|i\/flow\/login)\/?$/.test(window.location.pathname)) return 'login';
  const errors = document.querySelectorAll('[data-testid="error-detail"], [data-testid="error-message"], [data-testid="error"]');
  if ([...errors].some(visible)) return 'error';
  const alerts = document.querySelectorAll('[role="alert"], [data-testid="toast"]');
  if ([...alerts].some((element) => visible(element)
    && /something went wrong|try reloading|error|failed|rate limit|temporarily unavailable|account.*(?:locked|suspended)/i.test(element.textContent ?? ''))) return 'error';
  return readySelector && [...document.querySelectorAll(readySelector)].some(visible) ? 'ready' : null;
}

export async function reportRunnerPageFailure(page, cookies = [], { status = null } = {}) {
  if (reportedPages.has(page)) return;
  reportedPages.add(page);
  try {
    if (status === 'login' || isXLoginURL(page.url())) {
      console.warn('[RUNNER] Redirected to login page - cookies rejected by X');
    }
    const currentCookies = await page.context().cookies().catch(() => []);
    const title = redactRunnerDiagnostic(await page.title(), [...cookies, ...currentCookies]);
    console.warn(`[RUNNER] ${status === 'error' ? 'Visible error element' : 'Failure page'}; page title: ${JSON.stringify(title)}`);
  } catch {
    // Browser errors can also contain credentials; keep diagnostics best-effort.
    console.warn('[RUNNER] Page diagnostics unavailable (page or browser closed).');
  }
}

export async function waitForRunnerContent(page, readySelector, { cookies = [], timeoutMs = 30_000 } = {}) {
  const state = await page.waitForFunction(runnerPageState, { readySelector }, { polling: 100, timeout: timeoutMs });
  let status;
  try {
    status = await state.jsonValue();
  } finally {
    await state.dispose();
  }
  if (status === 'ready') return;
  await reportRunnerPageFailure(page, cookies, { status });
  throw new Error(status === 'login'
    ? 'X rejected the saved cookies. Re-authenticate the X account before publishing.'
    : 'X displayed an error page. Review the runner page-title diagnostic and retry.');
}
