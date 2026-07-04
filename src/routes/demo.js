const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { deleteDemo, insertDemoRows } = require('../db/seed');
const router = express.Router();

// Demo-only tools (admin). "Delete demo data" removes only seed-generated rows
// (keeping anything a trial user created); "Reload demo data" restores the demo
// set without touching customer rows. Remove this module for production.
const adminOnly = requireRole('admin');

router.get('/', requireLogin, adminOnly, (req, res) => {
  res.render('demo/tools', { title: 'Demo Data' });
});

router.post('/delete-demo', requireLogin, adminOnly, (req, res) => {
  deleteDemo();
  logAction(req, 'demo_delete', 'system', null, 'Deleted demo data (kept trial data)');
  res.redirect('/demo-tools?ok=Demo+data+deleted+-+your+trial+data+is+kept');
});

router.post('/reload-demo', requireLogin, adminOnly, (req, res) => {
  deleteDemo();
  insertDemoRows();
  logAction(req, 'demo_reload', 'system', null, 'Reloaded demo data (kept trial data)');
  res.redirect('/demo-tools?ok=Demo+data+reloaded');
});

module.exports = router;
