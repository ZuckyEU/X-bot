import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  clickLoginButton,
  detectLoginChallenge,
  fillXLoginForm,
  safeXHandle,
  waitForXHomeTimeline,
} from '../lib/x-login.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function locator(options = {}) {
  const handle = {
    first() {
      return handle;
    },
    async isVisible() {
      return typeof options.visible === 'function' ? options.visible() : Boolean(options.visible);
    },
    async click() {
      await options.onClick?.();
    },
    async fill(value) {
      await options.onFill?.(value);
    },
    async pressSequentially(value, config) {
      await options.onType?.(value, config);
    },
    async press(key) {
      await options.onPress?.(key);
    },
    async innerText() {
      return typeof options.text === 'function' ? options.text() : (options.text ?? '');
    },
    async evaluate() {
      return options.onEvaluate ? options.onEvaluate() : true;
    },
  };
  return handle;
}

const missingLocator = locator({ visible: false });

function pageFromState({
  state,
  values,
  body,
  url,
  buttons = [],
  textButtons = [],
  selectors = {},
}) {
  return {
    locator(selector) {
      if (selector === 'body') {
        return locator({ text: body });
      }
      const factory = selectors[selector];
      return factory ? factory() : missingLocator;
    },
    getByRole(role, { name } = {}) {
      for (const button of buttons) {
        if (button.role !== role) continue;
        if (name && !name.test(button.label)) continue;
        if (typeof button.visible === 'function' ? button.visible() : button.visible) {
          return locator({ visible: true, onClick: button.onClick });
        }
      }
      return missingLocator;
    },
    getByText(text, { exact } = {}) {
      const matches = textButtons.filter(
        (button) => (exact ? button.label === text : button.label.includes(text)),
      );
      return {
        count: async () => matches.length,
        nth: (index) => {
          const match = matches[index];
          const visible = typeof match?.visible === 'function' ? match.visible() : match?.visible;
          return visible ? locator({ visible: true, onClick: match.onClick }) : missingLocator;
        },
      };
    },
    url() {
      return url();
    },
    _state: state,
    _values: values,
  };
}

function twoStepPage({ twoFactor = false } = {}) {
  const values = { identifier: '', password: '', code: '' };
  let state = 'identifier';

  const buttons = [
    {
      role: 'button',
      label: 'Next',
      visible: () => state === 'identifier' || state === 'two_factor',
      onClick: () => {
        if (state === 'identifier') state = 'password';
        else if (state === 'two_factor') state = 'home';
      },
    },
    {
      role: 'button',
      label: 'Log in',
      visible: () => state === 'password',
      onClick: () => {
        state = twoFactor ? 'two_factor' : 'home';
      },
    },
  ];

  const selectors = {
    'input[autocomplete="username"]': () => locator({
      visible: state === 'identifier',
      onType: (value) => { values.identifier = value; },
    }),
    'input[name="password"]': () => locator({
      visible: state === 'password',
      onType: (value) => { values.password = value; },
    }),
    'input[autocomplete="one-time-code"]': () => locator({
      visible: state === 'two_factor',
      onType: (value) => { values.code = value; },
    }),
    '[data-testid="primaryColumn"]': () => locator({ visible: state === 'home' }),
  };

  const page = pageFromState({
    state,
    values,
    body: () => {
      if (state === 'two_factor') return 'Enter your confirmation code';
      if (state === 'password') return 'Enter your password';
      if (state === 'home') return 'Home timeline';
      return 'Sign in to X';
    },
    url: () => (state === 'home' ? 'https://x.com/home' : 'https://x.com/i/flow/login'),
    buttons,
    selectors,
  });
  page.state = () => state;
  return page;
}

test('safeXHandle accepts handles and rejects email identifiers', () => {
  assert.equal(safeXHandle('@Alice_1'), 'alice_1');
  assert.equal(safeXHandle('alice'), 'alice');
  assert.equal(safeXHandle('alice@example.test'), null);
  assert.equal(safeXHandle('toolong_handle_name'), null);
  assert.equal(safeXHandle('1234567890'), null);
  assert.equal(safeXHandle('@1234567890'), '1234567890');
});

test('clickLoginButton can submit the plain div control on the new onboarding screen', async () => {
  const clicked = [];
  const page = {
    locator: () => missingLocator,
    getByRole: () => missingLocator,
    getByText: (label) => ({
      count: async () => 1,
      nth: () => locator({ visible: true, onClick: () => clicked.push(label) }),
    }),
  };

  assert.equal(await clickLoginButton(page, ['Continue']), true);
  assert.deepEqual(clicked, ['Continue']);
});

test('detectLoginChallenge recognizes 2FA, identity, and error screens', async () => {
  const challengePage = (body) => pageFromState({
    state: 'login',
    values: {},
    body,
    url: () => 'https://x.com/i/flow/login',
  });

  assert.equal((await detectLoginChallenge(challengePage('Enter your confirmation code'))).type, 'two-factor');
  assert.equal((await detectLoginChallenge(challengePage('Enter your phone number or username'))).type, 'identity');
  assert.equal((await detectLoginChallenge(challengePage('The password you entered is incorrect'))).type, 'error');

  const otpPage = pageFromState({
    state: 'login',
    values: {},
    body: 'Check your device',
    url: () => 'https://x.com/i/flow/login',
    selectors: {
      'input[autocomplete="one-time-code"]': () => locator({ visible: true }),
    },
  });
  assert.equal((await detectLoginChallenge(otpPage)).type, 'two-factor');
});

test('fillXLoginForm completes the two-step identifier/password flow', async () => {
  const page = twoStepPage();
  await fillXLoginForm(page, {
    identifier: 'alice@example.test',
    password: 'Password-123!',
  });

  assert.equal(page._values.identifier, 'alice@example.test');
  assert.equal(page._values.password, 'Password-123!');
  assert.equal(page.state(), 'home');
});

test('fillXLoginForm ignores an opacity-hidden password field until X advances', async () => {
  const events = [];
  const values = { identifier: '', password: '' };
  let state = 'identifier';

  const page = pageFromState({
    state,
    values,
    body: () => (state === 'password' ? 'Enter your password' : 'Email or username'),
    url: () => (state === 'home' ? 'https://x.com/home' : 'https://x.com/i/jf/onboarding/web?mode=login'),
    buttons: [
      {
        role: 'button',
        label: 'Log in',
        visible: () => state === 'password',
        onClick: () => {
          events.push('login');
          state = 'home';
        },
      },
    ],
    textButtons: [
      {
        label: 'Continue',
        visible: () => state === 'identifier',
        onClick: () => {
          events.push('continue');
          state = 'password';
        },
      },
    ],
    selectors: {
      'input[autocomplete="username"]': () => locator({
        visible: true,
        onType: (value) => {
          events.push('identifier');
          values.identifier = value;
        },
      }),
      'input[name="password"]': () => locator({
        visible: true,
        onEvaluate: () => state !== 'identifier',
        onType: (value) => {
          events.push('password');
          values.password = value;
        },
      }),
    },
  });

  await fillXLoginForm(page, {
    identifier: 'alice@example.test',
    password: 'Password-123!',
  });

  assert.equal(values.identifier, 'alice@example.test');
  assert.equal(values.password, 'Password-123!');
  assert.deepEqual(events, ['identifier', 'continue', 'password', 'login']);
  assert.equal(state, 'home');
});

test('fillXLoginForm submits an optional 2FA code when X asks for one', async () => {
  const page = twoStepPage({ twoFactor: true });
  await fillXLoginForm(page, {
    identifier: 'alice',
    password: 'Password-123!',
    twoFactorCode: '123456',
  });

  assert.equal(page._values.code, '123456');
  assert.equal(page.state(), 'home');
});

test('fillXLoginForm reports a missing 2FA code instead of hanging', async () => {
  const page = twoStepPage({ twoFactor: true });
  await assert.rejects(
    fillXLoginForm(page, {
      identifier: 'alice',
      password: 'Password-123!',
    }),
    /requires a two-factor authentication code/i,
  );
});

test('waitForXHomeTimeline waits for the authenticated home markers', async () => {
  const page = pageFromState({
    state: 'home',
    values: {},
    body: 'Home timeline',
    url: () => 'https://x.com/home',
    selectors: {
      '[data-testid="primaryColumn"]': () => locator({ visible: true }),
    },
  });

  assert.equal(await waitForXHomeTimeline(page, undefined, { timeoutMs: 100 }), true);
});

test('Fly harvest login uses stealth launch settings and the robust login helper', async () => {
  const server = await readFile(join(ROOT, 'server.js'), 'utf8');
  const flow = server.slice(
    server.indexOf('async function runAutomatedXLogin'),
    server.indexOf('async function runBrowserLogin'),
  );

  assert.match(server, /--disable-blink-features=AutomationControlled/);
  assert.match(flow, /HARVEST_STEALTH_ARGS/);
  assert.match(flow, /ignoreDefaultArgs: \['--enable-automation'\]/);
  assert.match(flow, /applyStealthProfile\(context\)/);
  assert.match(flow, /fillXLoginForm\(page/);
  assert.match(flow, /waitForXHomeTimeline\(page/);
  assert.match(flow, /hasXSessionCookies\(storageState\?\.cookies\)/);
});
