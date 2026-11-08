import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import bcrypt from 'bcrypt';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'crypto';
import {
  closeDatabase,
  initializeDatabase,
  isPostgresEnabled,
  query,
  withTransaction,
} from './lib/database.js';
import { CHROME_USER_AGENT, createTrustedLoginProfile, X_LOGIN_URL } from './lib/browser.js';

/**
 * Local service for the X reply automation.
 *
 *   POST /api/auth/register, /api/auth/login -> persisted local user authentication
 *   GET  /api/auth/x-accounts -> list the logged-in user's saved X sessions
 *   POST /api/auth/import-session -> import X cookies -> active per-user session
 *   POST /api/auth/switch-account -> select the X session used by automation
 *   GET/PUT/DELETE /api/config/groq -> manage the user's persisted Groq API key
 *   POST /auth/x     -> retired interactive sign-in; directs clients to cookie import
 *   POST /auth/x/cancel -> authenticated compatibility no-op
 *   POST /api/run    -> run the reply pipeline with the active X session
 *
 * Binds to 0.0.0.0 by default so container platforms such as Render can reach it.
 * Terminate TLS before public exposure. Imported X cookies grant account access
 * and must only be sent by authenticated users over HTTPS in production.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const INDEX_FILE = join(PUBLIC_DIR, 'index.html');
const DATA_DIR = resolve(process.env.DATA_DIR || ROOT);
const AUTH_FILE = join(DATA_DIR, 'auth.json');
const USER_DB_FILE = join(DATA_DIR, 'user-db.json');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const DEFAULT_ADMIN_USERNAME = String(process.env.DEFAULT_ADMIN_USERNAME || '').trim();
const DEFAULT_ADMIN_EMAIL = String(process.env.DEFAULT_ADMIN_EMAIL || '')
  .trim()
  .toLowerCase();
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || '');
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';
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

function envInteger(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * The dashboard health check uses X's authenticated settings endpoint. It is a
 * cheap HTTP request (no browser) and fails closed if X cannot confirm the
 * cookies. Try the API host first, then the web-app host if the probe fails.
 * Configured URLs run first; tests only call explicitly configured fixtures.
 */
const X_SESSION_CHECK_DEFAULT_URLS = [
  'https://api.x.com/1.1/account/settings.json',
  'https://x.com/i/api/1.1/account/settings.json',
];
const X_SESSION_CHECK_CONFIGURED_URLS = String(process.env.X_SESSION_CHECK_URL || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const X_SESSION_CHECK_URLS = X_SESSION_CHECK_CONFIGURED_URLS.length
  ? IS_TEST
    ? X_SESSION_CHECK_CONFIGURED_URLS
    : [...new Set([...X_SESSION_CHECK_CONFIGURED_URLS, ...X_SESSION_CHECK_DEFAULT_URLS])]
  : X_SESSION_CHECK_DEFAULT_URLS;
const X_SESSION_CHECK_TIMEOUT_MS = envInteger('X_SESSION_CHECK_TIMEOUT_MS', 3_500, 500, 15_000);
const X_SESSION_CHECK_CACHE_MS = envInteger('X_SESSION_CHECK_CACHE_MS', 60_000, 0, 15 * 60_000);
const X_SESSION_CHECK_DISABLED = process.env.X_SESSION_CHECK_DISABLED === '1'
  || (IS_TEST && X_SESSION_CHECK_CONFIGURED_URLS.length === 0);
// Public web-app bearer used by x.com itself; overridable in case X rotates it.
const X_WEB_BEARER = String(
  process.env.X_SESSION_CHECK_BEARER
    || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
).trim();
const X_SESSION_INVALID_ERROR_CODES = new Set([32, 89, 239, 326, 353]);

const HISTORY_FILE = join(DATA_DIR, 'history.json');
const REPLY_OUT_FILE = join(tmpdir(), 'playwright-gemini-reply.txt');

/** Only one automation / session import at a time; drives the 409 + the Stop button. */
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
    methods: ['GET', 'PUT', 'DELETE', 'POST'],
    credentials: false,
  }),
);

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(bodyParser.json({ limit: MAX_BODY }));

/* -------------------------------- helpers -------------------------------- */

/** Serialises writes so two overlapping PUTs cannot clobber each other. */
let writeQueue = Promise.resolve();
const withWriteLock = (task) => {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_TARGET_RETRIES = 2;
const REPLY_VERIFICATION_ERROR_MESSAGE = 'Reply verification failed: Post was not confirmed on X';

const RETRYABLE_NETWORK_ERROR =
  /(?:net::ERR_(?:ABORTED|CONNECTION_(?:ABORTED|CLOSED|REFUSED|RESET|TIMED_OUT)|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|TIMED_OUT|TUNNEL_CONNECTION_FAILED)|ECONN(?:ABORTED|REFUSED|RESET)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network (?:error|is unreachable)|temporary failure in name resolution|navigation timeout|browser has disconnected|browser has been closed|websocket (?:error|closed))/i;
const REPLY_VERIFICATION_ERROR =
  /(?:Reply verification failed: Post was not confirmed on X|Warning: could not confirm the reply was sent)/i;

function errorDetail(error) {
  const stderr = Array.isArray(error?.result?.stderr)
    ? error.result.stderr
    : Array.isArray(error?.stderr)
      ? error.stderr
      : error?.stderr
        ? [error.stderr]
        : [];
  return [
    error?.message,
    error?.code,
    error?.result?.error,
    error?.result?.spawnError,
    ...stderr,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Detects transient network failures from child stderr, spawn errors, or thrown errors. */
function isTransientNetworkError(error) {
  return RETRYABLE_NETWORK_ERROR.test(errorDetail(error));
}

/** An unconfirmed reply is retryable, but still bounded by executeWithRetry. */
function isReplyVerificationError(error) {
  return REPLY_VERIFICATION_ERROR.test(errorDetail(error));
}

function isRetryableTargetError(error) {
  return isTransientNetworkError(error) || isReplyVerificationError(error);
}

/**
 * Retries an action at most twice (three total attempts). Cancellation and
 * permanent failures stop immediately; exhausted retries stay with this URL.
 */
async function executeWithRetry(
  action,
  { retries = MAX_TARGET_RETRIES, delayMs = 5_000, label = 'operation', shouldRetry = () => true, wait = sleep } = {},
) {
  const retryCount = Number.isInteger(retries) && retries >= 0
    ? Math.min(retries, MAX_TARGET_RETRIES)
    : MAX_TARGET_RETRIES;
  const attempts = retryCount + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;

      const canRetry = attempt < attempts && shouldRetry(error);
      if (!canRetry) {
        console.error(
          `[retry] ${label}: attempt ${attempt}/${attempts} failed${attempt < attempts ? ' (not retryable)' : ''}: ${error?.message ?? error}`,
        );
        if (attempt === attempts) {
          const permanentError = new Error(error?.message ?? String(error), { cause: error });
          permanentError.name = 'RetryExhaustedError';
          permanentError.attempts = attempt;
          permanentError.result = error?.result;
          throw permanentError;
        }
        throw error;
      }

      console.warn(
        `[retry] ${label}: attempt ${attempt}/${attempts} failed: ${error?.message ?? error}. Retrying in ${delayMs / 1000}s...`,
      );
      await wait(delayMs);
    }
  }

  throw new Error(`[retry] ${label}: exhausted all attempts`);
}

const mask = (value) =>
  value.length <= 8 ? '•'.repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;

/** User authentication and session management. */
const MAX_USERS_PER_IP = 10;

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function splitHandles(value) {
  return String(value ?? '')
    .split(',')
    .map((handle) => handle.trim())
    .filter(Boolean);
}

function userFromDatabaseRow(row) {
  const xAccounts = splitHandles(row.linked_handles);
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    passwordHash: row.password_hash,
    createdAt: isoDate(row.created_at),
    lastLogin: isoDate(row.last_login),
    preferences: { defaultXAccount: row.default_handle ?? xAccounts[0] ?? null },
    xAccounts,
    sessionToken: row.session_token,
    groqApiKey: row.groq_api_key ?? undefined,
    ipAddress: row.ip_address ?? null,
  };
}

/** Load user records from PostgreSQL when configured, otherwise the local test/dev file. */
async function loadUserDb() {
  if (isPostgresEnabled()) {
    const { rows } = await query(`
      SELECT id, username, email, password_hash, created_at, last_login,
             session_token, default_handle, linked_handles, groq_api_key, ip_address
      FROM users
      ORDER BY id
    `);
    return rows.map(userFromDatabaseRow);
  }

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
    // Windows can briefly hold the destination open (antivirus, another
    // reader, or the browser process), making replace-rename fail with EPERM.
    // Retry briefly instead of failing a session write/rollback.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, path);
        break;
      } catch (error) {
        if (attempt >= 19 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(10);
      }
    }
  } finally {
    await unlink(tmp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Save user records to PostgreSQL, or atomically replace the local fallback file. */
async function saveUserDb(users) {
  if (!isPostgresEnabled()) {
    await atomicWritePrivateFile(USER_DB_FILE, `${JSON.stringify(users, null, 2)}\n`);
    return;
  }

  await withTransaction(async (tx) => {
    for (const user of users) {
      const metadata = [
        user.username,
        user.email ?? null,
        user.passwordHash,
        user.lastLogin ?? null,
        user.sessionToken ?? null,
        user.preferences?.defaultXAccount ?? null,
        (Array.isArray(user.xAccounts) ? user.xAccounts : []).join(','),
        user.groqApiKey ?? null,
        user.ipAddress ?? null,
      ];

      const isNewDatabaseUser =
        user.id === undefined ||
        user.id === null ||
        (typeof user.id === 'string' && !/^\d+$/.test(user.id));
      if (isNewDatabaseUser) {
        const { rows } = await tx(
          `INSERT INTO users
             (username, email, password_hash, created_at, last_login, session_token,
              default_handle, linked_handles, groq_api_key, ip_address)
           VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP), $5, $6, $7, $8, $9, $10)
           RETURNING id, created_at`,
          [user.username, user.email ?? null, user.passwordHash, user.createdAt ?? null, ...metadata.slice(3)],
        );
        user.id = rows[0].id;
        user.createdAt = isoDate(rows[0].created_at) ?? user.createdAt;
        continue;
      }

      const { rowCount } = await tx(
        `UPDATE users
            SET username = $2, email = $3, password_hash = $4, last_login = $5,
                session_token = $6, default_handle = $7, linked_handles = $8,
                groq_api_key = $9, ip_address = $10
          WHERE id = $1`,
        [user.id, ...metadata],
      );
      if (rowCount === 0) throw new Error(`User ${user.id} no longer exists`);
    }
  });
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
  if (!/^(?:\d+|[a-f0-9-]{16,64})$/i.test(safeUserId)) {
    throw new Error('Invalid user id in user database');
  }
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

/** Build a minimal Playwright storage state from an x_sessions row. */
function sessionStateFromRecord(record) {
  return {
    cookies: [
      {
        name: 'auth_token',
        value: record.auth_token,
        domain: '.x.com',
        path: '/',
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
      {
        name: 'ct0',
        value: record.ct0,
        domain: '.x.com',
        path: '/',
        expires: -1,
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
    username: record.handle,
    savedAt: isoDate(record.updated_at) ?? new Date().toISOString(),
    loginUrl: X_LOGIN_URL,
    cookieCount: 2,
    source: 'postgres',
  };
}

async function xSessionExists(userId, xUsername) {
  if (!isPostgresEnabled()) return sessionFileExists(sessionFileFor(userId, xUsername));
  const { rowCount } = await query(
    'SELECT 1 FROM x_sessions WHERE user_id = $1 AND handle = $2 LIMIT 1',
    [userId, xUsername],
  );
  return rowCount > 0;
}

async function readXSession(userId, xUsername) {
  if (!isPostgresEnabled()) return readAuthFile(sessionFileFor(userId, xUsername));
  const { rows } = await query(
    `SELECT handle, auth_token, ct0, updated_at
       FROM x_sessions
      WHERE user_id = $1 AND handle = $2
      LIMIT 1`,
    [userId, xUsername],
  );
  return rows[0] ? sessionStateFromRecord(rows[0]) : null;
}

async function writeXSession(userId, xUsername, storageState) {
  if (!isPostgresEnabled()) {
    await writeAuthFile(storageState, sessionFileFor(userId, xUsername));
    return storageState;
  }

  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  const authToken = cookies.find((cookie) => cookie.name === 'auth_token')?.value;
  const ct0 = cookies.find((cookie) => cookie.name === 'ct0')?.value;
  if (!authToken || !ct0) {
    throw new ValidationError('The X session must include both auth_token and ct0');
  }

  const { rows } = await query(
    `INSERT INTO x_sessions (user_id, handle, auth_token, ct0, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, handle)
     DO UPDATE SET auth_token = EXCLUDED.auth_token,
                   ct0 = EXCLUDED.ct0,
                   updated_at = CURRENT_TIMESTAMP
     RETURNING handle, auth_token, ct0, updated_at`,
    [userId, xUsername, authToken, ct0],
  );
  return sessionStateFromRecord(rows[0]);
}

async function deleteXSession(userId, xUsername) {
  if (!isPostgresEnabled()) {
    await deleteAuthFile(sessionFileFor(userId, xUsername));
    return;
  }
  await query('DELETE FROM x_sessions WHERE user_id = $1 AND handle = $2', [userId, xUsername]);
}

/** Most recent saved account for one user, used when their default handle is empty. */
async function latestXSessionForUser(userId) {
  if (!isPostgresEnabled()) return null;
  const { rows } = await query(
    `SELECT handle, auth_token, ct0, updated_at
       FROM x_sessions
      WHERE user_id = $1
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [userId],
  );
  return rows[0]
    ? { xUsername: normalizeXUsername(rows[0].handle), state: sessionStateFromRecord(rows[0]) }
    : null;
}

/** Latest saved session across app users, used to warm auth.json after a restart. */
async function latestXSession() {
  if (!isPostgresEnabled()) return null;
  const { rows } = await query(
    `SELECT s.handle, s.auth_token, s.ct0, s.updated_at
       FROM x_sessions s
       JOIN users u ON u.id = s.user_id
      ORDER BY (s.handle = u.default_handle) DESC, s.updated_at DESC, s.id DESC
      LIMIT 1`,
  );
  return rows[0] ? sessionStateFromRecord(rows[0]) : null;
}

/** Re-stage the most recently active saved X account after a container restart. */
async function hydrateActiveSessionFromDatabase() {
  if (!isPostgresEnabled()) return;
  const state = await latestXSession();
  if (!state) {
    // PostgreSQL is the source of truth; do not let a stale staged file from a
    // previous deployment authenticate a run.
    await deleteAuthFile(AUTH_FILE);
    console.log('[storage] No saved X sessions to hydrate yet.');
    return;
  }
  await writeAuthFile(state, AUTH_FILE);
  console.log(`[storage] Hydrated active X session for @${state.username} from PostgreSQL.`);
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
  let xUsername = user.preferences.defaultXAccount;

  // Older rows can have a saved session without a default handle. Resolve the
  // most recent database session so new devices still restore an account.
  if (!xUsername) {
    const fallback = await latestXSessionForUser(user.id);
    if (fallback) {
      xUsername = fallback.xUsername;
      user.preferences.defaultXAccount = xUsername;
      if (!user.xAccounts.includes(xUsername)) user.xAccounts.push(xUsername);
      return fallback;
    }
    if (required) throw new HttpError(409, 'No active X account. Add an X account first.');
    return null;
  }

  const state = await readXSession(user.id, xUsername);
  if (!state) {
    if (required) throw new HttpError(409, `Saved session for @${xUsername} was not found`);
    return null;
  }

  return { xUsername, state };
}

async function accountSummaries(user) {
  normalizeUserAccounts(user);
  return Promise.all(
    user.xAccounts.map(async (xUsername) => ({
      xUsername,
      active: xUsername === user.preferences.defaultXAccount,
      status: (await xSessionExists(user.id, xUsername)) ? 'ready' : 'missing',
    })),
  );
}

async function stageActiveSession(user, { sessionToken = null, onlyWhenIdle = false } = {}) {
  return withWriteLock(async () => {
    // A bootstrap request must never replace the cookie file while an
    // automation or sign-in run is using it.
    if (onlyWhenIdle && activeRun) return null;
    if (sessionToken) {
      const users = await loadUserDb();
      user = users.find((candidate) => candidate.id === user.id && candidate.sessionToken === sessionToken);
      if (!user) throw new HttpError(401, 'The app session is no longer active');
    }
    const session = await activeSessionFor(user, { required: true });
    await writeAuthFile(session.state, AUTH_FILE);
    return session;
  });
}

/** Read the X cookies the automation scripts need from a storage state. */
function xSessionCredentials(storageState) {
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  const valueFor = (name) => cookies.find((cookie) => cookie.name === name)?.value ?? null;
  return { auth_token: valueFor('auth_token'), ct0: valueFor('ct0') };
}

/** Rebuild a minimal storage state from the credentials exposed by hydration. */
function credentialsStorageState(credentials) {
  return {
    cookies: Object.entries(COOKIE_SPEC).map(([name, spec]) => ({
      name,
      value: credentials?.[name] ?? '',
      domain: '.x.com',
      path: '/',
      secure: true,
      httpOnly: spec.httpOnly,
      sameSite: 'Lax',
    })),
    origins: [],
  };
}

function xSessionErrorCode(payload) {
  const code = payload?.errors?.[0]?.code ?? payload?.error?.code ?? payload?.code;
  return Number.isFinite(Number(code)) ? Number(code) : null;
}

function xSessionHealth(status, checkedAt = new Date().toISOString()) {
  return {
    xSessionValid: status === 'valid' ? true : status === 'invalid' ? false : null,
    xSessionStatus: status,
    xSessionCheckedAt: checkedAt,
  };
}

/** Probe one endpoint; an inconclusive result lets verification try the next. */
async function probeXSession(url, credentials, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${X_WEB_BEARER}`,
        cookie: `auth_token=${credentials.auth_token}; ct0=${credentials.ct0}`,
        'user-agent': CHROME_USER_AGENT,
        'x-csrf-token': credentials.ct0,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      },
    });

    // A 401 is definitive even when the response body is empty, HTML, or slow.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      return { status: 'invalid', reason: 'unauthorized', httpStatus: 401, url };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // Responses such as Cloudflare challenges are not JSON.
    }
    const errorCode = xSessionErrorCode(payload);

    // A rejected cookie is definitive no matter which host answered. Do not
    // fall back to another endpoint after this: it would hide an expired login.
    if (errorCode !== null && X_SESSION_INVALID_ERROR_CODES.has(errorCode)) {
      return { status: 'invalid', httpStatus: response.status, errorCode, url };
    }
    const hasError = errorCode !== null || Boolean(payload?.error)
      || (Array.isArray(payload?.errors) && payload.errors.length > 0);
    if (response.status === 200 && !hasError && typeof payload?.screen_name === 'string' && payload.screen_name.trim()) {
      return { status: 'valid', httpStatus: response.status, url };
    }
    return {
      status: 'unknown',
      reason: [404, 410].includes(response.status) ? 'endpoint-not-found' : response.ok ? 'invalid-response' : 'http-error',
      httpStatus: response.status,
      errorCode,
      url,
    };
  } catch (error) {
    return {
      status: 'unknown',
      reason: controller.signal.aborted ? 'timeout' : 'network',
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Only an authenticated settings response validates the cookies; failures block runs. */
async function verifyXSession(
  storageState,
  { timeoutMs = X_SESSION_CHECK_TIMEOUT_MS, urls = X_SESSION_CHECK_URLS } = {},
) {
  const credentials = xSessionCredentials(storageState);
  if (!credentials.auth_token || !credentials.ct0) return { status: 'invalid', reason: 'missing-cookies' };
  if (X_SESSION_CHECK_DISABLED) return { status: 'unknown', reason: 'disabled' };

  const outcomes = [];
  for (const url of urls) {
    const outcome = await probeXSession(url, credentials, timeoutMs);
    // Never hide an explicit authentication rejection behind a fallback.
    if (outcome.status === 'valid' || outcome.status === 'invalid') return outcome;
    outcomes.push(outcome);
  }

  // No endpoint confirmed the login. Do not let 404s, outages, or HTML login
  // pages fall through as a non-blocking "unknown" session.
  const failure = outcomes.find((outcome) => ![404, 410].includes(outcome.httpStatus)) ?? outcomes[0];
  return { ...(failure ?? { reason: 'no-endpoints' }), status: 'invalid' };
}

const xSessionHealthCache = new Map();
const xSessionHealthInflight = new Map();

/** Cached/single-flight wrapper so dashboard refreshes do not hammer X. */
async function checkXSessionHealth(storageState, { handle = null, force = false } = {}) {
  const credentials = xSessionCredentials(storageState);
  if (!credentials.auth_token || !credentials.ct0) return xSessionHealth('invalid');

  const key = crypto
    .createHash('sha256')
    .update(`${credentials.auth_token}\0${credentials.ct0}`)
    .digest('hex');
  const cached = xSessionHealthCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.result;
  if (!force && xSessionHealthInflight.has(key)) return xSessionHealthInflight.get(key);

  const pending = (async () => {
    const outcome = await verifyXSession(storageState);
    const result = xSessionHealth(outcome.status);
    if (X_SESSION_CHECK_CACHE_MS > 0) {
      if (xSessionHealthCache.size > 512) xSessionHealthCache.clear();
      xSessionHealthCache.set(key, { expiresAt: Date.now() + X_SESSION_CHECK_CACHE_MS, result });
    }
    if (outcome.status !== 'valid') {
      const account = handle ? `@${handle}` : 'the active X account';
      const reason = outcome.reason ?? (outcome.httpStatus ? `HTTP ${outcome.httpStatus}` : 'no response');
      console.warn(`[x-session] Health check for ${account} is ${outcome.status} (${reason}).`);
    }
    return result;
  })().finally(() => xSessionHealthInflight.delete(key));

  xSessionHealthInflight.set(key, pending);
  return pending;
}

/** Health for the hydrated active session, including "no account" and missing-cookie states. */
async function activeXSessionHealth(active, user, { force = false } = {}) {
  if (active?.xSession) {
    return checkXSessionHealth(credentialsStorageState(active.xSession), {
      handle: active.xSession.handle,
      force,
    });
  }
  const account = active?.activeXAccount ?? user?.preferences?.defaultXAccount ?? null;
  return xSessionHealth(account ? 'invalid' : 'none');
}

/**
 * Resolve the user's saved X account, optionally restage auth.json, and return
 * the credentials for the authenticated dashboard. PostgreSQL remains the
 * source of truth when the local staging file is missing (for example after a
 * new device logs in or a container restarts).
 */
async function hydrateUserXSession(user, { sessionToken = null } = {}) {
  try {
    normalizeUserAccounts(user);
    const session = await activeSessionFor(user);
    if (!session) return null;

    const credentials = xSessionCredentials(session.state);
    let staged = false;
    if (credentials.auth_token && credentials.ct0) {
      staged = Boolean(await stageActiveSession(user, { sessionToken, onlyWhenIdle: true }));
    }

    return {
      activeXAccount: session.xUsername,
      xSession: credentials.auth_token && credentials.ct0
        ? {
            handle: session.xUsername,
            auth_token: credentials.auth_token,
            ct0: credentials.ct0,
            savedAt: session.state.savedAt ?? null,
            source: session.state.source ?? (isPostgresEnabled() ? 'postgres' : 'file'),
            staged,
          }
        : null,
    };
  } catch (error) {
    // Account metadata and an existing app session should remain usable even
    // if the saved X session cannot be read or staged right now.
    console.warn(`[storage] Could not hydrate the saved X session: ${error.message}`);
    return null;
  }
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

/* --------------------------- manual X session import ---------------------- */

app.post('/api/auth/import-session', async (req, res, next) => {
  try {
    const auth = await authenticatedUser(req);
    const body = req.body ?? {};
    if (typeof body.handle !== 'string') throw new ValidationError('handle must be an X username');
    const username = normalizeXUsername(body.handle);
    const storageState = {
      cookies: Object.entries(COOKIE_SPEC).map(([name, spec]) => ({
        name,
        value: validateValue(name, body[name]),
        domain: '.x.com',
        path: '/',
        expires: -1,
        secure: true,
        httpOnly: spec.httpOnly,
        sameSite: 'Lax',
      })),
      origins: [],
      username,
      savedAt: new Date().toISOString(),
      loginUrl: X_LOGIN_URL,
      cookieCount: 2,
      source: 'manual-import',
    };
    if (activeRun && activeRun.type !== 'session-import') {
      throw new HttpError(409, 'A run is already in progress');
    }

    // Validate before writing anything. Rejected cookies should keep the
    // previous session intact and return the user to the re-authentication
    // dialog with a clear message. Failed verification never replaces a session.
    const health = await checkXSessionHealth(storageState, { handle: username });
    if (health.xSessionValid === false) {
      throw new HttpError(422, 'X rejected these cookies. Sign in to X again and copy fresh auth_token and ct0 values.');
    }

    const result = await withWriteLock(async () => {
      const users = await loadUserDb();
      const current = users.find((user) => user.id === auth.user.id && user.sessionToken === auth.token);
      if (!current) throw new HttpError(401, 'The app session is no longer active');
      normalizeUserAccounts(current);
      if (!current.xAccounts.includes(username) && current.xAccounts.length >= MAX_X_ACCOUNTS) {
        throw new HttpError(409, `A maximum of ${MAX_X_ACCOUNTS} X accounts can be linked`);
      }
      if (activeRun) throw new HttpError(409, 'A run is already in progress');

      // Reserve the runtime while staging auth.json so no browser can start
      // with another user's partially imported session.
      const request = new AbortController();
      const completion = createCompletionSignal();
      const handle = {
        type: 'session-import',
        userId: current.id,
        xUsername: username,
        done: completion.promise,
        abort() { request.abort(); },
      };
      activeRun = handle;
      attachRunCleanup(res, handle);
      const assertOpen = () => {
        if (request.signal.aborted || res.destroyed || req.aborted || req.socket?.destroyed) {
          throw new HttpError(410, 'Session import was cancelled');
        }
      };
      const previousUsers = structuredClone(users);
      let previousSession;
      let previousActive;
      let sessionWritten = false;
      let usersWritten = false;
      let activeWritten = false;
      try {
        previousSession = await readXSession(current.id, username);
        previousActive = await readAuthFile(AUTH_FILE);
        assertOpen();
        const savedSession = await writeXSession(current.id, username, storageState);
        sessionWritten = true;
        assertOpen();
        if (!current.xAccounts.includes(username)) current.xAccounts.push(username);
        current.preferences.defaultXAccount = username;
        await saveUserDb(users);
        usersWritten = true;
        assertOpen();
        await writeAuthFile(savedSession, AUTH_FILE);
        activeWritten = true;
        const accounts = await accountSummaries(current);
        assertOpen();
        return { username, activeXAccount: username, accounts };
      } catch (error) {
        // Restore only this import's writes while still holding the write lock.
        try {
          if (activeWritten) {
            if (previousActive) await writeAuthFile(previousActive, AUTH_FILE);
            else await deleteAuthFile(AUTH_FILE);
          }
          if (usersWritten) await saveUserDb(previousUsers);
          if (sessionWritten) {
            if (previousSession) await writeXSession(current.id, username, previousSession);
            else await deleteXSession(current.id, username);
          }
        } catch {
          throw new HttpError(503, 'Could not restore an interrupted session import. Check persistent storage before retrying.');
        }
        throw error;
      } finally {
        if (activeRun === handle) activeRun = null;
        completion.resolve();
      }
    });
    res.status(201).json({ ok: true, authenticated: true, cookieCount: storageState.cookieCount, ...result, ...health });
  } catch (error) {
    // Storage/parser errors can contain snippets of existing session files.
    // Keep those details out of both the response and the shared error logger.
    next(error instanceof HttpError ? error : new HttpError(500, 'Could not import the X session. Check persistent storage before retrying.'));
  } finally {
    if (req.body) {
      delete req.body.auth_token;
      delete req.body.ct0;
    }
  }
});

/* --------------------------------- auth ---------------------------------- */

app.get('/api/auth', async (req, res, next) => {
  try {
    const auth = await optionalAuthenticatedUser(req);
    if (!auth) return res.json(describe(await readAuthFile()));

    const session = await activeSessionFor(auth.user);
    const state = session?.state ?? null;
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
    const body = req.body ?? {};
    const updates = Object.keys(COOKIE_SPEC).filter((name) => body[name] !== undefined);

    if (updates.length === 0) {
      throw new ValidationError('Provide auth_token and/or ct0');
    }

    const values = Object.fromEntries(updates.map((name) => [name, validateValue(name, body[name])]));

    const saved = await withWriteLock(async () => {
      if (activeRun) throw new HttpError(409, 'A run is already in progress');
      const payload = selectedSession
        ? structuredClone(selectedSession.state)
        : ((await readAuthFile(AUTH_FILE)) ?? { cookies: [] });
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

      if (selectedSession) {
        const savedState = await writeXSession(auth.user.id, selectedSession.xUsername, payload);
        await writeAuthFile(savedState, AUTH_FILE);
        return savedState;
      }

      await writeAuthFile(payload, AUTH_FILE);
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
      await withWriteLock(async () => {
        const users = await loadUserDb();
        const user = users.find((candidate) => candidate.id === auth.user.id);
        if (user) user.sessionToken = null;
        await saveUserDb(users);
      });
      // Imports recheck this token under the same lock before saving cookies.
      await stopActiveRunForUser(auth.user.id);
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

    await stopActiveRunForUser(user.id, { type: 'x-auth' });
    setSessionCookie(res, user.sessionToken);
    const active = await hydrateUserXSession(user, { sessionToken: user.sessionToken });
    const health = await activeXSessionHealth(active, user);
    return res.json({
      user: publicUser(user),
      activeXAccount: active?.activeXAccount ?? user.preferences.defaultXAccount ?? null,
      xAccounts: user.xAccounts,
      accounts: await accountSummaries(user),
      ...health,
    });
  } catch (error) {
    next(error);
  }
});

// Get current user and restore the active X session on this device
app.get('/api/auth/me', async (req, res, next) => {
  const signedOut = {
    authenticated: false,
    userAuthenticated: false,
    user: null,
    activeXAccount: null,
    xAccounts: [],
    accounts: [],
    xSessionValid: null,
    xSessionStatus: 'none',
    xSessionCheckedAt: null,
  };

  try {
    if (!sessionTokenFromRequest(req)) return res.json(signedOut);

    let auth;
    try {
      auth = await authenticatedUser(req);
    } catch (error) {
      // A stale cookie should let the dashboard show its sign-in form instead
      // of failing the whole bootstrap with a 401.
      if (error instanceof HttpError && error.status === 401) return res.json(signedOut);
      throw error;
    }

    normalizeUserAccounts(auth.user);
    const active = await hydrateUserXSession(auth.user, { sessionToken: auth.token });
    const health = await activeXSessionHealth(active, auth.user);
    return res.json({
      authenticated: true,
      userAuthenticated: true,
      user: publicUser(auth.user),
      groq: publicGroqConfiguration(auth.user),
      activeXAccount: active?.activeXAccount ?? auth.user.preferences.defaultXAccount ?? null,
      xAccounts: auth.user.xAccounts,
      accounts: await accountSummaries(auth.user),
      ...(active?.xSession ? { xSession: active.xSession } : {}),
      ...health,
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

      if (storageState) {
        await writeXSession(current.id, xUsername, { ...storageState, username: xUsername });
        await writeAuthFile(trustedLoginProfilePayload(storageState), loginProfileFileFor(current.id));
      } else if (!(await xSessionExists(current.id, xUsername))) {
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
    if (!(await xSessionExists(auth.user.id, xUsername))) {
      throw new HttpError(404, `No saved session for @${xUsername}`);
    }

    const switched = await withWriteLock(async () => {
      const users = await loadUserDb();
      const current = users.find((candidate) => candidate.id === auth.user.id);
      if (!current) throw new HttpError(401, 'User account no longer exists');
      normalizeUserAccounts(current);
      if (!current.xAccounts.includes(xUsername)) throw new HttpError(404, 'X account is not linked');
      if (activeRun) throw new HttpError(409, 'A run is already in progress');
      const state = await readXSession(current.id, xUsername);
      if (!state) throw new HttpError(404, `Saved session for @${xUsername} was not found`);
      current.preferences.defaultXAccount = xUsername;
      await saveUserDb(users);
      await writeAuthFile(state, AUTH_FILE);
      return { user: current, state };
    });

    return res.json({
      ok: true,
      activeXAccount: xUsername,
      defaultXAccount: xUsername,
      accounts: await accountSummaries(switched.user),
      ...(await checkXSessionHealth(switched.state, { handle: xUsername })),
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

      const linked = current.xAccounts.includes(xUsername);
      const sessionDeleted = await xSessionExists(current.id, xUsername);
      if (!linked && !sessionDeleted) throw new HttpError(404, `X account @${xUsername} is not linked`);

      const wasActive = current.preferences.defaultXAccount === xUsername;
      current.xAccounts = current.xAccounts.filter((account) => account !== xUsername);
      if (wasActive) current.preferences.defaultXAccount = current.xAccounts[0] ?? null;

      // Persist metadata first. A failed unlink can leave only an unreachable
      // session row, never a user record that points at a deleted session.
      await saveUserDb(users);
      await deleteXSession(current.id, xUsername);

      let activeSessionStaged = false;
      if (wasActive) {
        const nextActive = current.preferences.defaultXAccount;
        if (nextActive) {
          let nextState = null;
          try {
            nextState = await readXSession(current.id, nextActive);
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
          const profileState = await readXSession(current.id, profileAccount);
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

    const activeXAccount = result.user.preferences.defaultXAccount;
    let health = xSessionHealth(activeXAccount ? 'invalid' : 'none');
    if (activeXAccount) {
      const state = await readXSession(result.user.id, activeXAccount);
      if (state) health = await checkXSessionHealth(state, { handle: activeXAccount });
    }

    return res.json({
      ok: true,
      deletedXAccount: xUsername,
      sessionDeleted: result.sessionDeleted,
      wasActive: result.wasActive,
      activeSessionStaged: result.activeSessionStaged,
      activeXAccount,
      accounts: await accountSummaries(result.user),
      ...health,
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

async function recordRunHistory(entry) {
  if (!entry) return;
  try {
    await appendHistory(entry);
  } catch (error) {
    console.error(`Could not write automation history: ${error.message}`);
  }
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

// A headless container has no interactive viewer. Fail fast instead of reserving
// the automation lock for a sign-in the user cannot complete.
app.post('/auth/x', async (req, res, next) => {
  try {
    await authenticatedUser(req);
    if (activeRun) throw new HttpError(409, 'A run is already in progress');
    return res.status(410).json({
      error: 'Interactive X sign-in is unavailable with local headless Chromium. Import auth_token and ct0 through /api/auth/import-session.',
    });
  } catch (error) {
    next(error);
  }
});

app.post('/auth/x/cancel', async (req, res, next) => {
  try {
    await authenticatedUser(req);
    return res.json({ ok: true, cancelled: false });
  } catch (error) {
    next(error);
  }
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
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Could not load the active X session' });
  }

  const groqConfiguration = getGroqConfiguration(appAuth.user);
  if (!groqConfiguration.configured) {
    return res.status(400).json({ error: 'Groq API key is not configured. Add a saved key in the dashboard.' });
  }
  // Authentication yields; reserve before staging so overlapping requests cannot
  // replace the active cookie file, even if they never launch a browser.
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
    xUsername: null,
    done: completion.promise,
    abort() {
      if (aborted) return;
      aborted = true;
      if (currentChild) killTree(currentChild);
      finishCooldown?.();
    },
  };
  // Keep the single-flight lock inside one outer try/finally so every exit
  // path, including staging failures and unexpected throws, releases it.
  try {
    activeRun = batchHandle;
    attachRunCleanup(res, batchHandle);

    try {
      // Validate before writing auth.json or spawning Playwright. An expired
      // account must fail with 409 immediately instead of launching a browser
      // that only discovers the rejected cookies after startup.
      selectedSession = await activeSessionFor(appAuth.user, { required: true });
      batchHandle.xUsername = selectedSession.xUsername;
      if (aborted || res.destroyed) throw new HttpError(410, 'The run was cancelled');

      const health = await checkXSessionHealth(selectedSession.state, {
        handle: selectedSession.xUsername,
        force: true,
      });
      if (health.xSessionValid === false) {
        return res.status(409).json({
          error: `X connection expired for @${selectedSession.xUsername}. Re-authenticate the account before publishing.`,
          code: 'X_SESSION_EXPIRED',
          ...health,
        });
      }

      selectedSession = await stageActiveSession(appAuth.user, { sessionToken: appAuth.token });
      batchHandle.xUsername = selectedSession.xUsername;
      if (aborted || res.destroyed) throw new HttpError(410, 'The run was cancelled');
    } catch (error) {
      return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Could not load the active X session' });
    }

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    const send = makeSend(res);

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
      let replyVerificationError = null;
      let lastTopic = 'other';
      let auditResult = null;
      let spawnError = null;
      const stderrLines = [];

      const recordStderr = (line) => {
        if (REPLY_VERIFICATION_ERROR.test(line)) replyVerificationError = REPLY_VERIFICATION_ERROR_MESSAGE;
        lastError = line;
        stderrLines.push(line);
        if (stderrLines.length > 50) stderrLines.shift();
        console.log(line);
      };

      const forward = (stream, type) => {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (type === 'stderr') {
              recordStderr(line);
            } else if (type === 'stdout') {
              const topicMatch = line.match(/Detected topic: (\w+)/);
              if (topicMatch) lastTopic = topicMatch[1];
              if (REPLY_VERIFICATION_ERROR.test(line)) replyVerificationError = REPLY_VERIFICATION_ERROR_MESSAGE;
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
              recordStderr(pending);
            } else if (type === 'stdout') {
              const topicMatch = pending.match(/Detected topic: (\w+)/);
              if (topicMatch) lastTopic = topicMatch[1];
              if (REPLY_VERIFICATION_ERROR.test(pending)) replyVerificationError = REPLY_VERIFICATION_ERROR_MESSAGE;
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
      child.on('error', (error) => {
        spawnError = error;
        send({ type: 'stderr', data: `[server] could not start main.js: ${error.message}` });
      });

      send({ type: 'start', command: args.join(' '), pid: child.pid, url: targetUrl });

      const exitInfo = await new Promise((resolve) => {
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (currentChild === child) currentChild = null;
          resolve({ code, signal });
        });
      });

      // Older runners may emit a confirmation warning and still exit zero.
      // Treat that as a failed attempt, regardless of the child exit status.
      const code = replyVerificationError && exitInfo.code === 0 ? 1 : exitInfo.code;
      const ok = code === 0 && !spawnError;
      const runError = replyVerificationError || lastError || spawnError?.message || `exit ${code}`;
      const skipped = auditResult?.status === 'engaged';
      const draftReply = reply && !dryRun && !skipped ? await readReplyForHistory(reply, dryRun) : null;
      if (ok && draftReply) send({ type: 'reply', data: draftReply });

      const historyEntry = {
        id: new Date().toISOString(),
        at: new Date().toISOString(),
        url: targetUrl,
        dryRun: Boolean(dryRun),
        actions: skipped || !ok ? [] : buildActions({ reply, like, repost, dryRun }),
        reply: draftReply,
        topic: lastTopic,
        userId: appAuth.user.id,
        xUsername: selectedSession.xUsername,
        ...(auditResult ? { audit: auditResult } : {}),
        ok,
        error: ok ? null : runError,
      };

      return {
        code,
        signal: exitInfo.signal,
        error: ok ? null : runError,
        stderr: stderrLines,
        spawnError: spawnError?.message ?? null,
        audit: auditResult,
        historyEntry,
      };
    };

    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    send({ type: 'batch-start', total: targets.length, percent: 0, succeeded, failed, skipped, xUsername: selectedSession.xUsername });

    try {
      for (let i = 0; i < targets.length; i += 1) {
        if (aborted) break;

        const seq = i + 1;
        const targetUrl = targets[i];
        const processingPercent = Math.round((completed / targets.length) * 100);
        console.error(`[QUEUE] Processing ${seq}/${targets.length}: ${targetUrl}`);
        send({ type: 'progress', index: seq, completed, total: targets.length, percent: processingPercent, url: targetUrl, succeeded, failed, skipped });

        let itemStatus = 'succeeded';
        let itemError = null;
        try {
          const result = await executeWithRetry(
            async () => {
              const attemptResult = await runOne(targetUrl);
              const replyUnconfirmed = isReplyVerificationError({ result: attemptResult });
              const transientNetworkFailure =
                attemptResult.code !== 0 && isTransientNetworkError({ result: attemptResult });
              if (!aborted && (replyUnconfirmed || transientNetworkFailure)) {
                const retryError = new Error(
                  attemptResult.error
                    || attemptResult.spawnError
                    || (replyUnconfirmed
                      ? REPLY_VERIFICATION_ERROR_MESSAGE
                      : `transient network failure (exit ${attemptResult.code})`),
                );
                retryError.name = replyUnconfirmed ? 'ReplyVerificationError' : 'TransientNetworkError';
                retryError.result = attemptResult;
                throw retryError;
              }
              return attemptResult;
            },
            {
              // Two retries means at most three total attempts per target URL.
              retries: MAX_TARGET_RETRIES,
              delayMs: 5_000,
              label: `tweet ${seq}/${targets.length} (${targetUrl})`,
              shouldRetry: isRetryableTargetError,
              wait: waitForCooldown,
            },
          );

          await recordRunHistory(result.historyEntry);
          if (aborted) break;
          if (result.code !== 0) {
            itemStatus = 'failed';
            itemError = result.error || `exit ${result.code}`;
            failed += 1;
            send({ type: 'failed', index: seq, url: targetUrl, error: itemError, succeeded, failed, skipped });
          } else if (result.audit?.status === 'engaged') {
            itemStatus = 'skipped';
            skipped += 1;
          } else {
            succeeded += 1;
          }
        } catch (error) {
          if (aborted || error?.name === 'AbortError') break;
          await recordRunHistory(error?.result?.historyEntry);
          itemStatus = 'failed';
          itemError = error?.message ?? 'unknown error';
          failed += 1;
          const hardFailure = `[QUEUE] Hard failure for URL, skipping to next target (${targetUrl}): ${itemError}`;
          console.error(hardFailure);
          send({ type: 'stderr', data: hardFailure });
          send({ type: 'failed', index: seq, url: targetUrl, error: itemError, attempts: error?.attempts, succeeded, failed, skipped });
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
          succeeded,
          failed,
          skipped,
        });

        if (i < targets.length - 1 && !aborted) {
          const waitMs = 15_000 + Math.random() * 15_000;
          const waitSeconds = Math.round(waitMs / 1000);
          console.error(`[COOLDOWN] Waiting ${waitSeconds} seconds before next tweet...`);
          send({ type: 'cooldown', completed, total: targets.length, percent: completedPercent, seconds: waitSeconds, succeeded, failed, skipped });
          await waitForCooldown(waitMs);
        }
      }

      if (!aborted) {
        send({ type: 'batch-complete', completed, total: targets.length, percent: 100, succeeded, failed, skipped });
      }
    } catch (error) {
      if (!aborted) send({ type: 'batch-error', error: error?.message ?? 'unknown batch error' });
    }
  } finally {
    clearTimeout(cooldownTimer);
    finishCooldown = null;
    if (currentChild) killTree(currentChild);
    if (activeRun === batchHandle) activeRun = null;
    completion.resolve();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

app.get('/', (req, res, next) => {
  res.sendFile(INDEX_FILE, (error) => {
    if (error) next(error);
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Body must be valid JSON' });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: `JSON body must not exceed ${MAX_BODY}` });
  }
  if (error?.message === 'Origin not allowed') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  console.error('Request failed:', error);
  return res.status(500).json({ error: 'Something went wrong' });
});

await mkdir(DATA_DIR, { recursive: true });
console.log(`[storage] Runtime file directory: ${DATA_DIR}`);
if (
  IS_PRODUCTION &&
  !process.env.DATA_DIR &&
  (process.env.RENDER || process.env.RENDER_EXTERNAL_URL)
) {
  console.warn(
    '[storage] DATA_DIR is not set. Render containers have an ephemeral filesystem; auth.json, history, and trusted login profiles will be re-created from PostgreSQL where possible.',
  );
}

await initializeDatabase();
await hydrateActiveSessionFromDatabase();
await seedDefaultAdmin();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`X automation API service: http://${HOST}:${PORT}`);
  console.log(`  POST ${HOST}:${PORT}/api/auth/register   (create local user)`);
  console.log(`  POST ${HOST}:${PORT}/api/auth/login      (create app session)`);
  console.log(`  GET  ${HOST}:${PORT}/api/auth/me         (current local user)`);
  console.log(`  GET  ${HOST}:${PORT}/api/auth/x-accounts (list saved X sessions)`);
  console.log(`  POST ${HOST}:${PORT}/api/auth/import-session (import and activate X session cookies)`);
  console.log(`  POST ${HOST}:${PORT}/api/auth/switch-account (select active X session)`);
  console.log(`  GET/PUT/DELETE ${HOST}:${PORT}/api/config/groq   (persisted per-user key configuration)`);
  console.log(`  GET ${HOST}:${PORT}/api/history`);
  console.log(`  DELETE ${HOST}:${PORT}/api/history`);
  console.log(`  POST ${HOST}:${PORT}/auth/x      (retired; use /api/auth/import-session)`);
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
  server.close(async () => {
    clearTimeout(forceExit);
    await closeDatabase().catch((error) => console.error('[storage] Could not close PostgreSQL:', error.message));
    process.exit(0);
  });
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
