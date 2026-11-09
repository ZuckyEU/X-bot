// Exercise the real main.js CLI and local Chromium with synthetic X pages and
// Groq responses. This preload is never loaded by the application in production.
const { appendFileSync } = require('node:fs');
const { chromium } = require('playwright');

if (process.env.NODE_ENV !== 'test' || !process.env.SESSION_TEST_RUNNER_RECORD) {
  throw new Error('Runner browser fixture requires test-only environment and a record file');
}

const scenario = process.env.SESSION_TEST_RUNNER_SCENARIO;
const record = (event) => appendFileSync(process.env.SESSION_TEST_RUNNER_RECORD, `${JSON.stringify(event)}\n`);
const home = '<button data-testid="SideNav_AccountSwitcher_Button">@zuckyeu</button><a data-testid="AppTabBar_Home_Link" href="/home">Home</a>';
const tweet = '<article data-testid="tweet"><div data-testid="User-Name">Fixture @author</div><div data-testid="tweetText">Building software with careful tests.</div></article>';
const html = (body, title = 'Synthetic X') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const refreshedCsrf = 'synthetic_refreshed_ct0_value';
const launch = chromium.launch.bind(chromium);
const launchPersistent = chromium.launchPersistentContext.bind(chromium);

async function decorate(context) {
  const addCookies = context.addCookies.bind(context);
  context.addCookies = async (cookies) => {
    record({ type: 'cookies', cookies });
    if (scenario === 'restore-error') throw new Error(`Synthetic restoration error: ${cookies[0].value}`);
    return addCookies(cookies);
  };
  if (scenario === 'navigation-warning') {
    const patchPage = (page) => {
      const goto = page.goto.bind(page);
      page.goto = async (...args) => {
        await goto(...args);
        const cookies = await context.cookies();
        throw new Error(`net::ERR_CONNECTION_RESET ${cookies.find((cookie) => cookie.name === 'auth_token').value}`);
      };
    };
    for (const page of context.pages()) patchPage(page);
    context.on('page', patchPage);
  }
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    record({ type: 'request', url: url.href });
    if (url.hostname !== 'x.com') return route.abort();
    const isHome = url.pathname === '/home';
    const isTweet = url.pathname === '/zuckyeu/status/1';
    if ((isHome && scenario === 'home-login')
      || (isTweet && ['target-login', 'target-flow-login'].includes(scenario))) {
      return route.fulfill({ status: 302, headers: { location: scenario === 'target-login' ? '/login' : '/i/flow/login' }, body: '' });
    }
    let body = html(isHome ? home : isTweet ? tweet : 'Sign in', isHome ? 'Home / X' : 'Fixture post / X');
    if (isTweet && scenario === 'delayed-login') {
      body = html('<script>setTimeout(() => history.replaceState(null, "", "/i/flow/login?redirect_after_login=%2Fhome"), 100)</script>', 'Sign in to X');
    }
    if (isTweet && ['error-element', 'error-alert'].includes(scenario)) {
      const cookies = await context.cookies();
      const auth = cookies.find((cookie) => cookie.name === 'auth_token').value;
      const title = `X error ${auth} ${encodeURIComponent(auth)} ${refreshedCsrf} ${process.env.GROQ_API_KEY}`;
      const error = scenario === 'error-element'
        ? '<div data-testid="error-detail">Something went wrong. Try reloading.</div>'
        : '<div role="alert">Request failed. Temporarily unavailable.</div>';
      body = html(`${error}<script>document.cookie = "ct0=${refreshedCsrf}; Path=/; Secure; SameSite=Lax"</script>`, title);
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  return context;
}

chromium.launch = async (options) => {
  record({ type: 'launch' });
  const browser = await launch(options);
  browser.once('disconnected', () => record({ type: 'close' }));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext({ ...options, serviceWorkers: 'block' });
    return decorate(context);
  };
  return browser;
};

chromium.launchPersistentContext = async (directory, options = {}) => {
  record({ type: 'persistent-launch', directory: String(directory), headless: Boolean(options.headless) });
  const context = await launchPersistent(directory, { ...options, serviceWorkers: 'block' });
  return decorate(context);
};

globalThis.fetch = async (target) => {
  record({ type: 'fetch', url: String(target) });
  if (target === 'https://api.groq.com/openai/v1/models') {
    return Response.json({ data: [{ id: 'llama-3.1-8b-instant' }] });
  }
  if (target === 'https://api.groq.com/openai/v1/chat/completions') {
    return Response.json({ choices: [{ message: { content: 'Small, well-tested changes make a strong foundation.' } }] });
  }
  throw new Error('External HTTP request blocked by the runner fixture');
};
