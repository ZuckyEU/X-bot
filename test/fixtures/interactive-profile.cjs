// Test-only stand-in for chromium.launchPersistentContext. It behaves like the
// narrow slice of the Playwright API used by the interactive login route without
// opening a real browser window (important on headless CI).
const { appendFileSync } = require('node:fs');
const { chromium } = require('playwright');

if (process.env.NODE_ENV !== 'test' || !process.env.SESSION_TEST_INTERACTIVE_RECORD) {
  throw new Error('Interactive profile fixture requires test-only environment and a record file');
}

const handle = String(process.env.SESSION_TEST_INTERACTIVE_HANDLE || 'alice').replace(/^@/, '');
const prefix = process.env.SESSION_TEST_INTERACTIVE_PREFIX || 'interactive';
const record = (event) => appendFileSync(process.env.SESSION_TEST_INTERACTIVE_RECORD, `${JSON.stringify(event)}\n`);
const cookie = (name, value, httpOnly) => ({
  name,
  value,
  domain: '.x.com',
  path: '/',
  expires: -1,
  secure: true,
  httpOnly,
  sameSite: 'Lax',
});
const sessionCookies = () => [
  cookie('auth_token', `${prefix}_auth_token_value`, true),
  cookie('ct0', `${prefix}_ct0_value`, false),
  cookie('twid', 'u%3D12345', false),
];

let context;

const page = {
  currentUrl: 'about:blank',
  isClosed: () => false,
  url() {
    return this.currentUrl;
  },
  async goto(url) {
    record({ type: 'goto', url: String(url) });
    this.currentUrl = String(url);
    setTimeout(() => {
      this.currentUrl = 'https://x.com/home';
      context.loggedIn = true;
    }, 100);
  },
  locator(selector) {
    const locator = {
      first: () => locator,
      async getAttribute(name) {
        if (selector.includes('Profile_Link') && name === 'href') return `/${handle}`;
        return null;
      },
      async innerText() {
        return selector.includes('AccountSwitcher') ? `@${handle}` : '';
      },
    };
    return locator;
  },
};

context = {
  loggedIn: false,
  pages: () => [page],
  async newPage() {
    return page;
  },
  async cookies() {
    return context.loggedIn ? sessionCookies() : [];
  },
  async storageState() {
    return { cookies: sessionCookies(), origins: [] };
  },
  async addInitScript() {},
  on() {},
  async newCDPSession() {
    return { send: async () => {}, detach: async () => {} };
  },
  browser() {
    return {
      isConnected: () => true,
      version: () => '122.0.0.0',
      contexts: () => [context],
    };
  },
  async close() {
    record({ type: 'close' });
  },
};

chromium.launchPersistentContext = async (directory, options = {}) => {
  record({
    type: 'launch',
    directory: String(directory),
    headless: Boolean(options.headless),
  });
  context.loggedIn = false;
  page.currentUrl = 'about:blank';
  return context;
};
