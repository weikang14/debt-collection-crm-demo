const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { parseActive, MAX_NAME, MIN_PASSWORD, HASH_COST } = require('../utils/forms');
const router = express.Router();

// Shared by create and edit: the linked agent/client must exist and names stay sane.
function linkError(role, agent_id, client_id, full_name) {
  if (full_name.length > MAX_NAME || full_name.length === 0) return `Full name must be 1–${MAX_NAME} characters`;
  if (role === 'agent' && !agent_id) return 'Agent accounts must be linked to an agent';
  if (role === 'client' && !client_id) return 'Client accounts must be linked to a client';
  if (agent_id && !get('SELECT 1 FROM agents WHERE id=?', [agent_id])) return 'Agent not found';
  if (client_id && !get('SELECT 1 FROM clients WHERE id=?', [client_id])) return 'Client not found';
  return null;
}
const passwordError = p => (p.length < MIN_PASSWORD ? `Password must be at least ${MIN_PASSWORD} characters` : null);

// User management is an admin-only capability (no public self-registration:
// this is an internal system, so accounts are provisioned by an admin).
const ROLES = ['admin', 'manager', 'agent', 'finance', 'auditor'];
const adminOnly = requireRole('admin');

// Prevent an admin from locking themselves out when editing their own account.
function userEditGuard(sessionUser, targetId, newRole, newActive) {
  if (sessionUser.id !== Number(targetId)) return null;
  if (newRole !== 'admin') return 'You cannot change your own admin role';
  if (Number(newActive) === 0) return 'You cannot deactivate your own account';
  return null;
}

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
  const err = passwordError(password) || linkError(role, agent_id, client_id, full_name);
  if (err) return res.redirect(`/users/new?err=${encodeURIComponent(err)}`);
  try {
    const r = run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id,active) VALUES (?,?,?,?,?,?,1)',
      [username, bcrypt.hashSync(password, HASH_COST), full_name, role, agent_id, client_id]);
    logAction(req, 'create', 'user', r.lastInsertRowid, `Created user ${username} (${role})`);
    res.redirect('/users?ok=User+' + encodeURIComponent(username) + '+created');
  } catch (e) {
    // UNIQUE constraint on username (or any insert failure)
    res.redirect('/users/new?err=Could+not+create+user+(username+may+already+exist)');
  }
});

// reset password — admin sets a new password for any account (incl. their own)
router.get('/:id/password', requireLogin, adminOnly, (req, res) => {
  const u = get('SELECT id, username, full_name FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.redirect('/users?err=User+not+found');
  res.render('users/password', { title: 'Reset Password', u });
});
router.post('/:id/password', requireLogin, adminOnly, (req, res) => {
  const u = get('SELECT id, username FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.redirect('/users?err=User+not+found');
  const password = req.body.password || '';
  const pwErr = passwordError(password);
  if (pwErr) return res.redirect('/users/' + u.id + '/password?err=' + encodeURIComponent(pwErr));
  run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(password, HASH_COST), u.id]);
  logAction(req, 'update', 'user', u.id, `Reset password for ${u.username}`);
  res.redirect('/users?ok=Password+updated+for+' + encodeURIComponent(u.username));
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

router.get('/:id/edit', requireLogin, adminOnly, (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.redirect('/users?err=User+not+found');
  res.render('users/edit', {
    title: 'Edit User', u, roles: ROLES,
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    clients: all('SELECT id,company_name FROM clients ORDER BY company_name'),
  });
});

router.post('/:id', requireLogin, adminOnly, (req, res) => {
  const u = get('SELECT id FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.redirect('/users?err=User+not+found');
  const b = req.body;
  const username = (b.username || '').trim();
  const full_name = (b.full_name || '').trim();
  const role = ROLES.includes(b.role) ? b.role : null;
  const active = parseActive(b.active);
  if (!username || !full_name || !role) {
    return res.redirect(`/users/${u.id}/edit?err=Username,+full+name+and+role+are+required`);
  }
  const guard = userEditGuard(req.session.user, u.id, role, active);
  if (guard) return res.redirect(`/users/${u.id}/edit?err=${encodeURIComponent(guard)}`);
  const agent_id = role === 'agent' ? (Number(b.agent_id) || null) : null;
  const client_id = role === 'client' ? (Number(b.client_id) || null) : null;
  const linkErr = linkError(role, agent_id, client_id, full_name);
  if (linkErr) return res.redirect(`/users/${u.id}/edit?err=${encodeURIComponent(linkErr)}`);
  try {
    run('UPDATE users SET username=?,full_name=?,role=?,agent_id=?,client_id=?,active=? WHERE id=?',
      [username, full_name, role, agent_id, client_id, active, u.id]);
    logAction(req, 'update', 'user', u.id, `Updated user ${username} (${role})`);
    res.redirect('/users?ok=User+updated');
  } catch (e) {
    res.redirect(`/users/${u.id}/edit?err=Could+not+save+(username+may+already+exist)`);
  }
});

module.exports = router;
module.exports.userEditGuard = userEditGuard;
