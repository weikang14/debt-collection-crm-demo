const { get } = require('../db');

// The session holds a login-time snapshot; re-read the account on every request
// so a deactivation or role change takes effect at once, not at next login.
function attachUser(req, res, next) {
  const s = req.session && req.session.user;
  if (s) {
    const u = get('SELECT id, username, full_name, role, agent_id, client_id, active FROM users WHERE id = ?', [s.id]);
    req.session.user = u && u.active
      ? { id: u.id, username: u.username, full_name: u.full_name, role: u.role, agent_id: u.agent_id, client_id: u.client_id }
      : null;
  }
  res.locals.currentUser = (req.session && req.session.user) || null;
  next();
}
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (!roles.includes(u.role)) return res.status(403).render('error', { message: 'Forbidden' });
    next();
  };
}
module.exports = { attachUser, requireLogin, requireRole };
