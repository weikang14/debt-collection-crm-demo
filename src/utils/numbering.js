const { get, run } = require('../db');
const { todayMYT } = require('./helpers');
function pad(n) { return String(n).padStart(4, '0'); }

// Next number = per-year high-water mark + 1. The mark (number_sequences) only
// ever grows, so deleting any row — including the newest — never reuses its
// number; MAX(suffix) still seeds it for rows numbered before the table existed.
// node:sqlite is synchronous/single-threaded so no locking needed.
function nextNumber(table, column, prefix) {
  const row = get(
    `SELECT MAX(CAST(substr(${column}, ?) AS INTEGER)) AS m FROM ${table} WHERE ${column} LIKE ?`,
    [prefix.length + 1, prefix + '%']);
  const seq = get('SELECT last FROM number_sequences WHERE prefix = ?', [prefix]);
  const n = Math.max(row.m || 0, seq ? seq.last : 0) + 1;
  run('INSERT INTO number_sequences (prefix, last) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET last = excluded.last', [prefix, n]);
  return prefix + pad(n);
}
// Year in Malaysia time, so the first hours of 1 January don't number into the old year.
const year = () => todayMYT().slice(0, 4);
function nextCaseNo() {
  return nextNumber('cases', 'case_no', `CASE-${year()}-`);
}
function nextReceiptNo() {
  return nextNumber('payments', 'receipt_no', `RCPT-${year()}-`);
}
module.exports = { nextCaseNo, nextReceiptNo };
