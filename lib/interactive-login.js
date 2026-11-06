import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isXHomeURL } from './browser.js';
import { waitForXHomeTimeline } from './x-login.js';

export const INTERACTIVE_LOGIN_PATH = '/api/interactive-login/sessions';
export const INTERACTIVE_CALLBACK_PATH = '/api/auth/x-accounts/interactive/callback';
export const CALLBACK_GRACE_MS = 90_000;
export const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const MACHINE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class InteractiveLoginError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function secretDigest(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest();
}

export function matchesSecret(value, digest) {
  return Boolean(value && digest) && crypto.timingSafeEqual(secretDigest(value), digest);
}

export function interactiveTimeout(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 30_000
    ? Math.min(milliseconds, 900_000)
    : 600_000;
}

export function trustedHttpURL(value, { production = false, label = 'URL' } = {}) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new InteractiveLoginError(503, `${label} must be configured as an http(s) URL`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || (production && url.protocol !== 'https:') ||
      url.username || url.password || url.hash || url.search) {
    throw new InteractiveLoginError(503, `${label} must be an ${production ? 'HTTPS' : 'http(s)'} URL without credentials, query, or fragment`);
  }
  return url;
}

/** Fly's callback destination is fixed by configuration, never by browser input. */
export function resolveInteractiveLoginConfig(environment = process.env) {
  const enabled = environment.INTERACTIVE_LOGIN_ENABLED === 'true';
  const production = environment.NODE_ENV === 'production';
  const publicValue = environment.INTERACTIVE_LOGIN_PUBLIC_ORIGIN ||
    (environment.FLY_APP_NAME ? `https://${environment.FLY_APP_NAME}.fly.dev` : '');
  const config = {
    enabled,
    timeoutMs: interactiveTimeout(environment.INTERACTIVE_LOGIN_TIMEOUT_MS),
    machineId: String(environment.FLY_MACHINE_ID ?? ''),
    publicOrigin: '',
    callbackUrl: '',
  };
  if (!enabled) return config;
  const publicUrl = trustedHttpURL(publicValue, { production, label: 'INTERACTIVE_LOGIN_PUBLIC_ORIGIN' });
  const callbackUrl = trustedHttpURL(environment.HARVEST_CALLBACK_URL, { production, label: 'HARVEST_CALLBACK_URL' });
  if (publicUrl.pathname !== '/') throw new InteractiveLoginError(503, 'INTERACTIVE_LOGIN_PUBLIC_ORIGIN must be an origin without a path');
  if (callbackUrl.pathname !== INTERACTIVE_CALLBACK_PATH) {
    throw new InteractiveLoginError(503, `HARVEST_CALLBACK_URL must end with ${INTERACTIVE_CALLBACK_PATH}`);
  }
  config.publicOrigin = publicUrl.origin;
  config.callbackUrl = callbackUrl.href;
  if (config.machineId && !MACHINE_ID_PATTERN.test(config.machineId)) {
    throw new InteractiveLoginError(503, 'FLY_MACHINE_ID is invalid');
  }
  return config;
}

/** Only cookies usable on X itself can signal login; foreign names are ignored. */
export function extractXSessionCookies(cookies) {
  const result = [];
  for (const name of ['auth_token', 'ct0']) {
    const cookie = (Array.isArray(cookies) ? cookies : []).find((candidate) =>
      candidate?.name === name && typeof candidate.value === 'string' &&
      candidate.value.length >= 8 && candidate.value.length <= 512 && /^[A-Za-z0-9._~%+/-]+={0,2}$/.test(candidate.value) &&
      candidate.secure !== false && !(candidate.expires > 0 && candidate.expires <= Date.now() / 1_000) &&
      ['x.com', '.x.com'].includes(String(candidate.domain).toLowerCase()) && candidate.path === '/',
    );
    if (!cookie) return null;
    result.push({
      name,
      value: cookie.value,
      domain: cookie.domain,
      path: '/',
      secure: true,
      httpOnly: name === 'auth_token',
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    });
  }
  return result;
}

/** One virtual desktop at a time, with immediate viewer revocation on capture. */
export function createInteractiveLoginService({
  config,
  openBrowser,
  readIdentity,
  waitForHome = waitForXHomeTimeline,
  fetchImpl = fetch,
  pollIntervalMs = 1_000,
  retryDelays = [0, 1_000, 2_000, 4_000, 8_000],
  retentionMs = 60_000,
}) {
  const sessions = new Map();
  let active = null;
  let cleanupBlocked = false;
  let closing = false;

  function sessionFor(id) {
    const session = sessions.get(id);
    if (!session) throw new InteractiveLoginError(404, 'Remote sign-in session not found');
    return session;
  }

  function status(id) {
    const session = sessionFor(id);
    return {
      sessionId: session.id,
      status: session.status,
      expiresAt: new Date(session.expiresAt).toISOString(),
      machineId: config.machineId || null,
      browserClosed: session.desktopCleared === true,
      ...(session.username ? { username: session.username } : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }

  function revokeViewers(session) {
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
  }

  function authorizeViewer(id, token, { transport = false } = {}) {
    const session = sessionFor(id);
    if (!matchesSecret(token, session.viewerDigest)) {
      throw new InteractiveLoginError(401, 'Remote sign-in access required');
    }
    if (transport && (active !== session || !['starting', 'waiting'].includes(session.status) || Date.now() >= session.expiresAt)) {
      throw new InteractiveLoginError(410, 'This remote browser is no longer available');
    }
    return status(id);
  }

  function trackSocket(id, socket) {
    const session = sessionFor(id);
    session.sockets.add(socket);
    socket.once('close', () => session.sockets.delete(socket));
  }

  async function deliver(session, payload) {
    for (const milliseconds of retryDelays) {
      if (session.controller.signal.aborted) return false;
      try {
        await delay(milliseconds, undefined, { signal: session.controller.signal });
        const response = await fetchImpl(config.callbackUrl, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.callbackToken}` },
          body: JSON.stringify({ requestId: session.id, sessionId: session.id, browserClosed: session.desktopCleared === true, ...payload }),
          signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(10_000)]),
        });
        // Consume the response to release the connection, without logging secrets.
        await response.text();
        if (response.ok) return true;
        if (response.status >= 400 && response.status < 500 && response.status !== 429) return false;
      } catch {
        // A lost acknowledgement is retried; Render accepts identical callbacks.
      }
    }
    return false;
  }

  async function run(session) {
    let remote = null;
    let payload;
    try {
      remote = await openBrowser({ signal: session.controller.signal });
      session.controller.signal.throwIfAborted();
      session.status = 'waiting';

      while (!session.controller.signal.aborted) {
        const cookies = extractXSessionCookies(await remote.context.cookies(['https://x.com']));
        session.controller.signal.throwIfAborted();
        if (cookies) {
          const page = remote.context.pages().find((candidate) => !candidate.isClosed() && isXHomeURL(candidate.url())) || remote.page;
          if (!(await waitForHome(page, session.controller.signal, { timeoutMs: 1_000 }))) {
            // Some X challenges expose cookies before onboarding is finished.
            // Keep input available until the authenticated timeline is ready.
            await delay(pollIntervalMs, undefined, { signal: session.controller.signal });
            continue;
          }
          session.controller.signal.throwIfAborted();
          session.status = 'capturing';
          revokeViewers(session);
          const identity = await readIdentity(page, session.controller.signal);
          if (!/^[a-z0-9_]{1,15}$/i.test(identity?.username ?? '')) throw new Error('Account identity not found');
          session.controller.signal.throwIfAborted();
          const verifiedCookies = extractXSessionCookies(await remote.context.cookies(['https://x.com']));
          if (!verifiedCookies) throw new Error('Session cookies disappeared');
          session.username = identity.username.toLowerCase();
          payload = { status: 'completed', username: session.username, cookies: verifiedCookies };
          session.status = 'delivering';
          break;
        }
        await delay(pollIntervalMs, undefined, { signal: session.controller.signal });
      }
    } catch (error) {
      if (error?.cleanupFailed) cleanupBlocked = true;
      if (!session.controller.signal.aborted) {
        session.status = 'failed';
        session.error = cleanupBlocked
          ? 'The remote desktop could not be cleared. Restart the Fly Machine.'
          : 'Remote X sign-in failed. Start a new session and try again.';
      }
      payload = { status: session.status, error: session.error || 'Remote sign-in expired' };
    } finally {
      clearTimeout(session.expiryTimer);
      revokeViewers(session);
      try {
        await remote?.close();
        session.desktopCleared = !cleanupBlocked;
      } catch {
        // Never give the next tenant a desktop whose previous browser survived.
        cleanupBlocked = true;
        session.status = 'failed';
        session.error = 'The remote desktop could not be cleared. Restart the Fly Machine.';
        payload = { status: 'failed', error: session.error };
      }
      if (active === session) active = null;
    }

    if (session.status !== 'cancelled' && !closing && payload) {
      // Expiry aborts browser work, but must still report the terminal state.
      if (session.status === 'expired') session.controller = new AbortController();
      const delivered = await deliver(session, payload);
      if (delivered) session.status = payload.status;
      else if (session.status !== 'cancelled') {
        session.status = 'failed';
        session.error = 'Could not deliver the login result to Render. Start a new session.';
      }
    }
    session.callbackToken = null;
    payload = null;
    session.finished = true;
    session.retentionTimer = setTimeout(() => sessions.delete(session.id), retentionMs);
    session.retentionTimer.unref?.();
  }

  function start({ requestId, callbackUrl, callbackToken }) {
    if (!config.enabled || closing) throw new InteractiveLoginError(503, 'Interactive login is not enabled on this service');
    if (typeof requestId !== 'string' || !SESSION_ID_PATTERN.test(requestId) ||
        typeof callbackToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(callbackToken)) {
      throw new InteractiveLoginError(400, 'A request ID and strong one-time callback token are required');
    }
    if (callbackUrl !== config.callbackUrl) throw new InteractiveLoginError(400, 'Callback URL does not match HARVEST_CALLBACK_URL');
    if (cleanupBlocked) throw new InteractiveLoginError(503, 'The remote desktop needs a Fly Machine restart');
    if (active) throw new InteractiveLoginError(409, 'The remote desktop is busy. Try again when the current sign-in finishes.');
    if (sessions.has(requestId)) throw new InteractiveLoginError(409, 'This sign-in request was already used');

    const token = crypto.randomBytes(32).toString('base64url');
    const session = {
      id: requestId,
      status: 'starting',
      expiresAt: Date.now() + config.timeoutMs,
      viewerDigest: secretDigest(token),
      callbackToken,
      controller: new AbortController(),
      sockets: new Set(),
    };
    sessions.set(session.id, session);
    active = session;
    session.expiryTimer = setTimeout(() => {
      session.status = 'expired';
      session.controller.abort();
      revokeViewers(session);
    }, config.timeoutMs);
    session.expiryTimer.unref?.();
    session.work = Promise.resolve().then(() => run(session));

    const viewerUrl = new URL(`/remote-login/${session.id}`, config.publicOrigin);
    if (config.machineId) viewerUrl.searchParams.set('machine', config.machineId);
    // Fragments never appear in HTTP requests, referrers, or Fly access logs.
    viewerUrl.hash = `token=${token}`;
    return { ...status(session.id), viewerUrl: viewerUrl.href };
  }

  async function cancel(id) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) throw new InteractiveLoginError(400, 'Invalid remote sign-in ID');
    let session = sessions.get(id);
    if (!session) {
      // A DELETE can beat a delayed START acknowledgement. Remember the ID so
      // that a subsequently-arriving START cannot leave an ownerless browser.
      session = { id, status: 'cancelled', expiresAt: Date.now(), desktopCleared: true, finished: true };
      sessions.set(id, session);
      session.retentionTimer = setTimeout(() => sessions.delete(id), config.timeoutMs + CALLBACK_GRACE_MS);
      session.retentionTimer.unref?.();
      return status(id);
    }
    if (!session.finished && session.status !== 'cancelled') {
      session.status = 'cancelled';
      session.controller.abort();
      revokeViewers(session);
    }
    await session.work;
    return status(id);
  }

  async function close() {
    closing = true;
    await Promise.all([...sessions.values()].map(async (session) => {
      await cancel(session.id);
      clearTimeout(session.retentionTimer);
    }));
    sessions.clear();
  }

  return { start, status, authorizeViewer, trackSocket, cancel, close, whenFinished: (id) => sessionFor(id).work };
}
