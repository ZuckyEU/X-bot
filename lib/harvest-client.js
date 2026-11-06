export const DEFAULT_HARVEST_API_URL = 'https://x-auth-bot-free.fly.dev/api/harvest-token';

const X_SESSION_COOKIE_NAMES = new Set(['auth_token', 'ct0']);

/**
 * Resolve the Fly.io harvest endpoint and shared bearer token.
 *
 * The token is an internal service credential. Call this from a trusted
 * backend (for example the Render bot), not from browser code.
 */
export function resolveHarvestConfig({
  apiUrl = process.env.HARVEST_API_URL,
  token = process.env.HARVEST_API_TOKEN,
} = {}) {
  const url = String(apiUrl ?? DEFAULT_HARVEST_API_URL).trim();
  const bearer = String(token ?? '').trim();

  if (!url) throw new Error('HARVEST_API_URL must not be empty');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('HARVEST_API_URL must be an http(s) URL');
  }
  if (!bearer) throw new Error('HARVEST_API_TOKEN is required');

  return { url, token: bearer };
}

/**
 * Harvest fresh X session cookies from the Fly.io service.
 *
 * Returns the raw cookies plus the two values needed to restore an X login.
 * Persist `authToken` and `ct0` in the caller's account store before treating
 * the X account as connected.
 *
 * @param {object} options
 * @param {string} options.identifier X username, email, or phone number.
 * @param {string} options.password X password.
 * @param {string|number|null} [options.twoFactorCode] Optional 2FA code.
 * @param {string} [options.apiUrl] Override the Fly.io endpoint.
 * @param {string} [options.token] Override HARVEST_API_TOKEN.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch for tests.
 */
export async function harvestXAccount({
  identifier,
  password,
  twoFactorCode = null,
  apiUrl,
  token,
  fetchImpl = fetch,
} = {}) {
  const { url, token: bearer } = resolveHarvestConfig({ apiUrl, token });
  const normalizedIdentifier = String(identifier ?? '').trim();

  if (!normalizedIdentifier) throw new Error('X identifier is required');
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('X password is required');
  }

  const payload = { identifier: normalizedIdentifier, password };
  if (twoFactorCode !== null && twoFactorCode !== undefined && String(twoFactorCode).trim() !== '') {
    payload.twoFactorCode = String(twoFactorCode).trim();
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? `Harvest request failed with HTTP ${response.status}`);
  }

  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  const authToken = cookies.find((cookie) => cookie?.name === 'auth_token')?.value;
  const ct0 = cookies.find((cookie) => cookie?.name === 'ct0')?.value;
  if (!authToken || !ct0) {
    throw new Error('Harvest response did not include auth_token and ct0');
  }

  return {
    username: data.username ?? null,
    cookies: cookies.filter((cookie) => cookie && X_SESSION_COOKIE_NAMES.has(cookie.name)),
    authToken,
    ct0,
  };
}
