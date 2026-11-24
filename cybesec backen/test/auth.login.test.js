const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { after, test } = require("node:test");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

assert.ok(!Object.hasOwn(process.env, "JWT_SECRET"), "Run login tests without an application JWT secret");
const jwtSecret = randomBytes(32).toString("hex");
process.env.JWT_SECRET = jwtSecret;
after(() => { delete process.env.JWT_SECRET; });

const db = { async execute() { assert.fail("Expected a mocked database lookup"); } };
const dbPath = require.resolve("../config/db");
assert.ok(!require.cache[dbPath], "Run login tests in an isolated test process");
require.cache[dbPath] = { exports: { promise: () => db } };
const router = require("../routes/auth");
delete require.cache[dbPath];
const loginRoute = router.stack.find(({ route }) => route?.path === "/login" && route.methods.post);
const login = loginRoute.route.stack[0].handle;

const credentials = { username: "test-analyst", password: randomBytes(24).toString("hex") };
const user = { user_id: 7, username: credentials.username, role: "Analyst", password: randomBytes(32).toString("hex") };
const invalidCredentials = "Wrong username or password";
const malformedCredentials = "Enter username and password";
const internalError = "Unable to complete login";

async function requestLogin(body) {
  const responses = [];
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      responses.push({ status: this.statusCode, payload });
      return this;
    },
  };
  await login({ body }, res);
  assert.equal(responses.length, 1, "Login must send exactly one response");
  return responses[0];
}

function assertError(response, status, message) {
  assert.equal(response.status, status);
  assert.ok(response.payload?.error === message && Object.keys(response.payload).length === 1,
    "Login must send only the expected generic error");
}

function mockUser(t, rows = [user]) {
  return t.mock.method(db, "execute", async () => [rows, []]);
}

function assertPrivateFailure(response, detail) {
  assertError(response, 500, internalError);
  const serialized = JSON.stringify(response.payload);
  assert.ok(![detail, credentials.password, user.password, jwtSecret].some(value => serialized.includes(value)),
    "Login failure must omit internal details and credentials");
}

test("returns the existing login response with an eight-hour JWT", async (t) => {
  const lookup = mockUser(t);
  const compare = t.mock.method(bcrypt, "compare", async (password, hash) => {
    assert.ok(password === credentials.password && hash === user.password, "Compare the supplied password with the stored hash");
    return true;
  });

  const { status, payload } = await requestLogin(credentials);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(payload).sort(), ["role", "success", "token", "username"]);
  assert.equal(payload.success, true);
  assert.equal(payload.username, user.username);
  assert.equal(payload.role, user.role);
  assert.equal(typeof payload.token, "string");
  const claims = jwt.verify(payload.token, jwtSecret);
  assert.equal(claims.user_id, user.user_id);
  assert.equal(claims.role, user.role);
  assert.equal(claims.exp - claims.iat, 8 * 60 * 60);
  assert.equal(lookup.mock.callCount(), 1);
  assert.deepEqual(lookup.mock.calls[0].arguments[1], [credentials.username]);
  assert.equal(compare.mock.callCount(), 1);
});

for (const field of ["username", "password"]) {
  test(`rejects non-string ${field} values before database lookup`, async (t) => {
    const lookup = mockUser(t, []);
    for (const value of [null, 42, true, {}, []]) {
      const response = await requestLogin({ ...credentials, [field]: value });
      assertError(response, 400, malformedCredentials);
    }
    assert.equal(lookup.mock.callCount(), 0);
  });
}

test("rejects missing or empty credentials before database lookup", async (t) => {
  const lookup = mockUser(t, []);
  for (const body of [undefined, null, {}, { ...credentials, username: "" }, { ...credentials, password: "" }]) {
    assertError(await requestLogin(body), 400, malformedCredentials);
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test("returns the generic 401 for a nonexistent user", async (t) => {
  mockUser(t, []);
  const compare = t.mock.method(bcrypt, "compare", async () => false);
  assertError(await requestLogin(credentials), 401, invalidCredentials);
  assert.equal(compare.mock.callCount(), 0);
});

test("returns the same generic 401 for an incorrect password", async (t) => {
  mockUser(t);
  t.mock.method(bcrypt, "compare", async () => false);
  const sign = t.mock.method(jwt, "sign", () => assert.fail("Unexpected JWT signing"));
  assertError(await requestLogin(credentials), 401, invalidCredentials);
  assert.equal(sign.mock.callCount(), 0);
});

test("contains a rejected database lookup and hides its details", async (t) => {
  const detail = randomBytes(24).toString("hex");
  t.mock.method(db, "execute", async () => { throw new Error(detail); });
  assertPrivateFailure(await requestLogin(credentials), detail);
});

test("contains a rejected password comparison and hides its details", async (t) => {
  const detail = randomBytes(24).toString("hex");
  mockUser(t);
  t.mock.method(bcrypt, "compare", async () => { throw new Error(detail); });
  assertPrivateFailure(await requestLogin(credentials), detail);
});

test("contains a synchronous password comparison error", async (t) => {
  const detail = randomBytes(24).toString("hex");
  mockUser(t);
  t.mock.method(bcrypt, "compare", () => { throw new Error(detail); });
  assertPrivateFailure(await requestLogin(credentials), detail);
});

test("contains a JWT signing error and hides its details", async (t) => {
  const detail = randomBytes(24).toString("hex");
  mockUser(t);
  t.mock.method(bcrypt, "compare", async () => true);
  t.mock.method(jwt, "sign", () => { throw new Error(detail); });
  assertPrivateFailure(await requestLogin(credentials), detail);
});
