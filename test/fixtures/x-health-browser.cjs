// Test-only preload. API tests never launch a browser or contact X; real
// Chromium/DOM coverage lives in browser tests with routed fixtures.
const { appendFileSync, existsSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

// Production enforces live verification even with the old disable flag.
// Route its default X endpoints to the local fixture, never to the internet.
if (process.env.SESSION_TEST_HEALTH_HTTP_URL) {
  const fetch = globalThis.fetch;
  globalThis.fetch = (target, options) => {
    const url = new URL(target);
    if (/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) {
      return fetch(process.env.SESSION_TEST_HEALTH_HTTP_URL, options);
    }
    if (url.hostname !== '127.0.0.1') throw new Error('External HTTP request blocked by the X health fixture');
    return fetch(target, options);
  };
}

function record(event) {
  if (process.env.SESSION_TEST_HEALTH_BROWSER_LOG) {
    appendFileSync(process.env.SESSION_TEST_HEALTH_BROWSER_LOG, `${event}\n`);
  }
}

chromium.launch = async (options) => {
  if (!options.headless || !options.args.includes('--no-sandbox')) throw new Error('Expected local headless launch');
  record('launch');
  let cookies = [];
  const pages = [];
  let connected = true;
  const browser = {
    version: () => '156.0.8078.4',
    isConnected: () => connected,
    contexts: () => [context],
    newContext: async () => context,
    close: async () => {
      if (connected) record('close');
      connected = false;
    },
  };
  const context = {
    browser: () => browser,
    pages: () => pages,
    on() {},
    addInitScript: async () => {},
    addCookies: async (values) => { cookies = values; record('cookies'); },
    route: async () => {},
    newCDPSession: async () => ({ send: async () => {}, detach: async () => {} }),
    newPage: async () => {
      let url = 'about:blank';
      const token = () => cookies.find((cookie) => cookie.name === 'auth_token')?.value ?? '';
      const page = {
        isClosed: () => !connected,
        url: () => url,
        goto: async (target) => {
          record('home');
          url = target;
          if (token().includes('browsererror')) throw new Error(`Synthetic browser failure: ${token()}`);
          if (!token().includes('browservalid') && /expired|unauthorized/.test(token())) url = 'https://x.com/i/flow/login';
          return { status: () => 200 };
        },
        waitForFunction: async () => {
          const gate = process.env.SESSION_TEST_HEALTH_BROWSER_GATE;
          if (gate && existsSync(gate)) {
            appendFileSync(`${gate}.entered`, 'home');
            const deadline = Date.now() + 5_000;
            while (existsSync(gate)) {
              if (Date.now() >= deadline) throw new Error('Health fixture gate was not released');
              await delay(10);
            }
          }
          if (token().includes('browservalid')) return { jsonValue: async () => 'valid', dispose: async () => {} };
          if (/expired|unauthorized/.test(token())) return { jsonValue: async () => 'invalid', dispose: async () => {} };
          throw new Error('Synthetic browser challenge or unavailable feed');
        },
      };
      pages.push(page);
      return page;
    },
  };
  return browser;
};
