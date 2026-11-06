import { spawn } from 'node:child_process';
import { access, chown, chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { applyStealthProfile, chromeIdentityForVersion, safeGoto, X_REFERER } from './browser.js';
import { InteractiveLoginError } from './interactive-login.js';

const WORKER_PATH = '/opt/x-login-worker/desktop-browser-server.cjs';
const TEMP_ROOT = '/run/x-login-browser';
const BROWSER_UID = 1001;
const BROWSER_GID = 1001;

/** UID 1001 is reserved for this one login's worker and Chromium, not the WM. */
async function browserUserProcesses() {
  const processes = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let status;
    try {
      status = await readFile(`/proc/${entry}/status`, 'utf8');
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
      throw error;
    }
    const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
    // Tini reaps adopted zombies; they cannot run or retain a desktop window.
    if (uid === BROWSER_UID && !/^State:\s+Z/m.test(status)) processes.push(Number(entry));
  }
  return processes;
}

async function clearBrowserUserProcesses() {
  const deadline = Date.now() + 3_000;
  do {
    const processes = await browserUserProcesses();
    if (!processes.length) return;
    for (const pid of processes) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('Desktop Chromium processes did not stop');
}

function cleanupError() {
  const error = new InteractiveLoginError(503, 'The remote desktop could not be cleared. Restart the Fly Machine.');
  error.cleanupFailed = true;
  return error;
}

/** Whitelist, rather than copy, the environment visible to the remote desktop. */
export function desktopBrowserEnvironment(directory, environment = process.env) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: join(directory, 'home'),
    TMPDIR: directory,
    XDG_CONFIG_HOME: join(directory, 'home', '.config'),
    XDG_CACHE_HOME: join(directory, 'home', '.cache'),
    USER: 'xbrowser',
    LOGNAME: 'xbrowser',
    LANG: 'en_US.UTF-8',
    DISPLAY: environment.DISPLAY || ':99',
    XAUTHORITY: '/run/x-login-desktop/Xauthority',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
  };
}

/** Launch the browser under a separate OS user, then control it over loopback. */
export async function openDesktopBrowser({ signal } = {}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new InteractiveLoginError(503, 'The isolated remote browser requires the supplied Linux container');
  }
  await access(WORKER_PATH);
  // Playwright launches Chromium in its own process group. Killing only the
  // worker's group is insufficient after a worker crash or startup abort.
  try {
    await clearBrowserUserProcesses();
  } catch {
    throw cleanupError();
  }
  await mkdir(TEMP_ROOT, { recursive: true, mode: 0o711 });
  const directory = await mkdtemp(join(TEMP_ROOT, 'login-'));
  const environment = desktopBrowserEnvironment(directory);

  let child;
  let browser;
  let closing;
  let childExited;
  function killGroup(sig) {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      signal?.removeEventListener('abort', onAbort);
      await Promise.race([browser?.close().catch(() => {}), delay(1_000)]);
      if (child?.connected) child.send({ type: 'stop' }, () => {});
      if (child) {
        await Promise.race([childExited, delay(1_000)]);
      }
      await clearBrowserUserProcesses();
      if (child) {
        await Promise.race([
          childExited,
          delay(1_000).then(() => { throw new Error('Desktop browser worker did not stop'); }),
        ]);
      }
      // This exact, newly-created directory contains only this login's profile.
      await rm(directory, { recursive: true, force: true });
    })();
    return closing;
  };
  const onAbort = () => {
    // Interrupt pending connect/navigation immediately; full cleanup is awaited.
    try { killGroup('SIGTERM'); } catch { /* Cleanup below verifies all processes. */ }
    void close().catch(() => {});
  };

  try {
    await chown(directory, BROWSER_UID, BROWSER_GID);
    await chmod(directory, 0o700);
    await mkdir(environment.HOME, { mode: 0o700 });
    await chown(environment.HOME, BROWSER_UID, BROWSER_GID);
    signal?.throwIfAborted();
    child = spawn(process.execPath, [WORKER_PATH], {
      cwd: directory,
      uid: BROWSER_UID,
      gid: BROWSER_GID,
      env: environment,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    childExited = new Promise((resolve) => child.once('close', resolve));
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Remote Chromium did not start in time')); }, 50_000);
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      };
      const onError = () => { cleanup(); reject(new Error('Could not start the desktop browser worker')); };
      const onExit = () => { cleanup(); reject(new Error('Desktop browser worker exited before startup')); };
      const onMessage = (message) => {
        if (message?.type !== 'ready') return onError();
        let url;
        try { url = new URL(message.endpoint); } catch { return onError(); }
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') return onError();
        cleanup();
        resolve(url.href);
      };
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    signal?.throwIfAborted();
    browser = await chromium.connect(endpoint, { timeout: 15_000 });
    signal?.throwIfAborted();
    const identity = chromeIdentityForVersion(browser.version());
    const context = await browser.newContext({
      userAgent: identity.userAgent,
      viewport: null,
      screen: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
      acceptDownloads: false,
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page = await context.newPage();
    await applyStealthProfile(context);
    page.setDefaultTimeout(15_000);
    await safeGoto(page, 'https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000, referer: X_REFERER });
    signal?.throwIfAborted();
    return { browser, context, page, close };
  } catch (error) {
    try {
      await close();
    } catch {
      throw cleanupError();
    }
    throw error;
  }
}
