const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { reachableDebtorIds } = require('../utils/scope');
const router = express.Router();

const canView = requireRole('admin','manager','agent','finance','auditor');
const canEdit = requireRole('admin','manager','agent');

router.get('/', requireLogin, canView, (req, res) => {
  const ids = reachableDebtorIds(req.session.user); // null = unrestricted
  let debtors;
  if (ids === null) debtors = all('SELECT * FROM debtors ORDER BY name');
  else if (ids.length === 0) debtors = [];
  else debtors = all(`SELECT * FROM debtors WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY name`, ids);
  res.render('debtors/list', { title: 'Debtors', debtors });
});
router.get('/new', requireLogin, canEdit, (req, res) => res.render('debtors/form', { title: 'New Debtor', debtor: {}, action: '/debtors' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const r = run(`INSERT INTO debtors (name,ic_passport,company,phone,email,address,employer,salary,risk_level,guarantor_name,guarantor_phone,remark)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.name,b.ic_passport,b.company,b.phone,b.email,b.address,b.employer,Number(b.salary)||null,b.risk_level||'medium',b.guarantor_name,b.guarantor_phone,b.remark]);
  logAction(req,'create','debtor',r.lastInsertRowid,`Created debtor ${b.name}`);
  res.redirect('/debtors?ok=Debtor+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const debtor = get('SELECT * FROM debtors WHERE id=?', [req.params.id]);
  if (!debtor) return res.status(404).render('error', { message: 'Debtor not found' });
  const ids = reachableDebtorIds(req.session.user);
  if (ids !== null && !ids.includes(debtor.id)) return res.status(403).render('error', { message: 'Forbidden' });
  const cases = all('SELECT * FROM cases WHERE debtor_id=? ORDER BY opened_at DESC', [req.params.id]);
  res.render('debtors/show', { title: debtor.name, debtor, cases });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const debtor = get('SELECT * FROM debtors WHERE id=?', [req.params.id]);
  if (!debtor) return res.status(404).render('error', { message: 'Debtor not found' });
  res.render('debtors/form', { title: 'Edit Debtor', debtor, action: `/debtors/${debtor.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  run(`UPDATE debtors SET name=?,ic_passport=?,company=?,phone=?,email=?,address=?,employer=?,salary=?,risk_level=?,guarantor_name=?,guarantor_phone=?,remark=? WHERE id=?`,
    [b.name,b.ic_passport,b.company,b.phone,b.email,b.address,b.employer,Number(b.salary)||null,b.risk_level||'medium',b.guarantor_name,b.guarantor_phone,b.remark,req.params.id]);
  logAction(req,'update','debtor',Number(req.params.id),`Updated debtor ${b.name}`);
  res.redirect(`/debtors/${req.params.id}?ok=Saved`);
});
module.exports = router;
