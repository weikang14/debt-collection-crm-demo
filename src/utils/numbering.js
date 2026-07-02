const { get } = require('../db');
function pad(n) { return String(n).padStart(4, '0'); }
function nextCaseNo() {
  const year = new Date().getFullYear();
  const prefix = `CASE-${year}-`;
  const row = get('SELECT COUNT(*) AS c FROM cases WHERE case_no LIKE ?', [prefix + '%']);
  return prefix + pad(row.c + 1);
}
function nextReceiptNo() {
  const year = new Date().getFullYear();
  const prefix = `RCPT-${year}-`;
  const row = get('SELECT COUNT(*) AS c FROM payments WHERE receipt_no LIKE ?', [prefix + '%']);
  return prefix + pad(row.c + 1);
}
module.exports = { nextCaseNo, nextReceiptNo };
