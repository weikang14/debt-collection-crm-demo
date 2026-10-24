const dayjs = require('dayjs');
const { db, get, all, run } = require('../db');
const { caseBalance, resyncCaseStatus } = require('./payments');
const { maturityDate } = require('../utils/installments');
const { repaymentSchedule } = require('../utils/schedule');
const { logAction } = require('../utils/audit');
const { todayMYT, interestTerms, money } = require('../utils/helpers');

// Extension / Restructure (docs/superpowers/specs/2026-10-23-restructure-design.md).
// Each row starts a new ledger segment at effective_date; the case row keeps the
// original terms. Payment ownership: payment_date < E → earlier segment.

const MODES = ['fixed', 'monthly', 'daily'];

function restructuresOf(caseId) {
  return all('SELECT * FROM case_restructures WHERE case_id = ? ORDER BY effective_date, id', [caseId]);
}

// Payments dated before this belong to a superseded segment and are frozen.
function lockDate(caseId) {
  const r = get('SELECT effective_date FROM case_restructures WHERE case_id = ? ORDER BY effective_date DESC, id DESC LIMIT 1', [caseId]);
  return r ? r.effective_date : null;
}

function canRestructure(c) {
  return c.outstanding_amount > 0 && !['closed', 'cancelled'].includes(c.status);
}

// Allowed effective dates for a new restructure. min > max means none today.
function effectiveDateRange(c, payments, restructures) {
  const prev = restructures[restructures.length - 1];
  const candidates = [
    String(c.interest_from || c.opened_at || '').slice(0, 10),
    ...payments.map(p => String(p.payment_date).slice(0, 10)), // demo rows carry a time of day
    prev ? dayjs(prev.effective_date).add(1, 'day').format('YYYY-MM-DD') : '',
  ];
  return { min: candidates.reduce((m, d) => (d > m ? d : m), ''), max: todayMYT() };
}

// What is owed at the cut, from payments strictly before it — a payment ON the
// effective date belongs to the new segment. `payments` sorted ascending.
function balanceAtCut(c, payments, restructures, effectiveDate) {
  const b = caseBalance(c, payments.filter(p => p.payment_date < effectiveDate), effectiveDate, restructures);
  return { principal: b.principalRemaining, arrears: b.interestUnpaid };
}

function parseTerms(body) {
  const effective_date = String(body.effective_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_date) || dayjs(effective_date).format('YYYY-MM-DD') !== effective_date) {
    return { error: 'Invalid effective date' };
  }
  const interest_mode = body.interest_mode;
  if (!MODES.includes(interest_mode)) return { error: 'Invalid interest mode' };
  // A blank field is refused rather than read as 0 — an interest-free
  // restructure must be typed in as 0 on purpose.
  const blank = v => v === undefined || v === '';
  if (interest_mode !== 'fixed' && blank(body.interest_rate)) return { error: 'Interest rate is required' };
  if (interest_mode === 'fixed' && blank(body.interest_amount)) return { error: 'Interest amount is required' };
  const interest_rate = interest_mode === 'fixed' ? 0 : Number(body.interest_rate);
  const interest_amount = interest_mode === 'fixed' ? Number(body.interest_amount) : 0;
  if (!Number.isFinite(interest_rate) || interest_rate < 0) return { error: 'Invalid interest rate' };
  if (!Number.isFinite(interest_amount) || interest_amount < 0) return { error: 'Invalid interest amount' };
  const tenure = body.tenure === '' || body.tenure === undefined ? NaN : Number(body.tenure);
  if (!Number.isInteger(tenure) || tenure < 1 || tenure > 120) return { error: 'Tenure must be 1–120 months' };
  const reason = String(body.reason || '').trim();
  if (!reason) return { error: 'Reason is required' };
  return { effective_date, interest_mode, interest_rate, interest_amount, tenure, reason };
}

function createRestructure(caseId, body, req) {
  const c = get('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) return { ok: false, error: 'Case not found' };
  if (!canRestructure(c)) return { ok: false, error: 'This case cannot be restructured' };
  const t = parseTerms(body);
  if (t.error) return { ok: false, error: t.error };
  const payments = all('SELECT amount, payment_date FROM payments WHERE case_id = ? ORDER BY payment_date, id', [caseId]);
  const prior = restructuresOf(caseId);
  const range = effectiveDateRange(c, payments, prior);
  if (t.effective_date < range.min || t.effective_date > range.max) {
    return { ok: false, error: `Effective date must be between ${range.min} and ${range.max}` };
  }
  const cut = balanceAtCut(c, payments, prior, t.effective_date);
  const by = req.session.user.full_name;
  let id;
  db.transaction(() => {
    id = Number(run(`INSERT INTO case_restructures (case_id,effective_date,reason,interest_mode,interest_rate,interest_amount,tenure,maturity_date,principal_at_cut,arrears_at_cut,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId, t.effective_date, t.reason, t.interest_mode, t.interest_rate, t.interest_amount, t.tenure,
        maturityDate(t.effective_date, t.tenure, 'months'), cut.principal, cut.arrears, by]).lastInsertRowid);
    resyncCaseStatus(caseId, by);
    // ponytail: 'note' because timeline_events.event_type has a CHECK list and adding
    // a type needs a table rebuild; case_restructures + audit_logs are the record.
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
      [caseId, 'note', `Restructure: from ${t.effective_date}, ${interestTerms(t.interest_mode, t.interest_rate, t.interest_amount)}, ${t.tenure} months. `
        + `Principal RM ${money(cut.principal)}, arrears RM ${money(cut.arrears)} carried. Reason: ${t.reason}`, by]);
  })();
  logAction(req, 'restructure', 'case', caseId, `Restructured from ${t.effective_date} (${t.tenure} months)`);
  return { ok: true, id };
}

function undoRestructure(caseId, restructureId, req) {
  const rows = restructuresOf(caseId);
  const latest = rows[rows.length - 1];
  if (!latest || latest.id !== Number(restructureId)) return { ok: false, error: 'Only the latest restructure can be undone' };
  const after = get('SELECT COUNT(*) AS n FROM payments WHERE case_id = ? AND payment_date >= ?', [caseId, latest.effective_date]).n;
  if (after > 0) return { ok: false, error: 'Payments exist on or after the effective date; void them first' };
  const by = req.session.user.full_name;
  db.transaction(() => {
    run('DELETE FROM case_restructures WHERE id = ?', [latest.id]);
    resyncCaseStatus(caseId, by);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
      [caseId, 'note', `Restructure undone: from ${latest.effective_date}`, by]);
  })();
  logAction(req, 'restructure_undo', 'case', caseId, `Undid restructure from ${latest.effective_date}`);
  return { ok: true };
}

function paymentDateError(caseId, date) {
  const lock = lockDate(caseId);
  return lock && date && date < lock ? `Payment date must be on or after the restructure date (${lock})` : null;
}

function lockedPaymentError(caseId, payment) {
  const lock = lockDate(caseId);
  return lock && payment.payment_date < lock ? 'This payment belongs to a restructured period; undo the restructure first' : null;
}

// After a restructure the original loan terms are history: Edit Case keeps the
// stored values whatever the form sent. Keys are cases column names.
function lockedTerms(caseId, terms) {
  if (!lockDate(caseId)) return terms;
  return get(`SELECT principal_amount, interest_amount, interest_mode, interest_rate, interest_from,
    loan_start_date, tenure, tenure_unit, maturity_date FROM cases WHERE id = ?`, [caseId]);
}

// Repayment schedules for the case page: the current segment's (led by its
// carried-arrears row) plus, per restructure, the schedule it superseded —
// each fed only the payments inside its own date window.
function scheduleView(c, payments, restructures) {
  if (!restructures.length) return { current: repaymentSchedule(c, payments), history: [] };
  const inWindow = (from, to) => payments.filter(p => (!from || p.payment_date >= from) && (!to || p.payment_date < to));
  const segCase = r => ({ interest_mode: r.interest_mode, interest_rate: r.interest_rate, interest_amount: r.interest_amount,
    principal_amount: r.principal_at_cut, loan_start_date: r.effective_date, interest_from: r.effective_date,
    tenure: r.tenure, tenure_unit: 'months', outstanding_amount: c.outstanding_amount });
  const history = restructures.map((r, k) => {
    const prev = restructures[k - 1];
    const rows = repaymentSchedule(prev ? segCase(prev) : c, inWindow(prev && prev.effective_date, r.effective_date),
      { superseded: true, arrears: prev ? prev.arrears_at_cut : 0 });
    return { restructure: r, rows };
  });
  const last = restructures[restructures.length - 1];
  return { current: repaymentSchedule(segCase(last), inWindow(last.effective_date), { arrears: last.arrears_at_cut }), history };
}

module.exports = { restructuresOf, lockDate, canRestructure, effectiveDateRange, balanceAtCut, parseTerms,
  createRestructure, undoRestructure, paymentDateError, lockedPaymentError, lockedTerms, scheduleView };
