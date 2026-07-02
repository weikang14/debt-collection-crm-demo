const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const router = express.Router();

const canView = requireRole('admin', 'manager', 'finance', 'auditor');
const canEdit = requireRole('admin', 'manager');

router.get('/', requireLogin, canView, (req, res) => {
  const clients = all(`SELECT c.*, (SELECT COUNT(*) FROM cases WHERE client_id=c.id) AS case_count
                       FROM clients c ORDER BY c.company_name`);
  res.render('clients/list', { title: 'Clients', clients });
});
// ponytail: locals key is `clientData` not `client` — EJS treats a top-level `client` render
// local as its own reserved `opts.client` (client-side compile mode) and silently drops the
// `include()` helper, breaking layout.ejs. Views alias it back to `client` internally.
router.get('/new', requireLogin, canEdit, (req, res) => res.render('clients/form', { title: 'New Client', clientData: {}, action: '/clients' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const r = run(`INSERT INTO clients (company_name,pic_name,phone,email,agreement_no,commission_rate,remark)
                 VALUES (?,?,?,?,?,?,?)`, [b.company_name, b.pic_name, b.phone, b.email, b.agreement_no, Number(b.commission_rate)||15, b.remark]);
  logAction(req, 'create', 'client', r.lastInsertRowid, `Created client ${b.company_name}`);
  res.redirect('/clients?ok=Client+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const client = get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (!client) return res.status(404).render('error', { message: 'Client not found' });
  const cases = all('SELECT * FROM cases WHERE client_id=? ORDER BY opened_at DESC', [req.params.id]);
  res.render('clients/show', { title: client.company_name, clientData: client, cases });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const client = get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (!client) return res.status(404).render('error', { message: 'Client not found' });
  res.render('clients/form', { title: 'Edit Client', clientData: client, action: `/clients/${client.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  run(`UPDATE clients SET company_name=?,pic_name=?,phone=?,email=?,agreement_no=?,commission_rate=?,remark=? WHERE id=?`,
    [b.company_name, b.pic_name, b.phone, b.email, b.agreement_no, Number(b.commission_rate)||15, b.remark, req.params.id]);
  logAction(req, 'update', 'client', Number(req.params.id), `Updated client ${b.company_name}`);
  res.redirect(`/clients/${req.params.id}?ok=Saved`);
});
module.exports = router;
