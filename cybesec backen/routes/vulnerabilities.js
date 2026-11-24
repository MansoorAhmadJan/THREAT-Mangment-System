const express = require("express");
const router  = express.Router();
const db      = require("../config/db");
const { body, param, validationResult } = require("express-validator");
const requireRole = require("../middleware/requireRole");

router.get("/", (req, res) => {
  db.query(`SELECT v.*, s.system_name FROM Vulnerabilities v
    LEFT JOIN Systems s ON v.system_id=s.system_id ORDER BY risk_level DESC`, (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(r);
  });
});

router.post("/",
  requireRole("Admin", "Analyst"),
  body("system_id").isInt().withMessage("system_id must be a number"),
  body("description").trim().notEmpty().withMessage("description is required"),
  body("risk_level").isIn(["Low", "Medium", "High", "Critical"]).withMessage("Invalid risk_level"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { system_id, description, risk_level } = req.body;
    db.query("INSERT INTO Vulnerabilities(system_id,description,risk_level) VALUES(?,?,?)",
      [system_id, description, risk_level], (e, r) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["INSERT", "Vulnerabilities", r.insertId, `Vulnerability added, risk: ${risk_level}`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Vulnerability added" });
    });
  }
);

router.put("/:id",
  requireRole("Admin", "Analyst"),
  param("id").isInt().withMessage("Invalid vulnerability id"),
  body("system_id").optional().isInt().withMessage("system_id must be a number"),
  body("description").optional().trim().notEmpty().withMessage("description cannot be empty"),
  body("risk_level").optional().isIn(["Low", "Medium", "High", "Critical"]).withMessage("Invalid risk_level"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { system_id, description, risk_level } = req.body;
    db.query("UPDATE Vulnerabilities SET system_id=?, description=?, risk_level=? WHERE vuln_id=?",
      [system_id, description, risk_level, req.params.id], (e) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["UPDATE", "Vulnerabilities", req.params.id, `Vulnerability updated, risk: ${risk_level}`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Vulnerability updated" });
    });
  }
);

router.delete("/:id",
  requireRole("Admin"),
  param("id").isInt().withMessage("Invalid vulnerability id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("DELETE FROM Vulnerabilities WHERE vuln_id=?", [req.params.id], (e) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["DELETE", "Vulnerabilities", req.params.id, "Vulnerability deleted", req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Deleted" });
    });
  }
);

module.exports = router;