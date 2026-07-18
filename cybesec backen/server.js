require('dotenv').config();

const express = require("express");
const cors    = require("cors");
const http    = require("http");
const app     = express();
const server  = http.createServer(app);

app.use(cors({
  origin: ['http://localhost:5500', 'http://127.0.0.1:5500'],
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json());

/* ── SOCKET.IO ── */
try {
  const { Server } = require("socket.io");
  const io = new Server(server, { cors: { origin: "*" } });
  io.on("connection", socket => {
    console.log("Client connected:", socket.id);
    socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
  });
  app.set("io", io);
  console.log("Socket.IO ready");
} catch(e) {
  console.warn("Socket.IO not available");
  app.set("io", null);
}

/* ── NODEMAILER ── */
try {
  const nodemailer = require("nodemailer");
  const mailer = nodemailer.createTransport({
    host:   "smtp.gmail.com",
    port:   465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  app.set("mailer", mailer);
  console.log("Nodemailer ready");
} catch(e) {
  console.warn("Nodemailer not available");
  app.set("mailer", null);
}

/* ── RATE LIMITING ── */
try {
  const rateLimit = require("express-rate-limit");
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: "Too many requests — please try again later" }
  });
  app.use("/api/", limiter);
  console.log("Rate limiting active");
} catch(e) {
  console.warn("Rate limiting not available");
}

/* ── AUTH MIDDLEWARE ── */
const authMiddleware = require("./middleware/auth");

/* ── ROUTES ── */
app.use("/api/auth",            require("./routes/auth")); // NOT protected — login must stay public
app.use("/api/threats",         authMiddleware, require("./routes/threats"));
app.use("/api/incidents",       authMiddleware, require("./routes/incidents"));
app.use("/api/vulnerabilities", authMiddleware, require("./routes/vulnerabilities"));
app.use("/api/patches",         authMiddleware, require("./routes/patches"));
app.use("/api/analysts",        authMiddleware, require("./routes/analysts"));
app.use("/api/systems",         authMiddleware, require("./routes/systems"));
app.use("/api/auditlogs",       authMiddleware, require("./routes/auditlogs"));
app.use("/api/dashboard",       authMiddleware, require("./routes/dashboard"));
app.use("/api/users",           authMiddleware, require("./routes/users"));

/* ── START ── */
server.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});