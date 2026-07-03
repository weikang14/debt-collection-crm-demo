const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const router = express.Router();

// User management is an admin-only capability (no public self-registration:
// this is an internal system, so accounts are provisioned by an admin).
const ROLES = ['admin', 'manager', 'agent', 'finance', 'auditor', 'client'];
const adminOnly = requireRole('admin');

router.get('/', requireLogin, adminOnly, (req, res) => {
  const users = all(`SELECT u.*, a.name AS agent_name, c.company_name AS client_name
    FROM users u LEFT JOIN agents a ON a.id=u.agent_id LEFT JOIN clients c ON c.id=u.client_id
    ORDER BY u.active DESC, u.role, u.username`);
  res.render('users/index', { title: 'Users', users });
});

router.get('/new', requireLogin, adminOnly, (req, res) => {
  res.render('users/form', {
    title: 'New User', roles: ROLES,
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    clients: all('SELECT id,company_name FROM clients ORDER BY company_name'),
  });
});

router.post('/', requireLogin, adminOnly, (req, res) => {
  const b = req.body;
  const username = (b.username || '').trim();
  const full_name = (b.full_name || '').trim();
  const password = b.password || '';
  const role = ROLES.includes(b.role) ? b.role : null;
  if (!username || !full_name || !password || !role) {
    return res.redirect('/users/new?err=Username,+full+name,+password+and+role+are+required');
  }
  // agent / client accounts must be linked to a record so row-level scope works
  const agent_id = role === 'agent' ? (Number(b.agent_id) || null) : null;
  const client_id = role === 'client' ? (Number(b.client_id) || null) : null;
  if (role === 'agent' && !agent_id) return res.redirect('/users/new?err=Agent+accounts+must+be+linked+to+an+agent');
  if (role === 'client' && !client_id) return res.redirect('/users/new?err=Client+accounts+must+be+linked+to+a+client');
  try {
    const r = run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id,active) VALUES (?,?,?,?,?,?,1)',
      [username, bcrypt.hashSync(password, 8), full_name, role, agent_id, client_id]);
    logAction(req, 'create', 'user', r.lastInsertRowid, `Created user ${username} (${role})`);
    res.redirect('/users?ok=User+' + encodeURIComponent(username) + '+created');
  } catch (e) {
    // UNIQUE constraint on username (or any insert failure)
    res.redirect('/users/new?err=Could+not+create+user+(username+may+already+exist)');
  }
});

// activate / deactivate — disable staff instead of deleting (keeps audit trail intact)
router.post('/:id/toggle', requireLogin, adminOnly, (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.redirect('/users?err=User+not+found');
  if (u.id === req.session.user.id) return res.redirect('/users?err=You+cannot+deactivate+your+own+account');
  const na = u.active ? 0 : 1;
  run('UPDATE users SET active=? WHERE id=?', [na, u.id]);
  logAction(req, 'update', 'user', u.id, `${na ? 'Activated' : 'Deactivated'} user ${u.username}`);
  res.redirect('/users?ok=User+updated');
});

module.exports = router;
