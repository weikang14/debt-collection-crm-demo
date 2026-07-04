const express = require('express');
const bcrypt = require('bcryptjs');
const { get } = require('../db');
const { logAction } = require('../utils/audit');
const { VERSION } = require('../version');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { error: null, version: VERSION });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const u = get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.status(401).render('auth/login', { error: 'Invalid username or password', version: VERSION });
  }
  req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role, agent_id: u.agent_id, client_id: u.client_id };
  logAction(req, 'login', 'user', u.id, `User ${u.username} logged in`);
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  if (req.session.user) logAction(req, 'logout', 'user', req.session.user.id, `User ${req.session.user.username} logged out`);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
