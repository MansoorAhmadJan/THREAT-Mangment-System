const { createHash, randomUUID } = require("node:crypto");

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxBatchSize = 1000;

function validateUserId(userId) {
  if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2147483647) {
    throw new TypeError("Expected a positive Users primary key");
  }
}

function hashSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length !== 36 || !sessionIdPattern.test(sessionId)) {
    throw new TypeError("Invalid session identifier");
  }
  return createHash("sha256").update(sessionId, "utf8").digest();
}

function validateBatchSize(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxBatchSize) {
    throw new RangeError(`Session batch size must be between 1 and ${maxBatchSize}`);
  }
}

// Pass a mysql2 promise pool or an existing transaction connection. The caller owns the transaction.
function createSessionStore(executor) {
  if (typeof executor?.execute !== "function") throw new TypeError("Expected a MySQL promise executor");

  return {
    async createSession({ userId, expiresAt }) {
      validateUserId(userId);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
        throw new TypeError("Session expiration must be a positive Unix timestamp in seconds");
      }

      const sessionId = randomUUID();
      const [result] = await executor.execute(
        `INSERT INTO user_sessions (session_hash, user_id, expires_at)
         SELECT ?, user_id, ? FROM users
         WHERE user_id = ? AND disabled_at IS NULL AND ? > UNIX_TIMESTAMP()`,
        [hashSessionId(sessionId), expiresAt, userId, expiresAt]
      );
      return result.affectedRows === 1 ? sessionId : null;
    },

    async findActiveSession({ userId, sessionId }) {
      validateUserId(userId);
      const [rows] = await executor.execute(
        `SELECT s.user_id AS userId, u.role, s.expires_at AS expiresAt
         FROM user_sessions AS s JOIN users AS u ON u.user_id = s.user_id
         WHERE s.session_hash = ? AND s.user_id = ? AND u.disabled_at IS NULL
           AND s.expires_at > UNIX_TIMESTAMP()`,
        [hashSessionId(sessionId), userId]
      );
      return rows[0] ?? null;
    },

    async findAccountStatus(userId) {
      validateUserId(userId);
      const [rows] = await executor.execute(
        `SELECT user_id AS userId, role, disabled_at AS disabledAt
         FROM users WHERE user_id = ?`,
        [userId]
      );
      return rows[0] ?? null;
    },

    async revokeSession({ userId, sessionId }) {
      validateUserId(userId);
      const [result] = await executor.execute(
        "DELETE FROM user_sessions WHERE session_hash = ? AND user_id = ?",
        [hashSessionId(sessionId), userId]
      );
      return result.affectedRows === 1;
    },

    async revokeUserSessions(userId) {
      validateUserId(userId);
      const [result] = await executor.execute("DELETE FROM user_sessions WHERE user_id = ?", [userId]);
      return result.affectedRows;
    },

    // Bind validated LIMIT values as decimal strings because mysql2 sends numbers as DOUBLE.
    async listExpiredSessions(limit = 100) {
      validateBatchSize(limit);
      const [rows] = await executor.execute(
        `SELECT user_id AS userId, expires_at AS expiresAt FROM user_sessions
         WHERE expires_at <= UNIX_TIMESTAMP() ORDER BY expires_at, session_hash LIMIT ?`,
        [String(limit)]
      );
      return rows;
    },

    async deleteExpiredSessions(limit = 100) {
      validateBatchSize(limit);
      const [result] = await executor.execute(
        `DELETE FROM user_sessions WHERE expires_at <= UNIX_TIMESTAMP()
         ORDER BY expires_at, session_hash LIMIT ?`,
        [String(limit)]
      );
      return result.affectedRows;
    },
  };
}

module.exports = { createSessionStore };
