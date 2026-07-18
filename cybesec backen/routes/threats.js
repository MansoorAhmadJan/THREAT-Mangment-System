const express = require("express");
const router  = express.Router();
const db      = require("../config/db");
const { body, param, validationResult } = require("express-validator");

router.get("/", (req, res) => {
  db.query("SELECT * FROM Threats ORDER BY severity_level DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.post("/",
  body("threat_name").trim().notEmpty().withMessage("threat_name is required"),
  body("threat_type").trim().notEmpty().withMessage("threat_type is required"),
  body("severity_level").isIn(["Low", "Medium", "High", "Critical"]).withMessage("Invalid severity_level"),
  body("description").optional().trim(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { threat_name, threat_type, severity_level, description } = req.body;
    db.query("INSERT INTO Threats (threat_name,threat_type,severity_level,description) VALUES (?,?,?,?)",
      [threat_name, threat_type, severity_level, description], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["INSERT", "Threats", result.insertId, `New threat: ${threat_name} (${severity_level})`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Threat added", id: result.insertId });
    });
  }
);

router.put("/:id",
  param("id").isInt().withMessage("Invalid threat id"),
  body("threat_name").optional().trim().notEmpty().withMessage("threat_name cannot be empty"),
  body("threat_type").optional().trim().notEmpty().withMessage("threat_type cannot be empty"),
  body("severity_level").optional().isIn(["Low", "Medium", "High", "Critical"]).withMessage("Invalid severity_level"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { threat_name, threat_type, severity_level, description } = req.body;
    db.query("UPDATE Threats SET threat_name=?, threat_type=?, severity_level=?, description=? WHERE threat_id=?",
      [threat_name, threat_type, severity_level, description, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["UPDATE", "Threats", req.params.id, `Threat updated: ${threat_name}`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Threat updated" });
    });
  }
);

router.delete("/:id",
  param("id").isInt().withMessage("Invalid threat id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("DELETE FROM Threats WHERE threat_id=?", [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["DELETE", "Threats", req.params.id, "Threat deleted", req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Threat deleted" });
    });
  }
);

module.exports = router;