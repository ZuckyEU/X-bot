import express from 'express';
import { request } from 'node:http';
import { join } from 'node:path';
import {
  CALLBACK_GRACE_MS,
  INTERACTIVE_LOGIN_PATH,
  InteractiveLoginError,
  MACHINE_ID_PATTERN,
  SESSION_ID_PATTERN,
} from './interactive-login.js';

const VIEW_COOKIE = 'x_remote_view';

export function bearerToken(headers) {
  return String(headers.authorization ?? '').match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
}

function viewerCookie(headers) {
  for (const part of String(headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === VIEW_COOKIE) return value.join('=');
  }
  return '';
}

function replayMachine(url, config) {
  const machine = url.searchParams.get('machine');
  if (machine && !MACHINE_ID_PATTERN.test(machine)) throw new InteractiveLoginError(400, 'Invalid Fly Machine ID');
  return machine && config.machineId && machine !== config.machineId ? machine : null;
}

/** Keep status, cancellation and WebSockets on the Machine that owns the browser. */
export function flySessionRouting(config) {
  return (req, res, next) => {
    try {
      const machine = replayMachine(new URL(req.originalUrl, 'http://localhost'), config);
      if (machine) return res.set('fly-replay', `instance=${machine}`).status(409).end();
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireViewerOrigin(req, config, { required = false } = {}) {
  const origin = req.headers.origin;
  if ((required && !origin) || (origin && origin !== config.publicOrigin)) {
    throw new InteractiveLoginError(403, 'Remote browser requests must come from the Fly viewer origin');
  }
}

export function installRemoteViewer(app, { service, config, publicDir, noVncDir = '/usr/share/novnc' }) {
  app.use('/remote-login', (req, res, next) => {
    if (!config.enabled) return res.status(503).send('Interactive login is not enabled on this service.');
    const socketOrigin = config.publicOrigin.replace(/^http/, 'ws');
    res.set({
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${socketOrigin}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    });
    next();
  });
  app.use('/remote-login/novnc', express.static(noVncDir, { index: false, dotfiles: 'deny', fallthrough: false }));
  for (const file of ['viewer.js', 'viewer.css']) {
    app.get(`/remote-login/${file}`, (req, res) => res.sendFile(join(publicDir, 'remote-login', file)));
  }
  app.get('/remote-login/:sessionId', flySessionRouting(config), (req, res) => {
    if (!SESSION_ID_PATTERN.test(req.params.sessionId)) return res.status(404).end();
    // The shell and library are public static files; only the token unlocks pixels/input.
    return res.sendFile(join(publicDir, 'remote-login', 'viewer.html'));
  });

  app.post(`${INTERACTIVE_LOGIN_PATH}/:sessionId/viewer`, flySessionRouting(config), (req, res, next) => {
    try {
      requireViewerOrigin(req, config, { required: true });
      const token = bearerToken(req.headers);
      const state = service.authorizeViewer(req.params.sessionId, token);
      const maxAge = Math.floor((Date.parse(state.expiresAt) + CALLBACK_GRACE_MS - Date.now()) / 1_000);
      if (maxAge <= 0) throw new InteractiveLoginError(410, 'Remote sign-in link expired');
      res.set('Set-Cookie', `${VIEW_COOKIE}=${token}; Path=${INTERACTIVE_LOGIN_PATH}/${req.params.sessionId}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });
  app.get(`${INTERACTIVE_LOGIN_PATH}/:sessionId/viewer`, flySessionRouting(config), (req, res, next) => {
    try {
      requireViewerOrigin(req, config);
      res.json(service.authorizeViewer(req.params.sessionId, viewerCookie(req.headers)));
    } catch (error) {
      next(error);
    }
  });
}

function rejectUpgrade(socket, status, extraHeaders = '') {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n${extraHeaders}\r\n`);
}

/** An authenticated, transparent WebSocket tunnel to loopback-only websockify. */
export function attachRemoteDesktopUpgrade(server, { service, config, websockifyPort = 6080 }) {
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let sessionId;
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/');
      sessionId = parts[4];
      if (!config.enabled || parts.slice(0, 4).join('/') !== INTERACTIVE_LOGIN_PATH ||
          parts[5] !== 'websockify' || parts.length !== 6 || !SESSION_ID_PATTERN.test(sessionId ?? '')) {
        return rejectUpgrade(socket, 404);
      }
      const machine = replayMachine(url, config);
      if (machine) return rejectUpgrade(socket, 409, `fly-replay: instance=${machine}\r\n`);
      requireViewerOrigin(req, config, { required: true });
      service.authorizeViewer(sessionId, viewerCookie(req.headers), { transport: true });
      if (req.method !== 'GET' || req.headers['sec-websocket-version'] !== '13' ||
          !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] ?? '')) {
        return rejectUpgrade(socket, 400);
      }
    } catch (error) {
      return rejectUpgrade(socket, error.status || 503);
    }

    service.trackSocket(sessionId, socket);
    const headers = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': req.headers['sec-websocket-key'],
      'sec-websocket-version': '13',
    };
    if (String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((part) => part.trim()).includes('binary')) {
      headers['sec-websocket-protocol'] = 'binary';
    }
    // No app cookies, internal bearer tokens, URL tokens or arbitrary targets
    // are forwarded to websockify, which is never directly exposed by Fly.
    const proxy = request({ hostname: '127.0.0.1', port: websockifyPort, path: '/', method: 'GET', headers });
    socket.once('close', () => proxy.destroy());
    proxy.setTimeout(10_000, () => proxy.destroy(new Error('WebSocket handshake timed out')));
    proxy.on('error', () => rejectUpgrade(socket, 503));
    proxy.on('response', (response) => { response.resume(); rejectUpgrade(socket, 503); });
    proxy.on('upgrade', (response, upstream, upstreamHead) => {
      proxy.setTimeout(0);
      upstream.setTimeout(0);
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
      try {
        service.authorizeViewer(sessionId, viewerCookie(req.headers), { transport: true });
      } catch {
        upstream.destroy();
        return rejectUpgrade(socket, 410);
      }
      const responseHeaders = ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol']
        .filter((name) => response.headers[name])
        .map((name) => `${name}: ${response.headers[name]}\r\n`).join('');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    proxy.end();
  });
}
