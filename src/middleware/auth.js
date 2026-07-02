function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
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
