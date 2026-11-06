import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { desktopBrowserEnvironment } from '../lib/desktop-browser.js';
import { createInteractiveLoginClient } from '../lib/interactive-login-client.js';
import {
  createInteractiveLoginService,
  extractXSessionCookies,
  INTERACTIVE_CALLBACK_PATH,
  INTERACTIVE_LOGIN_PATH,
  interactiveTimeout,
  resolveInteractiveLoginConfig,
} from '../lib/interactive-login.js';
import { attachRemoteDesktopUpgrade, flySessionRouting, installRemoteViewer } from '../lib/remote-desktop-http.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CALLBACK_TOKEN = 'callback-token-'.padEnd(43, 'x');
const config = {
  enabled: true,
  publicOrigin: 'https://fly.example.test',
  callbackUrl: `https://render.example.test${INTERACTIVE_CALLBACK_PATH}`,
  machineId: 'machine-a',
  timeoutMs: 60_000,
};
const xCookies = [
  { name: 'auth_token', value: 'private_auth_token_value', domain: '.x.com', path: '/', secure: true, httpOnly: true },
  { name: 'ct0', value: 'private_csrf_token_value', domain: '.x.com', path: '/', secure: true, httpOnly: false },
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check) {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), 'condition did not become true');
}

function fixture(t, options = {}) {
  const state = { cookies: options.cookies ?? [], closes: 0, calls: [], cookieReads: [] };
  const page = { url: () => 'https://x.com/home', isClosed: () => false };
  const remote = {
    page,
    context: {
      pages: () => [page],
      async cookies(urls) { state.cookieReads.push(urls); return state.cookies; },
    },
    async close() { state.closes += 1; await options.onClose?.(); },
  };
  const service = createInteractiveLoginService({
    config: { ...config, ...options.config },
    openBrowser: options.openBrowser ?? (async () => remote),
    readIdentity: options.readIdentity ?? (async () => ({ username: 'alice' })),
    waitForHome: options.waitForHome ?? (async () => true),
    pollIntervalMs: 5,
    retryDelays: options.retryDelays ?? [0],
    fetchImpl: options.fetchImpl ?? (async (url, request) => {
      state.calls.push({ url, request, body: JSON.parse(request.body), closesAtDelivery: state.closes });
      return new Response('{"ok":true}');
    }),
  });
  t.after(() => service.close());
  const start = () => service.start({ requestId: crypto.randomUUID(), callbackUrl: config.callbackUrl, callbackToken: CALLBACK_TOKEN });
  return { service, start, state, remote };
}

function viewerToken(resource) {
  return new URLSearchParams(new URL(resource.viewerUrl).hash.slice(1)).get('token');
}

test('interactive configuration requires fixed HTTPS destinations in production', () => {
  assert.equal(resolveInteractiveLoginConfig({}).enabled, false);
  assert.equal(interactiveTimeout(undefined), 600_000);
  assert.equal(interactiveTimeout(1), 600_000);
  assert.equal(interactiveTimeout(1_000_000), 900_000);
  assert.throws(() => resolveInteractiveLoginConfig({
    NODE_ENV: 'production', INTERACTIVE_LOGIN_ENABLED: 'true',
    INTERACTIVE_LOGIN_PUBLIC_ORIGIN: 'http://fly.test', HARVEST_CALLBACK_URL: config.callbackUrl,
  }), /HTTPS/);
  assert.throws(() => resolveInteractiveLoginConfig({
    NODE_ENV: 'production', INTERACTIVE_LOGIN_ENABLED: 'true',
    INTERACTIVE_LOGIN_PUBLIC_ORIGIN: config.publicOrigin, HARVEST_CALLBACK_URL: 'https://user:secret@render.test/callback',
  }), /without credentials/);
});

test('remote login requires both X-scoped cookies, not foreign or incomplete names', () => {
  assert.equal(extractXSessionCookies([xCookies[0]]), null);
  assert.equal(extractXSessionCookies(xCookies.map((cookie) => ({ ...cookie, domain: '.evilx.com' }))), null);
  assert.equal(extractXSessionCookies(xCookies.map((cookie) => ({ ...cookie, path: '/login' }))), null);
  assert.equal(extractXSessionCookies(xCookies.map((cookie) => ({ ...cookie, secure: false }))), null);
  assert.equal(extractXSessionCookies(xCookies.map((cookie) => ({ ...cookie, expires: 1 }))), null);
  assert.equal(extractXSessionCookies([...xCookies, { name: 'guest_id', value: 'discard' }]).length, 2);
});

test('cookie watcher closes the desktop before posting verified cookies and never exposes them in status', async (t) => {
  const { service, start, state } = fixture(t, { cookies: xCookies });
  const resource = start();
  await service.whenFinished(resource.sessionId);
  assert.equal(service.status(resource.sessionId).status, 'completed');
  assert.equal(state.closes, 1);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].closesAtDelivery, 1);
  assert.equal(state.calls[0].url, config.callbackUrl);
  assert.equal(state.calls[0].request.redirect, 'error');
  assert.equal(state.calls[0].request.headers.Authorization, `Bearer ${CALLBACK_TOKEN}`);
  assert.deepEqual(state.calls[0].body.cookies, xCookies);
  assert.equal(state.calls[0].body.username, 'alice');
  assert.equal(state.calls[0].body.requestId, resource.sessionId);
  assert.deepEqual(state.cookieReads, [['https://x.com'], ['https://x.com']]);
  assert.equal(JSON.stringify(service.status(resource.sessionId)).includes('private_auth'), false);
  const url = new URL(resource.viewerUrl);
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.searchParams.get('machine'), 'machine-a');
  assert.throws(() => service.authorizeViewer(resource.sessionId, viewerToken(resource), { transport: true }), /no longer available/);
});

test('viewer access is per login, revoked at capture, and desktop reuse waits for cleanup', async (t) => {
  const cleanup = deferred();
  const { service, start, state } = fixture(t, { onClose: () => cleanup.promise });
  const resource = start();
  await until(() => service.status(resource.sessionId).status === 'waiting');
  assert.throws(() => service.authorizeViewer(resource.sessionId, 'wrong', { transport: true }), /access required/);
  assert.throws(start, /desktop is busy/);
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  service.trackSocket(resource.sessionId, socket);
  state.cookies = xCookies;
  await until(() => state.closes === 1);
  assert.equal(socket.destroyed, true);
  assert.throws(start, /desktop is busy/);
  cleanup.resolve();
  await service.whenFinished(resource.sessionId);
  state.cookies = [];
  const next = start();
  assert.throws(() => service.authorizeViewer(next.sessionId, viewerToken(resource), { transport: true }), /access required/);
  assert.throws(() => service.authorizeViewer(resource.sessionId, viewerToken(resource), { transport: true }), /no longer available/);
  await service.cancel(next.sessionId);
});

test('incomplete cookies keep the login interactive; cancellation closes it without cookie delivery', async (t) => {
  const { service, start, state } = fixture(t, { cookies: [xCookies[0]] });
  const resource = start();
  await until(() => service.status(resource.sessionId).status === 'waiting');
  assert.equal(service.authorizeViewer(resource.sessionId, viewerToken(resource), { transport: true }).status, 'waiting');
  await service.cancel(resource.sessionId);
  assert.equal(state.closes, 1);
  assert.equal(state.calls.length, 0);
  assert.equal(service.status(resource.sessionId).status, 'cancelled');
});

test('cookies alone do not revoke desktop input while X still requires an interactive challenge', async (t) => {
  let homeReady = false;
  const { service, start, state } = fixture(t, { cookies: xCookies, waitForHome: async () => homeReady });
  const resource = start();
  await until(() => state.cookieReads.length > 1);
  assert.equal(service.status(resource.sessionId).status, 'waiting');
  assert.equal(service.authorizeViewer(resource.sessionId, viewerToken(resource), { transport: true }).status, 'waiting');
  assert.equal(state.closes, 0);
  homeReady = true;
  await service.whenFinished(resource.sessionId);
  assert.equal(service.status(resource.sessionId).status, 'completed');
});

test('expiry revokes the stream, clears the browser and reports no cookies', async (t) => {
  const { service, start, state } = fixture(t, { config: { timeoutMs: 20 } });
  const resource = start();
  await service.whenFinished(resource.sessionId);
  assert.equal(service.status(resource.sessionId).status, 'expired');
  assert.equal(state.closes, 1);
  assert.equal(state.calls[0].body.status, 'expired');
  assert.equal(Object.hasOwn(state.calls[0].body, 'cookies'), false);
});

test('callback delivery retries a lost acknowledgement using identical payloads', async (t) => {
  const calls = [];
  const { service, start } = fixture(t, {
    cookies: xCookies,
    retryDelays: [0, 1],
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return new Response('{}', { status: calls.length === 1 ? 503 : 200 });
    },
  });
  const resource = start();
  await service.whenFinished(resource.sessionId);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.body, calls[1].request.body);
  assert.equal(service.status(resource.sessionId).status, 'completed');
});

test('a permanent callback rejection fails safely and does not publish cookies', async (t) => {
  let calls = 0;
  const { service, start } = fixture(t, {
    cookies: xCookies, retryDelays: [0, 1],
    fetchImpl: async () => { calls += 1; return new Response('{}', { status: 401 }); },
  });
  const resource = start();
  await service.whenFinished(resource.sessionId);
  assert.equal(calls, 1);
  assert.equal(service.status(resource.sessionId).status, 'failed');
  assert.equal(JSON.stringify(service.status(resource.sessionId)).includes(xCookies[0].value), false);
});

test('cancel during startup still waits for the eventual browser to be disposed', async (t) => {
  const startup = deferred();
  const { service, start, remote, state } = fixture(t, { openBrowser: () => startup.promise });
  const resource = start();
  const stopped = service.cancel(resource.sessionId);
  assert.throws(start, /desktop is busy/);
  startup.resolve(remote);
  await stopped;
  assert.equal(state.closes, 1);
  assert.equal(state.calls.length, 0);
});

test('cancellation remembers a not-yet-started request and rejects delayed starts', async (t) => {
  const { service } = fixture(t);
  const id = crypto.randomUUID();
  const cancelled = await service.cancel(id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.browserClosed, true);
  assert.throws(() => service.start({ requestId: id, callbackUrl: config.callbackUrl, callbackToken: CALLBACK_TOKEN }), /already used/);
  assert.equal((await service.cancel(id)).status, 'cancelled');
});

test('cancellation during a cookie read cannot overwrite the cancelled state or deliver cookies', async (t) => {
  const reading = deferred();
  const { service, start, remote, state } = fixture(t);
  remote.context.cookies = () => reading.promise;
  const resource = start();
  await until(() => service.status(resource.sessionId).status === 'waiting');
  const stopped = service.cancel(resource.sessionId);
  reading.resolve(xCookies);
  await stopped;
  assert.equal(service.status(resource.sessionId).status, 'cancelled');
  assert.equal(state.calls.length, 0);
  assert.equal(state.closes, 1);
});

test('an unconfirmed cleanup during browser startup blocks desktop reuse', async (t) => {
  const { service, start } = fixture(t, {
    openBrowser: async () => { throw Object.assign(new Error('Startup cleanup failed'), { cleanupFailed: true }); },
  });
  const resource = start();
  await service.whenFinished(resource.sessionId);
  assert.equal(service.status(resource.sessionId).browserClosed, false);
  assert.throws(start, /needs a Fly Machine restart/);
});

test('cleanup failure blocks subsequent tenants instead of reusing a stale desktop', async (t) => {
  const { service, start } = fixture(t, { cookies: xCookies, onClose: () => { throw new Error('close failed'); } });
  const resource = start();
  await service.whenFinished(resource.sessionId);
  assert.equal(service.status(resource.sessionId).status, 'failed');
  assert.throws(start, /needs a Fly Machine restart/);
});

test('Fly refuses callback overrides and weak callback tokens before launching a browser', async (t) => {
  const { service, state } = fixture(t);
  assert.throws(() => service.start({ requestId: crypto.randomUUID(), callbackUrl: 'http://169.254.169.254/', callbackToken: CALLBACK_TOKEN }), /does not match/);
  assert.throws(() => service.start({ requestId: crypto.randomUUID(), callbackUrl: config.callbackUrl, callbackToken: 'short' }), /strong one-time/);
  assert.throws(() => service.start({ requestId: [crypto.randomUUID()], callbackUrl: config.callbackUrl, callbackToken: CALLBACK_TOKEN }), /request ID/);
  assert.equal(state.cookieReads.length, 0);
});

test('desktop worker gets fresh paths and a whitelist without application secrets', () => {
  const environment = desktopBrowserEnvironment('/run/browser/login-one', {
    DISPLAY: ':99', SESSION_SECRET: 'secret', HARVEST_API_TOKEN: 'secret',
    GROQ_API_KEY: 'secret', BROWSERBASE_API_KEY: 'secret', DATA_DIR: '/private',
  });
  assert.equal(environment.DISPLAY, ':99');
  assert.equal(environment.HOME, '/run/browser/login-one/home'.replaceAll('/', process.platform === 'win32' ? '\\' : '/'));
  assert.equal(environment.TMPDIR, '/run/browser/login-one');
  assert.equal(environment.USER, 'xbrowser');
  assert.equal(JSON.stringify(environment).includes('secret'), false);
  assert.equal(Object.hasOwn(environment, 'DATA_DIR'), false);
});

test('interactive client keeps service credentials backend-only and pins status/cancel to Fly', async () => {
  const calls = [];
  const id = crypto.randomUUID();
  const client = createInteractiveLoginClient({
    environment: { HARVEST_API_URL: 'https://fly.example.test/api/harvest-token', HARVEST_API_TOKEN: 'service-secret', HARVEST_CALLBACK_URL: config.callbackUrl },
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return new Response(JSON.stringify(request.method === 'POST' ? {
        sessionId: id, viewerUrl: `https://fly.example.test/remote-login/${id}?machine=machine-a#token=${'v'.repeat(43)}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), machineId: 'machine-a',
      } : { status: 'waiting' }));
    },
  });
  const resource = await client.start({ requestId: id, callbackToken: CALLBACK_TOKEN });
  await client.status(id, { machineId: resource.machineId });
  await client.cancel(id, { machineId: resource.machineId });
  assert.equal(calls[0].request.headers.Authorization, 'Bearer service-secret');
  assert.deepEqual(JSON.parse(calls[0].request.body), { requestId: id, callbackUrl: config.callbackUrl, callbackToken: CALLBACK_TOKEN });
  assert.equal(calls[0].request.redirect, 'error');
  assert.match(calls[1].url, /\?machine=machine-a$/);
  assert.equal(calls[2].request.method, 'DELETE');
  assert.equal(JSON.stringify(resource).includes('service-secret'), false);
  assert.equal(JSON.stringify(resource).includes(CALLBACK_TOKEN), false);
});

test('interactive client rejects a mismatched or external viewer URL', async () => {
  const id = crypto.randomUUID();
  const client = createInteractiveLoginClient({
    environment: { HARVEST_API_URL: 'https://fly.example.test/api/harvest-token', HARVEST_API_TOKEN: 'secret', HARVEST_CALLBACK_URL: config.callbackUrl },
    fetchImpl: async () => new Response(JSON.stringify({
      sessionId: id, viewerUrl: `https://evil.test/remote-login/${id}#token=${'v'.repeat(43)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  });
  await assert.rejects(client.start({ requestId: id, callbackToken: CALLBACK_TOKEN }), /invalid remote sign-in/);
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function handshake(baseUrl, path, { cookie = '', origin = baseUrl, extra = '' } = {}) {
  const url = new URL(baseUrl);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  const chunks = [];
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Handshake timed out')); }, 2_000);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      const boundary = data.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      clearTimeout(timer);
      resolve({ socket, header: data.subarray(0, boundary).toString(), received: () => Buffer.concat(chunks).toString() });
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Protocol: binary\r\nCookie: ${cookie}\r\n\r\n${extra}`);
  return connected;
}

test('noVNC HTTP/WebSocket gateway requires a session cookie and same-origin access, then revokes the tunnel', { timeout: 10_000 }, async (t) => {
  const backendHeaders = [];
  const backendSockets = new Set();
  const backend = createServer();
  backend.on('upgrade', (req, socket, head) => {
    backendSockets.add(socket);
    socket.once('close', () => backendSockets.delete(socket));
    socket.once('end', () => socket.end());
    backendHeaders.push(req.headers);
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.on('error', () => {});
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: binary\r\n\r\nRFB-TEST`);
    if (head.length) socket.write(head);
    socket.on('data', (data) => socket.write(data));
  });
  await listen(backend);
  const { service, start } = fixture(t);
  const localConfig = { ...config, machineId: '' };
  const app = express();
  app.use(express.json());
  installRemoteViewer(app, { service, config: localConfig, publicDir: join(ROOT, 'public') });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app);
  attachRemoteDesktopUpgrade(server, { service, config: localConfig, websockifyPort: backend.address().port });
  const baseUrl = await listen(server);
  localConfig.publicOrigin = baseUrl;
  t.after(async () => {
    await service.close();
    for (const socket of backendSockets) socket.destroy();
    server.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => backend.close(resolve))]);
  });
  const resource = start();
  await until(() => service.status(resource.sessionId).status === 'waiting');
  const path = `${INTERACTIVE_LOGIN_PATH}/${resource.sessionId}`;
  const shell = await fetch(`${baseUrl}/remote-login/${resource.sessionId}`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await shell.text(), /official/);
  const unauthorized = await handshake(baseUrl, `${path}/websockify`);
  assert.match(unauthorized.header, /401/);
  const claim = await fetch(`${baseUrl}${path}/viewer`, { method: 'POST', headers: { Origin: baseUrl, Authorization: `Bearer ${viewerToken(resource)}` } });
  assert.equal(claim.status, 200);
  const setCookie = claim.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, new RegExp(`Path=${path}/`));
  const cookie = setCookie.split(';')[0];
  const foreign = await handshake(baseUrl, `${path}/websockify`, { cookie, origin: 'https://evil.test' });
  assert.match(foreign.header, /403/);
  const tunnel = await handshake(baseUrl, `${path}/websockify`, { cookie, extra: 'HEAD-BYTES' });
  assert.match(tunnel.header, /101 Switching Protocols/);
  await until(() => tunnel.received().includes('RFB-TEST') && tunnel.received().includes('HEAD-BYTES'));
  assert.equal(backendHeaders[0].cookie, undefined);
  assert.equal(backendHeaders[0].authorization, undefined);
  const closed = new Promise((resolve) => tunnel.socket.once('close', resolve));
  await service.cancel(resource.sessionId);
  await closed;
  const stale = await handshake(baseUrl, `${path}/websockify`, { cookie });
  assert.match(stale.header, /410/);
});

test('Fly session routing replays to the owning Machine without accepting header injection', () => {
  const routing = flySessionRouting(config);
  let header;
  let code;
  const response = { set(name, value) { header = [name, value]; return response; }, status(value) { code = value; return response; }, end() {} };
  routing({ originalUrl: '/session?machine=machine-b' }, response, () => assert.fail('should replay'));
  assert.deepEqual(header, ['fly-replay', 'instance=machine-b']);
  assert.equal(code, 409);
  routing({ originalUrl: '/session?machine=bad%0D%0Aheader' }, response, (error) => assert.equal(error.status, 400));
});

test('desktop restores Xauthority group access after the atomic xauth write', async () => {
  const startup = await readFile(join(ROOT, 'scripts', 'start-desktop.sh'), 'utf8');
  const write = startup.indexOf('xauth -f "$XAUTHORITY" add ');
  const ownership = startup.indexOf('chown root:xbrowser "$XAUTHORITY"');
  const permissions = startup.indexOf('chmod 640 "$XAUTHORITY"');
  const displayStart = startup.indexOf('env -i PATH="$SERVICE_PATH" Xvfb ');

  assert.notEqual(write, -1);
  assert.ok(ownership > write, 'Restore group ownership after xauth replaces the file');
  assert.ok(permissions > ownership, 'Restore group read access after the write');
  assert.ok(displayStart > permissions, 'Finalize restricted access before starting the display');
});

test('container privacy and lifetime settings are explicit, and the dashboard script parses', async () => {
  const [dockerfile, startup, worker, fly, html, viewer] = await Promise.all([
    readFile(join(ROOT, 'Dockerfile'), 'utf8'), readFile(join(ROOT, 'scripts', 'start-desktop.sh'), 'utf8'),
    readFile(join(ROOT, 'scripts', 'desktop-browser-server.cjs'), 'utf8'), readFile(join(ROOT, 'fly.toml'), 'utf8'),
    readFile(join(ROOT, 'public', 'index.html'), 'utf8'), readFile(join(ROOT, 'public', 'remote-login', 'viewer.js'), 'utf8'),
  ]);
  assert.match(dockerfile, /DEBIAN_FRONTEND=noninteractive TZ=Etc\/UTC apt-get install -y --no-install-recommends/);
  assert.match(dockerfile, /chmod -R go-rwx \/usr\/src\/app/);
  assert.match(startup, /-listen 127\.0\.0\.1 -no6/);
  assert.match(startup, /127\.0\.0\.1:6080 127\.0\.0\.1:5900/);
  assert.match(startup, /runuser -u xdesktop -- env -i/);
  assert.match(startup, /wait -n/);
  assert.match(worker, /headless: false/);
  assert.match(worker, /host: '127\.0\.0\.1'/);
  assert.match(fly, /auto_stop_machines = false/);
  assert.match(fly, /memory = "1gb"/);
  assert.match(viewer, /history\.replaceState/);
  assert.equal(viewer.includes('localStorage'), false);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});
