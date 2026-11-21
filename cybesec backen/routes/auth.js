const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db").promise();

router.post("/login", async (req, res) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return res.status(400).json({ error: "Enter username and password" });
  }

  try {
    const [[user]] = await db.execute(
      "SELECT user_id, username, password, role FROM Users WHERE username = ?",
      [username]
    );

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Wrong username or password" });
    }

    const token = jwt.sign(
      { user_id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({
      success: true,
      token,
      username: user.username,
      role: user.role
    });
  } catch {
    return res.status(500).json({ error: "Unable to complete login" });
  }
});

module.exports = router;
