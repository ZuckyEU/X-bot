import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { applyStealthProfile } from '../lib/browser.js';

async function runtimeFixture(options, { plugins = [], chrome } = {}) {
  const initScripts = [];
  const context = {
    addInitScript: async (script, argument) => initScripts.push({ script, argument }),
    pages: () => [],
  };
  await applyStealthProfile(context, options);
  await applyStealthProfile(context, options);
  assert.equal(initScripts.length, 1, 'install the shared init script only once');

  class Navigator {}
  Object.defineProperties(Navigator.prototype, {
    webdriver: { configurable: true, get: () => true },
    plugins: { configurable: true, get: () => plugins },
  });
  const navigator = new Navigator();
  const window = {
    navigator,
    chrome,
    innerWidth: 1366,
    innerHeight: 768,
    Plugin: class Plugin {},
    PluginArray: class PluginArray {},
    MimeType: class MimeType {},
    MimeTypeArray: class MimeTypeArray {},
  };
  const { script, argument } = initScripts[0];
  runInNewContext(`(${script.toString()})(argument)`, { Navigator, navigator, window, argument });
  return { navigator, window };
}

test('isolated desktop worker launches headed Chromium with all requested flags', async () => {
  const source = await readFile(new URL('../scripts/desktop-browser-server.cjs', import.meta.url), 'utf8');
  const browserServer = new EventEmitter();
  browserServer.wsEndpoint = () => 'ws://127.0.0.1:9222/desktop';
  const workerProcess = new EventEmitter();
  const messages = [];
  workerProcess.send = (message) => messages.push(message);
  workerProcess.exit = () => assert.fail('worker should remain available after startup');
  let launchOptions;

  await runInNewContext(source, {
    process: workerProcess,
    require: (name) => {
      assert.equal(name, 'playwright');
      return { chromium: {
        launchServer: async (options) => {
          launchOptions = options;
          return browserServer;
        },
      } };
    },
  });

  assert.equal(launchOptions.headless, false);
  assert.equal(launchOptions.host, '127.0.0.1');
  assert.deepEqual(Array.from(launchOptions.ignoreDefaultArgs), ['--enable-automation']);
  for (const flag of [
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1366,768',
  ]) {
    assert.ok(launchOptions.args.includes(flag), `missing Chromium flag: ${flag}`);
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'ready');
  assert.equal(messages[0].endpoint, browserServer.wsEndpoint());
});

test('desktop context uses a version-matched Chrome UA, desktop viewport, and init script before navigation', async () => {
  const source = await readFile(new URL('../lib/desktop-browser.js', import.meta.url), 'utf8');
  assert.match(source, /chromeIdentityForVersion\(browser\.version\(\)\)/);
  assert.match(source, /userAgent: identity\.userAgent/);
  assert.match(source, /viewport: \{ width: 1366, height: 768 \}/);
  assert.match(source, /screen: \{ width: 1366, height: 768 \}/);
  assert.match(source, /await applyStealthProfile\(context, \{ hideWebdriver: true \}\)/);
  assert.ok(source.indexOf('await applyStealthProfile(') < source.indexOf('await safeGoto('));
});

test('desktop init script hides webdriver and supplies languages, PDF plugins, and Chrome runtime', async () => {
  const { navigator, window } = await runtimeFixture({ hideWebdriver: true });
  assert.equal(navigator.webdriver, undefined);
  assert.deepEqual(Array.from(navigator.languages), ['en-US', 'en']);
  assert.equal(navigator.plugins.length, 5);
  assert.ok(navigator.plugins instanceof window.PluginArray);
  assert.equal(navigator.plugins.item(1).name, 'Chrome PDF Viewer');
  assert.equal(navigator.plugins.namedItem('PDF Viewer').filename, 'internal-pdf-viewer');
  assert.equal(navigator.mimeTypes.length, 2);
  assert.ok(window.chrome);
  assert.equal(typeof window.chrome.runtime, 'object');
});

test('desktop init script preserves native plugins and Chrome runtime; other contexts retain their default', async () => {
  const plugins = [{ name: 'Native PDF Viewer' }];
  const chrome = { runtime: { id: 'native-runtime' }, app: {} };
  const desktop = await runtimeFixture({ hideWebdriver: true }, { plugins, chrome });
  assert.equal(desktop.navigator.webdriver, undefined);
  assert.equal(desktop.navigator.plugins, plugins);
  assert.equal(desktop.window.chrome, chrome);
  assert.equal(desktop.window.chrome.runtime.id, 'native-runtime');
  assert.equal((await runtimeFixture()).navigator.webdriver, false);
});
