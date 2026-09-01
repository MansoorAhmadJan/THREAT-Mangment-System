/**
 * requireRole(...allowedRoles)
 *
 * Route-level authorization. Must run AFTER authMiddleware, since it reads
 * req.user (set from the verified JWT payload: { user_id, role }).
 *
 * Usage:
 *   router.post("/", requireRole("Admin", "Analyst"), (req, res) => { ... });
 */
module.exports = function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: "No authenticated user on request" });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden — your role does not permit this action" });
    }
    next();
  };
};
