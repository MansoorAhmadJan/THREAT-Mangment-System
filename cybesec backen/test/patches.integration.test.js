const assert = require("node:assert/strict");
const { test } = require("node:test");

// Replace the database module before loading the real Express router.
const db = {
  promise() { assert.fail("A mock connection is required"); },
  query() { assert.fail("Patch creation must use its transaction connection"); },
};
require.cache[require.resolve("../config/db")] = { exports: db };
const router = require("../routes/patches");

const patch = {
  system_id: 4,
  patch_name: "Security patch",
  applied_date: "2026-11-20",
  applied_by: 12,
};
const user = { user_id: 81, role: "Admin" };
const patchId = 37;

function mockTransaction(t, { failAt, failRollback, commit } = {}) {
  const calls = [];

  function record(operation, ...args) {
    calls.push([operation, ...args]);
    if (operation === failAt || (operation === "rollback" && failRollback)) {
      throw new Error(`${operation} failed`);
    }
  }

  const conn = {
    async beginTransaction() { record("begin"); },
    async query(sql, params) {
      const [, table] = /^(?:INSERT INTO|UPDATE) (\w+)/.exec(sql);
      record(table, params);
      return table === "Patches" ? [{ insertId: patchId }] : [{ affectedRows: 1 }];
    },
    async commit() {
      record("commit");
      await commit?.();
    },
    async rollback() { record("rollback"); },
    release() { record("release"); },
    destroy() { record("destroy"); },
  };
  t.mock.method(db, "promise", () => ({
    async getConnection() {
      record("getConnection");
      return conn;
    },
  }));

  return calls;
}

function postPatch(body = patch) {
  return new Promise((resolve, reject) => {
    const req = { method: "POST", url: "/", body: { ...body }, user };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    router.handle(req, res, (err) => reject(err || new Error("POST route did not respond")));
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("creates an audited patch in one transaction and waits for commit", { timeout: 3000 }, async (t) => {
  const commitStarted = deferred();
  const finishCommit = deferred();
  const calls = mockTransaction(t, {
    commit() {
      commitStarted.resolve();
      return finishCommit.promise;
    },
  });
  let responded = false;
  const response = postPatch({ ...patch, user_id: 99 }).then((result) => {
    responded = true;
    return result;
  });
  const expectedCalls = [
    ["getConnection"],
    ["begin"],
    ["Patches", [patch.system_id, patch.patch_name, patch.applied_date, patch.applied_by]],
    ["Systems", [patch.applied_date, patch.system_id]],
    ["AuditLogs", ["INSERT", "Patches", patchId, 'Patch "Security patch" applied to system #4', user.user_id]],
    ["commit"],
  ];

  await Promise.race([commitStarted.promise, response]);
  try {
    assert.equal(responded, false);
    assert.deepEqual(calls, expectedCalls);
  } finally {
    finishCommit.resolve();
  }

  assert.deepEqual(await response, {
    status: 200,
    payload: { message: "Patch recorded and system updated", id: patchId },
  });
  assert.deepEqual(calls, [...expectedCalls, ["release"]]);
});

const transactionSteps = ["getConnection", "begin", "Patches", "Systems", "AuditLogs", "commit"];

for (const operation of transactionSteps) {
  test(`returns an error when ${operation} fails`, { timeout: 3000 }, async (t) => {
    const calls = mockTransaction(t, { failAt: operation });

    assert.deepEqual(await postPatch(), {
      status: 500,
      payload: { error: `${operation} failed` },
    });

    const failedStep = transactionSteps.indexOf(operation);
    const expectedCalls = transactionSteps.slice(0, failedStep + 1);
    if (failedStep > 1) expectedCalls.push("rollback");
    if (failedStep > 0) expectedCalls.push("release");
    assert.deepEqual(calls.map(([name]) => name), expectedCalls);
  });
}

test("discards the connection if audit failure cannot be rolled back", { timeout: 3000 }, async (t) => {
  const calls = mockTransaction(t, { failAt: "AuditLogs", failRollback: true });

  assert.deepEqual(await postPatch(), {
    status: 500,
    payload: { error: "AuditLogs failed" },
  });
  assert.deepEqual(calls.map(([name]) => name), [
    "getConnection", "begin", "Patches", "Systems", "AuditLogs", "rollback", "destroy",
  ]);
});
