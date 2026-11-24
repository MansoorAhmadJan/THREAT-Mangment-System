const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const http = require("node:http");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { configureIncidentNotifications, notifyIncidentReaders } = require("../incidentNotifications");

// Use the same client bundle served to the browser, with Node's WebSocket.
const connect = require(join(dirname(require.resolve("socket.io")), "../client-dist/socket.io.js"));
const testSecret = randomBytes(32);

function tokenFor(role, options = { expiresIn: "5m" }, userId = 1) {
  return jwt.sign({ user_id: userId, role }, testSecret, options);
}

async function startFixture(t, secret = testSecret) {
  const server = http.createServer();
  const io = new Server(server);
  const clients = [];
  configureIncidentNotifications(io, secret);
  t.after(async () => {
    clients.forEach(socket => socket.disconnect());
    await io.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port;
  return {
    io,
    client(auth) {
      const socket = connect(url, {
        auth, autoConnect: false, forceNew: true, reconnection: false, timeout: 2000,
        transports: ["websocket"],
      });
      clients.push(socket);
      return socket;
    },
  };
}

function connectResult(socket) {
  return new Promise(resolve => {
    socket.once("connect", () => resolve(null));
    socket.once("connect_error", error => resolve(error.message));
    socket.connect();
  });
}

test("incident sockets reject missing, malformed, expired, and unauthorized credentials", { timeout: 5000 }, async t => {
  const { io, client } = await startFixture(t);
  const rejected = [
    [undefined, "Unauthorized"],
    [{ token: ["fixture"] }, "Unauthorized"],
    [{ token: "invalid-fixture-token" }, "Unauthorized"],
    [{ token: jwt.sign({ user_id: 1, role: "Admin" }, randomBytes(32), { expiresIn: "5m" }) }, "Unauthorized"],
    [{ token: tokenFor("Admin", { expiresIn: -1 }) }, "Unauthorized"],
    [{ token: tokenFor("Admin", {}) }, "Unauthorized"],
    [{ token: tokenFor("Admin", { expiresIn: "5m", algorithm: "HS384" }) }, "Unauthorized"],
    [{ token: tokenFor("Admin", { expiresIn: "5m" }, "1") }, "Unauthorized"],
    [{ token: tokenFor("Admin", { expiresIn: "5m" }, 0) }, "Unauthorized"],
    [{ token: tokenFor("Other") }, "Forbidden"],
    [{ token: tokenFor(undefined) }, "Forbidden"],
  ];
  await Promise.all(rejected.map(async ([auth, message]) => {
    const socket = client(auth);
    assert.equal(await connectResult(socket), message);
    assert.equal(socket.connected, false);
  }));
  assert.equal(io.of("/").sockets.size, 0);
});

test("incident sockets fail closed without a configured signing key", { timeout: 5000 }, async t => {
  const { io, client } = await startFixture(t, "");
  assert.equal(await connectResult(client({ token: tokenFor("Admin") })), "Unauthorized");
  assert.equal(io.of("/").sockets.size, 0);
});

test("both synthetic notifications reach all CTMS reader roles and stay in the readers room", { timeout: 5000 }, async t => {
  const { io, client } = await startFixture(t);
  const readers = ["Admin", "Analyst", "Viewer"].map(role => client({ token: tokenFor(role) }));
  const nonMember = client({ token: tokenFor("Admin") });
  assert.deepEqual(await Promise.all([...readers, nonMember].map(connectResult)), [null, null, null, null]);
  const serverSocket = io.of("/").sockets.get(nonMember.id);
  await serverSocket.leave("incident-readers");

  const created = { id: 1, threat: "Fixture threat", system: "Fixture system", severity: "Low", status: "Open" };
  const updated = { id: 1, status: "Resolved" };
  const received = readers.map(socket => Promise.all([
    new Promise(resolve => socket.once("new_incident", resolve)),
    new Promise(resolve => socket.once("incident_updated", resolve)),
  ]));
  const otherEvents = [];
  nonMember.onAny(event => otherEvents.push(event));
  const flushed = new Promise(resolve => nonMember.once("fixture_barrier", resolve));
  notifyIncidentReaders(io, "new_incident", created);
  notifyIncidentReaders(io, "incident_updated", updated);
  serverSocket.emit("fixture_barrier");
  await flushed;
  assert.deepEqual(otherEvents, ["fixture_barrier"]);
  assert.deepEqual(await Promise.all(received), readers.map(() => [created, updated]));
});

test("dispatch skips an expired reader before its disconnect timer runs", { timeout: 5000 }, async t => {
  const { io, client } = await startFixture(t);
  const expired = client({ token: tokenFor("Viewer", { expiresIn: "1m" }) });
  const current = client({ token: tokenFor("Analyst") });
  assert.deepEqual(await Promise.all([expired, current].map(connectResult)), [null, null]);

  const namespace = io.of("/");
  const expiredSocket = namespace.sockets.get(expired.id);
  const dispatchTime = expiredSocket.data.expiresAt + 1;
  assert.ok(dispatchTime < namespace.sockets.get(current.id).data.expiresAt);
  const expiredEvents = [];
  expired.onAny(event => expiredEvents.push(event));
  const flushed = new Promise(resolve => expired.once("fixture_barrier", resolve));
  const received = new Promise(resolve => current.once("incident_updated", resolve));
  const update = { id: 1, status: "Resolved" };

  // Move only the wall clock. The real disconnect timer has not had time to fire.
  const clock = t.mock.method(Date, "now", () => dispatchTime);
  try {
    assert.equal(expiredSocket.connected, true);
    assert.equal(expiredSocket.rooms.has("incident-readers"), true);
    notifyIncidentReaders(io, "incident_updated", update);
  } finally {
    clock.mock.restore();
  }
  expiredSocket.emit("fixture_barrier");

  await flushed;
  assert.deepEqual(expiredEvents, ["fixture_barrier"]);
  assert.deepEqual(await received, update);
  assert.equal(expiredSocket.connected, true);
});

test("an already-connected reader is disconnected when its JWT expires", { timeout: 8000 }, async t => {
  const { io, client } = await startFixture(t);
  const socket = client({ token: tokenFor("Viewer", { expiresIn: 3 }) });
  const disconnected = new Promise(resolve => socket.once("disconnect", resolve));
  assert.equal(await connectResult(socket), null);
  assert.equal(await disconnected, "io server disconnect");
  assert.equal(io.of("/").sockets.size, 0);
});

test("frontend supplies the current JWT through Socket.IO auth and preserves incident refresh", () => {
  const source = readFileSync(join(__dirname, "../../frontend/js/app.js"), "utf8");
  const start = source.indexOf("(function initSocket()");
  const end = source.indexOf("/* ── USER ROLES", start);
  assert.ok(start >= 0 && end > start);
  let session = '{"token":"first-fixture-token"}';
  let connection;
  let refreshes = 0;
  const handlers = new Map();
  const toasts = [];
  runInNewContext(source.slice(start, end), {
    document: { createElement: () => ({}), head: { appendChild: script => script.onload() } },
    localStorage: { getItem: () => session },
    io: (url, options) => {
      connection = { url, options };
      return { on: (name, handler) => handlers.set(name, handler) };
    },
    showToast: (...args) => toasts.push(args),
    load: () => { refreshes++; },
  });
  assert.equal(connection.url, "http://localhost:3000");
  assert.equal(Object.hasOwn(connection.options, "query"), false);
  const handshakeToken = () => {
    let token;
    connection.options.auth(auth => { token = auth.token; });
    return token;
  };
  assert.equal(handshakeToken(), "first-fixture-token");
  session = '{"token":"next-fixture-token"}';
  assert.equal(handshakeToken(), "next-fixture-token");
  session = "{";
  assert.equal(handshakeToken(), undefined);
  handlers.get("new_incident")({ threat: "Fixture threat", system: "Fixture system", severity: "Low" });
  handlers.get("incident_updated")({});
  assert.deepEqual(toasts, [["🟡 New incident: Fixture threat on Fixture system", "warning"]]);
  assert.equal(refreshes, 2);
});
