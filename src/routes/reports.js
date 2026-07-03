const express = require('express');
const { all } = require('../db');
const dayjs = require('dayjs');
const { requireLogin } = require('../middleware/auth');
const { caseWhere } = require('../utils/scope');
const { toCsv, sendCsv } = require('../utils/csv');
const { caseStatusLabel } = require('../utils/helpers');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const from = req.query.from || dayjs().startOf('month').format('YYYY-MM-DD');
  const to = req.query.to || dayjs().format('YYYY-MM-DD');
  const w = caseWhere(req.session.user); const cAlias = w.clause.replace(/cases\./g,'c.');
  const collection = all(`SELECT cl.company_name, COUNT(p.id) cnt, COALESCE(SUM(p.amount),0) total
    FROM payments p JOIN cases c ON c.id=p.case_id JOIN clients cl ON cl.id=c.client_id
    WHERE ${cAlias} AND date(p.payment_date) BETWEEN ? AND ? GROUP BY cl.id ORDER BY total DESC`, [...w.params, from, to]);
  const outstanding = all(`SELECT c.status, COUNT(*) cnt, COALESCE(SUM(c.outstanding_amount),0) total
    FROM cases c WHERE ${cAlias} GROUP BY c.status ORDER BY total DESC`, w.params);
  const performance = all(`SELECT a.name, a.target_amount, COALESCE(SUM(CASE WHEN date(p.payment_date) BETWEEN ? AND ? THEN p.amount ELSE 0 END),0) collected
    FROM agents a LEFT JOIN cases c ON c.agent_id=a.id LEFT JOIN payments p ON p.case_id=c.id
    GROUP BY a.id ORDER BY collected DESC`, [from, to]);
  if (req.query.export === 'outstanding') {
    const rows = outstanding.map(r => [caseStatusLabel(r.status), r.cnt, r.total]);
    return sendCsv(res, 'outstanding-by-status.csv', toCsv(['Status', 'Cases', 'Outstanding'], rows));
  }
  if (req.query.export === 'performance' && !['agent', 'client'].includes(req.session.user.role)) {
    const rows = performance.map(r => [r.name, r.collected, r.target_amount]);
    return sendCsv(res, 'agent-performance.csv', toCsv(['Agent', 'Collected', 'Target'], rows));
  }
  res.render('reports/index', { title: 'Reports', from, to, collection, outstanding, performance });
});
module.exports = router;
