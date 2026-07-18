const express = require("express");
const router = express.Router();
const db = require("../config/db").promise();

router.get("/", async (req, res) => {
  try {
    const [[open], [resolved], [critical], [vulns], [patches], [recent]] = await Promise.all([
      db.query("SELECT COUNT(*) AS n FROM Incidents WHERE status='Open'"),
      db.query("SELECT COUNT(*) AS n FROM Incidents WHERE status='Resolved'"),
      db.query("SELECT COUNT(*) AS n FROM Threats WHERE severity_level='Critical'"),
      db.query("SELECT COUNT(*) AS n FROM Vulnerabilities"),
      db.query("SELECT COUNT(*) AS n FROM Patches"),
      db.query(`SELECT i.incident_id, t.threat_name, s.system_name,
                 i.status, i.incident_date
                 FROM Incidents i
                 LEFT JOIN Threats t ON i.threat_id=t.threat_id
                 LEFT JOIN Systems s ON i.system_id=s.system_id
                 ORDER BY i.incident_date DESC LIMIT 5`)
    ]);

    res.json({
      open_incidents:   open[0].n,
      resolved:         resolved[0].n,
      critical_threats: critical[0].n,
      total_vulns:      vulns[0].n,
      total_patches:    patches[0].n,
      recent
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;