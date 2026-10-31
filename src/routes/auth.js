const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db');
const { logAction } = require('../utils/audit');
const { VERSION } = require('../version');
const router = express.Router();

// A bcrypt hash of a random string, compared against when the username is
// unknown so a missing user costs the same time as a wrong password → no
// username enumeration via response timing. Real hashes use the same cost
// (users.js, seed.js); older, cheaper ones are upgraded at login below.
const { HASH_COST } = require('../utils/forms');
const DUMMY_HASH = bcrypt.hashSync('no-such-user', HASH_COST);

// Per-IP login throttle. In-memory: resets on restart, per-process — fine for a
// single-process node:sqlite app.
// ponytail: in-memory Map, swap for a shared store only if run multi-process.
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { fails, until }
function throttleState(ip) {
  const a = attempts.get(ip);
  if (a && a.until && a.until > Date.now()) return a;
  return null;
}
function recordFail(ip) {
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) { a.until = Date.now() + LOCK_MS; a.fails = 0; }
  attempts.set(ip, a);
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { error: null, version: VERSION });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (throttleState(req.ip)) {
    return res.status(429).render('auth/login', { error: 'Too many attempts. Try again later.', version: VERSION });
  }
  const u = get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
  const ok = bcrypt.compareSync(password || '', u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) {
    recordFail(req.ip);
    return res.status(401).render('auth/login', { error: 'Invalid username or password', version: VERSION });
  }
  attempts.delete(req.ip);
  if (bcrypt.getRounds(u.password_hash) < HASH_COST) {
    run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(password, HASH_COST), u.id]);
  }
  req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role, agent_id: u.agent_id, client_id: u.client_id };
  // No login without its audit row (G-25).
  try { logAction(req, 'login', 'user', u.id, `User ${u.username} logged in`); } catch (e) { delete req.session.user; throw e; }
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  if (req.session.user) logAction(req, 'logout', 'user', req.session.user.id, `User ${req.session.user.username} logged out`);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
