const express = require('express');
const { db } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { seedDemo } = require('../db/seed');
const router = express.Router();

// Demo-only tools for a trial: clear everything to start fresh, or reload the
// standard demo dataset. Demo data is generated from seed.js, so clearing never
// permanently loses it. Admin-only. (Remove this module for production.)
const adminOnly = requireRole('admin');

// business tables, FK-safe order (children first). Users are kept so the current
// session stays logged in and people can still sign in after a clear.
const BUSINESS_TABLES = ['audit_logs', 'call_logs', 'tasks', 'ptps', 'payments', 'timeline_events', 'cases', 'debtors', 'agents', 'clients'];

function clearData() {
  for (const t of BUSINESS_TABLES) {
    db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name='${t}'`);
  }
}

router.get('/', requireLogin, adminOnly, (req, res) => {
  res.render('demo/tools', { title: 'Demo Data' });
});

router.post('/clear', requireLogin, adminOnly, (req, res) => {
  clearData();
  logAction(req, 'demo_clear', 'system', null, 'Cleared all business data (demo trial)');
  res.redirect('/demo-tools?ok=All+data+cleared+-+start+fresh');
});

router.post('/reload', requireLogin, adminOnly, (req, res) => {
  seedDemo();
  logAction(req, 'demo_reload', 'system', null, 'Reloaded standard demo data');
  res.redirect('/demo-tools?ok=Demo+data+reloaded');
});

module.exports = router;
