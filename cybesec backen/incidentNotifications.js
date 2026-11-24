const jwt = require("jsonwebtoken");

const incidentReaders = "incident-readers";
// The incident list is readable by all three CTMS roles. Write permissions are separate.
const incidentReaderRoles = new Set(["Admin", "Analyst", "Viewer"]);

function configureIncidentNotifications(io, jwtSecret) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || !token || !jwtSecret) {
      return next(new Error("Unauthorized"));
    }

    let user;
    try {
      user = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    } catch {
      return next(new Error("Unauthorized"));
    }
    if (!Number.isSafeInteger(user?.user_id) || user.user_id <= 0 || !Number.isSafeInteger(user.exp)) {
      return next(new Error("Unauthorized"));
    }
    if (!incidentReaderRoles.has(user.role)) return next(new Error("Forbidden"));

    socket.data.expiresAt = user.exp * 1000;
    next();
  });

  io.on("connection", socket => {
    const remainingMs = socket.data.expiresAt - Date.now();
    if (remainingMs <= 0) return socket.disconnect(true);

    socket.join(incidentReaders);
    // The connection must not outlive the token that authorized it.
    const expiration = setTimeout(() => socket.disconnect(true), Math.min(remainingMs, 2 ** 31 - 1));
    socket.once("disconnect", () => clearTimeout(expiration));
  });
}

function notifyIncidentReaders(io, event, payload) {
  if (!io) return;
  const namespace = io.of("/");
  const members = namespace.adapter.rooms.get(incidentReaders);
  if (!members) return;

  // Check the deadline at dispatch because the disconnect timer can run late.
  for (const id of members) {
    const socket = namespace.sockets.get(id);
    if (socket?.connected && socket.data.expiresAt > Date.now()) {
      socket.emit(event, payload);
    }
  }
}

module.exports = { configureIncidentNotifications, notifyIncidentReaders };
