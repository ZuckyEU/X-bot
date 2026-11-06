import { isXHomeURL, safeGoto, X_REFERER } from './browser.js';

export const X_HOME_URL = 'https://x.com/home';

export const X_LOGIN_IDENTIFIER_SELECTORS = [
  'input[autocomplete="username"]',
  'input[name="text"]',
  'input[name="username_or_email"]',
];

export const X_LOGIN_PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[type="password"]',
];

export const X_LOGIN_IDENTITY_SELECTORS = [
  'input[data-testid="ocfEnterTextTextInput"]',
  'input[name="text"]',
  'input[autocomplete="username"]',
];

export const X_LOGIN_2FA_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="otp"]',
  'input[inputmode="numeric"]',
  'input[data-testid="ocfEnterTextTextInput"]',
  'input[name="text"]',
];

export const X_LOGIN_HOME_MARKERS = [
  '[data-testid="primaryColumn"]',
  '[data-testid="AppTabBar_Home_Link"]',
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="AppTabBar_Profile_Link"]',
];

const X_LOGIN_NEXT_TEST_IDS = ['ocfEnterTextNextButton'];
const X_LOGIN_SUBMIT_TEST_IDS = ['LoginForm_Login_Button', 'ocfEnterTextNextButton'];
const X_LOGIN_ERROR_TEXT =
  /wrong password|incorrect password|password you entered is incorrect|couldn't log you in|could not log you in|couldn't find your account|this account doesn't exist|account has been locked|too many attempts|invalid (?:email|username|phone)|enter a valid (?:email|phone|phone number|username)|please enter a valid|something went wrong[\s\S]{0,80}?try (?:again|reloading)/i;
const X_LOGIN_2FA_TEXT =
  /two-factor authentication|authentication code|confirmation code|verification code|check your email|check your phone|enter the code|security code|login code/i;
const X_LOGIN_IDENTITY_TEXT =
  /enter your phone number or username|verify your identity|verify it'?s you|unusual activity|we need to verify/i;

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  throw error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function currentURL(page) {
  try {
    return page?.url?.() ?? '';
  } catch {
    return '';
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalizes an identifier only when it already looks like an X handle. */
export function safeXHandle(value) {
  const raw = String(value ?? '').trim();
  const explicitHandle = raw.startsWith('@');
  const handle = raw.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return null;
  // A bare phone number is ambiguous; require @ before treating digits as a handle.
  if (!explicitHandle && /^\d+$/.test(handle)) return null;
  return handle;
}

async function isActuallyVisible(locator) {
  if (!(await locator.isVisible().catch(() => false))) return false;
  if (typeof locator.evaluate !== 'function') return true;

  return locator
    .evaluate((element) => {
      if (typeof element.checkVisibility === 'function') {
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility === 'visible' && style.opacity !== '0';
    })
    .catch(() => true);
}

/** Returns the first locator in `selectors` that is actually visible. */
export async function visibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await isActuallyVisible(locator)) return locator;
  }
  return null;
}

/** Polls for the first visible locator until the timeout expires. */
export async function waitForVisibleLocator(page, selectors, timeoutMs, { signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    throwIfAborted(signal);
    const locator = await visibleLocator(page, selectors);
    if (locator) return locator;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

/** Types like a person instead of setting the whole value in one event. */
export async function humanType(locator, value, { signal, delay = 35 } = {}) {
  throwIfAborted(signal);
  await locator.click({ timeout: 10_000 }).catch(() => {});
  await locator.fill('');
  await locator.pressSequentially(String(value), { delay });
  throwIfAborted(signal);
}

async function clickVisibleLocator(locator) {
  if (!(await isActuallyVisible(locator))) return false;
  try {
    await locator.click({ timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Clicks a visible button by test id, accessible name, or text fallback. */
export async function clickLoginButton(page, labels, testIds = []) {
  for (const testId of testIds) {
    const locator = page.locator(`[data-testid="${testId}"]`).first();
    if (await clickVisibleLocator(locator)) return true;
  }

  for (const label of labels) {
    const locator = page.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(label)}$`, 'i'),
    }).first();
    if (await clickVisibleLocator(locator)) return true;
  }

  for (const label of labels) {
    const locator = page.locator(`[role="button"]:has-text("${label}"), button:has-text("${label}")`).first();
    if (await clickVisibleLocator(locator)) return true;
  }

  // X's newer onboarding screen renders its submit control as a plain div.
  if (typeof page.getByText === 'function') {
    for (const label of labels) {
      const matches = page.getByText(label, { exact: true });
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (await clickVisibleLocator(matches.nth(index))) return true;
      }
    }
  }

  return false;
}

export async function dismissCookieBanner(page) {
  const button = page.getByRole('button', { name: /accept all cookies|accept cookies/i }).first();
  if (!(await isActuallyVisible(button))) return false;
  await button.click({ timeout: 5_000 }).catch(() => {});
  return true;
}

/** Detects the intermediate screens X uses after an identifier or password. */
export async function detectLoginChallenge(page) {
  const bodyText = await page
    .locator('body')
    .innerText({ timeout: 2_000 })
    .catch(() => '');

  if (X_LOGIN_ERROR_TEXT.test(bodyText)) {
    return {
      type: 'error',
      message: 'X rejected the login. Check the identifier and password, then try again.',
    };
  }
  if (X_LOGIN_2FA_TEXT.test(bodyText)) return { type: 'two-factor' };

  const strongOneTimeCode = await visibleLocator(page, [
    'input[autocomplete="one-time-code"]',
    'input[name="otp"]',
  ]);
  if (strongOneTimeCode) return { type: 'two-factor' };

  if (X_LOGIN_IDENTITY_TEXT.test(bodyText)) return { type: 'identity' };

  const numericCode = await visibleLocator(page, ['input[inputmode="numeric"]']);
  if (numericCode) return { type: 'two-factor' };

  return null;
}

async function waitForPasswordOrChallenge(page, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (isXHomeURL(currentURL(page))) return { type: 'home' };

    const passwordInput = await visibleLocator(page, X_LOGIN_PASSWORD_SELECTORS);
    if (passwordInput) return { type: 'password', locator: passwordInput };

    const challenge = await detectLoginChallenge(page);
    if (challenge) return challenge;

    await sleep(300);
  }
  return { type: 'timeout' };
}

async function waitForLoginOutcome(page, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (isXHomeURL(currentURL(page))) return { type: 'home' };

    const challenge = await detectLoginChallenge(page);
    if (challenge) return challenge;

    await sleep(400);
  }
  return { type: 'timeout' };
}

async function handleIdentityChallenge(page, identifier, signal) {
  const handle = safeXHandle(identifier);
  if (!handle) {
    throw new Error(
      'X requested additional identity verification. Retry with your @handle as the identifier.',
    );
  }

  const input = await waitForVisibleLocator(page, X_LOGIN_IDENTITY_SELECTORS, 15_000, { signal });
  if (!input) throw new Error('X requested identity verification but no input appeared.');

  await humanType(input, handle, { signal });
  const clicked = await clickLoginButton(page, ['Next', 'Continue'], X_LOGIN_NEXT_TEST_IDS);
  if (!clicked) await input.press('Enter').catch(() => {});
}

async function handlePostPasswordChallenges(page, { identifier, twoFactorCode, signal }) {
  let codeSubmitted = false;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const outcome = await waitForLoginOutcome(page, signal, 30_000);
    if (outcome.type === 'home' || outcome.type === 'timeout') return;
    if (outcome.type === 'error') throw new Error(outcome.message);

    if (outcome.type === 'identity') {
      await handleIdentityChallenge(page, identifier, signal);
      continue;
    }

    if (outcome.type === 'two-factor') {
      if (!twoFactorCode) {
        throw new Error('X requires a two-factor authentication code. Retry with a current code.');
      }
      if (codeSubmitted) {
        throw new Error('X rejected the two-factor authentication code. Retry with a fresh code.');
      }

      const input = await waitForVisibleLocator(page, X_LOGIN_2FA_SELECTORS, 15_000, { signal });
      if (!input) throw new Error('X requested a two-factor code but no input appeared.');

      await humanType(input, String(twoFactorCode), { signal });
      const clicked = await clickLoginButton(
        page,
        ['Next', 'Verify', 'Confirm', 'Log in', 'Continue'],
        X_LOGIN_NEXT_TEST_IDS,
      );
      if (!clicked) await input.press('Enter').catch(() => {});
      codeSubmitted = true;
      // Let X replace the challenge page before inspecting it again.
      await sleep(1_000);
    }
  }
}

/**
 * Completes X's login flow, including the two-step identifier/password pages,
 * optional 2FA/email code, and X's occasional identity-verification challenge.
 */
export async function fillXLoginForm(page, { identifier, password, twoFactorCode = null, signal } = {}) {
  await dismissCookieBanner(page);

  const identifierInput = await waitForVisibleLocator(page, X_LOGIN_IDENTIFIER_SELECTORS, 30_000, { signal });
  if (!identifierInput) throw new Error('X login form did not load (identifier field was not found).');

  await humanType(identifierInput, identifier, { signal });

  let passwordInput = await visibleLocator(page, X_LOGIN_PASSWORD_SELECTORS);
  if (!passwordInput) {
    const clicked = await clickLoginButton(page, ['Next', 'Continue'], X_LOGIN_NEXT_TEST_IDS);
    if (!clicked) await identifierInput.press('Enter').catch(() => {});

    let step = await waitForPasswordOrChallenge(page, signal, 20_000);
    if (step.type === 'identity') {
      await handleIdentityChallenge(page, identifier, signal);
      step = await waitForPasswordOrChallenge(page, signal, 20_000);
    }
    if (step.type === 'error') throw new Error(step.message);
    if (step.type === 'home') return;
    if (step.type === 'two-factor') {
      throw new Error('X requested a verification code before the password step. Retry the login.');
    }
    if (step.type !== 'password') {
      throw new Error('X password field did not appear after the identifier step.');
    }
    passwordInput = step.locator;
  }

  await humanType(passwordInput, password, { signal });
  const clicked = await clickLoginButton(
    page,
    ['Log in', 'Sign in', 'Next', 'Continue'],
    X_LOGIN_SUBMIT_TEST_IDS,
  );
  if (!clicked) await passwordInput.press('Enter').catch(() => {});

  await handlePostPasswordChallenges(page, { identifier, twoFactorCode, signal });
}

/** Waits for the authenticated home timeline to paint after cookies are issued. */
export async function waitForXHomeTimeline(page, signal, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  if (!isXHomeURL(currentURL(page))) {
    await safeGoto(page, X_HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(30_000, timeoutMs),
      referer: X_REFERER,
    });
  }

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (isXHomeURL(currentURL(page))) {
      const marker = await visibleLocator(page, X_LOGIN_HOME_MARKERS);
      if (marker) return true;
    }
    await sleep(400);
  }

  return false;
}
