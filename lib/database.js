import pg from 'pg';

/**
 * PostgreSQL is the optional source of truth for user accounts and X
 * sessions. Without DATABASE_URL, the server uses data/db.json and local
 * session files in development and production alike.
 *
 * Set DATABASE_URL to a Supabase connection string on Render. The optional
 * value "pg-mem://" uses an in-process PostgreSQL-compatible database for
 * tests that need to exercise the SQL path without a network server.
 */
let pool = null;
let postgresEnabled = false;

const USERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    email TEXT UNIQUE,
    last_login TIMESTAMP,
    session_token TEXT,
    default_handle TEXT,
    linked_handles TEXT NOT NULL DEFAULT '',
    groq_api_key TEXT,
    ip_address TEXT
  )
`;

const X_SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS x_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    auth_token TEXT NOT NULL,
    ct0 TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

function shouldUseSsl(connectionString) {
  if (String(process.env.DATABASE_SSL ?? '').toLowerCase() === 'false') return false;
  if (/[?&]sslmode=disable(?:&|$)/i.test(connectionString)) return false;
  return !/@(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i.test(connectionString);
}

async function createPool() {
  const connectionString = String(process.env.DATABASE_URL ?? '').trim();
  if (!connectionString) {
    console.warn('[storage] DATABASE_URL is not set; using the local JSON storage fallback.');
    return null;
  }

  if (connectionString === 'pg-mem://' || connectionString.startsWith('pg-mem:')) {
    const { newDb } = await import('pg-mem');
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memory.adapters.createPg();
    return new adapter.Pool();
  }

  return new pg.Pool({
    connectionString,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
  });
}

export function isPostgresEnabled() {
  return postgresEnabled;
}

export function query(text, params = []) {
  if (!pool) throw new Error('PostgreSQL is not initialized');
  return pool.query(text, params);
}

export async function withTransaction(task) {
  if (!pool) throw new Error('PostgreSQL is not initialized');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await task((text, params = []) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase() {
  pool = await createPool();
  if (!pool) return false;

  pool.on?.('error', (error) => {
    console.error('[storage] Unexpected PostgreSQL pool error:', error.message);
  });

  await pool.query('SELECT 1');
  await pool.query(USERS_SCHEMA);
  await pool.query(X_SESSIONS_SCHEMA);

  // Keep databases created from the minimal schema compatible with the
  // account metadata used by the dashboard.
  for (const statement of [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS default_handle TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_handles TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS groq_api_key TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS ip_address TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS x_sessions_user_handle_idx ON x_sessions (user_id, handle)',
    'CREATE INDEX IF NOT EXISTS x_sessions_updated_at_idx ON x_sessions (updated_at DESC)',
    'CREATE INDEX IF NOT EXISTS users_session_token_idx ON users (session_token)',
  ]) {
    await pool.query(statement);
  }

  postgresEnabled = true;
  console.log('[storage] PostgreSQL connected and schema is ready.');
  return true;
}

export async function closeDatabase() {
  if (!pool) return;
  const active = pool;
  pool = null;
  postgresEnabled = false;
  await active.end?.();
}
