const USERNAME_SELECTORS = [
  'input[name="username_or_email"]',
  'input[autocomplete="username"]',
  'input[name="text"]',
];
const PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[type="password"]',
];

const TEMPORARILY_LIMITED = /temporarily limited|try again later|too many (?:login )?attempts/i;
const INVALID_CREDENTIALS = /wrong password|incorrect password|could not log you in|invalid (?:username|email|password)/i;
const CHALLENGE_REQUIRED =
  /verification code|two-factor|authenticate your account|check your (?:email|phone)|confirm your identity|unusual login|captcha|arkose|enter your (?:phone number|email|username)/i;

const sleep = (page, timeoutMs) => page.waitForTimeout(Math.max(1, timeoutMs));

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  throw error;
}

async function hasAuthCookie(context) {
  return (await context.cookies()).some((cookie) => cookie.name === 'auth_token');
}

async function visibleInput(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible().catch(() => false))) continue;
    if (typeof locator.isEditable === 'function' && !(await locator.isEditable().catch(() => false))) continue;
    return locator;
  }
  return null;
}

async function pageText(page) {
  return page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
}

function classifyLoginPage(text) {
  if (TEMPORARILY_LIMITED.test(text)) return 'temporarily_limited';
  if (INVALID_CREDENTIALS.test(text)) return 'invalid_credentials';
  if (CHALLENGE_REQUIRED.test(text)) return 'challenge_required';
  return 'pending';
}

async function waitForInput(page, context, selectors, deadline, signal, { classify = false } = {}) {
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (await hasAuthCookie(context)) return { status: 'authenticated', locator: null };
    const locator = await visibleInput(page, selectors);
    if (locator) return { status: 'ready', locator };
    if (classify) {
      const status = classifyLoginPage(await pageText(page));
      if (status !== 'pending') return { status, locator: null };
    }
    await sleep(page, Math.min(250, deadline - Date.now()));
  }
  return { status: 'timeout', locator: null };
}

/**
 * Submits X credentials in the remote browser. Credentials are only passed to
 * locator.fill() and are never logged or included in thrown error messages.
 */
export async function automateXCredentialLogin({
  context,
  page,
  identifier,
  password,
  signal,
  timeoutMs = 75_000,
}) {
  const deadline = Date.now() + timeoutMs;
  throwIfAborted(signal);
  if (await hasAuthCookie(context)) return { status: 'authenticated' };

  const usernameStep = await waitForInput(
    page,
    context,
    USERNAME_SELECTORS,
    deadline,
    signal,
    { classify: true },
  );
  if (usernameStep.status === 'authenticated') return usernameStep;
  if (usernameStep.status !== 'ready') return { status: usernameStep.status };

  await usernameStep.locator.fill(identifier);
  let passwordStep = await waitForInput(page, context, PASSWORD_SELECTORS, Date.now() + 1_000, signal);
  if (passwordStep.status !== 'ready') {
    await usernameStep.locator.press('Enter');
    passwordStep = await waitForInput(page, context, PASSWORD_SELECTORS, deadline, signal, { classify: true });
  }
  if (passwordStep.status === 'authenticated') return passwordStep;
  if (passwordStep.status !== 'ready') return { status: passwordStep.status };

  await passwordStep.locator.fill(password);
  await passwordStep.locator.press('Enter');

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (await hasAuthCookie(context)) return { status: 'authenticated' };
    const status = classifyLoginPage(await pageText(page));
    if (status !== 'pending') return { status };
    await sleep(page, Math.min(500, deadline - Date.now()));
  }

  return { status: 'timeout' };
}

export const credentialLoginPatterns = Object.freeze({
  temporarilyLimited: TEMPORARILY_LIMITED,
  invalidCredentials: INVALID_CREDENTIALS,
  challengeRequired: CHALLENGE_REQUIRED,
});
