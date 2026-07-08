const express = require('express');
const { all } = require('../db');
const { commission } = require('../utils/helpers');
const router = express.Router();

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One row per in-scope agent for the given 'YYYY-MM' month.
// agent role → only own agent_id; everyone else → all agents.
function commissionRows(user, month) {
  const scoped = user && user.role === 'agent';
  const rows = all(
    `SELECT a.id AS agent_id, a.name, a.commission_rate AS rate,
       COALESCE((SELECT SUM(p.amount) FROM payments p JOIN cases c ON c.id = p.case_id
                 WHERE c.agent_id = a.id AND substr(p.payment_date,1,7) = ?), 0) AS collected,
       COALESCE((SELECT SUM(cs.amount) FROM commission_settlements cs
                 WHERE cs.agent_id = a.id AND cs.period = ?), 0) AS settled
     FROM agents a
     ${scoped ? 'WHERE a.id = ?' : ''}
     ORDER BY a.name`,
    scoped ? [month, month, user.agent_id || -1] : [month, month]);
  return rows.map((r) => {
    const earned = round2(commission(r.collected, r.rate));
    return { ...r, earned, pending: round2(earned - r.settled) };
  });
}

module.exports = { router, commissionRows, round2 };
