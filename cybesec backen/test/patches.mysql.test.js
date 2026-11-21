const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");

const mysqlHost = "127.0.0.1";
const mysqlPort = 3307;
const serverUuid = "f54d7901-e572-11f1-bc8c-c018033e952e";
const databases = ["ctms_audit_it_upgrade", "ctms_audit_it_fresh"];
const auditForeignKey = /\bauditlogs_ibfk_1\b/i;

function verifiedPool(pool, database) {
  assert.ok(databases.includes(database), "MySQL schema is outside the integration test allowlist");
  return {
    async getConnection() {
      const connection = await pool.getConnection();
      try {
        const [[identity]] = await connection.query({ sql: `
          SELECT @@server_uuid AS server_uuid, @@port AS server_port,
                 DATABASE() AS selected_database, @@SESSION.foreign_key_checks AS foreign_key_checks,
                 @@SESSION.autocommit AS autocommit`, timeout: 5000 });
        assert.ok(identity && identity.server_uuid === serverUuid &&
          Number(identity.server_port) === mysqlPort && identity.selected_database === database,
        "MySQL identity check failed; connection discarded before use");
        assert.equal(Number(identity.foreign_key_checks), 1, "Foreign-key checks must be enabled");
        assert.equal(Number(identity.autocommit), 1, "Fixture connections require autocommit");
        return connection;
      } catch (err) {
        connection.destroy();
        throw err;
      }
    },
  };
}

function trackPatchRequest(database, fixtureName) {
  const trace = [];
  let accepting = true;
  let admitted = false;
  let responseEnded = false;
  let checkoutStarted = false;
  let connectionReturned = false;
  let transactionSettled = false;
  let abandoned = false;
  let activeConnection;
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });

  function checkCompletion() {
    if (responseEnded && (!checkoutStarted || connectionReturned)) {
      complete(!checkoutStarted || transactionSettled);
    }
  }

  function observe(connection) {
    return {
      async beginTransaction() {
        transactionSettled = false;
        await connection.beginTransaction();
        trace.push({ step: "begin" });
      },
      async query(sql, params) {
        const step = /^(INSERT INTO Patches|UPDATE Systems|INSERT INTO AuditLogs)\b/i.exec(sql)?.[1].toLowerCase();
        try {
          const result = await connection.query(sql, params);
          const [write] = result;
          const completed = { step, affectedRows: write.affectedRows };
          if (step === "insert into patches") completed.patchId = write.insertId;
          trace.push(completed);
          return result;
        } catch (err) {
          trace.push({ step, code: err.code, auditForeignKey: auditForeignKey.test(err.message) });
          throw err;
        }
      },
      async commit() {
        await connection.commit();
        transactionSettled = true;
        trace.push({ step: "commit" });
      },
      async rollback() {
        await connection.rollback();
        transactionSettled = true;
        trace.push({ step: "rollback" });
      },
      release() {
        connection.release();
        activeConnection = undefined;
        connectionReturned = true;
        checkCompletion();
      },
      destroy() {
        connection.destroy();
        activeConnection = undefined;
        connectionReturned = true;
        transactionSettled = false;
        checkCompletion();
      },
    };
  }

  return {
    trace,
    admit(req, res, next) {
      if (!accepting || admitted || req.get("X-CTMS-Test-Fixture") !== fixtureName) return res.sendStatus(403);
      admitted = true;
      // A disconnected client may never emit `finish`, but the route still attempts to end its response.
      const end = res.end;
      res.end = function (...args) {
        try {
          return end.apply(this, args);
        } finally {
          responseEnded = true;
          checkCompletion();
        }
      };
      next();
    },
    async getConnection() {
      assert.ok(accepting && admitted && !responseEnded && !checkoutStarted, "Unexpected route connection checkout");
      checkoutStarted = true;
      transactionSettled = true; // The route has not received a connection or started a transaction.
      try {
        const connection = await database.getConnection();
        if (abandoned) {
          connection.destroy();
          throw new Error("Request settlement deadline expired before checkout completed");
        }
        activeConnection = connection;
        return observe(connection);
      } catch (err) {
        connectionReturned = true;
        checkCompletion();
        throw err;
      }
    },
    async waitForSettlement() {
      accepting = false;
      if (!admitted) return;
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); });
      try {
        if (await Promise.race([completion, deadline])) return;
        abandoned = true;
        activeConnection?.destroy();
        throw new Error(`Request or transaction settlement unconfirmed; cleanup skipped for ${fixtureName}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function patchServer(request) {
  const configPath = require.resolve("../config/db");
  const routerPath = require.resolve("../routes/patches");
  assert.ok(!require.cache[configPath] && !require.cache[routerPath],
    "Load this suite in a separate Node test process");

  // The real router uses the verified test pool without loading dotenv or the application pool.
  require.cache[configPath] = { exports: { promise: () => request } };
  try {
    const app = express();
    app.use(request.admit);
    app.use(express.json());
    app.use("/api/patches", require("../middleware/auth"), require(routerPath));
    return createServer(app);
  } finally {
    delete require.cache[configPath];
    delete require.cache[routerPath];
  }
}

async function postPatch(server, secret, fixture) {
  const token = jwt.sign({ user_id: fixture.actorId, role: "Admin" }, secret, { expiresIn: "2m" });
  return fetch(`http://${mysqlHost}:${server.address().port}/api/patches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-CTMS-Test-Fixture": fixture.name,
    },
    body: JSON.stringify({
      system_id: fixture.systemId,
      patch_name: fixture.patchName,
      applied_date: fixture.appliedDate,
      applied_by: fixture.analystIds.at(-1),
    }),
    signal: AbortSignal.timeout(10000),
  });
}

async function seedFixture(connection, fixture) {
  const [actor] = await connection.execute(
    "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
    [fixture.name, randomBytes(32).toString("hex"), "Admin"]
  );
  fixture.actorId = actor.insertId;

  // Ensure confusing the two ID namespaces would make the attribution assertion fail.
  do {
    const [analyst] = await connection.execute("INSERT INTO analysts (name) VALUES (?)", [fixture.name]);
    fixture.analystIds.push(analyst.insertId);
  } while (fixture.analystIds.at(-1) === fixture.actorId);

  const [system] = await connection.execute(
    "INSERT INTO systems (system_name, last_patched) VALUES (?, ?)",
    [fixture.name, fixture.originalDate]
  );
  fixture.systemId = system.insertId;
}

function auditDescription(fixture) {
  return `Patch "${fixture.patchName}" applied to system #${fixture.systemId}`;
}

async function cleanupFixture(connection, fixture) {
  if (fixture.systemId !== undefined) {
    // Search by the fixture's unique description as well, in case a broken route leaves an orphan audit row.
    await connection.execute(`
      DELETE al FROM auditlogs al
      LEFT JOIN patches p ON p.patch_id = al.record_id AND p.system_id = ? AND p.patch_name = ?
      WHERE LOWER(al.table_name) = 'patches' AND (p.patch_id IS NOT NULL OR al.description = ?)`,
    [fixture.systemId, fixture.patchName, auditDescription(fixture)]);
    await connection.execute("DELETE FROM patches WHERE system_id = ? AND patch_name = ?",
      [fixture.systemId, fixture.patchName]);
    await connection.execute("DELETE FROM systems WHERE system_id = ? AND system_name = ?",
      [fixture.systemId, fixture.name]);
  }
  for (const analystId of fixture.analystIds) {
    await connection.execute("DELETE FROM analysts WHERE analyst_id = ? AND name = ?", [analystId, fixture.name]);
  }
  if (fixture.actorId !== undefined) {
    await connection.execute("DELETE FROM users WHERE user_id = ? AND username = ?", [fixture.actorId, fixture.name]);
  }
}

async function requireTriggerAbsence(connection) {
  // The metadata view can hide triggers from an account without the TRIGGER privilege.
  const [[metadata]] = await connection.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES
      WHERE TABLE_SCHEMA IN (DATABASE(), REPLACE(DATABASE(), '_', CONCAT(CHAR(92), '_')))
        AND PRIVILEGE_TYPE = 'TRIGGER'
        AND GRANTEE = CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', 1)), '@',
                             QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', -1)))
    ) AS can_inspect_triggers,
    EXISTS (
      SELECT 1 FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND LOWER(TRIGGER_NAME) = 'trg_patch_insert'
    ) AS legacy_trigger_present`);
  assert.equal(Number(metadata.can_inspect_triggers), 1,
    "Cannot verify trigger absence without a direct TRIGGER grant on the selected test schema");
  assert.equal(Number(metadata.legacy_trigger_present), 0, "Legacy trg_patch_insert must be absent before testing");
}

async function withFixture(database, runState, exercise) {
  assert.ok(!runState.settlementLost, "Remaining cases blocked after an unconfirmed transaction");
  const name = `ctms-it-${randomUUID()}`;
  const fixture = {
    name, patchName: `${name}-patch`, analystIds: [],
    originalDate: "2025-01-10", appliedDate: "2025-02-20",
  };
  const request = trackPatchRequest(database, name);
  const fixtureConnection = await database.getConnection();
  let server;
  try {
    await requireTriggerAbsence(fixtureConnection);
    await seedFixture(fixtureConnection, fixture);
    server = patchServer(request);
    server.listen(0, mysqlHost);
    await once(server, "listening");
    await exercise(server, fixture, fixtureConnection, request.trace);
  } finally {
    try {
      try {
        await request.waitForSettlement();
      } catch (err) {
        runState.settlementLost = true;
        throw err;
      }
      await cleanupFixture(fixtureConnection, fixture);
    } finally {
      fixtureConnection.release();
      if (server?.listening) {
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await closed;
      }
    }
  }
}

async function checkCommittedPatch(server, database, secret, fixture) {
  const verifier = await database.getConnection();
  try {
    const response = await postPatch(server, secret, fixture);
    assert.equal(response.status, 200);
    const { id } = await response.json();
    assert.ok(Number.isInteger(id), "Successful POST must return a patch ID");
    const [patches] = await verifier.execute(`
      SELECT patch_id, applied_by, DATE_FORMAT(applied_date, '%Y-%m-%d') AS applied_date
      FROM patches WHERE system_id = ? AND patch_name = ?`, [fixture.systemId, fixture.patchName]);
    assert.deepEqual(patches, [{ patch_id: id, applied_by: fixture.analystIds.at(-1), applied_date: fixture.appliedDate }]);
    await checkLastPatched(verifier, fixture, fixture.appliedDate);

    const [audit] = await verifier.execute(`
      SELECT action, performed_by FROM auditlogs
      WHERE record_id = ? AND LOWER(table_name) = 'patches'`, [id]);
    assert.deepEqual(audit, [{ action: "INSERT", performed_by: fixture.actorId }]);
  } finally {
    verifier.release();
  }
}

async function checkLastPatched(connection, fixture, expectedDate) {
  const [systems] = await connection.execute(`
    SELECT DATE_FORMAT(last_patched, '%Y-%m-%d') AS last_patched FROM systems WHERE system_id = ?`,
  [fixture.systemId]);
  assert.deepEqual(systems, [{ last_patched: expectedDate }]);
}

async function checkAuditRollback(server, database, secret, fixture, fixtureConnection, trace) {
  // A signed JWT can outlive its user row. The audit FK should reject that actor.
  const [result] = await fixtureConnection.execute("DELETE FROM users WHERE user_id = ? AND username = ?",
    [fixture.actorId, fixture.name]);
  assert.equal(result.affectedRows, 1);

  const verifier = await database.getConnection();
  try {
    const response = await postPatch(server, secret, fixture);
    assert.equal(response.status, 500);
    const { error } = await response.json();
    assert.ok(typeof error === "string" && auditForeignKey.test(error),
      "Expected auditlogs.performed_by foreign-key failure");
    const patchId = trace[1]?.patchId;
    assert.ok(Number.isInteger(patchId) && patchId > 0, "MySQL must return the inserted patch ID before the audit failure");
    assert.deepEqual(trace, [
      { step: "begin" },
      { step: "insert into patches", affectedRows: 1, patchId },
      { step: "update systems", affectedRows: 1 },
      { step: "insert into auditlogs", code: "ER_NO_REFERENCED_ROW_2", auditForeignKey: true },
      { step: "rollback" },
    ], "The explicit audit query must fail after both writes, and MySQL must acknowledge rollback");

    const [patches] = await verifier.execute(`
      SELECT patch_id FROM patches WHERE patch_id = ? OR (system_id = ? AND patch_name = ?)`,
    [patchId, fixture.systemId, fixture.patchName]);
    const [audit] = await verifier.execute(`
      SELECT log_id FROM auditlogs WHERE (record_id = ? AND LOWER(table_name) = 'patches') OR description = ?`,
    [patchId, auditDescription(fixture)]);
    assert.equal(patches.length, 0, "The failed request must roll back the patch row");
    assert.equal(audit.length, 0, "The failed request must leave no audit row");
    await checkLastPatched(verifier, fixture, fixture.originalDate);
  } finally {
    verifier.release();
  }
}

test("patch audit transactions on isolated MySQL", { skip: process.env.CTMS_MYSQL_IT !== "1" }, async (t) => {
  const user = process.env.CTMS_MYSQL_IT_USER;
  const password = process.env.CTMS_MYSQL_IT_PASSWORD;
  assert.ok(user === "ctms_test_import" && password, "Supply the isolated test username and password through CTMS_MYSQL_IT_* variables");
  assert.ok(!Object.hasOwn(process.env, "JWT_SECRET"), "Use a dedicated test process without the application JWT configuration");
  const secret = randomBytes(32).toString("hex");
  process.env.JWT_SECRET = secret;
  const runState = { settlementLost: false };

  try {
    for (const databaseName of databases) {
      await t.test(databaseName, async (schemaTest) => {
        assert.ok(!runState.settlementLost, "Remaining schemas blocked after an unconfirmed transaction");
        const pool = mysql.createPool({
          host: mysqlHost, port: mysqlPort, database: databaseName, user, password,
          connectionLimit: 3, waitForConnections: false, connectTimeout: 5000,
        });
        const database = verifiedPool(pool, databaseName);
        try {
          await schemaTest.test("commits one correctly attributed audit row", () =>
            withFixture(database, runState, (server, fixture) => checkCommittedPatch(server, database, secret, fixture)));
          await schemaTest.test("rolls back the patch and system update when the audit actor is missing", () =>
            withFixture(database, runState, (server, fixture, connection, trace) =>
              checkAuditRollback(server, database, secret, fixture, connection, trace)));
        } finally {
          await pool.end();
        }
      });
    }
  } finally {
    delete process.env.JWT_SECRET;
  }
});
