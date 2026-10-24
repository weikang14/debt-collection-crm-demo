const express = require('express');
const { all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere } = require('../utils/scope');
const { toCsv, sendCsv } = require('../utils/csv');
const { caseStatusLabel, dateFmt, commission, round2, todayMYT } = require('../utils/helpers');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  // Default range = this month to date, in Malaysia time (the server may run in UTC).
  const today = todayMYT();
  const from = req.query.from || today.slice(0, 8) + '01';
  const to = req.query.to || today;
  const w = caseWhere(req.session.user); const cAlias = w.clause.replace(/cases\./g,'c.');
  const collection = all(`SELECT cl.company_name, COUNT(p.id) cnt, COALESCE(SUM(p.amount),0) total
    FROM payments p JOIN cases c ON c.id=p.case_id JOIN clients cl ON cl.id=c.client_id
    WHERE ${cAlias} AND date(p.payment_date) BETWEEN ? AND ? GROUP BY cl.id ORDER BY total DESC`, [...w.params, from, to]);
  const outstanding = all(`SELECT c.status, COUNT(*) cnt, COALESCE(SUM(c.outstanding_amount),0) total
    FROM cases c WHERE ${cAlias} GROUP BY c.status ORDER BY total DESC`, w.params);
  const performance = all(`SELECT a.name, a.target_amount, a.commission_rate, COALESCE(SUM(CASE WHEN date(p.payment_date) BETWEEN ? AND ? THEN p.amount ELSE 0 END),0) collected
    FROM agents a LEFT JOIN cases c ON c.agent_id=a.id LEFT JOIN payments p ON p.case_id=c.id
    GROUP BY a.id ORDER BY collected DESC`, [from, to]);
  if (req.query.export === 'cases') {
    const rows = all(`SELECT cases.case_no, debtors.name AS debtor_name, agents.name AS agent_name,
        cases.principal_amount, cases.interest_charged, cases.outstanding_amount, cases.status, cases.opened_at,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid
      FROM cases JOIN debtors ON debtors.id=cases.debtor_id
      LEFT JOIN agents ON agents.id=cases.agent_id
      WHERE ${w.clause} ORDER BY cases.opened_at DESC`, w.params)
      .map(c => [c.case_no, c.debtor_name, c.agent_name || '', c.principal_amount, c.interest_charged, round2(c.paid), c.outstanding_amount, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
    return sendCsv(res, 'cases-detailed.csv', toCsv(['Case No', 'Debtor', 'Agent', 'Principal', 'Interest', 'Paid', 'Outstanding', 'Status', 'Opened'], rows));
  }
  if (req.query.export === 'outstanding') {
    const rows = outstanding.map(r => [caseStatusLabel(r.status), r.cnt, round2(r.total)]);
    return sendCsv(res, 'outstanding-by-status.csv', toCsv(['Status', 'Cases', 'Outstanding'], rows));
  }
  if (req.query.export === 'performance' && !['agent', 'client'].includes(req.session.user.role)) {
    const rows = performance.map(r => [r.name, round2(r.collected), r.commission_rate, round2(commission(r.collected, r.commission_rate)), r.target_amount]);
    return sendCsv(res, 'agent-performance.csv', toCsv(['Agent', 'Collected', 'Rate %', 'Commission', 'Target'], rows));
  }
  res.render('reports/index', { title: 'Reports', from, to, collection, outstanding, performance });
});
module.exports = router;
