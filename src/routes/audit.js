const express = require('express');
const { all } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireLogin, requireRole('admin','auditor'), (req, res) => {
  const where = []; const params = [];
  if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const logs = all(`SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT 200`, params);
  const actions = all('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  res.render('audit/index', { title: 'Audit Log', logs, actions });
});
module.exports = router;
