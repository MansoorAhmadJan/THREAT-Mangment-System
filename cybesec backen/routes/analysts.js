const express = require("express");
const router  = express.Router();
const db      = require("../config/db");
const { body, param, validationResult } = require("express-validator");
const requireRole = require("../middleware/requireRole");

// GET all
router.get("/", (req, res) => {
  db.query("SELECT * FROM Analysts ORDER BY analyst_id DESC", (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(r);
  });
});

// GET one
router.get("/:id",
  param("id").isInt().withMessage("Invalid analyst id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("SELECT * FROM Analysts WHERE analyst_id=?", [req.params.id], (e, r) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json(r[0] || null);
    });
  }
);

// POST — create
router.post("/",
  requireRole("Admin", "Analyst"),
  body("name").trim().notEmpty().withMessage("name is required"),
  body("specialization").optional().trim(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, specialization } = req.body;
    db.query("INSERT INTO Analysts (name, specialization) VALUES (?,?)",
      [name, specialization], (e, r) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["INSERT", "Analysts", r.insertId, `Analyst added: ${name} (${specialization || "General"})`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ analyst_id: r.insertId, name, specialization });
    });
  }
);

// PUT — update
router.put("/:id",
  requireRole("Admin", "Analyst"),
  param("id").isInt().withMessage("Invalid analyst id"),
  body("name").optional().trim().notEmpty().withMessage("name cannot be empty"),
  body("specialization").optional().trim(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, specialization } = req.body;
    db.query("UPDATE Analysts SET name=?, specialization=? WHERE analyst_id=?",
      [name, specialization, req.params.id], (e) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["UPDATE", "Analysts", req.params.id, `Analyst updated: ${name}`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ success: true });
    });
  }
);

// DELETE
router.delete("/:id",
  requireRole("Admin"),
  param("id").isInt().withMessage("Invalid analyst id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("DELETE FROM Analysts WHERE analyst_id=?", [req.params.id], (e) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["DELETE", "Analysts", req.params.id, "Analyst deleted", req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ success: true });
    });
  }
);

module.exports = router;