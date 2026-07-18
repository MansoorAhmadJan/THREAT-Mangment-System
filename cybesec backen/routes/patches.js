const express = require("express");
const router  = express.Router();
const db      = require("../config/db");
const { body, param, validationResult } = require("express-validator");

router.get("/", (req, res) => {
  db.query(
    `SELECT p.*, s.system_name, a.name AS analyst_name 
     FROM Patches p
     LEFT JOIN Systems  s ON p.system_id  = s.system_id
     LEFT JOIN Analysts a ON p.applied_by = a.analyst_id
     ORDER BY applied_date DESC`,
    (e, r) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json(r);
    }
  );
});

router.post("/",
  body("system_id").isInt().withMessage("system_id must be a number"),
  body("patch_name").trim().notEmpty().withMessage("patch_name is required"),
  body("applied_date").isISO8601().withMessage("applied_date must be a valid date"),
  body("applied_by").isInt().withMessage("applied_by must be a number"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { system_id, patch_name, applied_date, applied_by } = req.body;

    db.getConnection((connErr, conn) => {
      if (connErr) return res.status(500).json({ error: connErr.message });

      conn.beginTransaction((err) => {
        if (err) { conn.release(); return res.status(500).json({ error: err.message }); }

        conn.query(
          "INSERT INTO Patches(system_id, patch_name, applied_date, applied_by) VALUES(?,?,?,?)",
          [system_id, patch_name, applied_date, applied_by],
          (err, result) => {
            if (err) return conn.rollback(() => { conn.release(); res.status(500).json({ error: err.message }); });

            conn.query(
              "UPDATE Systems SET last_patched = ? WHERE system_id = ?",
              [applied_date, system_id],
              (err) => {
                if (err) return conn.rollback(() => { conn.release(); res.status(500).json({ error: err.message }); });

                conn.commit((err) => {
                  if (err) return conn.rollback(() => { conn.release(); res.status(500).json({ error: err.message }); });

                  conn.release();

                  db.query(
                    "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
                    ["INSERT", "Patches", result.insertId, `Patch "${patch_name}" applied to system #${system_id}`, req.user.user_id],
                    (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
                  );

                  res.json({ message: "Patch recorded and system updated", id: result.insertId });
                });
              }
            );
          }
        );
      });
    });
  }
);

router.put("/:id",
  param("id").isInt().withMessage("Invalid patch id"),
  body("system_id").optional().isInt().withMessage("system_id must be a number"),
  body("patch_name").optional().trim().notEmpty().withMessage("patch_name cannot be empty"),
  body("applied_date").optional().isISO8601().withMessage("applied_date must be a valid date"),
  body("applied_by").optional().isInt().withMessage("applied_by must be a number"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { system_id, patch_name, applied_date, applied_by } = req.body;
    db.query(
      "UPDATE Patches SET system_id=?, patch_name=?, applied_date=?, applied_by=? WHERE patch_id=?",
      [system_id, patch_name, applied_date, applied_by, req.params.id],
      (e) => {
        if (e) return res.status(500).json({ error: e.message });

        db.query(
          "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
          ["UPDATE", "Patches", req.params.id, `Patch updated: ${patch_name}`, req.user.user_id],
          (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
        );

        res.json({ message: "Patch updated" });
      }
    );
  }
);

router.delete("/:id",
  param("id").isInt().withMessage("Invalid patch id"),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    db.query("DELETE FROM Patches WHERE patch_id=?", [req.params.id], (e) => {
      if (e) return res.status(500).json({ error: e.message });

      db.query(
        "INSERT INTO AuditLogs (action, table_name, record_id, description, performed_by) VALUES (?,?,?,?,?)",
        ["DELETE", "Patches", req.params.id, "Patch deleted", req.user.user_id],
        (auditErr) => { if (auditErr) console.error("Audit log failed:", auditErr.message); }
      );

      res.json({ message: "Deleted" });
    });
  }
);

module.exports = router;