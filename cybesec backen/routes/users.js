const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../config/db");
const { body, param, validationResult } = require("express-validator");

// GET all users
router.get("/", (req, res) => {
  db.query(
    "SELECT user_id, username, email, role, created_at FROM Users",
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// POST add new user
router.post("/",
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
        [username, email, role || "viewer", hashed],
        (err, result) => {
          if (err) return res.status(500).json({ error: err.message });

          db.query(
            "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
            ["INSERT", "Users", result.insertId, `User created: ${username} (${role || "viewer"})`, req.user.user_id],
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

// PUT update user
router.put("/:id",
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

// PUT change password
router.put("/:id/password",
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

// DELETE user
router.delete("/:id",
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