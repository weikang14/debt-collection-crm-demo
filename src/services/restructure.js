const dayjs = require('dayjs');
const { db, get, all, run } = require('../db');
const { caseBalance, resyncCaseStatus, localDate, nominalAnnualRate, rateCapError, accrue } = require('./payments');
const { maturityDate } = require('../utils/installments');
const { repaymentSchedule } = require('../utils/schedule');
const { logAction } = require('../utils/audit');
const { todayMYT, interestTerms, money } = require('../utils/helpers');

// Extension / Restructure (docs/superpowers/specs/2026-10-23-restructure-design.md).
// Each row starts a new ledger segment at effective_date; the case row keeps the
// original terms. Payment ownership (D-04): payment_date ≤ E → earlier segment,
// so a payment taken on the day of the restructure is inside its cut.

const { isISODate } = require('../utils/forms');

const MODES = ['fixed', 'monthly', 'daily'];

function restructuresOf(caseId) {
  return all('SELECT * FROM case_restructures WHERE case_id = ? ORDER BY effective_date, id', [caseId]);
}

// Payments dated on or before this belong to a superseded segment and are frozen.
function lockDate(caseId) {
  const r = get('SELECT effective_date FROM case_restructures WHERE case_id = ? ORDER BY effective_date DESC, id DESC LIMIT 1', [caseId]);
  return r ? r.effective_date : null;
}
// First date a new payment may carry once the case is restructured.
const afterLock = lock => (lock ? dayjs(lock).add(1, 'day').format('YYYY-MM-DD') : null);

// Bankrupt / deceased debtors aren't re-planned (D-13), nor closed / cancelled cases.
function canRestructure(c) {
  return c.outstanding_amount > 0 && !['closed', 'cancelled', 'bankruptcy', 'deceased'].includes(c.status);
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

// What is owed at the cut, from payments up to and including the effective
// date (D-04). `payments` sorted ascending.
function balanceAtCut(c, payments, restructures, effectiveDate) {
  const b = caseBalance(c, payments.filter(p => localDate(p.payment_date) <= effectiveDate), effectiveDate, restructures);
  return { principal: b.principalRemaining, arrears: b.interestUnpaid };
}

function parseTerms(body) {
  const effective_date = String(body.effective_date || '');
  if (!isISODate(effective_date)) return { error: 'Invalid effective date' };
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

// Legal limits on new terms (D-03): under the annual cap, no higher than the
// terms being replaced, total interest over the loan's life ≤ the original
// principal, and (N-11, pending legal advice) the new interest plus carried
// arrears ≤ the principal still owed at the cut.
function termsError(c, payments, prior, t, cut) {
  const capErr = rateCapError(t, cut.principal);
  if (capErr) return capErr;
  const prev = prior[prior.length - 1];
  // N-09: flat-rate annualisation isn't legally settled yet, so a rate-based
  // loan isn't moved to a fixed amount until it is.
  if (t.interest_mode === 'fixed' && ['monthly', 'daily'].includes((prev || c).interest_mode)) {
    return 'A rate-based loan cannot be restructured to a fixed amount (pending legal review)';
  }
  const maturity = maturityDate(t.effective_date, t.tenure, 'months');
  const newInterest = t.interest_mode === 'fixed' ? t.interest_amount
    : accrue({ ...t, start: t.effective_date }, cut.principal, t.effective_date, maturity);
  if (newInterest + cut.arrears > cut.principal + 0.005) {
    return 'Interest after the restructure plus carried arrears cannot exceed the remaining principal';
  }
  const before = nominalAnnualRate(prev || c, prev ? prev.principal_at_cut : c.principal_amount);
  const after = nominalAnnualRate(t, cut.principal);
  if (before !== null && after !== null && after > before + 1e-9) {
    return `A restructure cannot raise the interest rate (${Math.round(before * 100) / 100}% → ${Math.round(after * 100) / 100}% p.a.)`;
  }
  const draft = { ...t, maturity_date: maturity };
  if (caseBalance(c, payments, undefined, [...prior, draft]).interest > c.principal_amount + 0.005) {
    return 'Total interest cannot exceed the principal';
  }
  return null;
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
  const limitErr = termsError(c, payments, prior, t, cut);
  if (limitErr) return { ok: false, error: limitErr };
  const by = req.session.user.full_name;
  let id;
  db.transaction(() => {
    id = Number(run(`INSERT INTO case_restructures (case_id,effective_date,reason,interest_mode,interest_rate,interest_amount,tenure,maturity_date,principal_at_cut,arrears_at_cut,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId, t.effective_date, t.reason, t.interest_mode, t.interest_rate, t.interest_amount, t.tenure,
        maturityDate(t.effective_date, t.tenure, 'months'), cut.principal, cut.arrears, by]).lastInsertRowid);
    resyncCaseStatus(caseId, by);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
      [caseId, 'restructure', `Restructure: from ${t.effective_date}, ${interestTerms(t.interest_mode, t.interest_rate, t.interest_amount)}, ${t.tenure} months. `
        + `Principal RM ${money(cut.principal)}, arrears RM ${money(cut.arrears)} carried. Reason: ${t.reason}`, by]);
  })();
  logAction(req, 'restructure', 'case', caseId, `Restructured from ${t.effective_date} (${t.tenure} months)`);
  return { ok: true, id };
}

function undoRestructure(caseId, restructureId, req) {
  const rows = restructuresOf(caseId);
  const latest = rows[rows.length - 1];
  if (!latest || latest.id !== Number(restructureId)) return { ok: false, error: 'Only the latest restructure can be undone' };
  const after = get('SELECT COUNT(*) AS n FROM payments WHERE case_id = ? AND substr(payment_date, 1, 10) > ?', [caseId, latest.effective_date]).n;
  if (after > 0) return { ok: false, error: 'Payments exist after the effective date; void them first' };
  const by = req.session.user.full_name;
  db.transaction(() => {
    run('DELETE FROM case_restructures WHERE id = ?', [latest.id]);
    resyncCaseStatus(caseId, by);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
      [caseId, 'restructure', `Restructure undone: from ${latest.effective_date}`, by]);
  })();
  logAction(req, 'restructure_undo', 'case', caseId, `Undid restructure from ${latest.effective_date}`);
  return { ok: true };
}

// Every payment write path (record, Pay, PTP fulfil, edit) goes through here,
// so this is also where a payment date's format and range are checked. A
// future date would accrue interest to that day and push the restructure
// lower bound past today.
function paymentDateError(caseId, date) {
  if (!isISODate(date)) return 'Invalid payment date';
  if (date > todayMYT()) return 'Payment date cannot be in the future';
  // N-14: nothing is owed before interest starts (a deposit is a different record).
  const c = get('SELECT interest_from, loan_start_date, opened_at FROM cases WHERE id = ?', [caseId]);
  const start = c && (c.interest_from || c.loan_start_date) ? String(c.interest_from || c.loan_start_date).slice(0, 10)
    : c ? localDate(c.opened_at) : null;
  if (start && date < start) return `Payment date cannot be before the loan start date (${start})`;
  const lock = lockDate(caseId);
  return lock && date <= lock ? `Payment date must be after the restructure date (${lock})` : null;
}

function lockedPaymentError(caseId, payment) {
  const lock = lockDate(caseId);
  return lock && localDate(payment.payment_date) <= lock ? 'This payment belongs to a restructured period; undo the restructure first' : null;
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
// each fed only the payments inside its own date window (from, to].
function scheduleView(c, payments, restructures) {
  if (!restructures.length) return { current: repaymentSchedule(c, payments), history: [] };
  const inWindow = (from, to) => payments.filter(p => {
    const d = localDate(p.payment_date);
    return (!from || d > from) && (!to || d <= to);
  });
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

// Arrears from the current schedule (D-09): the unpaid amount of instalments
// already due, and days past due (DPD) counted from the oldest of them.
// { dpd: null, overdue: null } when the case has no schedule (no term set).
function arrearsOf(c, payments, restructures) {
  const rows = scheduleView(c, payments, restructures).current;
  if (!rows.length) return { dpd: null, overdue: null };
  const today = todayMYT();
  const due = rows.filter(r => r.due_date < today && r.outstanding_amount > 0);
  if (!due.length) return { dpd: 0, overdue: 0 };
  // The plan's FIFO can run ahead of the interest-first ledger after a principal
  // prepayment; never call more overdue than would settle the loan today (N-06).
  // ponytail: cap only; a ledger-based DPD is the full fix (N-06 A/B, K-02).
  const settle = caseBalance(c, payments.filter(p => localDate(p.payment_date) <= today)
    .sort((a, b) => localDate(a.payment_date).localeCompare(localDate(b.payment_date))), today, restructures).outstanding;
  const overdue = Math.min(Math.round(due.reduce((s, r) => s + r.outstanding_amount, 0) * 100) / 100, settle);
  if (overdue <= 0) return { dpd: 0, overdue: 0 };
  return { dpd: dayjs(today).diff(dayjs(due[0].due_date), 'day'), overdue };
}

module.exports = { restructuresOf, lockDate, afterLock, canRestructure, effectiveDateRange, balanceAtCut, parseTerms,
  createRestructure, undoRestructure, paymentDateError, lockedPaymentError, lockedTerms, scheduleView, arrearsOf };
