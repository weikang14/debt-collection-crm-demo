// Configurable permissions. Each role has a set of permissions (role_permissions,
// editable by admin; the defaults below are the rules the app shipped with),
// and a user may have personal grants or revocations on top (user_permissions).
// admin always has everything, and user management, company settings, the
// permission screen and demo tools stay admin-only — so no one can lock the
// admins out. Which cases a user sees (all, or only an agent's own) follows
// the role, not these permissions.
const { get, all, run } = require('../db');

const ROLES = ['admin', 'manager', 'agent', 'finance', 'auditor'];
const PERMISSIONS = [
  ['debtors.view', 'Debtors', 'View debtors', ['admin', 'manager', 'agent', 'finance', 'auditor']],
  ['debtors.sensitive', 'Debtors', 'See salary and guarantor details', ['admin', 'manager', 'agent', 'finance', 'auditor']],
  ['debtors.create', 'Debtors', 'Create debtors', ['admin', 'manager']],
  ['debtors.edit', 'Debtors', 'Edit debtors', ['admin', 'manager', 'agent']],
  ['cases.edit', 'Cases', 'Create and edit cases', ['admin', 'manager']],
  ['cases.status', 'Cases', 'Change case status (In progress statuses)', ['admin', 'manager', 'agent']],
  ['cases.status_any', 'Cases', 'Set or lift Fully Paid, Legal, Closed, Cancelled, Bankruptcy, Deceased', ['admin', 'manager']],
  ['cases.restructure', 'Cases', 'Restructure and undo restructures', ['admin', 'manager']],
  ['payments.record', 'Payments', 'Record payments', ['admin', 'manager', 'finance', 'agent']],
  ['payments.correct', 'Payments', 'Edit and void payments', ['admin', 'manager', 'finance']],
  ['ptps.manage', 'Promises', 'New PTP / plan, fulfil, break, cancel plan', ['admin', 'manager', 'agent']],
  ['calls.log', 'Activity', 'Log calls', ['admin', 'manager', 'agent']],
  ['notes.write', 'Activity', 'Add, edit and delete own notes', ['admin', 'manager', 'agent']],
  ['notes.any', 'Activity', 'Edit and delete other people’s notes', ['admin', 'manager']],
  ['tasks.manage', 'Activity', 'Create, edit and complete tasks', ['admin', 'manager', 'agent']],
  ['agents.view', 'Team', 'View agents', ['admin', 'manager', 'auditor']],
  ['agents.edit', 'Team', 'Create and edit agents', ['admin', 'manager']],
  ['reports.performance', 'Reports', 'See agent performance (and its CSV)', ['admin', 'manager', 'finance', 'auditor']],
  ['commissions.view', 'Commissions', 'View commissions', ['admin', 'manager', 'finance', 'auditor', 'agent']],
  ['commissions.settle', 'Commissions', 'Settle and void commission payouts', ['admin', 'manager', 'finance']],
  ['audit.view', 'Audit', 'View the audit and access logs', ['admin', 'auditor']],
].map(([key, group, label, defaults]) => ({ key, group, label, defaults }));
const KEYS = PERMISSIONS.map(p => p.key);

// Fill role_permissions with the defaults the first time (or after a reset).
function seedRoleDefaults(force = false) {
  if (!force && get('SELECT 1 x FROM role_permissions LIMIT 1')) return;
  run('DELETE FROM role_permissions');
  for (const p of PERMISSIONS) for (const r of p.defaults) if (r !== 'admin') run('INSERT INTO role_permissions (role, permission) VALUES (?,?)', [r, p.key]);
}
const rolePerms = role => (role === 'admin' ? new Set(KEYS)
  : new Set(all('SELECT permission FROM role_permissions WHERE role = ?', [role]).map(r => r.permission).filter(k => KEYS.includes(k))));
// A user's own grants (1) and revocations (0) on top of the role.
const overridesOf = userId => (userId == null ? [] : all('SELECT permission, granted FROM user_permissions WHERE user_id = ?', [userId]));
function permsFor(user) {
  if (!user) return new Set();
  if (user.role === 'admin') return new Set(KEYS);
  const s = rolePerms(user.role);
  for (const o of overridesOf(user.id)) (o.granted ? s.add(o.permission) : s.delete(o.permission));
  return s;
}
// In a handler: the request's permissions (attachUser computes them once).
const can = (req, perm) => (req.perms || permsFor(req.session && req.session.user)).has(perm);
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!can(req, perm)) return res.status(403).render('error', { message: 'Forbidden' });
    next();
  };
}
// Store what a user's ticked permissions differ from their role by.
function saveUserPerms(userId, role, ticked) {
  run('DELETE FROM user_permissions WHERE user_id = ?', [userId]);
  if (role === 'admin') return;
  const base = rolePerms(role), want = new Set(ticked.filter(k => KEYS.includes(k)));
  for (const k of KEYS) if (base.has(k) !== want.has(k)) run('INSERT INTO user_permissions (user_id, permission, granted) VALUES (?,?,?)', [userId, k, want.has(k) ? 1 : 0]);
}
// The permission lists of every role, for the forms' "role → defaults" prefill.
const roleMatrix = () => Object.fromEntries(ROLES.map(r => [r, [...rolePerms(r)]]));

module.exports = { ROLES, PERMISSIONS, KEYS, seedRoleDefaults, rolePerms, permsFor, can, requirePerm, saveUserPerms, roleMatrix, overridesOf };
