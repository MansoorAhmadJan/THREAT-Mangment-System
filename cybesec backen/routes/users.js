const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../config/db");
const { body, param, validationResult } = require("express-validator");
const requireRole = require("../middleware/requireRole");

// GET all users — Admin only: this is an account roster (emails, roles), not operational data
router.get("/", requireRole("Admin"), (req, res) => {
  db.query(
    "SELECT user_id, username, email, role, created_at FROM Users",
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// POST add new user — Admin only: creating accounts is privilege management
router.post("/",
  requireRole("Admin"),
  body("username").trim().notEmpty().withMessage("username is required"),
  body("email").optional({ checkFalsy: true }).isEmail().withMessage("email must be valid"),
  body("role").optional().isIn(["Admin", "Analyst", "Viewer"]).withMessage("Invalid role"),
  body("password").notEmpty().withMessage("Password is required")
    .isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, email, role, password } = req.body;

    try {
      const hashed = await bcrypt.hash(password, 10);
      db.query(
        "INSERT INTO Users (username, email, role, password) VALUES (?,?,?,?)",
        [username, email, role || "Viewer", hashed],
        (err, result) => {
          if (err) return res.status(500).json({ error: err.message });

          db.query(
            "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
            ["INSERT", "Users", result.insertId, `User created: ${username} (${role || "Viewer"})`, req.user.user_id],
            (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
          );

          res.json({ message: "User added", id: result.insertId });
        }
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PUT update user — Admin only: this route can change a user's role (privilege escalation surface)
router.put("/:id",
  requireRole("Admin"),
  param("id").isInt().withMessage("Invalid user id"),
  body("username").optional().trim().notEmpty().withMessage("username cannot be empty"),
  body("email").optional({ checkFalsy: true }).isEmail().withMessage("email must be valid"),
  body("role").optional().isIn(["Admin", "Analyst", "Viewer"]).withMessage("Invalid role"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, email, role } = req.body;
    db.query(
      "UPDATE Users SET username=?, email=?, role=? WHERE user_id=?",
      [username, email, role, req.params.id],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query(
          "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
          ["UPDATE", "Users", req.params.id, `User details updated: ${username}`, req.user.user_id],
          (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
        );

        res.json({ message: "User updated" });
      }
    );
  }
);

// PUT change password — Admin can reset anyone's password; a user can reset their own
router.put("/:id/password",
  (req, res, next) => {
    if (req.user.role === "Admin" || String(req.user.user_id) === String(req.params.id)) {
      return next();
    }
    return res.status(403).json({ error: "Forbidden — you can only change your own password" });
  },
  param("id").isInt().withMessage("Invalid user id"),
  body("password").notEmpty().withMessage("Password is required")
    .isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { password } = req.body;

    try {
      const hashed = await bcrypt.hash(password, 10);
      db.query(
        "UPDATE Users SET password=? WHERE user_id=?",
        [hashed, req.params.id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });

          db.query(
            "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
            ["UPDATE", "Users", req.params.id, "Password changed", req.user.user_id],
            (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
          );

          res.json({ message: "Password changed" });
        }
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE user — Admin only
router.delete("/:id",
  requireRole("Admin"),
  param("id").isInt().withMessage("Invalid user id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query(
      "DELETE FROM Users WHERE user_id=?",
      [req.params.id],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query(
          "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
          ["DELETE", "Users", req.params.id, "User deleted", req.user.user_id],
          (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
        );

        res.json({ message: "User deleted" });
      }
    );
  }
);

module.exports = router;