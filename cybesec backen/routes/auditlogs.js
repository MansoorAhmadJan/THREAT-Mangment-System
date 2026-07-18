const express = require("express");
const router  = express.Router();
const db      = require("../config/db");

router.get("/", (req, res) => {
  const sql = `
    SELECT al.*, u.username AS performed_by_username
    FROM AuditLogs al
    LEFT JOIN Users u ON al.performed_by = u.user_id
    ORDER BY al.log_time DESC`;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

module.exports = router;