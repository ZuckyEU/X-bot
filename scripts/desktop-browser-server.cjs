// This worker is copied outside the private backend directory in the image.
// It runs as xbrowser with a fresh HOME/TMPDIR and no backend environment.
const { chromium } = require('playwright');

let browserServer;
let stopping = false;
let stopPromise;

async function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    const server = await launchPromise.catch(() => null);
    await server?.close().catch(() => {});
    process.exit(0);
  })();
  return stopPromise;
}

process.on('message', (message) => {
  if (message?.type === 'stop') void stop();
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

const launchPromise = chromium.launchServer({
  headless: false,
  host: '127.0.0.1',
  port: 0,
  timeout: 45_000,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    '--window-size=1366,768',
    '--window-position=0,0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--mute-audio',
  ],
});

(async () => {
  browserServer = await launchPromise;
  if (stopping) return stop();
  process.send?.({ type: 'ready', endpoint: browserServer.wsEndpoint() });
  browserServer.on('close', () => process.exit(0));
})().catch(() => {
  // Do not emit launch arguments, process environments, or browser output.
  process.send?.({ type: 'error' });
  process.exit(1);
});
