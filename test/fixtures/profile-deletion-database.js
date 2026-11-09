// Test-only IPC access to the server's in-process PostgreSQL fixture. Never
// add database inspection routes or connect these tests to a deployment DB.
import { query } from '../../lib/database.js';

if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_URL !== 'pg-mem://' || !process.send) {
  throw new Error('Profile deletion database fixture requires test-only pg-mem and IPC');
}

process.on('message', async (message) => {
  if (message?.fixture !== 'profile-deletion-database') return;
  try {
    let result;
    if (message.action === 'snapshot') {
      const users = await query('SELECT id, username, email, groq_api_key, default_handle, linked_handles FROM users ORDER BY id');
      const sessions = await query('SELECT user_id, handle FROM x_sessions ORDER BY user_id, handle');
      result = { users: users.rows, sessions: sessions.rows };
    } else if (message.action === 'orphan') {
      // Simulate a cookie row left out of linked_handles by a legacy write.
      const inserted = await query(
        'INSERT INTO x_sessions (user_id, handle, auth_token, ct0) VALUES ($1, $2, $3, $4)',
        [message.userId, 'orphan', 'orphan_synthetic_auth_token', 'orphan_synthetic_csrf_token'],
      );
      result = { rowCount: inserted.rowCount };
    } else {
      throw new Error('Unknown profile deletion fixture action');
    }
    process.send({ requestId: message.requestId, result });
  } catch (error) {
    process.send({ requestId: message.requestId, error: error.message });
  }
});
