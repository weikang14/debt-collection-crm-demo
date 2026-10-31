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

// K-09: per-account back-off on top of the per-IP lock, against guessing one
// account's password from many IPs. Never a lock-out: from the 5th miss in a
// row each next try waits 1, 2, 4 … s (at most 60 s); a success clears it.
// Applies to any name typed, so it says nothing about which accounts exist.
const accountFails = new Map(); // lower-case username -> { fails, next }
const accountKey = u => String(u || '').trim().toLowerCase();
function accountWait(username) {
  const a = accountFails.get(accountKey(username));
  return a && a.next > Date.now() ? Math.ceil((a.next - Date.now()) / 1000) : 0;
}
function accountFail(username) {
  const k = accountKey(username), a = accountFails.get(k) || { fails: 0, next: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) a.next = Date.now() + Math.min(60, 2 ** (a.fails - MAX_FAILS)) * 1000;
  // ponytail: bounded by dropping idle entries; a shared store if run multi-process.
  if (accountFails.size > 5000) for (const [key, v] of accountFails) if (v.next < Date.now() - 3600000) accountFails.delete(key);
  accountFails.set(k, a);
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
  const wait = accountWait(username);
  if (wait) return res.status(429).render('auth/login', { error: `Too many attempts for this account. Try again in ${wait} s.`, version: VERSION });
  const u = get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
  const ok = bcrypt.compareSync(password || '', u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) {
    recordFail(req.ip); accountFail(username);
    return res.status(401).render('auth/login', { error: 'Invalid username or password', version: VERSION });
  }
  attempts.delete(req.ip); accountFails.delete(accountKey(username));
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
