const express = require("express");
const router  = express.Router();
const db      = require("../config/db");
const { body, param, validationResult } = require("express-validator");

router.get("/", (req, res) => {
  const sql = `
    SELECT i.*, t.threat_name, t.severity_level,
    s.system_name, a.name AS analyst_name
    FROM Incidents i
    LEFT JOIN Threats t ON i.threat_id = t.threat_id
    LEFT JOIN Systems s ON i.system_id = s.system_id
    LEFT JOIN Analysts a ON i.analyst_id = a.analyst_id
    ORDER BY i.incident_date DESC`;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.post("/",
  body("threat_id").isInt().withMessage("threat_id must be a number"),
  body("system_id").isInt().withMessage("system_id must be a number"),
  body("analyst_id").isInt().withMessage("analyst_id must be a number"),
  body("status").optional().isIn(["Open", "In Progress", "Resolved"]).withMessage("Invalid status"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { threat_id, system_id, analyst_id, status } = req.body;
    db.query("INSERT INTO Incidents (threat_id,system_id,analyst_id,status) VALUES (?,?,?,?)",
      [threat_id, system_id, analyst_id, status || "Open"], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      const newId = result.insertId;

      /* Audit log — written here, not by a trigger, so we know who did it */
      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["INSERT", "Incidents", newId, `Incident logged, status: ${status || "Open"}`, req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      /* Fetch the full incident to get severity + names for notifications */
      const sql2 = `SELECT i.*, t.threat_name, t.severity_level, s.system_name
        FROM Incidents i
        LEFT JOIN Threats t ON i.threat_id=t.threat_id
        LEFT JOIN Systems s ON i.system_id=s.system_id
        WHERE i.incident_id=?`;
      db.query(sql2, [newId], (e2, rows) => {
        if (!e2 && rows.length) {
          const inc = rows[0];

          /* #14 — emit real-time notification via Socket.IO */
          const io = req.app.get("io");
          if (io) {
            io.emit("new_incident", {
              id:       inc.incident_id,
              threat:   inc.threat_name,
              system:   inc.system_name,
              severity: inc.severity_level,
              status:   inc.status
            });
          }

          /* #21 — send email alert for every incident */
          const mailer = req.app.get("mailer");
          if (mailer) {
            mailer.sendMail({
              from:    process.env.SMTP_USER,
              to:      process.env.ALERT_EMAIL,
              subject: `🔴 CRITICAL INCIDENT #${newId}: ${inc.threat_name}`,
              html: `
                <h2 style="color:#ff3e6c">⚠ CRITICAL SECURITY INCIDENT</h2>
                <table>
                  <tr><td><b>Incident ID</b></td><td>#${newId}</td></tr>
                  <tr><td><b>Threat</b></td><td>${inc.threat_name}</td></tr>
                  <tr><td><b>System</b></td><td>${inc.system_name}</td></tr>
                  <tr><td><b>Severity</b></td><td style="color:#ff3e6c">CRITICAL</td></tr>
                  <tr><td><b>Status</b></td><td>${inc.status}</td></tr>
                  <tr><td><b>Time</b></td><td>${new Date().toLocaleString()}</td></tr>
                </table>
                <p>Login to <a href="http://localhost:3000">CyberSec SOC</a> to respond.</p>
              `
            }).catch(err => console.error("Email alert failed:", err.message));
          }
        }
      });

      res.json({ message: "Incident logged", id: newId });
    });
  }
);

router.put("/:id",
  param("id").isInt().withMessage("Invalid incident id"),
  body("status").optional().isIn(["Open", "In Progress", "Resolved"]).withMessage("Invalid status"),
  body("threat_id").optional().isInt().withMessage("threat_id must be a number"),
  body("system_id").optional().isInt().withMessage("system_id must be a number"),
  body("analyst_id").optional().isInt().withMessage("analyst_id must be a number"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { threat_id, system_id, analyst_id, status } = req.body;
    if (status && !threat_id && !system_id && !analyst_id) {
      db.query("UPDATE Incidents SET status=? WHERE incident_id=?",
        [status, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query(
          "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
          ["UPDATE", "Incidents", req.params.id, `Status changed to ${status}`, req.user.user_id],
          (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
        );

        const io = req.app.get("io");
        if (io) io.emit("incident_updated", { id: req.params.id, status });
        res.json({ message: "Status updated" });
      });
    } else {
      db.query("UPDATE Incidents SET threat_id=?, system_id=?, analyst_id=?, status=? WHERE incident_id=?",
        [threat_id, system_id, analyst_id, status, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query(
          "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
          ["UPDATE", "Incidents", req.params.id, "Incident details updated", req.user.user_id],
          (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
        );

        res.json({ message: "Incident updated" });
      });
    }
  }
);

router.delete("/:id",
  param("id").isInt().withMessage("Invalid incident id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("DELETE FROM Incidents WHERE incident_id=?", [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["DELETE", "Incidents", req.params.id, "Incident deleted", req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Deleted" });
    });
  }
);

module.exports = router;