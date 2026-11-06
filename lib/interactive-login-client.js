import crypto from 'node:crypto';
import { resolveHarvestConfig } from './harvest-client.js';
import {
  INTERACTIVE_CALLBACK_PATH,
  INTERACTIVE_LOGIN_PATH,
  InteractiveLoginError,
  MACHINE_ID_PATTERN,
  SESSION_ID_PATTERN,
  trustedHttpURL,
} from './interactive-login.js';

/** Server-to-server only: neither service credential ever goes to the dashboard. */
export function createInteractiveLoginClient({ environment = process.env, fetchImpl = fetch } = {}) {
  const harvest = resolveHarvestConfig({ apiUrl: environment.HARVEST_API_URL, token: environment.HARVEST_API_TOKEN });
  const production = environment.NODE_ENV === 'production';
  const origin = trustedHttpURL(harvest.url, { production, label: 'HARVEST_API_URL' }).origin;
  const callbackValue = environment.HARVEST_CALLBACK_URL ||
    (environment.RENDER_EXTERNAL_URL || environment.PUBLIC_ORIGIN
      ? new URL(INTERACTIVE_CALLBACK_PATH, environment.RENDER_EXTERNAL_URL || environment.PUBLIC_ORIGIN).href
      : '');
  const callbackUrl = trustedHttpURL(callbackValue, { production, label: 'HARVEST_CALLBACK_URL or RENDER_EXTERNAL_URL' });
  if (callbackUrl.pathname !== INTERACTIVE_CALLBACK_PATH) {
    throw new InteractiveLoginError(503, `HARVEST_CALLBACK_URL must end with ${INTERACTIVE_CALLBACK_PATH}`);
  }

  async function call(path, { method = 'GET', body, signal, machineId, timeoutMs = 15_000 } = {}) {
    const url = new URL(path, origin);
    if (machineId) {
      if (!MACHINE_ID_PATTERN.test(machineId)) throw new InteractiveLoginError(502, 'Fly returned an invalid Machine ID');
      url.searchParams.set('machine', machineId);
    }
    const response = await fetchImpl(url.href, {
      method,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${harvest.token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new InteractiveLoginError(response.status === 409 ? 409 : 502, data.error || `Fly login request failed (HTTP ${response.status})`);
    return data;
  }

  async function start({ requestId = crypto.randomUUID(), callbackToken, signal }) {
    const data = await call(INTERACTIVE_LOGIN_PATH, {
      method: 'POST',
      body: { requestId, callbackUrl: callbackUrl.href, callbackToken },
      signal,
    });
    let viewerUrl;
    try { viewerUrl = new URL(data.viewerUrl); } catch { /* validated below */ }
    const expiresAt = Date.parse(data.expiresAt);
    if (data.sessionId !== requestId || !SESSION_ID_PATTERN.test(data.sessionId ?? '') ||
        !viewerUrl || viewerUrl.origin !== origin || viewerUrl.username || viewerUrl.password ||
        viewerUrl.pathname !== `/remote-login/${requestId}` ||
        !/^#token=[A-Za-z0-9_-]{43}$/.test(viewerUrl.hash) ||
        (data.machineId && !MACHINE_ID_PATTERN.test(data.machineId)) ||
        (viewerUrl.searchParams.get('machine') || null) !== (data.machineId || null) ||
        !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 905_000) {
      throw new InteractiveLoginError(502, 'Fly returned an invalid remote sign-in session');
    }
    return { sessionId: data.sessionId, viewerUrl: viewerUrl.href, expiresAt: data.expiresAt, machineId: data.machineId || null };
  }

  function sessionPath(sessionId) {
    if (!SESSION_ID_PATTERN.test(sessionId ?? '')) throw new InteractiveLoginError(400, 'Invalid remote sign-in ID');
    return `${INTERACTIVE_LOGIN_PATH}/${sessionId}`;
  }

  return {
    start,
    status: (sessionId, options) => call(sessionPath(sessionId), options),
    cancel: (sessionId, options) => call(sessionPath(sessionId), { ...options, method: 'DELETE', timeoutMs: 8_000 }),
  };
}
