const express = require('express');
const { all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere } = require('../utils/scope');
const { toCsv, sendCsv } = require('../utils/csv');
const { caseStatusLabel, dateFmt, commission, round2, todayMYT } = require('../utils/helpers');
const { logAction } = require('../utils/audit');
const { todayFigures } = require('../services/restructure');
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
  // Every in-scope case with today's figures (N-07, G-24): `settlement` is the
  // primary amount, outstanding_amount the contract balance.
  const cases = all(`SELECT cases.*, debtors.name AS debtor_name, agents.name AS agent_name,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid
    FROM cases JOIN debtors ON debtors.id=cases.debtor_id LEFT JOIN agents ON agents.id=cases.agent_id
    WHERE ${w.clause} ORDER BY cases.opened_at DESC`, w.params).map(c => ({ ...c, ...todayFigures(c) }));
  const byStatus = {};
  for (const c of cases) {
    const r = byStatus[c.status] ||= { status: c.status, cnt: 0, total: 0, contract: 0 };
    r.cnt++; r.total += c.settlement; r.contract += c.outstanding_amount;
  }
  const outstanding = Object.values(byStatus).map(r => ({ ...r, total: round2(r.total), contract: round2(r.contract) }))
    .sort((a, b) => b.total - a.total);
  const performance = all(`SELECT a.name, a.target_amount, a.commission_rate, COALESCE(SUM(CASE WHEN date(p.payment_date) BETWEEN ? AND ? THEN p.amount ELSE 0 END),0) collected
    FROM agents a LEFT JOIN payments p ON p.agent_id=a.id
    GROUP BY a.id ORDER BY collected DESC`, [from, to]);
  // Each export leaves an audit record of who took what (G-25).
  const exported = (name, rows) => logAction(req, 'export', 'report', null, `Exported ${name} (${rows.length} rows)`);
  if (req.query.export === 'cases') {
    const rows = cases.map(c => [c.case_no, c.debtor_name, c.agent_name || '', c.principal_amount, c.interest_charged, round2(c.paid),
      c.settlement, c.overdue ?? '', c.dpd ?? '', c.outstanding_amount, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
    exported('cases-detailed.csv', rows);
    return sendCsv(res, 'cases-detailed.csv', toCsv(['Case No', 'Debtor', 'Agent', 'Principal', 'Interest', 'Paid',
      'Settlement Today', 'Overdue', 'DPD', 'Contract Balance', 'Status', 'Opened'], rows));
  }
  if (req.query.export === 'outstanding') {
    const rows = outstanding.map(r => [caseStatusLabel(r.status), r.cnt, r.total, r.contract]);
    exported('outstanding-by-status.csv', rows);
    return sendCsv(res, 'outstanding-by-status.csv', toCsv(['Status', 'Cases', 'Settlement Today', 'Contract Balance'], rows));
  }
  if (req.query.export === 'performance' && !['agent', 'client'].includes(req.session.user.role)) {
    const rows = performance.map(r => [r.name, round2(r.collected), r.commission_rate, round2(commission(r.collected, r.commission_rate)), r.target_amount]);
    exported('agent-performance.csv', rows);
    return sendCsv(res, 'agent-performance.csv', toCsv(['Agent', 'Collected', 'Rate %', 'Commission', 'Target'], rows));
  }
  res.render('reports/index', { title: 'Reports', from, to, collection, outstanding, performance });
});
module.exports = router;
