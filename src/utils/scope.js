const { all } = require('../db');

const isScoped = (user) => user && (user.role === 'agent' || user.role === 'client');

function caseWhere(user, alias = 'cases') {
  if (!user) return { clause: '1=0', params: [] };
  if (user.role === 'agent') return { clause: `${alias}.agent_id = ?`, params: [user.agent_id] };
  if (user.role === 'client') return { clause: `${alias}.client_id = ?`, params: [user.client_id] };
  return { clause: '1=1', params: [] };
}
function reachableDebtorIds(user) {
  if (!isScoped(user)) return null;
  const w = caseWhere(user);
  return all(`SELECT DISTINCT debtor_id FROM cases WHERE ${w.clause}`, w.params).map((r) => r.debtor_id);
}
function reachableClientIds(user) {
  if (!isScoped(user)) return null;
  const w = caseWhere(user);
  return all(`SELECT DISTINCT client_id FROM cases WHERE ${w.clause}`, w.params).map((r) => r.client_id);
}
module.exports = { isScoped, caseWhere, reachableDebtorIds, reachableClientIds };
