const { all } = require('../db');
const { caseWhere } = require('./scope');
const { TERMINAL_STATUSES } = require('../services/payments');

// Pending tasks linked to a non-terminal case, ordered by due date (soonest
// or most-overdue first). Scoped the same way as the rest of the app (agent
// sees own cases, client sees own cases, admin/manager see everything) via
// caseWhere(). windowDays caps how far into the future to look (e.g. 14 =
// due within 14 days, including anything already overdue); pass null/undefined
// for no upper bound.
function followupTasks(user, windowDays) {
  const w = caseWhere(user);
  const tph = TERMINAL_STATUSES.map(() => '?').join(',');
  const hasWindow = windowDays !== null && windowDays !== undefined && Number.isFinite(Number(windowDays));
  const winDays = hasWindow ? Number(windowDays) : null;
  const upperClause = hasWindow ? "AND date(tasks.due_date) <= date('now','+8 hours', ?)" : '';
  const upperParam = hasWindow ? [`+${winDays} days`] : [];
  return all(`SELECT tasks.id, tasks.title, tasks.due_date, cases.id case_id, cases.case_no,
      cases.outstanding_amount, debtors.name debtor_name, agents.name agent_name,
      CAST(julianday(date('now','+8 hours')) - julianday(date(tasks.due_date)) AS INTEGER) days_over
    FROM tasks JOIN cases ON cases.id=tasks.case_id JOIN debtors ON debtors.id=cases.debtor_id
      LEFT JOIN agents ON agents.id=tasks.agent_id
    WHERE tasks.status='pending' AND tasks.due_date IS NOT NULL ${upperClause}
      AND ${w.clause} AND cases.status NOT IN (${tph})
    ORDER BY tasks.due_date`,
    [...upperParam, ...w.params, ...TERMINAL_STATUSES]);
}

module.exports = { followupTasks };
