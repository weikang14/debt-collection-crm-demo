const { get } = require('../db');
function pad(n) { return String(n).padStart(4, '0'); }

// Next number = per-year MAX suffix + 1, not COUNT+1. COUNT reused a number
// whenever any earlier row was deleted (→ UNIQUE violation); MAX never looks
// back at gaps. node:sqlite is synchronous/single-threaded so no locking needed.
function nextNumber(table, column, prefix) {
  const row = get(
    `SELECT MAX(CAST(substr(${column}, ?) AS INTEGER)) AS m FROM ${table} WHERE ${column} LIKE ?`,
    [prefix.length + 1, prefix + '%']);
  return prefix + pad((row.m || 0) + 1);
}
function nextCaseNo() {
  return nextNumber('cases', 'case_no', `CASE-${new Date().getFullYear()}-`);
}
function nextReceiptNo() {
  return nextNumber('payments', 'receipt_no', `RCPT-${new Date().getFullYear()}-`);
}
module.exports = { nextCaseNo, nextReceiptNo };
