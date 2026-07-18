const express = require("express");
const router  = express.Router();
const db      = require("../config/db");
const { body, param, validationResult } = require("express-validator");

// GET all
router.get("/", (req, res) => {
  db.query("SELECT * FROM Systems ORDER BY system_id DESC", (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(r);
  });
});

// GET one
router.get("/:id",
  param("id").isInt().withMessage("Invalid system id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("SELECT * FROM Systems WHERE system_id=?", [req.params.id], (e, r) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json(r[0] || null);
    });
  }
);

// POST — create
router.post("/",
  body("system_name").trim().notEmpty().withMessage("system_name is required"),
  body("os_type").optional().trim(),
  body("ip_address").optional({ checkFalsy: true }).isIP().withMessage("ip_address must be a valid IP"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { system_name, os_type, ip_address } = req.body;
    db.query("INSERT INTO Systems (system_name, os_type, ip_address) VALUES (?,?,?)",
      [system_name, os_type, ip_address], (e, r) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["INSERT", "Systems", r.insertId, `System added: ${system_name} (${ip_address || "no IP"})`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ system_id: r.insertId, system_name, os_type, ip_address });
    });
  }
);

// PUT — update
router.put("/:id",
  param("id").isInt().withMessage("Invalid system id"),
  body("system_name").optional().trim().notEmpty().withMessage("system_name cannot be empty"),
  body("ip_address").optional({ checkFalsy: true }).isIP().withMessage("ip_address must be a valid IP"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { system_name, os_type, ip_address } = req.body;
    db.query("UPDATE Systems SET system_name=?, os_type=?, ip_address=? WHERE system_id=?",
      [system_name, os_type, ip_address, req.params.id], (e) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["UPDATE", "Systems", req.params.id, `System updated: ${system_name}`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ success: true });
    });
  }
);

// DELETE
router.delete("/:id",
  param("id").isInt().withMessage("Invalid system id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("DELETE FROM Systems WHERE system_id=?", [req.params.id], (e) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["DELETE", "Systems", req.params.id, "System deleted", req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ success: true });
    });
  }
);

module.exports = router;