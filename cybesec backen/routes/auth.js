const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Enter username and password" });
  }

  db.query(
    "SELECT * FROM Users WHERE username = ?",
    [username],
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (rows.length === 0)
        return res.status(401).json({ error: "Wrong username or password" });

      const user = rows[0];
      const match = await bcrypt.compare(password, user.password);

      if (!match)
        return res.status(401).json({ error: "Wrong username or password" });

      const token = jwt.sign(
        { user_id: user.user_id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
      );

      res.json({
        success: true,
        token,
        username: user.username,
        role: user.role
      });
    }
  );
});

module.exports = router;