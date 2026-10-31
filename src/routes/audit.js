const express = require('express');
const { all } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { isISODate } = require('../utils/forms');
const { toCsv, sendCsv } = require('../utils/csv');
const { dateTimeFmt } = require('../utils/helpers');
const { logAction } = require('../utils/audit');
const router = express.Router();

router.get('/', requireLogin, requireRole('admin','auditor'), (req, res) => {
  // ?log=access shows who looked at personal data (F-31); the default is the audit log of changes.
  const access = req.query.log === 'access';
  const table = access ? 'access_logs' : 'audit_logs';
  const where = []; const params = [];
  if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
  if (req.query.entity) { where.push('entity_type = ?'); params.push(req.query.entity); }
  // Date filters are Malaysia dates; created_at is stored in UTC.
  if (isISODate(req.query.from)) { where.push("date(created_at,'+8 hours') >= ?"); params.push(req.query.from); }
  if (isISODate(req.query.to)) { where.push("date(created_at,'+8 hours') <= ?"); params.push(req.query.to); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  if (req.query.format === 'csv') {
    const rows = all(`SELECT * FROM ${table} ${clause} ORDER BY created_at DESC, id DESC`, params)
      .map(l => [dateTimeFmt(l.created_at), l.username || '', l.action, l.entity_type, l.entity_id ?? '', l.details || '', l.ip_address || '']);
    const file = access ? 'access-log.csv' : 'audit-log.csv';
    logAction(req, 'export', access ? 'access_log' : 'audit_log', null, `Exported ${file} (${rows.length} rows${clause ? ', filtered' : ''})`);
    return sendCsv(res, file, toCsv(['Time', 'User', 'Action', 'Entity', 'Entity ID', 'Details', 'IP'], rows));
  }
  const logs = all(`SELECT * FROM ${table} ${clause} ORDER BY created_at DESC, id DESC LIMIT 200`, params);
  const actions = all(`SELECT DISTINCT action FROM ${table} ORDER BY action`);
  const entities = all(`SELECT DISTINCT entity_type FROM ${table} ORDER BY entity_type`);
  res.render('audit/index', { title: 'Audit Log', logs, actions, entities, access });
});
module.exports = router;
