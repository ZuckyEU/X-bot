import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import bcrypt from 'bcrypt';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'crypto';
import {
  closeBrowser,
  connectBrowser,
  createTrustedLoginProfile,
  createLiveInspection,
  getDefaultContext,
  getOrCreatePage,
  restoreStorageState,
  safeContextCall,
  safeGoto,
  X_LOGIN_URL,
  X_REFERER,
} from './lib/browser.js';

/**
 * Local service for the X reply automation.
 *
 *   POST /api/auth/register, /api/auth/login -> persisted local user authentication
 *   GET  /api/auth/x-accounts -> list the logged-in user's saved X sessions
 *   POST /api/auth/switch-account -> select the X session used by automation
 *   GET/PUT/DELETE /api/config/groq -> manage the user's persisted Groq API key
 *   POST /auth/x     -> Browserless Live URL sign-in -> sessions/<userId>/<xUsername>.json
 *   POST /auth/x/complete -> confirm the remote sign-in and save the X session
 *   POST /auth/x/cancel   -> cancel the active remote sign-in and close Browserless
 *   POST /api/run    -> run the reply pipeline with the active X session
 *
 * Binds to 0.0.0.0 by default so container platforms such as Render can reach it.
 * Anyone who can reach this port can swap your X session or trigger the sign-in
 * browser, so terminate TLS and configure access controls before public exposure.
 * Set HOST=127.0.0.1 for local-only use.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR || ROOT);
const AUTH_FILE = join(DATA_DIR, 'auth.json');
const USER_DB_FILE = join(DATA_DIR, 'user-db.json');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const DEFAULT_ADMIN_USERNAME = String(process.env.DEFAULT_ADMIN_USERNAME || '').trim();
const DEFAULT_ADMIN_EMAIL = String(process.env.DEFAULT_ADMIN_EMAIL || '')
  .trim()
  .toLowerCase();
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || '');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const MAX_BODY = '16kb';

/** Only these cookies can be written through the API. */
const COOKIE_SPEC = {
  auth_token: { httpOnly: true },
  ct0: { httpOnly: false },
};
const COOKIE_VALUE = /^[A-Za-z0-9._~%+/-]+={0,2}$/;
const MAX_VALUE_LENGTH = 512;
const MAX_GROQ_API_KEY_LENGTH = 512;
const MAX_X_ACCOUNTS = 3;
const APP_SESSION_COOKIE = 'x_engine_session';
const APP_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEVELOPMENT_SESSION_SECRET = 'dev-secret-change-in-production';
const SESSION_SECRET = String(process.env.SESSION_SECRET || DEVELOPMENT_SESSION_SECRET);
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);
const INSECURE_SESSION_SECRETS = new Set([
  DEVELOPMENT_SESSION_SECRET,
  'change-me',
  'changeme',
  'your-session-secret',
  'replace-with-at-least-32-random-characters',
]);

if (!Number.isInteger(BCRYPT_ROUNDS) || BCRYPT_ROUNDS < 10 || BCRYPT_ROUNDS > 15) {
  throw new Error('BCRYPT_ROUNDS must be an integer between 10 and 15');
}
if (IS_PRODUCTION && (SESSION_SECRET.length < 32 || INSECURE_SESSION_SECRETS.has(SESSION_SECRET.toLowerCase()))) {
  throw new Error('SESSION_SECRET must be a unique value of at least 32 characters in production');
}
if (!IS_PRODUCTION && !process.env.SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET is using the development fallback; set a unique 32+ character value before deployment.');
}

/** Same shape main.js accepts; keeps anything else out of argv. */
const TWEET_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

const LOGIN_URL = X_LOGIN_URL;
const HOME_URL = 'https://x.com/home';
const SESSION_COOKIE = 'auth_token';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LIVE_VIEW_TIMEOUT_MS = (() => {
  const configured = Number(process.env.BROWSERLESS_LIVE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 30_000) return LOGIN_TIMEOUT_MS;
  return Math.min(configured, LOGIN_TIMEOUT_MS);
})();
const POST_LOGIN_TIMEOUT_MS = 60 * 1000;
const AUTH_RUN_TIMEOUT_MS = LOGIN_TIMEOUT_MS + POST_LOGIN_TIMEOUT_MS + 5_000;
const LOGIN_PROFILE_CHECKPOINT_MS = 15_000;
const RESERVED_X_ROUTES = new Set(['home', 'explore', 'notifications', 'messages', 'search', 'compose', 'settings', 'i']);

const HISTORY_FILE = join(DATA_DIR, 'history.json');
const REPLY_OUT_FILE = join(tmpdir(), 'playwright-gemini-reply.txt');

/** Invalidates an in-flight sign-in before it can save a cleared session again. */
let authGeneration = 0;

/** Only one automation / sign-in run at a time; drives the 409 + the Stop button. */
let activeRun = null;

const app = express();
app.disable('x-powered-by');

// cors() with no options would let any website PUT to localhost and hijack the
// session, so only the UI's own origin and explicitly trusted deployment origins
// are allowed. Render sets RENDER_EXTERNAL_URL automatically; PUBLIC_ORIGIN and
// ALLOWED_ORIGINS support custom domains (comma-separated).
function toOrigin(value) {
  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return null;
  }
}

const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
for (const value of [process.env.PUBLIC_ORIGIN, process.env.RENDER_EXTERNAL_URL, process.env.ALLOWED_ORIGINS]) {
  for (const candidate of String(value || '').split(',')) {
    if (!candidate.trim()) continue;
    const origin = toOrigin(candidate);
    if (origin) allowedOrigins.add(origin);
    else console.warn(`[cors] Ignoring invalid origin: ${candidate.trim()}`);
  }
}

function isOnRenderOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:'
      && (url.hostname === 'onrender.com' || url.hostname.endsWith('.onrender.com'));
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const normalized = toOrigin(origin);
  if (!normalized) return false;
  if (allowedOrigins.has(normalized)) return true;
  return IS_PRODUCTION && isOnRenderOrigin(normalized);
}

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'));
    },
  }),
);

app.use(bodyParser.json({ limit: MAX_BODY }));
app.use(express.static(PUBLIC_DIR));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/* -------------------------------- helpers -------------------------------- */

/** Serialises writes so two overlapping PUTs cannot clobber each other. */
let writeQueue = Promise.resolve();
const withWriteLock = (task) => {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mask = (value) =>
  value.length <= 8 ? '•'.repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;

/** User authentication and session management. */
const MAX_USERS_PER_IP = 10;

/** Load user database */
async function loadUserDb() {
  try {
    const raw = await readFile(USER_DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function atomicWritePrivateFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Save user database through a private, atomic replacement. Call under withWriteLock. */
async function saveUserDb(users) {
  await atomicWritePrivateFile(USER_DB_FILE, `${JSON.stringify(users, null, 2)}\n`);
}

/**
 * Optional bootstrap account for deployments with ephemeral storage. The
 * account is only created when the database has no matching username/email, so
 * an existing password and linked X sessions are never overwritten.
 */
async function seedDefaultAdmin() {
  const configured = [DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD];
  if (configured.every((value) => value === '')) return;

  if (!configured.every((value) => value !== '')) {
    throw new Error(
      'DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD must all be set when admin seeding is enabled',
    );
  }

  const { username, email, password } = validateUserInput({
    username: DEFAULT_ADMIN_USERNAME,
    email: DEFAULT_ADMIN_EMAIL,
    password: DEFAULT_ADMIN_PASSWORD,
  });
  const created = await withWriteLock(async () => {
    const users = await loadUserDb();
    const exists = users.some(
      (user) =>
        String(user.username ?? '').toLowerCase() === username.toLowerCase() ||
        String(user.email ?? '').toLowerCase() === email,
    );
    if (exists) return false;

    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    users.push({
      id: crypto.randomUUID(),
      username,
      email,
      passwordHash,
      createdAt: now,
      lastLogin: null,
      preferences: { defaultXAccount: null },
      xAccounts: [],
      sessionToken: null,
      ipAddress: 'bootstrap',
    });
    await saveUserDb(users);
    return true;
  });

  console.log(
    created
      ? `[bootstrap] Seeded default admin @${username}.`
      : '[bootstrap] A matching default admin already exists; no changes made.',
  );
}

/** Bcrypt receives a fixed-length HMAC so long passwords are never silently truncated. */
function passwordMaterial(password) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(password, 'utf8').digest('base64');
}

async function hashPassword(password) {
  return bcrypt.hash(passwordMaterial(password), BCRYPT_ROUNDS);
}

async function verifyPassword(password, storedHash) {
  const encoded = String(storedHash ?? '');
  if (/^\$2[aby]\$\d{2}\$/.test(encoded)) {
    return bcrypt.compare(passwordMaterial(password), encoded);
  }

  // Successful legacy logins are migrated to bcrypt immediately below.
  const [algorithm, salt, expectedHex] = encoded.split('$');
  if (algorithm === 'scrypt' && salt && /^[a-f0-9]{128}$/i.test(expectedHex ?? '')) {
    const expected = Buffer.from(expectedHex, 'hex');
    for (const legacySecret of new Set([SESSION_SECRET, DEVELOPMENT_SESSION_SECRET])) {
      const actual = crypto.scryptSync(`${password}${legacySecret}`, salt, 64);
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return true;
    }
    return false;
  }

  if (/^[a-f0-9]{64}$/i.test(encoded)) {
    const legacy = crypto.createHash('sha256').update(password).digest();
    const expected = Buffer.from(encoded, 'hex');
    return expected.length === legacy.length && crypto.timingSafeEqual(expected, legacy);
  }

  return false;
}

function passwordHashNeedsUpgrade(storedHash) {
  const encoded = String(storedHash ?? '');
  if (!/^\$2[aby]\$\d{2}\$/.test(encoded)) return true;
  try {
    return bcrypt.getRounds(encoded) < BCRYPT_ROUNDS;
  } catch {
    return true;
  }
}

/** Generate session token */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Validate user input */
function validateUserInput({ username, email, password }) {
  const normalizedUsername = String(username ?? '').trim();
  const normalizedEmail = String(email ?? '').trim().toLowerCase();

  if (normalizedUsername.length < 3 || normalizedUsername.length > 30) {
    throw new ValidationError('Username must be between 3 and 30 characters');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(normalizedUsername)) {
    throw new ValidationError('Username can only contain letters, numbers, and underscores');
  }
  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    throw new ValidationError('A valid email address is required');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new ValidationError('Password must be between 8 and 256 characters');
  }

  return { username: normalizedUsername, email: normalizedEmail, password };
}

/** Get client IP address */
function getClientIP(req) {
  return req.ip ||
    req.connection.remoteAddress ||
    (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : null) ||
    req.socket.remoteAddress ||
    'unknown';
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    xAccounts: Array.isArray(user.xAccounts) ? user.xAccounts : [],
    activeXAccount: user.preferences?.defaultXAccount ?? null,
    groq: publicGroqConfiguration(user),
  };
}

function setSessionCookie(res, token) {
  res.cookie(APP_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,
    maxAge: APP_SESSION_MAX_AGE_MS,
    priority: 'high',
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(APP_SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: IS_PRODUCTION, path: '/' });
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionTokenFromRequest(req) {
  const authorization = String(req.headers.authorization ?? '');
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  return bearer ?? cookieValue(req, APP_SESSION_COOKIE) ?? null;
}

async function authenticatedUser(req, { required = true } = {}) {
  const token = sessionTokenFromRequest(req);
  if (!token) {
    if (required) throw new HttpError(401, 'Authentication required');
    return null;
  }

  const users = await loadUserDb();
  const index = users.findIndex((user) => user.sessionToken === token);
  if (index < 0) {
    if (required) throw new HttpError(401, 'Invalid or expired session');
    return null;
  }

  return { token, users, index, user: users[index] };
}

async function optionalAuthenticatedUser(req) {
  return sessionTokenFromRequest(req) ? authenticatedUser(req) : null;
}

function normalizeXUsername(value) {
  const username = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(username)) {
    throw new ValidationError('X username must contain 1-15 letters, numbers, or underscores');
  }
  return username;
}

function normalizeUserAccounts(user) {
  const accounts = Array.isArray(user.xAccounts) ? user.xAccounts : [];
  user.xAccounts = [...new Set(accounts.map((account) => normalizeXUsername(account)))];
  user.preferences ??= {};
  const preferred = user.preferences.defaultXAccount;
  user.preferences.defaultXAccount = preferred && user.xAccounts.includes(normalizeXUsername(preferred))
    ? normalizeXUsername(preferred)
    : user.xAccounts[0] ?? null;
  return user;
}

function sessionDirectoryFor(userId) {
  const safeUserId = String(userId ?? '');
  if (!/^[a-f0-9-]{16,64}$/i.test(safeUserId)) throw new Error('Invalid user id in user database');
  return join(SESSIONS_DIR, safeUserId);
}

function sessionFileFor(userId, xUsername) {
  return join(sessionDirectoryFor(userId), `${normalizeXUsername(xUsername)}.json`);
}

function loginProfileFileFor(userId) {
  return join(sessionDirectoryFor(userId), '_trusted-login-profile.json');
}

async function sessionFileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readAuthFile(path = AUTH_FILE) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); // tolerate a BOM
  if (Array.isArray(parsed)) return { cookies: parsed };
  if (!parsed || !Array.isArray(parsed.cookies)) throw new Error(`${path} is not a Playwright storage-state file`);
  return parsed;
}

async function writeAuthFile(payload, path = AUTH_FILE) {
  if (!payload || !Array.isArray(payload.cookies)) {
    throw new ValidationError('Playwright storage state must contain a cookies array');
  }
  await atomicWritePrivateFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function deleteAuthFile(path = AUTH_FILE) {
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function describe(payload) {
  const cookies = payload?.cookies ?? [];
  const view = {};

  for (const [name, spec] of Object.entries(COOKIE_SPEC)) {
    const cookie = cookies.find((item) => item.name === name && item.domain === '.x.com');
    view[name] = cookie
      ? {
          present: true,
          preview: mask(String(cookie.value ?? '')),
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...spec,
        }
      : { present: false, ...spec };
  }

  return {
    authenticated: Boolean(payload) && Boolean(view.auth_token?.present),
    username: payload?.username ?? null,
  };
}

function validateValue(name, value) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < 8) throw new ValidationError(`${name} looks too short (${trimmed.length} chars)`);
  if (trimmed.length > MAX_VALUE_LENGTH) throw new ValidationError(`${name} is too long (max ${MAX_VALUE_LENGTH})`);
  if (!COOKIE_VALUE.test(trimmed)) throw new ValidationError(`${name} contains characters a cookie value cannot have`);
  return trimmed;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ValidationError extends HttpError {
  constructor(message) {
    super(400, message);
  }
}

function getGroqConfiguration(user) {
  const apiKey = String(user?.groqApiKey ?? '').trim() || null;
  return {
    configured: Boolean(apiKey),
    source: apiKey ? 'account' : 'none',
    apiKey,
  };
}

function publicGroqConfiguration(user) {
  const { configured, apiKey } = getGroqConfiguration(user);
  return {
    configured,
    source: configured ? 'account' : 'none',
    preview: configured ? mask(apiKey) : null,
  };
}

/** Persists the key on the user record so it survives logout/login. */
async function saveUserGroqApiKey(userId, apiKey) {
  return withWriteLock(async () => {
    const users = await loadUserDb();
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) throw new HttpError(401, 'User account no longer exists');
    if (apiKey) user.groqApiKey = apiKey;
    else delete user.groqApiKey;
    await saveUserDb(users);
    return user;
  });
}

function validateGroqApiKey(value) {
  if (typeof value !== 'string') throw new ValidationError('apiKey must be a string');
  const trimmed = value.trim();
  if (trimmed.length < 16) throw new ValidationError('Groq API key looks too short');
  if (trimmed.length > MAX_GROQ_API_KEY_LENGTH) {
    throw new ValidationError(`Groq API key is too long (max ${MAX_GROQ_API_KEY_LENGTH})`);
  }
  if (/\s/.test(trimmed)) throw new ValidationError('Groq API key cannot contain whitespace');
  return trimmed;
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  };
  signalGroup('SIGTERM');
  const forceKill = setTimeout(() => signalGroup('SIGKILL'), 2_000);
  forceKill.unref?.();
  child.once('close', () => clearTimeout(forceKill));
}

function attachRunCleanup(res, handle) {
  res.on('close', () => {
    if (!res.writableEnded && activeRun === handle) handle.abort();
  });
}

function makeSend(res) {
  return (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
}

function createCompletionSignal() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Coordinates the "Complete Sign-In" button with the long-running login stream. */
function createLoginControl() {
  let requested = false;
  let wake = null;

  return {
    get requested() {
      return requested;
    },
    request() {
      requested = true;
      const resume = wake;
      wake = null;
      resume?.();
    },
    reset() {
      requested = false;
    },
    wake() {
      const resume = wake;
      wake = null;
      resume?.();
    },
    wait(timeoutMs) {
      if (requested) return Promise.resolve(true);

      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (wake === onWake) wake = null;
          resolve(value);
        };
        const onWake = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        wake = onWake;
      });
    },
  };
}

async function stopActiveRunForUser(userId, { xUsername = null, type = null } = {}) {
  const handle = activeRun;
  if (!handle || handle.userId !== userId) return false;
  if (type && handle.type !== type) return false;
  if (xUsername && handle.xUsername && handle.xUsername !== xUsername) return false;

  handle.abort();
  let timer;
  const stopped = await Promise.race([
    handle.done.then(() => true),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), 10_000);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (!stopped) throw new HttpError(503, 'The active browser process did not stop in time');
  return true;
}

async function activeSessionFor(user, { required = false } = {}) {
  normalizeUserAccounts(user);
  const xUsername = user.preferences.defaultXAccount;
  if (!xUsername) {
    if (required) throw new HttpError(409, 'No active X account. Add an X account first.');
    return null;
  }

  const path = sessionFileFor(user.id, xUsername);
  if (!(await sessionFileExists(path))) {
    if (required) throw new HttpError(409, `Saved session for @${xUsername} was not found`);
    return null;
  }

  return { xUsername, path };
}

async function accountSummaries(user) {
  normalizeUserAccounts(user);
  return Promise.all(
    user.xAccounts.map(async (xUsername) => ({
      xUsername,
      active: xUsername === user.preferences.defaultXAccount,
      status: (await sessionFileExists(sessionFileFor(user.id, xUsername))) ? 'ready' : 'missing',
    })),
  );
}

async function stageActiveSession(user) {
  const session = await activeSessionFor(user, { required: true });
  const payload = await readAuthFile(session.path);
  await withWriteLock(() => writeAuthFile(payload, AUTH_FILE));
  return session;
}

function trustedLoginProfilePayload(storageState) {
  const profile = createTrustedLoginProfile(storageState);
  return {
    ...profile,
    savedAt: new Date().toISOString(),
    cookieCount: profile.cookies.length,
    profile: 'tenant-trusted-login',
  };
}

async function saveTrustedLoginProfile(userId, storageState) {
  const payload = trustedLoginProfilePayload(storageState);
  await withWriteLock(() => writeAuthFile(payload, loginProfileFileFor(userId)));
  return payload;
}

async function loginBootstrapStateFor(user, requestedXUsername = null) {
  normalizeUserAccounts(user);

  if (requestedXUsername && user.xAccounts.includes(requestedXUsername)) {
    const accountPath = sessionFileFor(user.id, requestedXUsername);
    if (await sessionFileExists(accountPath)) {
      return {
        state: await readAuthFile(accountPath),
        source: `saved session for @${requestedXUsername}`,
      };
    }
  }

  const profilePath = loginProfileFileFor(user.id);
  if (await sessionFileExists(profilePath)) {
    return {
      state: await readAuthFile(profilePath),
      source: 'tenant trusted-browser profile',
    };
  }

  const activeSession = await activeSessionFor(user);
  if (!activeSession) return null;
  const activeState = await readAuthFile(activeSession.path);
  if (!activeState) return null;
  return {
    state: createTrustedLoginProfile(activeState),
    source: `trusted device state from @${activeSession.xUsername}`,
  };
}

async function addAccountToUser(userId, xUsername) {
  return withWriteLock(async () => {
    const users = await loadUserDb();
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) throw new HttpError(401, 'User account no longer exists');
    normalizeUserAccounts(user);

    if (!user.xAccounts.includes(xUsername)) {
      if (user.xAccounts.length >= MAX_X_ACCOUNTS) {
        throw new HttpError(409, `A maximum of ${MAX_X_ACCOUNTS} X accounts can be linked`);
      }
      user.xAccounts.push(xUsername);
    }
    user.preferences.defaultXAccount ??= xUsername;
    await saveUserDb(users);
    return user;
  });
}

/* --------------------------------- auth ---------------------------------- */

app.get('/api/auth', async (req, res, next) => {
  try {
    const auth = await optionalAuthenticatedUser(req);
    if (!auth) return res.json(describe(await readAuthFile()));

    const session = await activeSessionFor(auth.user);
    const state = session ? await readAuthFile(session.path) : null;
    return res.json({
      ...describe(state),
      userAuthenticated: true,
      user: publicUser(auth.user),
      groq: publicGroqConfiguration(auth.user),
      activeXAccount: session?.xUsername ?? null,
      xAccounts: auth.user.xAccounts,
    });
  } catch (error) {
    next(error);
  }
});

app.put('/api/auth', async (req, res, next) => {
  try {
    const auth = await optionalAuthenticatedUser(req);
    const selectedSession = auth ? await activeSessionFor(auth.user, { required: true }) : null;
    const destination = selectedSession?.path ?? AUTH_FILE;
    const body = req.body ?? {};
    const updates = Object.keys(COOKIE_SPEC).filter((name) => body[name] !== undefined);

    if (updates.length === 0) {
      throw new ValidationError('Provide auth_token and/or ct0');
    }

    const values = Object.fromEntries(updates.map((name) => [name, validateValue(name, body[name])]));

    const saved = await withWriteLock(async () => {
      const payload = (await readAuthFile(destination)) ?? { cookies: [] };
      const now = new Date().toISOString();

      payload.savedAt = now;
      payload.loginUrl ??= X_LOGIN_URL;
      payload.origins ??= [];
      payload.cookies ??= [];

      for (const [name, value] of Object.entries(values)) {
        const spec = COOKIE_SPEC[name];
        const index = payload.cookies.findIndex((item) => item.name === name && item.domain === '.x.com');
        const cookie = {
          name,
          value,
          domain: '.x.com',
          path: '/',
          secure: true,
          httpOnly: spec.httpOnly,
        };

        if (index >= 0) payload.cookies[index] = { ...payload.cookies[index], ...cookie };
        else payload.cookies.push(cookie);
      }

      payload.cookieCount = payload.cookies.length;

      await writeAuthFile(payload, destination);
      return payload;
    });

    res.json({ ...describe(saved), activeXAccount: selectedSession?.xUsername ?? null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const auth = await optionalAuthenticatedUser(req);
    if (auth) {
      await stopActiveRunForUser(auth.user.id);
      await withWriteLock(async () => {
        const users = await loadUserDb();
        const user = users.find((candidate) => candidate.id === auth.user.id);
        if (user) user.sessionToken = null;
        await saveUserDb(users);
      });
      clearSessionCookie(res);
      return res.json({ ok: true, authenticated: false });
    }

    await withWriteLock(deleteAuthFile);
    clearSessionCookie(res);
    return res.json({ ok: true, authenticated: false, username: null });
  } catch (error) {
    next(error);
  }
});

/* ------------------------- user authentication ------------------------- */

// User registration
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { username, email, password } = validateUserInput(req.body ?? {});
    const passwordHash = await hashPassword(password);
    const ip = getClientIP(req);
    const newUser = await withWriteLock(async () => {
      const users = await loadUserDb();
      if (users.filter((user) => user.ipAddress === ip).length >= MAX_USERS_PER_IP) {
        throw new HttpError(429, 'Too many user registrations from this IP address');
      }
      if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
        throw new HttpError(409, 'Username already exists');
      }
      if (users.some((user) => String(user.email ?? '').toLowerCase() === email)) {
        throw new HttpError(409, 'Email already registered');
      }

      const now = new Date().toISOString();
      const user = {
        id: crypto.randomUUID(),
        username,
        email,
        passwordHash,
        createdAt: now,
        lastLogin: now,
        preferences: { defaultXAccount: null },
        xAccounts: [],
        sessionToken: generateSessionToken(),
        ipAddress: ip,
      };
      users.push(user);
      await saveUserDb(users);
      return user;
    });

    setSessionCookie(res, newUser.sessionToken);
    return res.status(201).json({ user: publicUser(newUser) });
  } catch (error) {
    next(error);
  }
});

// User login
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const username = String(req.body?.username ?? '').trim();
    const password = req.body?.password;

    if (!username || typeof password !== 'string') {
      throw new ValidationError('Username and password are required');
    }

    const user = await withWriteLock(async () => {
      const users = await loadUserDb();
      const match = users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
      if (!match || !(await verifyPassword(password, match.passwordHash))) {
        throw new HttpError(401, 'Invalid username or password');
      }

      if (passwordHashNeedsUpgrade(match.passwordHash)) match.passwordHash = await hashPassword(password);
      match.lastLogin = new Date().toISOString();
      match.sessionToken = generateSessionToken();
      normalizeUserAccounts(match);
      await saveUserDb(users);
      return match;
    });

    setSessionCookie(res, user.sessionToken);
    return res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

// Get current user
app.get('/api/auth/me', async (req, res, next) => {
  try {
    if (!sessionTokenFromRequest(req)) return res.json({ authenticated: false, user: null });
    const auth = await authenticatedUser(req);
    normalizeUserAccounts(auth.user);
    return res.json({
      authenticated: true,
      user: publicUser(auth.user),
      groq: publicGroqConfiguration(auth.user),
    });
  } catch (error) {
    next(error);
  }
});

// Link X account
app.post('/api/auth/x-accounts', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    const xUsername = normalizeXUsername(req.body?.xUsername);
    const storageState = req.body?.storageState ?? (Array.isArray(req.body?.cookies) ? req.body : null);

    const user = await withWriteLock(async () => {
      const users = await loadUserDb();
      const current = users.find((candidate) => candidate.id === auth.user.id);
      if (!current) throw new HttpError(401, 'User account no longer exists');
      normalizeUserAccounts(current);

      if (!current.xAccounts.includes(xUsername) && current.xAccounts.length >= MAX_X_ACCOUNTS) {
        throw new HttpError(409, `A maximum of ${MAX_X_ACCOUNTS} X accounts can be linked`);
      }

      const destination = sessionFileFor(current.id, xUsername);
      if (storageState) {
        await writeAuthFile({ ...storageState, username: xUsername }, destination);
        await writeAuthFile(trustedLoginProfilePayload(storageState), loginProfileFileFor(current.id));
      } else if (!(await sessionFileExists(destination))) {
        throw new ValidationError('storageState is required when linking a new X account');
      }

      if (!current.xAccounts.includes(xUsername)) current.xAccounts.push(xUsername);
      current.preferences.defaultXAccount ??= xUsername;
      await saveUserDb(users);
      return current;
    });

    return res.status(201).json({
      ok: true,
      activeXAccount: user.preferences.defaultXAccount,
      accounts: await accountSummaries(user),
    });
  } catch (error) {
    next(error);
  }
});

// Switch active X account
app.post('/api/auth/switch-account', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    const xUsername = normalizeXUsername(req.body?.xUsername);
    if (!(await sessionFileExists(sessionFileFor(auth.user.id, xUsername)))) {
      throw new HttpError(404, `No saved session for @${xUsername}`);
    }

    const user = await withWriteLock(async () => {
      const users = await loadUserDb();
      const current = users.find((candidate) => candidate.id === auth.user.id);
      if (!current) throw new HttpError(401, 'User account no longer exists');
      normalizeUserAccounts(current);
      if (!current.xAccounts.includes(xUsername)) throw new HttpError(404, 'X account is not linked');
      const state = await readAuthFile(sessionFileFor(current.id, xUsername));
      if (!state) throw new HttpError(404, `Saved session for @${xUsername} was not found`);
      current.preferences.defaultXAccount = xUsername;
      await saveUserDb(users);
      await writeAuthFile(state, AUTH_FILE);
      return current;
    });

    return res.json({
      ok: true,
      activeXAccount: xUsername,
      defaultXAccount: xUsername,
      accounts: await accountSummaries(user),
    });
  } catch (error) {
    next(error);
  }
});

// Unlink X account
app.delete('/api/auth/x-accounts/:xUsername', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    // normalizeXUsername accepts only 1-15 alphanumeric/underscore characters,
    // so encoded separators and traversal segments never reach sessionFileFor.
    const xUsername = normalizeXUsername(req.params.xUsername);
    await stopActiveRunForUser(auth.user.id, { xUsername });

    const result = await withWriteLock(async () => {
      const users = await loadUserDb();
      const current = users.find((candidate) => candidate.id === auth.user.id);
      if (!current) throw new HttpError(401, 'User account no longer exists');
      normalizeUserAccounts(current);

      const sessionPath = sessionFileFor(current.id, xUsername);
      const linked = current.xAccounts.includes(xUsername);
      const sessionDeleted = await sessionFileExists(sessionPath);
      if (!linked && !sessionDeleted) throw new HttpError(404, `X account @${xUsername} is not linked`);

      const wasActive = current.preferences.defaultXAccount === xUsername;
      current.xAccounts = current.xAccounts.filter((account) => account !== xUsername);
      if (wasActive) current.preferences.defaultXAccount = current.xAccounts[0] ?? null;

      // Persist metadata first. A failed unlink can leave only an unreachable file,
      // never a user record that points at a deleted session.
      await saveUserDb(users);
      await deleteAuthFile(sessionPath);

      let activeSessionStaged = false;
      if (wasActive) {
        const nextActive = current.preferences.defaultXAccount;
        if (nextActive) {
          const nextPath = sessionFileFor(current.id, nextActive);
          let nextState = null;
          try {
            nextState = await readAuthFile(nextPath);
          } catch (error) {
            console.warn(`Could not stage @${nextActive} after unlinking @${xUsername}: ${error.message}`);
          }
          if (nextState) {
            await writeAuthFile(nextState, AUTH_FILE);
            activeSessionStaged = true;
          } else {
            await deleteAuthFile(AUTH_FILE);
          }
        } else {
          await deleteAuthFile(AUTH_FILE);
        }
      }

      const trustedProfilePath = loginProfileFileFor(current.id);
      const profileAccount = current.preferences.defaultXAccount ?? current.xAccounts[0] ?? null;
      if (profileAccount) {
        try {
          const profileState = await readAuthFile(sessionFileFor(current.id, profileAccount));
          if (profileState) {
            await writeAuthFile(trustedLoginProfilePayload(profileState), trustedProfilePath);
          } else {
            await deleteAuthFile(trustedProfilePath);
          }
        } catch (error) {
          console.warn(`Could not refresh the trusted login profile after unlinking @${xUsername}: ${error.message}`);
          await deleteAuthFile(trustedProfilePath);
        }
      } else {
        await deleteAuthFile(trustedProfilePath);
      }

      return { user: current, wasActive, sessionDeleted, activeSessionStaged };
    });

    return res.json({
      ok: true,
      deletedXAccount: xUsername,
      sessionDeleted: result.sessionDeleted,
      wasActive: result.wasActive,
      activeSessionStaged: result.activeSessionStaged,
      activeXAccount: result.user.preferences.defaultXAccount,
      accounts: await accountSummaries(result.user),
    });
  } catch (error) {
    next(error);
  }
});
// Get linked X accounts
app.get('/api/auth/x-accounts', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    return res.json(await accountSummaries(auth.user));
  } catch (error) {
    next(error);
  }
});

/* ------------------------ persisted per-user Groq config ------------------ */

app.get('/api/config/groq', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    res.json(publicGroqConfiguration(auth.user));
  } catch (error) {
    next(error);
  }
});

app.put('/api/config/groq', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    const apiKey = validateGroqApiKey(req.body?.apiKey);
    const user = await saveUserGroqApiKey(auth.user.id, apiKey);
    res.json(publicGroqConfiguration(user));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/config/groq', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    // Stop an in-flight automation process so the deleted key is not retained
    // in a child process environment after this request succeeds.
    await stopActiveRunForUser(auth.user.id, { type: 'automation' });
    const user = await saveUserGroqApiKey(auth.user.id, null);
    delete auth.user.groqApiKey;
    res.json(publicGroqConfiguration(user));
  } catch (error) {
    next(error);
  }
});

/* ------------------------------ automation history ----------------------- */

function buildActions({ reply, like, repost, dryRun }) {
  if (dryRun) return [];
  const actions = [];
  if (reply) actions.push('replied');
  if (like) actions.push('liked');
  if (repost) actions.push('reposted');
  return actions;
}

async function readReplyForHistory(reply, dryRun) {
  if (!reply || dryRun) return null;
  try {
    const text = (await readFile(REPLY_OUT_FILE, 'utf8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

async function readHistoryFile() {
  try {
    const raw = await readFile(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendHistory(entry) {
  return withWriteLock(async () => {
    const history = await readHistoryFile();
    history.push(entry);
    const trimmed = history.length > 50 ? history.slice(history.length - 50) : history;
    await atomicWritePrivateFile(HISTORY_FILE, `${JSON.stringify(trimmed, null, 2)}\n`);
  });
}

async function clearHistoryForUser(userId) {
  return withWriteLock(async () => {
    const history = await readHistoryFile();
    const remaining = history.filter((entry) => entry.userId !== userId);
    await atomicWritePrivateFile(HISTORY_FILE, `${JSON.stringify(remaining, null, 2)}\n`);
  });
}

app.get('/api/history', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    const history = (await readHistoryFile()).filter((entry) => entry.userId === auth.user.id);
    res.json({ history });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/history', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    await clearHistoryForUser(auth.user.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/* ---------------- headed browser sign-in -> per-account state ------------- */

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  throw error;
}

function isXHomeUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return hostname === 'x.com' && /^\/home\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function usernameFromProfileHref(href) {
  try {
    const url = new URL(String(href ?? ''), HOME_URL);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'x.com') return null;
    const match = url.pathname.match(/^\/@?([A-Za-z0-9_]{1,15})\/?$/);
    if (!match) return null;
    const username = normalizeXUsername(match[1]);
    return RESERVED_X_ROUTES.has(username) ? null : username;
  } catch {
    return null;
  }
}

function usernameFromSwitcherText(value) {
  const match = String(value ?? '').match(/@([A-Za-z0-9_]{1,15})\b/);
  return match ? normalizeXUsername(match[1]) : null;
}

async function waitForXHome(page, signal, deadline) {
  const automaticRedirectDeadline = Math.min(deadline, Date.now() + 20_000);

  while (Date.now() < automaticRedirectDeadline) {
    throwIfAborted(signal);
    if (isXHomeUrl(page.url())) return true;

    try {
      await page.waitForURL((url) => isXHomeUrl(url), {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1, Math.min(1_000, automaticRedirectDeadline - Date.now())),
      });
      return true;
    } catch {
      throwIfAborted(signal);
      if (page.isClosed()) throw new Error('X login page closed before account detection completed');
    }
  }

  throwIfAborted(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;

  await page
    .goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, remaining) })
    .catch(() => null);
  throwIfAborted(signal);
  return isXHomeUrl(page.url());
}

async function readSignedInUsername(page, signal) {
  const deadline = Date.now() + POST_LOGIN_TIMEOUT_MS;
  if (!(await waitForXHome(page, signal, deadline))) return null;

  const profileLinks = page.locator('[data-testid="AppTabBar_Profile_Link"][href], a[aria-label="Profile"][href]');
  const accountSwitchers = page.locator(
    '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Account_Menu_Button"]',
  );

  while (Date.now() < deadline) {
    throwIfAborted(signal);

    const profileHrefs = await profileLinks
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')).filter(Boolean))
      .catch(() => []);
    for (const href of profileHrefs) {
      const username = usernameFromProfileHref(href);
      if (username) return { username, source: 'profile link' };
    }

    const switcherTexts = await accountSwitchers
      .evaluateAll((switchers) =>
        switchers.flatMap((switcher) => {
          const values = [switcher.textContent, switcher.getAttribute('aria-label')];
          for (const child of switcher.querySelectorAll('span, [dir="ltr"]')) values.push(child.textContent);
          return values.filter(Boolean);
        }),
      )
      .catch(() => []);
    for (const text of switcherTexts) {
      const username = usernameFromSwitcherText(text);
      if (username) return { username, source: 'account switcher' };
    }

    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }

  return null;
}

/**
 * Waits for the person to finish signing in in the remote window and click
 * Complete Sign-In. A missing session cookie keeps the run open for a retry.
 */
async function waitForManualSignIn(context, signal, loginControl, send) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let readyAnnounced = false;

  while (Date.now() < deadline) {
    throwIfAborted(signal);

    const cookieResult = await safeContextCall(context, () => context.cookies(), 'Reading login cookies');
    if (!cookieResult.ok) {
      throwIfAborted(signal);
      return { loggedIn: false, error: cookieResult.error };
    }

    const hasSessionCookie = cookieResult.value.some((cookie) => cookie.name === SESSION_COOKIE);
    if (hasSessionCookie && !readyAnnounced) {
      readyAnnounced = true;
      send({
        type: 'status',
        stage: 'signed-in',
        data: 'X session detected. Click Complete Sign-In to save it.',
      });
    }

    if (loginControl.requested) {
      if (hasSessionCookie) return { loggedIn: true, error: null };

      loginControl.reset();
      send({
        type: 'status',
        stage: 'complete-pending',
        data: 'No X session cookie found yet. Finish signing in in the remote window, then click Complete Sign-In again.',
      });
    }

    await loginControl.wait(1_000);
  }

  throwIfAborted(signal);
  return { loggedIn: false, error: null, timedOut: true };
}

/**
 * Connects to Browserless, reuses its default context, waits for the user to
 * finish logging in, then saves Playwright storage state for that user/X account.
 */
async function runBrowserLogin({
  send,
  signal,
  generation,
  user,
  requestedXUsername = null,
  loginControl = createLoginControl(),
  onBrowserConnected = null,
}) {
  send({
    type: 'start',
    command: `browser sign-in -> ${LOGIN_URL} (Browserless remote Chromium)`,
  });

  let browser = null;
  let context = null;
  let liveInspection = null;
  let profileCheckpointTimer = null;
  let profileCheckpointPromise = null;
  const checkpointTrustedProfile = () => {
    if (!context || signal?.aborted) return Promise.resolve(false);
    if (profileCheckpointPromise) return profileCheckpointPromise;

    profileCheckpointPromise = (async () => {
      const state = await safeContextCall(
        context,
        () => context.storageState(),
        'Capturing the tenant trusted-browser profile',
      );
      if (!state.ok) return false;
      await saveTrustedLoginProfile(user.id, state.value);
      return true;
    })()
      .catch((error) => {
        console.warn(`[browser] Could not checkpoint the trusted login profile: ${error.message}`);
        return false;
      })
      .finally(() => {
        profileCheckpointPromise = null;
      });
    return profileCheckpointPromise;
  };
  const closeBrowserOnAbort = () => {
    loginControl.wake();
    void closeBrowser(browser);
  };
  signal?.addEventListener('abort', closeBrowserOnAbort, { once: true });

  try {
    browser = await connectBrowser();
    onBrowserConnected?.(browser);
    throwIfAborted(signal);

    context = await getDefaultContext(browser);
    const bootstrap = await loginBootstrapStateFor(user, requestedXUsername);
    const restored = await safeContextCall(
      context,
      () => restoreStorageState(context, bootstrap?.state, { clearCookies: true }),
      'Restoring the tenant browser profile',
    );
    if (!restored.ok) {
      send({ type: 'stderr', data: `${restored.error.message}. Aborting sign-in.` });
      return { ok: false };
    }
    if (bootstrap) {
      send({
        type: 'status',
        stage: 'profile-restored',
        data: `Reused ${bootstrap.source} (${restored.value.cookieCount} cookies, ${restored.value.localStorageCount} local-storage entries).`,
      });
    }
    const page = await getOrCreatePage(context);

    send({ type: 'stdout', data: `Opening ${LOGIN_URL} …` });
    const navigation = await safeGoto(page, LOGIN_URL, {
      waitUntil: 'commit',
      timeout: 45_000,
      referer: X_REFERER,
    });
    if (navigation.error) {
      send({
        type: 'stderr',
        data: `Navigation warning: ${navigation.error.message}. Continuing to wait for sign-in …`,
      });
    } else if (navigation.response && navigation.response.status() >= 400) {
      send({
        type: 'stderr',
        data: `X returned HTTP ${navigation.response.status()} on the login page; continuing to wait for sign-in …`,
      });
    }

    void checkpointTrustedProfile();
    profileCheckpointTimer = setInterval(() => void checkpointTrustedProfile(), LOGIN_PROFILE_CHECKPOINT_MS);
    profileCheckpointTimer.unref?.();

    send({ type: 'stdout', data: 'Waiting for you to complete sign-in in the remote window …' });

    try {
      liveInspection = await createLiveInspection(page, {
        timeoutMs: LIVE_VIEW_TIMEOUT_MS,
        onViewerConnected: () => {
          send({
            type: 'status',
            stage: 'viewer-connected',
            data: 'Remote sign-in window connected. Finish signing in to X there.',
          });
        },
        onComplete: ({ reason } = {}) => {
          if (reason === 'timeout') {
            send({
              type: 'status',
              stage: 'live-expired',
              data: 'The remote sign-in link expired. Cancel and start a new sign-in if you still need it.',
            });
          } else if (reason === 'viewerDisconnected') {
            send({
              type: 'status',
              stage: 'viewer-disconnected',
              data: 'Remote viewer disconnected. Click Complete Sign-In once the login is finished.',
            });
          } else if (reason === 'closed') {
            send({
              type: 'status',
              stage: 'live-closed',
              data: 'The remote sign-in link closed. The browser is still waiting for Complete Sign-In.',
            });
          }
        },
      });

      send({
        type: 'live',
        status: 'ready',
        url: liveInspection.liveURL,
        expiresAt: new Date(liveInspection.expiresAt).toISOString(),
      });
      send({
        type: 'stdout',
        data: 'Remote sign-in window ready. Sign in there, then click Complete Sign-In in the dashboard.',
      });
    } catch (error) {
      send({ type: 'live', status: 'error', message: error.message });
      send({
        type: 'stderr',
        data: `${error.message}. If you can open the Browserless dashboard, sign in there and then click Complete Sign-In.`,
      });
    }

    const login = await waitForManualSignIn(context, signal, loginControl, send);
    if (login.error) {
      send({
        type: 'stderr',
        data: `${login.error.message}. The browser session closed before sign-in completed; nothing was saved.`,
      });
      return { ok: false };
    }
    if (!login.loggedIn) {
      send({
        type: 'stderr',
        data: login.timedOut
          ? 'X sign-in timed out before Complete Sign-In was confirmed — nothing was saved.'
          : 'X sign-in was not verified — the session was not saved.',
      });
      return { ok: false };
    }

    await liveInspection?.close();
    liveInspection = null;
    send({ type: 'stdout', data: 'Login confirmed. Waiting for X home and account identity …' });
    const identity = await readSignedInUsername(page, signal);
    let username = identity?.username ?? null;
    if (identity) send({ type: 'stdout', data: `Detected @${username} from the ${identity.source}.` });

    if (requestedXUsername && username && requestedXUsername !== username) {
      throw new Error(`Signed in as @${username}, but @${requestedXUsername} was requested`);
    }
    username ??= requestedXUsername;
    if (!username) throw new Error('Could not determine the signed-in X username');

    const storedState = await safeContextCall(
      context,
      () => context.storageState(),
      'Capturing browser session state',
    );
    if (!storedState.ok) {
      send({ type: 'stderr', data: `${storedState.error.message}. Nothing was saved.` });
      return { ok: false };
    }
    const storageState = storedState.value;
    if (storageState.cookies.length === 0) {
      send({ type: 'stderr', data: 'No cookies were captured — nothing was saved.' });
      return { ok: false };
    }

    const payload = {
      ...storageState,
      savedAt: new Date().toISOString(),
      loginUrl: LOGIN_URL,
      cookieCount: storageState.cookies.length,
      username,
    };
    const destination = sessionFileFor(user.id, username);
    const trustedProfile = trustedLoginProfilePayload(storageState);

    await withWriteLock(async () => {
      if (signal?.aborted || generation !== authGeneration) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      await writeAuthFile(payload, destination);
      await writeAuthFile(trustedProfile, loginProfileFileFor(user.id));
    });
    const updatedUser = await addAccountToUser(user.id, username);
    if (updatedUser.preferences.defaultXAccount === username) await stageActiveSession(updatedUser);

    send({
      type: 'stdout',
      data: `Saved ${storageState.cookies.length} cookies for @${username} (session valid).` + `\n`,
    });

    return { ok: login.loggedIn, cookieCount: storageState.cookies.length, username };
  } finally {
    clearInterval(profileCheckpointTimer);
    if (!signal?.aborted) await checkpointTrustedProfile();
    signal?.removeEventListener('abort', closeBrowserOnAbort);
    await liveInspection?.close();
    await closeBrowser(browser);
  }
}

app.post('/auth/x', async (req, res) => {
  let auth;
  let requestedXUsername = null;
  try {
    auth = await authenticatedUser(req);
    normalizeUserAccounts(auth.user);
    if (req.body?.xUsername) requestedXUsername = normalizeXUsername(req.body.xUsername);
    if (
      auth.user.xAccounts.length >= MAX_X_ACCOUNTS &&
      (!requestedXUsername || !auth.user.xAccounts.includes(requestedXUsername))
    ) {
      throw new HttpError(409, `A maximum of ${MAX_X_ACCOUNTS} X accounts can be linked`);
    }
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Could not start X sign-in' });
  }

  if (activeRun) {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const send = makeSend(res);
  const controller = new AbortController();
  const generation = authGeneration;
  const completion = createCompletionSignal();
  const loginControl = createLoginControl();
  let abortRequested = false;
  const handle = {
    type: 'x-auth',
    userId: auth.user.id,
    xUsername: requestedXUsername,
    done: completion.promise,
    loginControl,
    browser: null,
    abort() {
      if (abortRequested) return;
      abortRequested = true;
      authGeneration += 1;
      controller.abort();
    },
  };
  activeRun = handle;

  const timer = setTimeout(() => {
    send({ type: 'stderr', data: `[server] sign-in exceeded ${Math.ceil(AUTH_RUN_TIMEOUT_MS / 60_000)} minutes - stopping it.` });
    handle.abort();
  }, AUTH_RUN_TIMEOUT_MS);

  attachRunCleanup(res, handle);

  try {
    const result = await runBrowserLogin({
      send,
      signal: controller.signal,
      generation,
      user: auth.user,
      requestedXUsername,
      loginControl,
      onBrowserConnected: (connectedBrowser) => {
        handle.browser = connectedBrowser;
      },
    });
    send({ type: 'exit', code: result.ok ? 0 : 1, result });
    return res.end();
  } catch (error) {
    if (error?.name === 'AbortError') {
      send({ type: 'exit', code: 130, result: { aborted: true } });
      return res.end();
    }
    send({ type: 'stderr', data: `\nFailed: ${error.message}` });
    send({ type: 'exit', code: 1, result: { ok: false, error: error.message } });
    return res.end();
  } finally {
    clearTimeout(timer);
    if (activeRun === handle) activeRun = null;
    completion.resolve();
  }
});

app.post('/auth/x/complete', async (req, res) => {
  let auth;
  try {
    auth = await authenticatedUser(req);
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Could not confirm X sign-in' });
  }

  if (!activeRun || activeRun.type !== 'x-auth' || !activeRun.loginControl) {
    return res.status(409).json({ error: 'No X sign-in is currently in progress' });
  }
  if (activeRun.userId !== auth.user.id) {
    return res.status(403).json({ error: 'This X sign-in belongs to another session' });
  }

  activeRun.loginControl.request();
  return res.json({ ok: true });
});

app.post('/auth/x/cancel', async (req, res) => {
  let auth;
  try {
    auth = await authenticatedUser(req);
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Could not cancel X sign-in' });
  }

  const handle = activeRun;
  if (!handle || handle.type !== 'x-auth') {
    return res.json({ ok: true, cancelled: false });
  }
  if (handle.userId !== auth.user.id) {
    return res.status(403).json({ error: 'This X sign-in belongs to another session' });
  }

  // Release the lock before cleanup so a new sign-in can start immediately.
  activeRun = null;
  handle.abort();
  if (handle.browser) void closeBrowser(handle.browser);

  let timer;
  const closed = await Promise.race([
    handle.done.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);

  return res.json({ ok: true, cancelled: true, closed });
});

app.post('/api/run', async (req, res) => {
  const { url, urls, dryRun = false, headless = true, reply = false, like = false, repost = false, audit = false, tone } =
    req.body ?? {};

  const inputUrl = typeof url === 'string' ? url : Array.isArray(urls) ? urls.map((u) => String(u).trim()).join(' ') : '';
  const parsedUrls = inputUrl.split(/\s+/).map((u) => u.trim()).filter((u) => u.length > 0);
  const targets = parsedUrls.filter((u) => TWEET_URL.test(u));

  if (parsedUrls.length === 0 || targets.length !== parsedUrls.length) {
    return res.status(400).json({ error: 'Expected an x.com/<user>/status/<id> URL' });
  }
  if (activeRun) {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  let appAuth;
  let selectedSession;
  try {
    appAuth = await authenticatedUser(req);
    selectedSession = await stageActiveSession(appAuth.user);
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Could not load the active X session' });
  }

  const groqConfiguration = getGroqConfiguration(appAuth.user);
  if (!groqConfiguration.configured) {
    return res.status(400).json({ error: 'Groq API key is not configured. Add a saved key in the dashboard.' });
  }
  // Authentication/session staging above yields; reserve the runtime only after
  // re-checking so two concurrent requests cannot both launch browsers.
  if (activeRun) {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  let currentChild = null;
  let cooldownTimer = null;
  let finishCooldown = null;
  let aborted = false;
  const completion = createCompletionSignal();

  const batchHandle = {
    type: 'automation',
    userId: appAuth.user.id,
    xUsername: selectedSession.xUsername,
    done: completion.promise,
    abort() {
      if (aborted) return;
      aborted = true;
      if (currentChild) killTree(currentChild);
      finishCooldown?.();
    },
  };
  activeRun = batchHandle;

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const send = makeSend(res);
  attachRunCleanup(res, batchHandle);

  const waitForCooldown = (ms) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(cooldownTimer);
        cooldownTimer = null;
        finishCooldown = null;
        resolve();
      };
      finishCooldown = finish;
      cooldownTimer = setTimeout(finish, ms);
    });

  const runOne = async (targetUrl) => {
    if (aborted) {
      const error = new Error('Batch stopped');
      error.name = 'AbortError';
      throw error;
    }

    const args = ['main.js', targetUrl, '--yes'];
    if (dryRun) args.push('--dry-run');
    if (headless) args.push('--headless');
    if (reply) args.push('--reply');
    if (like) args.push('--like');
    if (repost) args.push('--repost');
    if (audit) args.push('--audit');
    if (tone) args.push('--tone=' + tone);
    if (reply) args.push('--reply-out=' + REPLY_OUT_FILE);

    if (reply) {
      await unlink(REPLY_OUT_FILE).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        GROQ_API_KEY: groqConfiguration.apiKey,
        GROQ_API_KEY_SOURCE: groqConfiguration.source,
        X_ACCOUNT_USERNAME: selectedSession.xUsername,
        AUTH_FILE_PATH: AUTH_FILE,
      },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentChild = child;

    const timer = setTimeout(() => {
      killTree(child);
    }, RUN_TIMEOUT_MS);

    let lastError = null;
    let lastTopic = 'other';
    let auditResult = null;

    const forward = (stream, type) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (type === 'stderr') {
            lastError = line;
            console.log(line);
          } else if (type === 'stdout') {
            const topicMatch = line.match(/Detected topic: (\w+)/);
            if (topicMatch) lastTopic = topicMatch[1];
            if (line.startsWith('[AUDIT_EVENT] ')) {
              try {
                auditResult = JSON.parse(line.slice('[AUDIT_EVENT] '.length));
                send({ type: 'audit', ...auditResult });
              } catch {
                /* malformed child audit events remain ordinary stdout */
              }
            }
          }
          send({ type, data: line });
        }
      });
      stream.on('end', () => {
        if (pending) {
          if (type === 'stderr') {
            lastError = pending;
            console.log(pending);
          } else if (type === 'stdout') {
            const topicMatch = pending.match(/Detected topic: (\w+)/);
            if (topicMatch) lastTopic = topicMatch[1];
            if (pending.startsWith('[AUDIT_EVENT] ')) {
              try {
                auditResult = JSON.parse(pending.slice('[AUDIT_EVENT] '.length));
                send({ type: 'audit', ...auditResult });
              } catch {
                /* malformed child audit events remain ordinary stdout */
              }
            }
          }
          send({ type, data: pending });
        }
      });
    };

    forward(child.stdout, 'stdout');
    forward(child.stderr, 'stderr');
    child.on('error', (error) => send({ type: 'stderr', data: `[server] could not start main.js: ${error.message}` }));

    send({ type: 'start', command: args.join(' '), pid: child.pid, url: targetUrl });

    const exitInfo = await new Promise((resolve) => {
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (currentChild === child) currentChild = null;
        resolve({ code, signal });
      });
    });

    try {
      const skipped = auditResult?.status === 'engaged';
      const draftReply = reply && !dryRun && !skipped ? await readReplyForHistory(reply, dryRun) : null;
      if (draftReply) send({ type: 'reply', data: draftReply });

      const entry = {
        id: new Date().toISOString(),
        at: new Date().toISOString(),
        url: targetUrl,
        dryRun: Boolean(dryRun),
        actions: skipped ? [] : buildActions({ reply, like, repost, dryRun }),
        reply: draftReply,
        topic: lastTopic,
        userId: appAuth.user.id,
        xUsername: selectedSession.xUsername,
        ...(auditResult ? { audit: auditResult } : {}),
        ok: exitInfo.code === 0,
        error: exitInfo.code === 0 ? null : `exit ${exitInfo.code}`,
      };
      await appendHistory(entry);
    } catch (error) {
      console.error(`Could not write automation history: ${error.message}`);
    }

    return { code: exitInfo.code, signal: exitInfo.signal, error: lastError, audit: auditResult };
  };

  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  send({ type: 'batch-start', total: targets.length, percent: 0, xUsername: selectedSession.xUsername });

  try {
    for (let i = 0; i < targets.length; i += 1) {
      if (aborted) break;

      const seq = i + 1;
      const targetUrl = targets[i];
      const processingPercent = Math.round((completed / targets.length) * 100);
      console.error(`[QUEUE] Processing ${seq}/${targets.length}: ${targetUrl}`);
      send({ type: 'progress', index: seq, completed, total: targets.length, percent: processingPercent, url: targetUrl });

      let itemStatus = 'succeeded';
      let itemError = null;
      try {
        const result = await runOne(targetUrl);
        if (aborted) break;
        if (result.code !== 0) {
          itemStatus = 'failed';
          itemError = result.error || `exit ${result.code}`;
          failed += 1;
          send({ type: 'failed', index: seq, url: targetUrl, error: itemError });
        } else if (result.audit?.status === 'engaged') {
          itemStatus = 'skipped';
          skipped += 1;
        } else {
          succeeded += 1;
        }
      } catch (error) {
        if (aborted || error?.name === 'AbortError') break;
        itemStatus = 'failed';
        itemError = error?.message ?? 'unknown error';
        failed += 1;
        send({ type: 'failed', index: seq, url: targetUrl, error: itemError });
      }

      completed = seq;
      const completedPercent = Math.round((completed / targets.length) * 100);
      send({
        type: 'item-complete',
        index: seq,
        completed,
        total: targets.length,
        percent: completedPercent,
        url: targetUrl,
        status: itemStatus,
        error: itemError,
      });

      if (i < targets.length - 1 && !aborted) {
        const waitMs = 15_000 + Math.random() * 15_000;
        const waitSeconds = Math.round(waitMs / 1000);
        console.error(`[COOLDOWN] Waiting ${waitSeconds} seconds before next tweet...`);
        send({ type: 'cooldown', completed, total: targets.length, percent: completedPercent, seconds: waitSeconds });
        await waitForCooldown(waitMs);
      }
    }

    if (!aborted) {
      send({ type: 'batch-complete', completed, total: targets.length, percent: 100, succeeded, failed, skipped });
    }
  } catch (error) {
    if (!aborted) send({ type: 'batch-error', error: error?.message ?? 'unknown batch error' });
  } finally {
    clearTimeout(cooldownTimer);
    finishCooldown = null;
    if (currentChild) killTree(currentChild);
    if (activeRun === batchHandle) activeRun = null;
    completion.resolve();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Body must be valid JSON' });
  }
  if (error?.message === 'Origin not allowed') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  console.error('Request failed:', error);
  return res.status(500).json({ error: 'Something went wrong' });
});

await mkdir(DATA_DIR, { recursive: true });
console.log(`[storage] User, session and history data directory: ${DATA_DIR}`);
if (
  IS_PRODUCTION &&
  !process.env.DATA_DIR &&
  (process.env.RENDER || process.env.RENDER_EXTERNAL_URL)
) {
  console.warn(
    '[storage] DATA_DIR is not set. Render containers have an ephemeral filesystem, so user accounts and X sessions will be lost on restart. Mount a persistent disk and set DATA_DIR (for example /var/data), or configure the DEFAULT_ADMIN_* variables to re-seed an admin account.',
  );
}

await seedDefaultAdmin();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`X automation admin UI: http://${HOST}:${PORT}`);
  console.log(`  POST ${HOST}:${PORT}/api/auth/register   (create local user)`);
  console.log(`  POST ${HOST}:${PORT}/api/auth/login      (create app session)`);
  console.log(`  GET  ${HOST}:${PORT}/api/auth/me         (current local user)`);
  console.log(`  GET  ${HOST}:${PORT}/api/auth/x-accounts (list saved X sessions)`);
  console.log(`  POST ${HOST}:${PORT}/api/auth/switch-account (select active X session)`);
  console.log(`  GET/PUT/DELETE ${HOST}:${PORT}/api/config/groq   (persisted per-user key configuration)`);
  console.log(`  GET ${HOST}:${PORT}/api/history`);
  console.log(`  DELETE ${HOST}:${PORT}/api/history`);
  console.log(`  POST ${HOST}:${PORT}/auth/x      (Browserless sign-in -> per-user session file)`);
  console.log(`  POST ${HOST}:${PORT}/api/run   {"url": "…", "dryRun": false, "reply": true, "like": true, "audit": false}  -> NDJSON log stream`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  const handle = activeRun;
  handle?.abort();
  if (handle) {
    await Promise.race([handle.done, sleep(10_000)]).catch(() => {});
  }

  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref?.();
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
