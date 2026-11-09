// Test-only IPC mutations simulate cookies changed directly in PostgreSQL,
// without updating the runner's staging file or using a deployment database.
import { query } from '../../lib/database.js';

if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_URL !== 'pg-mem://' || !process.send) {
  throw new Error('Run session database fixture requires test-only pg-mem and IPC');
}

process.on('message', async (message) => {
  if (message?.fixture !== 'run-session-database') return;
  try {
    let result;
    if (message.action === 'replace-session') {
      result = await query(
        `UPDATE x_sessions
            SET auth_token = $3, ct0 = $4, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND handle = $2`,
        [message.userId, message.handle, message.auth_token, message.ct0],
      );
    } else if (message.action === 'delete-session') {
      result = await query('DELETE FROM x_sessions WHERE user_id = $1 AND handle = $2', [message.userId, message.handle]);
    } else {
      throw new Error('Unknown run session fixture action');
    }
    process.send({ requestId: message.requestId, result: { rowCount: result.rowCount } });
  } catch (error) {
    process.send({ requestId: message.requestId, error: error.message });
  }
});
