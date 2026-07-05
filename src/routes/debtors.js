const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { reachableDebtorIds, caseWhere } = require('../utils/scope');
const { debtorFilter } = require('../utils/debtorFilter');
const router = express.Router();

const canView = requireRole('admin','manager','agent','finance','auditor');
const canEdit = requireRole('admin','manager','agent');

// Optional text -> trimmed string or null (never undefined, which SQLite rejects).
const S = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };

router.get('/', requireLogin, canView, (req, res) => {
  const ids = reachableDebtorIds(req.session.user); // null = unrestricted
  const f = debtorFilter(ids, req.query);
  const debtors = all(`SELECT * FROM debtors WHERE ${f.where} ORDER BY name`, f.params);
  res.render('debtors/list', { title: 'Debtors', debtors });
});
router.get('/new', requireLogin, canEdit, (req, res) => res.render('debtors/form', { title: 'New Debtor', debtor: {}, action: '/debtors' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const name = S(b.name);
  if (!name) return res.redirect('/debtors/new?err=Name+is+required');
  const r = run(`INSERT INTO debtors (name,ic_passport,company,phone,email,address,employer,salary,risk_level,guarantor_name,guarantor_phone,remark)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [name,S(b.ic_passport),S(b.company),S(b.phone),S(b.email),S(b.address),S(b.employer),Number(b.salary)||null,b.risk_level||'medium',S(b.guarantor_name),S(b.guarantor_phone),S(b.remark)]);
  logAction(req,'create','debtor',r.lastInsertRowid,`Created debtor ${name}`);
  res.redirect('/debtors?ok=Debtor+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const debtor = get('SELECT * FROM debtors WHERE id=?', [req.params.id]);
  if (!debtor) return res.status(404).render('error', { message: 'Debtor not found' });
  const ids = reachableDebtorIds(req.session.user);
  if (ids !== null && !ids.includes(debtor.id)) return res.status(403).render('error', { message: 'Forbidden' });
  const w = caseWhere(req.session.user);
  const cases = all(`SELECT * FROM cases WHERE debtor_id=? AND ${w.clause} ORDER BY opened_at DESC`, [req.params.id, ...w.params]);
  res.render('debtors/show', { title: debtor.name, debtor, cases });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const debtor = get('SELECT * FROM debtors WHERE id=?', [req.params.id]);
  if (!debtor) return res.status(404).render('error', { message: 'Debtor not found' });
  const ids = reachableDebtorIds(req.session.user);
  if (ids !== null && !ids.includes(debtor.id)) return res.status(403).render('error', { message: 'Forbidden' });
  res.render('debtors/form', { title: 'Edit Debtor', debtor, action: `/debtors/${debtor.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const ids = reachableDebtorIds(req.session.user);
  if (ids !== null && !ids.includes(Number(req.params.id))) return res.status(403).render('error', { message: 'Forbidden' });
  const b = req.body;
  const name = S(b.name);
  if (!name) return res.redirect(`/debtors/${req.params.id}/edit?err=Name+is+required`);
  run(`UPDATE debtors SET name=?,ic_passport=?,company=?,phone=?,email=?,address=?,employer=?,salary=?,risk_level=?,guarantor_name=?,guarantor_phone=?,remark=? WHERE id=?`,
    [name,S(b.ic_passport),S(b.company),S(b.phone),S(b.email),S(b.address),S(b.employer),Number(b.salary)||null,b.risk_level||'medium',S(b.guarantor_name),S(b.guarantor_phone),S(b.remark),req.params.id]);
  logAction(req,'update','debtor',Number(req.params.id),`Updated debtor ${name}`);
  res.redirect(`/debtors/${req.params.id}?ok=Saved`);
});
module.exports = router;
