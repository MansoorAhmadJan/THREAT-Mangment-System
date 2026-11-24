const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { createSessionStore } = require("../sessionStore");

const sessionId = "df242790-507b-4bfc-9d96-af93efced3bd";
const userId = 42;
const expiresAt = 1_900_000_000;

function digest(identifier) {
  return createHash("sha256").update(identifier).digest();
}

function fixture(...results) {
  const calls = [];
  const executor = {
    async execute(sql, params) {
      assert.strictEqual(this, executor);
      calls.push({ sql, params });
      assert.ok(results.length > 0, "Unexpected database call");
      return [results.shift()];
    },
    beginTransaction() { assert.fail("The caller owns the transaction"); },
    commit() { assert.fail("The caller owns the transaction"); },
    rollback() { assert.fail("The caller owns the transaction"); },
    release() { assert.fail("The caller owns the connection"); },
  };
  return { store: createSessionStore(executor), calls };
}

test("creates a session through the supplied executor and stores only its SHA-256 digest", async () => {
  const { store, calls } = fixture({ affectedRows: 1 }, { affectedRows: 1 }, { affectedRows: 0 });
  const first = await store.createSession({ userId, expiresAt });
  const second = await store.createSession({ userId, expiresAt });
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
  assert.equal(await store.createSession({ userId, expiresAt }), null);

  for (const [call, identifier] of [[calls[0], first], [calls[1], second]]) {
    assert.match(call.sql, /INSERT INTO user_sessions \(session_hash, user_id, expires_at\)/);
    assert.match(call.sql, /user_id = \? AND disabled_at IS NULL AND \? > UNIX_TIMESTAMP\(\)/);
    assert.deepEqual(call.params, [digest(identifier), expiresAt, userId, expiresAt]);
    assert.equal(call.params[0].length, 32);
    assert.ok(!call.sql.includes(identifier) && !call.params.includes(identifier));
  }
});

test("active lookup binds the user and digest, checks expiry and account state, and returns the current role", async () => {
  const active = { userId, role: "Viewer", expiresAt };
  const { store, calls } = fixture([active], []);
  assert.deepEqual(await store.findActiveSession({ userId, sessionId }), active);
  assert.equal(await store.findActiveSession({ userId: userId + 1, sessionId }), null);
  assert.match(calls[0].sql, /JOIN users AS u ON u.user_id = s.user_id/);
  assert.match(calls[0].sql, /s.session_hash = \? AND s.user_id = \? AND u.disabled_at IS NULL/);
  assert.match(calls[0].sql, /s.expires_at > UNIX_TIMESTAMP\(\)/);
  assert.deepEqual(calls.map(call => call.params), [[digest(sessionId), userId], [digest(sessionId), userId + 1]]);
});

test("account lookup distinguishes enabled, disabled, and missing accounts", async () => {
  const enabled = { userId, role: "Analyst", disabledAt: null };
  const disabled = { userId: userId + 1, role: "Analyst", disabledAt: "2026-11-22 08:00:00.000000" };
  const { store, calls } = fixture([enabled], [disabled], []);
  assert.deepEqual(await store.findAccountStatus(userId), enabled);
  assert.deepEqual(await store.findAccountStatus(userId + 1), disabled);
  assert.equal(await store.findAccountStatus(userId + 2), null);
  assert.match(calls[0].sql, /disabled_at AS disabledAt\s+FROM users WHERE user_id = \?/);
  assert.deepEqual(calls.map(call => call.params), [[userId], [userId + 1], [userId + 2]]);
});

test("revokes one session for its owner or all sessions for an account", async () => {
  const { store, calls } = fixture({ affectedRows: 1 }, { affectedRows: 0 }, { affectedRows: 3 });
  assert.equal(await store.revokeSession({ userId, sessionId }), true);
  assert.equal(await store.revokeSession({ userId, sessionId }), false);
  assert.equal(await store.revokeUserSessions(userId), 3);
  assert.deepEqual(calls[0], {
    sql: "DELETE FROM user_sessions WHERE session_hash = ? AND user_id = ?",
    params: [digest(sessionId), userId],
  });
  assert.deepEqual(calls[2], { sql: "DELETE FROM user_sessions WHERE user_id = ?", params: [userId] });
});

test("lists expired session metadata and cleans expired rows in bounded batches", async () => {
  const rows = [{ userId, expiresAt }];
  const { store, calls } = fixture(rows, { affectedRows: 1 }, { affectedRows: 0 });
  assert.deepEqual(await store.listExpiredSessions(), rows);
  assert.equal(await store.deleteExpiredSessions(25), 1);
  assert.equal(await store.deleteExpiredSessions(), 0);
  assert.match(calls[0].sql, /^SELECT user_id AS userId, expires_at AS expiresAt FROM user_sessions/);
  assert.match(calls[1].sql, /^DELETE FROM user_sessions/);
  for (const { sql } of calls) {
    assert.match(sql, /WHERE expires_at <= UNIX_TIMESTAMP\(\)\s+ORDER BY expires_at, session_hash LIMIT \?/);
  }
  assert.deepEqual(calls.map(call => call.params), [["100"], ["25"], ["100"]]);
});

test("binds the smallest and largest allowed batch limits as decimal strings", async () => {
  const { store, calls } = fixture([], { affectedRows: 0 }, [], { affectedRows: 0 });
  for (const limit of [1, 1000]) {
    await store.listExpiredSessions(limit);
    await store.deleteExpiredSessions(limit);
  }
  assert.deepEqual(calls.map(call => call.params), [["1"], ["1"], ["1000"], ["1000"]]);
});

test("rejects invalid arguments before reaching MySQL", async () => {
  const { store, calls } = fixture();
  assert.throws(() => createSessionStore(), TypeError);
  for (const id of [0, -1, 1.5, "42", 2_147_483_648]) {
    await assert.rejects(store.findAccountStatus(id), TypeError);
  }
  for (const id of [undefined, null, {}, "bad-id", sessionId + "\n"]) {
    await assert.rejects(store.findActiveSession({ userId, sessionId: id }), TypeError);
  }
  await assert.rejects(store.createSession({ userId, expiresAt: "1900000000" }), TypeError);
  await assert.rejects(store.createSession({ userId, expiresAt: 0 }), TypeError);
  for (const limit of [0, -1, 1.5, 1001, NaN, Infinity, "10", null]) {
    await assert.rejects(store.listExpiredSessions(limit), RangeError);
    await assert.rejects(store.deleteExpiredSessions(limit), RangeError);
  }
  assert.equal(calls.length, 0);
});

test("database failures reject every operation instead of fabricating a result", async () => {
  const failure = new Error("Fixture database unavailable");
  const store = createSessionStore({ execute: async () => { throw failure; } });
  for (const operation of [
    () => store.createSession({ userId, expiresAt }),
    () => store.findActiveSession({ userId, sessionId }),
    () => store.findAccountStatus(userId),
    () => store.revokeSession({ userId, sessionId }),
    () => store.revokeUserSessions(userId),
    () => store.listExpiredSessions(),
    () => store.deleteExpiredSessions(),
  ]) {
    await assert.rejects(operation, error => error === failure);
  }
});
