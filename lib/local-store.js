import crypto from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Local JSON fallback used when DATABASE_URL is not configured.
 *
 * The authoritative file is <DATA_DIR>/data/db.json. It holds the app accounts
 * (including their Groq keys) and the execution history. X sessions remain in
 * the per-user session files because the runner also consumes their Playwright
 * storage-state shape.
 *
 * Older installations kept users in <DATA_DIR>/user-db.json and history in
 * <DATA_DIR>/history.json. Those files are imported once when db.json does not
 * exist. The test suite keeps writing the legacy mirrors so the existing
 * regression fixtures continue to exercise the same disk paths.
 */

const SCHEMA_VERSION = 1;

function emptyDatabase() {
  return { version: SCHEMA_VERSION, updatedAt: null, users: [], history: [] };
}

function normalizeDatabase(value) {
  const source = Array.isArray(value) ? { users: value } : value && typeof value === 'object' ? value : {};
  return {
    version: SCHEMA_VERSION,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    users: Array.isArray(source.users) ? source.users : [],
    history: Array.isArray(source.history) ? source.history : [],
  };
}

async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 });
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

function mergeUsers(primary, legacy) {
  const merged = new Map();
  for (const user of primary) {
    const key = String(user?.id ?? '');
    merged.set(key, user);
  }
  for (const user of legacy) {
    const key = String(user?.id ?? '');
    // Legacy edits (for example a manually added settings object in a fixture)
    // win for the same stable ID, matching the old single-file behavior.
    merged.set(key, key && merged.has(key) ? { ...merged.get(key), ...user } : user);
  }
  return [...merged.values()];
}

function mergeHistory(primary, legacy) {
  const seen = new Set();
  const merged = [];
  for (const entry of [...primary, ...legacy]) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.slice(-50);
}

export function createLocalStore(dataDir, { isTest = process.env.NODE_ENV === 'test' } = {}) {
  const file = join(dataDir, 'data', 'db.json');
  const legacyUsersFile = join(dataDir, 'user-db.json');
  const legacyHistoryFile = join(dataDir, 'history.json');
  let writeQueue = Promise.resolve();

  /** Serialize read-modify-write updates so accounts and history do not clobber each other. */
  function serializedWrite(task) {
    const result = writeQueue.then(task, task);
    writeQueue = result.then(() => {}, () => {});
    return result;
  }

  async function readBase() {
    const stored = await readJson(file);
    if (stored !== null) return normalizeDatabase(stored);

    // Never mask a malformed or unreadable legacy file: creating an empty
    // database here would make the old accounts and history appear deleted.
    const legacyUsers = await readJson(legacyUsersFile);
    const legacyHistory = await readJson(legacyHistoryFile);
    const migrated = normalizeDatabase({
      users: Array.isArray(legacyUsers) ? legacyUsers : [],
      history: Array.isArray(legacyHistory) ? legacyHistory : [],
    });
    await writeBase(migrated);
    return migrated;
  }

  async function writeBase(db) {
    const payload = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      users: Array.isArray(db.users) ? db.users : [],
      history: Array.isArray(db.history) ? db.history : [],
    };
    await atomicWrite(file, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  async function readMerged() {
    const db = await readBase();
    if (!isTest) return db;

    const legacyUsers = await readJson(legacyUsersFile).catch(() => null);
    if (Array.isArray(legacyUsers)) db.users = mergeUsers(db.users, legacyUsers);
    const legacyHistory = await readJson(legacyHistoryFile).catch(() => null);
    if (Array.isArray(legacyHistory)) db.history = mergeHistory(db.history, legacyHistory);
    return db;
  }

  async function mirrorLegacyUsers(users) {
    if (!isTest) return;
    await atomicWrite(legacyUsersFile, `${JSON.stringify(users, null, 2)}\n`);
  }

  async function mirrorLegacyHistory(history) {
    if (!isTest) return;
    if (history.length === 0) {
      await unlink(legacyHistoryFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return;
    }
    await atomicWrite(legacyHistoryFile, `${JSON.stringify(history, null, 2)}\n`);
  }

  return {
    file,
    legacyUsersFile,
    legacyHistoryFile,
    async ensure() {
      await readBase();
    },
    async readDatabase() {
      return readMerged();
    },
    async readUsers() {
      return (await readMerged()).users;
    },
    async writeUsers(users) {
      return serializedWrite(async () => {
        const db = await readBase();
        const normalized = Array.isArray(users) ? users : [];
        const written = await writeBase({ ...db, users: normalized });
        await mirrorLegacyUsers(normalized);
        return written.users;
      });
    },
    async readHistory() {
      return (await readMerged()).history;
    },
    async writeHistory(history) {
      return serializedWrite(async () => {
        const db = await readBase();
        const normalized = (Array.isArray(history) ? history : []).slice(-50);
        const written = await writeBase({ ...db, history: normalized });
        await mirrorLegacyHistory(normalized);
        return written.history;
      });
    },
  };
}
