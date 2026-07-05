// Build the WHERE clause + params for the debtors list: row-level scope
// (reachable ids) plus optional risk / text filters. All user values are
// bound as ? params; only the dynamic IN placeholder list is interpolated.
const RISKS = ['low', 'medium', 'high'];

function debtorFilter(ids, query = {}) {
  const parts = [];
  const params = [];
  if (ids === null) parts.push('1=1');
  else if (!ids.length) parts.push('1=0');
  else { parts.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }

  if (RISKS.includes(query.risk)) { parts.push('risk_level = ?'); params.push(query.risk); }
  if (query.q) {
    const like = '%' + query.q + '%';
    parts.push('(name LIKE ? OR ic_passport LIKE ? OR phone LIKE ?)');
    params.push(like, like, like);
  }
  return { where: parts.join(' AND '), params };
}
module.exports = { debtorFilter };
