// F-35: a debtor's personal data is removed N years (company setting, default 7 —
// past the 6-year limitation period) after the last of their cases closed. An admin
// runs it from Company Settings. The money records stay (amounts, dates, receipt
// numbers, references); names, contact details and free text go. The audit and
// access logs and payment_history are append-only and keep their past entries; the removal
// entry in the audit log records the debtor's name and IC, so it stays known they were on file.
const { get, all, run } = require('../db');
const { todayMYT } = require('../utils/helpers');

const DONE = "('fully_paid','closed','cancelled')"; // bankruptcy / deceased / legal stay open
const REMOVED = '[removed after the retention period]';
// Once removed, the debtor and their cases are read-only, so nothing new is written about them.
const ANONYMIZED = 'Read-only: this debtor’s personal data was removed after the retention period';
const caseAnonymized = caseId => !!get(`SELECT 1 FROM cases c JOIN debtors d ON d.id = c.debtor_id
  WHERE c.id = ? AND d.anonymized_at IS NOT NULL`, [caseId]);

const retentionYears = () => Number((get('SELECT retention_years FROM settings WHERE id=1') || {}).retention_years) || 7;

// Debtors with every case finished and nothing on file since the cutoff date.
function dueForRemoval(today = todayMYT()) {
  const years = retentionYears();
  const cutoff = `${Number(today.slice(0, 4)) - years}${today.slice(4)}`;
  const rows = all(`SELECT d.id, d.name, d.ic_passport, date(d.created_at, '+8 hours') created,
      (SELECT COUNT(*) FROM cases c WHERE c.debtor_id = d.id AND c.status NOT IN ${DONE}) open,
      (SELECT MAX(date(COALESCE(c.closed_at, c.opened_at), '+8 hours')) FROM cases c WHERE c.debtor_id = d.id) last_case,
      (SELECT MAX(substr(p.payment_date, 1, 10)) FROM payments p JOIN cases c ON c.id = p.case_id WHERE c.debtor_id = d.id) last_pay
    FROM debtors d WHERE d.anonymized_at IS NULL ORDER BY d.id`);
  const list = rows.filter(r => !r.open)
    .map(r => ({ id: r.id, name: r.name, ic: r.ic_passport, last: [r.last_case, r.last_pay].filter(Boolean).sort().pop() || r.created }))
    .filter(r => r.last < cutoff);
  return { years, cutoff, list };
}

function anonymizeDebtor(id) {
  const ofDebtor = 'SELECT id FROM cases WHERE debtor_id = ?';
  run(`UPDATE debtors SET name = ?, ic_passport = NULL, company = NULL, phone = NULL, email = NULL, address = NULL,
    employer = NULL, salary = NULL, guarantor_name = NULL, guarantor_phone = NULL, remark = NULL,
    anonymized_at = datetime('now') WHERE id = ?`, [`Anonymized debtor #${id}`, id]);
  run('UPDATE cases SET remark = NULL WHERE debtor_id = ?', [id]);
  run(`UPDATE call_logs SET notes = NULL, phone = NULL WHERE case_id IN (${ofDebtor})`, [id]);
  run(`UPDATE timeline_events SET content = ? WHERE event_type IN ('note','call','whatsapp','email','legal') AND case_id IN (${ofDebtor})`, [REMOVED, id]);
  run(`UPDATE tasks SET title = ?, notes = NULL WHERE case_id IN (${ofDebtor})`, [REMOVED, id]);
  run(`UPDATE ptps SET remark = NULL WHERE case_id IN (${ofDebtor})`, [id]);
  run(`UPDATE payments SET remark = NULL WHERE case_id IN (${ofDebtor})`, [id]);
}

module.exports = { retentionYears, dueForRemoval, anonymizeDebtor, caseAnonymized, ANONYMIZED };
