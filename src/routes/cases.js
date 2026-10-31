const express = require('express');
const { db, all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction, logAccess } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const { nextCaseNo } = require('../utils/numbering');
const { resyncCaseStatus, recomputeOutstanding, TERMINAL_STATUSES, caseBalance, settlementOn, overpayError, rateCapError, snapshotPayment } = require('../services/payments');
const { toCsv, sendCsv } = require('../utils/csv');
const { caseStatusLabel, dateFmt, round2, todayMYT, money } = require('../utils/helpers');
const { splitInstallments, dueDates, maturityDate } = require('../utils/installments');
const { restructuresOf, afterLock, canRestructure, effectiveDateRange, balanceAtCut, createRestructure, undoRestructure,
  paymentDateError, lockedPaymentError, termsLocked, lockedTerms, scheduleView, arrearsOf, todayFigures } = require('../services/restructure');
const crypto = require('node:crypto');
const router = express.Router();

const { validatePayment, isISODate, parseMoney, methodError, refill } = require('../utils/forms');

const CASE_STATUSES = ['new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased'];
// What an agent may set by hand (D-12): no Fully Paid and no terminal status.
const AGENT_STATUSES = ['new','assigned','negotiation','ptp','partial_paid'];
const PRIORITIES = ['low','medium','high','urgent'];
const CALL_RESULTS = ['answered','no_answer','busy','wrong_number','refused'];
// F-33: the channel used and who was reached. Contact-hour and frequency limits wait on legal advice (D-17).
const CALL_CHANNELS = ['phone', 'whatsapp', 'sms'];
const CALL_CONTACTS = ['debtor', 'guarantor', 'employer', 'other'];
const blank = v => v === undefined || v === null || String(v).trim() === '';

// Bankrupt / deceased debtors (D-13): no new promises, calls or restructures;
// a payment can still be received but needs a reason on record.
const FROZEN = ['bankruptcy', 'deceased'];
const frozenError = c => (FROZEN.includes(c.status) ? `Not allowed while the case is ${caseStatusLabel(c.status)}` : null);

// Legal limits on a case's own terms (D-03): under the annual cap, and total
// contract interest no more than the principal.
function loanLimitError(t) {
  // A loan that charges interest needs a term (N-02): without one the cap can't
  // annualise fixed interest and accrual interest never stops. Checked only on
  // new or changed terms, so older term-less cases can still be reassigned.
  const charges = t.interest_mode === 'fixed' ? (t.interest_amount || 0) > 0 : (t.interest_rate || 0) > 0;
  if (charges && !t.tenure) return 'Tenure is required for a loan that charges interest';
  const capErr = rateCapError(t, t.principal_amount);
  if (capErr) return capErr;
  const draft = { ...t, opened_at: new Date().toISOString() };
  return caseBalance(draft, []).interest > t.principal_amount + 0.005 ? 'Total interest cannot exceed the principal' : null;
}

// Promises may not add up to more than would settle the loan on the last
// promised date (D-10).
function promiseCapError(caseId, amount, dueDate) {
  const pending = all("SELECT amount, due_date FROM ptps WHERE case_id=? AND status='pending'", [caseId]);
  const last = pending.reduce((m, p) => (p.due_date > m ? p.due_date : m), dueDate);
  const cap = settlementOn(caseId, last);
  const total = round2(pending.reduce((s, p) => s + p.amount, 0) + amount);
  return total > cap + 0.005 ? `Promised total RM ${money(total)} exceeds the settlement amount on ${last} (RM ${money(cap)})` : null;
}

// Server-side check of the New/Edit Case form (the browser's min/required are
// bypassable). Returns an error message, or null when the form is acceptable.
function caseFormError(b) {
  if (!get('SELECT 1 FROM debtors WHERE id=?', [b.debtor_id])) return 'Debtor not found';
  if (!blank(b.agent_id) && !get('SELECT 1 FROM agents WHERE id=?', [b.agent_id])) return 'Agent not found';
  const principal = parseMoney(b.principal_amount);
  if (!(principal > 0) || principal > 1e12) return 'Invalid principal';
  if (!blank(b.interest_amount) && !(parseMoney(b.interest_amount) >= 0)) return 'Invalid interest amount';
  if (!blank(b.interest_rate) && !/^\d+(\.\d+)?$/.test(String(b.interest_rate).trim())) return 'Invalid interest rate';
  if (!blank(b.loan_start_date) && !isISODate(b.loan_start_date)) return 'Invalid loan start date';
  if (!blank(b.agreement_date) && !isISODate(b.agreement_date)) return 'Invalid agreement date';
  if (!blank(b.agreement_no) && String(b.agreement_no).trim().length > 60) return 'Agreement no. must be at most 60 characters';
  const tenure = Number(b.tenure);
  if (!blank(b.tenure) && !(Number.isInteger(tenure) && tenure >= 1 && tenure <= 120)) return 'Tenure must be 1–120 months';
  if (!blank(b.priority) && !PRIORITIES.includes(b.priority)) return 'Invalid priority';
  if (!blank(b.status) && !CASE_STATUSES.includes(b.status)) return 'Invalid status';
  return null;
}
const noAgentCreate = requireRole('admin','manager'); // who can create/edit cases

// shared loader with scope enforcement
function loadCase(req, res) {
  // Freshen the accrual balance before every single-case read, so displayed
  // outstanding/interest and payment-validation ceilings reflect interest up to
  // now. No-op for fixed cases; skips silently if the id is missing/out of scope.
  // ponytail: recompute-on-load in lieu of a nightly accrual job — fine at this scale.
  recomputeOutstanding(req.params.id);
  const w = caseWhere(req.session.user);
  const c = get(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name,
    debtors.phone AS debtor_phone, debtors.ic_passport, debtors.address AS debtor_address, debtors.guarantor_phone, agents.name AS agent_name
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE cases.id=? AND ${w.clause}`, [req.params.id, ...w.params]);
  if (!c) { res.status(404).render('error', { message: 'Case not found or access denied' }); return null; }
  return c;
}

// Parse the interest-model form fields. Unknown mode falls back to 'fixed';
// rate only matters for accrual modes (blanked otherwise so a mode switch
// back to fixed doesn't leave stale values). Interest always starts accruing
// on loan_start_date — there is no separate manual "interest from" input;
// the loan starting IS what starts interest.
function interestFields(b) {
  const mode = ['fixed', 'monthly', 'daily'].includes(b.interest_mode) ? b.interest_mode : 'fixed';
  if (mode === 'fixed') return { mode, rate: 0, from: null };
  return { mode, rate: Number(b.interest_rate) || 0, from: b.loan_start_date || null };
}

// Parse the loan-tenure form fields. maturity_date is only derived when both
// loan_start_date and tenure are present; otherwise it's left null so the UI
// hides the Maturity Date display rather than showing a bogus computed date.
function tenureFields(b) {
  // The form only offers months; any other unit would skew the rate cap (G-15).
  const unit = 'months';
  const start = b.loan_start_date || null;
  const parsedTenure = Number(b.tenure);
  const tenure = Number.isFinite(parsedTenure) && parsedTenure > 0 ? parsedTenure : null;
  const maturity = (start && tenure) ? maturityDate(start, tenure, unit) : null;
  return { start, tenure, unit, maturity };
}

// Internal-only business: cases don't pick an external client. Every case is
// assigned to a single built-in "自营" (in-house) client so the schema's
// NOT NULL client_id stays satisfied without exposing Clients in the UI.
// ponytail: get-or-create keeps this reversible — re-add the client picker and
// the sidebar link to bring the Clients module back.
function internalClientId() {
  const c = get('SELECT id FROM clients WHERE company_name = ?', ['自营业务']);
  if (c) return c.id;
  const r = run('INSERT INTO clients (company_name, commission_rate) VALUES (?, 0)', ['自营业务']);
  return r.lastInsertRowid;
}

router.get('/', requireLogin, (req, res) => {
  const w = caseWhere(req.session.user);
  const filters = [w.clause]; const params = [...w.params];
  if (req.query.status) { filters.push('cases.status = ?'); params.push(req.query.status); }
  if (req.query.priority) { filters.push('cases.priority = ?'); params.push(req.query.priority); }
  if (req.query.q) { filters.push('(cases.case_no LIKE ? OR debtors.name LIKE ?)'); params.push('%'+req.query.q+'%','%'+req.query.q+'%'); }
  const cases = all(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name, debtors.phone AS debtor_phone, agents.name AS agent_name,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE ${filters.join(' AND ')} ORDER BY cases.opened_at DESC`, params)
    .map(c => ({ ...c, ...todayFigures(c) }));
  // G-23: a work queue by days past due, most overdue first; no schedule last.
  if (req.query.sort === 'dpd') cases.sort((a, b) => (b.dpd ?? -1) - (a.dpd ?? -1));
  if (req.query.format === 'csv') {
    const rows = cases.map(c => [c.case_no, c.debtor_name, c.debtor_phone || '', c.agent_name || '', c.settlement, c.overdue ?? '', c.dpd ?? '',
      c.outstanding_amount, round2(c.paid), c.priority, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
    logAction(req, 'export', 'case', null, `Exported cases.csv (${rows.length} rows)`);
    return sendCsv(res, 'cases.csv', toCsv(['Case No', 'Debtor', 'Debtor Phone', 'Agent', 'Settlement Today', 'Overdue', 'DPD',
      'Contract Balance', 'Paid', 'Priority', 'Status', 'Opened'], rows));
  }
  res.render('cases/list', { title: 'Cases', cases, statuses: CASE_STATUSES, priorities: PRIORITIES });
});

router.get('/new', requireLogin, noAgentCreate, (req, res) => {
  res.render('cases/form', { title: 'New Case', c: refill(res, {}), action: '/cases',
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES });
});
router.post('/', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  if (!b.debtor_id || b.principal_amount === undefined || b.principal_amount === '') {
    return res.redirect('/cases/new?err=Debtor+and+principal+are+required');
  }
  const formErr = caseFormError(b);
  if (formErr) return res.redirect(`/cases/new?err=${encodeURIComponent(formErr)}`);
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  // Accrual modes start with ~0 interest; the manual interest field only applies to fixed.
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  const { start: loanStart, tenure, unit: tenureUnit, maturity } = tenureFields(b);
  const limitErr = loanLimitError({ principal_amount: principal, interest_mode: mode, interest_rate: rate, interest_amount: interest,
    interest_from: from, tenure, maturity_date: maturity });
  if (limitErr) return res.redirect(`/cases/new?err=${encodeURIComponent(limitErr)}`);
  const case_no = nextCaseNo();
  const r = run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,interest_charged,outstanding_amount,priority,status,remark,interest_mode,interest_rate,interest_from,loan_start_date,tenure,tenure_unit,maturity_date,agreement_no,agreement_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [case_no, internalClientId(), b.debtor_id, b.agent_id||null, principal, interest, interest, principal+interest, b.priority||'medium', b.status||'new', b.remark||null, mode, rate, from, loanStart, tenure, tenureUnit, maturity,
      blank(b.agreement_no) ? null : String(b.agreement_no).trim(), blank(b.agreement_date) ? null : b.agreement_date]);
  // Accrual interest is derived; compute it now so lists and the dashboard
  // don't show the bare principal until someone opens the case.
  recomputeOutstanding(r.lastInsertRowid);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [r.lastInsertRowid,'note',`Case ${case_no} created`,req.session.user.full_name]);
  logAction(req,'create','case',r.lastInsertRowid,`Created case ${case_no}`);
  res.redirect(`/cases/${r.lastInsertRowid}?ok=Case+created`);
});
router.get('/:id/edit', requireLogin, noAgentCreate, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  res.render('cases/form', { title: 'Edit Case', c: refill(res, c), action: `/cases/${c.id}`,
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES, termsLocked: termsLocked(c.id) });
});
router.get('/:id/statement', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date', [c.id]);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const company = get('SELECT * FROM settings WHERE id=1') || {};
  const restructures = restructuresOf(c.id);
  logAccess(req, 'print', 'case', c.id, `Statement ${c.case_no}`);
  res.render('cases/statement', { c, payments, paid, today, company, restructures, schedule: scheduleView(c, payments, restructures).current,
    settlement: settlementOn(c.id, today), arrears: arrearsOf(c, payments, restructures) });
});
// F-25: a printable receipt for one payment, for anyone who can see the case.
router.get('/:id/payments/:pid/receipt', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const p = get('SELECT * FROM payments WHERE id=? AND case_id=?', [req.params.pid, c.id]);
  if (!p) return res.status(404).render('error', { message: 'Payment not found (it may have been voided)' });
  const amended = get("SELECT MAX(changed_at) at FROM payment_history WHERE payment_id=? AND change='edit'", [p.id]).at;
  logAccess(req, 'print', 'payment', p.id, `Receipt ${p.receipt_no} (${c.case_no})`);
  res.render('cases/receipt', { c, p, amended, company: get('SELECT * FROM settings WHERE id=1') || {} });
});
router.post('/:id', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  if (!b.debtor_id || b.principal_amount === undefined || b.principal_amount === '') {
    return res.redirect('/cases/'+req.params.id+'/edit?err=Debtor+and+principal+are+required');
  }
  const old = get('SELECT * FROM cases WHERE id=?', [req.params.id]);
  if (!old) return res.redirect('/cases?err=Case+not+found');
  const formErr = caseFormError(b);
  if (formErr) return res.redirect(`/cases/${old.id}/edit?err=${encodeURIComponent(formErr)}`);
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  const { start: loanStart, tenure, unit: tenureUnit, maturity } = tenureFields(b);
  const t = lockedTerms(req.params.id, { principal_amount: principal, interest_amount: interest, interest_mode: mode,
    interest_rate: rate, interest_from: from, loan_start_date: loanStart, tenure, tenure_unit: tenureUnit, maturity_date: maturity });
  // Who owes the money is locked with the terms (F-24).
  const debtorId = termsLocked(old.id) ? old.debtor_id : Number(b.debtor_id);
  const next = { debtor_id: debtorId, agent_id: b.agent_id ? Number(b.agent_id) : null, priority: b.priority || 'medium', remark: b.remark || null,
    agreement_no: blank(b.agreement_no) ? null : String(b.agreement_no).trim(), agreement_date: blank(b.agreement_date) ? null : b.agreement_date, ...t };
  // Limits apply to changed terms only, so an older case can still get a new
  // agent or remark; its terms are re-planned through a restructure.
  // interest_amount is only a term of a fixed loan; a rate-based loan may carry a
  // stale value (older demo rows), which must not count as a change (D-1).
  const termKeys = ['principal_amount', 'interest_mode', 'interest_rate', 'loan_start_date', 'tenure',
    ...(t.interest_mode === 'fixed' || old.interest_mode === 'fixed' ? ['interest_amount'] : [])];
  if (termKeys.some(k => String(old[k] ?? '') !== String(t[k] ?? ''))) {
    const limitErr = loanLimitError(t);
    if (limitErr) return res.redirect(`/cases/${old.id}/edit?err=${encodeURIComponent(limitErr)}`);
  }
  run(`UPDATE cases SET debtor_id=?,agent_id=?,principal_amount=?,interest_amount=?,priority=?,remark=?,interest_mode=?,interest_rate=?,interest_from=?,loan_start_date=?,tenure=?,tenure_unit=?,maturity_date=?,agreement_no=?,agreement_date=?,updated_at=datetime('now') WHERE id=?`,
    [next.debtor_id,next.agent_id,t.principal_amount,t.interest_amount,next.priority,next.remark,t.interest_mode,t.interest_rate,t.interest_from,t.loan_start_date,t.tenure,t.tenure_unit,t.maturity_date,next.agreement_no,next.agreement_date,req.params.id]);
  const cid = Number(req.params.id);
  resyncCaseStatus(cid, req.session.user.full_name);
  // Reassignment (D-11): open tasks move to the new agent; done tasks and past
  // collections stay credited to whoever did them. Unassigning keeps the tasks
  // with the previous agent until someone new takes the case (N-13).
  let movedTasks = 0;
  if (next.agent_id !== null && (old.agent_id ?? null) !== next.agent_id) {
    movedTasks = run("UPDATE tasks SET agent_id=? WHERE case_id=? AND status='pending'", [next.agent_id, cid]).changes;
  }
  // Audit what actually changed, old → new, so a corrected term leaves a trace.
  const changes = Object.keys(next).filter(k => String(old[k] ?? '') !== String(next[k] ?? ''))
    .map(k => `${k}: ${old[k] ?? '—'} → ${next[k] ?? '—'}`);
  if (movedTasks) changes.push(`${movedTasks} open task(s) reassigned`);
  logAction(req,'update','case',cid,`Updated case ${old.case_no}${changes.length ? ': ' + changes.join('; ') : ' (no field changes)'}`);
  res.redirect(`/cases/${cid}?ok=Saved`);
});

router.get('/:id', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  logAccess(req, 'view', 'case', c.id, c.case_no);
  const timeline = all('SELECT * FROM timeline_events WHERE case_id=? ORDER BY created_at DESC, id DESC', [c.id]);
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date DESC', [c.id]);
  const voided = all("SELECT * FROM payment_history WHERE case_id=? AND change='void' ORDER BY changed_at DESC, id DESC", [c.id]);
  const ptps = all('SELECT * FROM ptps WHERE case_id=? ORDER BY (plan_id IS NULL), plan_id, installment_no, due_date DESC', [c.id]);
  const tasks = all('SELECT * FROM tasks WHERE case_id=? ORDER BY due_date', [c.id]);
  const calls = all('SELECT * FROM call_logs WHERE case_id=? ORDER BY call_time DESC', [c.id]);
  const restructures = restructuresOf(c.id);
  const { current: schedule, history: scheduleHistory } = scheduleView(c, payments, restructures);
  const lastRestructure = restructures[restructures.length - 1] || null;
  const asc = payments.slice().sort((a, b) => a.payment_date.localeCompare(b.payment_date));
  const restructureForm = canRestructure(c)
    ? { range: effectiveDateRange(c, asc, restructures), cut: balanceAtCut(c, asc, restructures, todayMYT()) }
    : null;
  const lock = lastRestructure ? lastRestructure.effective_date : null;
  const canUndo = !!lastRestructure && !payments.some(p => String(p.payment_date).slice(0, 10) > lock);
  const role = req.session.user.role;
  // The status menu an agent sees omits Fully Paid and terminal statuses (D-12).
  const statusOptions = role === 'agent' ? AGENT_STATUSES : CASE_STATUSES;
  res.render('cases/show', { title: c.case_no, c, timeline, payments, voided, ptps, callChannels: CALL_CHANNELS, callContacts: CALL_CONTACTS, tasks, calls, schedule,
    scheduleHistory, lastRestructure, lock, lockMin: afterLock(lock), restructureForm, canUndo,
    settlement: settlementOn(c.id, todayMYT()), arrears: arrearsOf(c, asc, restructures), frozen: FROZEN.includes(c.status),
    statuses: statusOptions, terminal: TERMINAL_STATUSES,
    readOnly: ['auditor','client'].includes(role) });
});

const { applyPayment } = require('../services/payments');
router.post('/:id/payments', requireLogin, requireRole('admin','manager','finance','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const v = validatePayment(req.body.amount, c.outstanding_amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
  // G-21: the same form submitted twice within seconds (double click, resubmit)
  // is one payment — matched on amount, date and reference, so two genuine
  // same-day payments with different references still both record.
  const dup = get(`SELECT receipt_no FROM payments WHERE case_id=? AND amount=? AND payment_date=? AND IFNULL(reference,'')=?
    AND created_at >= datetime('now','-10 seconds')`, [c.id, v.amount, req.body.payment_date, String(req.body.reference || '')]);
  // Said as such, so the user doesn't take it for a second payment (O-5).
  if (dup) return res.redirect(`/cases/${c.id}?ok=${encodeURIComponent(`Duplicate submission ignored: payment ${dup.receipt_no} was already recorded`)}`);
  const dateErr = paymentDateError(c.id, req.body.payment_date) || methodError(req.body.method)
    || (FROZEN.includes(c.status) && blank(req.body.remark) ? `A reason is required to accept a payment on a ${caseStatusLabel(c.status)} case` : null)
    || overpayError(c.id, { amount: v.amount, payment_date: req.body.payment_date });
  if (dateErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(dateErr)}`);
  const r = applyPayment(c.id, { ...req.body, amount: v.amount, remark: blank(req.body.remark) ? null : String(req.body.remark).trim() }, req);
  res.redirect(`/cases/${c.id}?ok=Payment+${r.receipt_no}+recorded`);
});

// Correct a recorded payment. New amount is validated against what outstanding
// WOULD be without this payment (current outstanding + this payment's amount).
router.post('/:id/payments/:pid', requireLogin, requireRole('admin','manager','finance'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const pay = get('SELECT * FROM payments WHERE id=? AND case_id=?', [req.params.pid, c.id]);
  if (!pay) return res.redirect(`/cases/${c.id}?err=Payment+not+found`);
  const lockErr = lockedPaymentError(c.id, pay) || paymentDateError(c.id, req.body.payment_date || String(pay.payment_date).slice(0, 10))
    || methodError(req.body.method);
  if (lockErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(lockErr)}`);
  const v = validatePayment(req.body.amount, c.outstanding_amount + pay.amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
  const by = req.session.user.full_name;
  const next = { amount: v.amount, payment_date: req.body.payment_date || pay.payment_date, method: req.body.method || pay.method,
    reference: req.body.reference || null, bank: req.body.bank || null };
  const overErr = overpayError(c.id, { amount: next.amount, payment_date: String(next.payment_date).slice(0, 10), replaceId: pay.id });
  if (overErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(overErr)}`);
  db.transaction(() => {
    snapshotPayment(pay.id, 'edit', null, by);
    run('UPDATE payments SET amount=?, payment_date=?, method=?, reference=?, bank=? WHERE id=?',
      [next.amount, next.payment_date, next.method, next.reference, next.bank, pay.id]);
    resyncCaseStatus(c.id, by);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [c.id, 'payment', `Payment ${pay.receipt_no} edited: RM ${pay.amount.toFixed(2)} → RM ${v.amount.toFixed(2)}`, by]);
  })();
  // The row as it stood is in payment_history (F-24); the audit names the change.
  const fmt = (k, x) => (x == null ? '—' : k === 'amount' ? Number(x).toFixed(2) : x);
  const changes = Object.keys(next).filter(k => String(pay[k] ?? '') !== String(next[k] ?? ''))
    .map(k => `${k} ${fmt(k, pay[k])} → ${fmt(k, next[k])}`);
  logAction(req, 'payment_edit', 'case', c.id, `Edited payment ${pay.receipt_no}${changes.length ? ': ' + changes.join('; ') : ''}`);
  res.redirect(`/cases/${c.id}?ok=Payment+updated`);
});

// Void a recorded payment: the row leaves the ledger, but a copy as it stood
// (with who voided it and why) stays in payment_history and on the case page
// (F-24). numbering.js keeps a high-water mark per year, so the receipt number
// is never reused — not even the newest one.
router.post('/:id/payments/:pid/void', requireLogin, requireRole('admin','manager','finance'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const pay = get('SELECT * FROM payments WHERE id=? AND case_id=?', [req.params.pid, c.id]);
  if (!pay) return res.redirect(`/cases/${c.id}?err=Payment+not+found`);
  const lockErr = lockedPaymentError(c.id, pay);
  if (lockErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(lockErr)}`);
  const by = req.session.user.full_name;
  const reason = String(req.body.reason ?? '').trim().slice(0, 500);
  const why = reason ? ` — ${reason}` : '';
  db.transaction(() => {
    snapshotPayment(pay.id, 'void', reason, by);
    run('DELETE FROM payments WHERE id=?', [pay.id]);
    resyncCaseStatus(c.id, by);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [c.id, 'payment', `Payment ${pay.receipt_no} voided (RM ${pay.amount.toFixed(2)})${why}`, by]);
  })();
  logAction(req, 'payment_void', 'case', c.id, `Voided payment ${pay.receipt_no} (RM ${pay.amount.toFixed(2)}, ${String(pay.payment_date).slice(0, 10)})${why}`);
  res.redirect(`/cases/${c.id}?ok=Payment+voided`);
});

router.post('/:id/ptps', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const frozen = frozenError(c);
  if (frozen) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(frozen)}`);
  const v = validatePayment(req.body.amount, c.outstanding_amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
  if (!isISODate(req.body.due_date)) return res.redirect(`/cases/${c.id}?err=Invalid+due+date`);
  if (req.body.due_date < todayMYT()) return res.redirect(`/cases/${c.id}?err=Due+date+cannot+be+in+the+past`);
  // ponytail: a double click / resubmit lands twice within seconds — treat an
  // identical pending PTP from the last 10s as the same request.
  if (get(`SELECT 1 FROM ptps WHERE case_id=? AND plan_id IS NULL AND amount=? AND due_date=? AND status='pending'
      AND created_at >= datetime('now','-10 seconds')`, [c.id, v.amount, req.body.due_date])) {
    return res.redirect(`/cases/${c.id}?ok=PTP+created`);
  }
  const capErr = promiseCapError(c.id, v.amount, req.body.due_date);
  if (capErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(capErr)}`);
  const by = req.session.user.full_name;
  run('INSERT INTO ptps (case_id,amount,due_date,remark,created_by) VALUES (?,?,?,?,?)', [c.id, v.amount, req.body.due_date, req.body.remark||null, by]);
  if (!TERMINAL_STATUSES.includes(c.status)) run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'ptp_created',`PTP RM ${v.amount.toFixed(2)} due ${req.body.due_date}`,by]);
  logAction(req,'ptp_create','case',c.id,`PTP created for case ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=PTP+created`);
});

// Generate an installment plan: split a total into N monthly PTP rows sharing a
// plan_id. Each row is a normal PTP — existing fulfill/break/status logic applies
// per installment. Returns { ok, error?, planId?, count? } for testability.
function createPtpPlan(caseId, body, req) {
  const c = get('SELECT id, outstanding_amount, status FROM cases WHERE id=?', [caseId]);
  if (!c) return { ok: false, error: 'Case not found' };
  const frozen = frozenError(c);
  if (frozen) return { ok: false, error: frozen };
  const v = validatePayment(body.total_amount, c.outstanding_amount);
  if (v.error) return { ok: false, error: v.error };
  const n = Number(body.num_installments);
  if (!Number.isInteger(n) || n < 2 || n > 60) return { ok: false, error: 'Installments must be 2–60' };
  if (!body.first_due_date) return { ok: false, error: 'First due date is required' };
  if (!isISODate(body.first_due_date)) return { ok: false, error: 'Invalid first due date' };
  if (body.first_due_date < todayMYT()) return { ok: false, error: 'First due date cannot be in the past' };
  if (v.amount < n * 0.01) return { ok: false, error: 'Total too small for the number of installments' };
  const amounts = splitInstallments(v.amount, n);
  const dates = dueDates(body.first_due_date, n);
  const capErr = promiseCapError(caseId, v.amount, dates[n - 1]);
  if (capErr) return { ok: false, error: capErr };
  // Same double-submit guard as a single PTP: an identical plan from the last 10s.
  if (get(`SELECT 1 FROM ptps WHERE case_id=? AND installment_no=1 AND plan_size=? AND amount=? AND due_date=?
      AND created_at >= datetime('now','-10 seconds')`, [caseId, n, amounts[0], dates[0]])) {
    return { ok: true, duplicate: true };
  }
  const planId = crypto.randomUUID();
  const by = req.session.user.full_name;
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      run('INSERT INTO ptps (case_id,amount,due_date,status,remark,created_by,plan_id,installment_no,plan_size) VALUES (?,?,?,?,?,?,?,?,?)',
        [caseId, amounts[i], dates[i], 'pending', `Installment ${i + 1}/${n}`, by, planId, i + 1, n]);
    }
    if (!TERMINAL_STATUSES.includes(c.status)) run("UPDATE cases SET status='ptp' WHERE id=?", [caseId]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [caseId, 'ptp_created', `Installment plan created: RM ${v.amount.toFixed(2)} in ${n} installments`, by]);
  })();
  logAction(req, 'ptp_plan_create', 'case', caseId, `Installment plan (${n}) for case ${caseId}`);
  return { ok: true, planId, count: n };
}

router.post('/:id/ptp-plans', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = createPtpPlan(c.id, req.body, req);
  if (!r.ok) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${c.id}?ok=Installment+plan+created`);
});

// Cancel a whole installment plan: break every still-pending installment in one
// action, then revert the case status exactly like breakPtp does for a single
// PTP (ptp -> negotiation once nothing is left pending).
function cancelPtpPlan(caseId, planId, req) {
  if (!get('SELECT 1 FROM ptps WHERE case_id=? AND plan_id=?', [caseId, planId])) return { ok: false, error: 'Installment plan not found' };
  const by = req.session.user.full_name;
  let broken = 0;
  db.transaction(() => {
    const r = run("UPDATE ptps SET status='broken' WHERE case_id=? AND plan_id=? AND status='pending'", [caseId, planId]);
    broken = r.changes;
    if (broken > 0) {
      run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
        [caseId, 'ptp_broken', `Installment plan cancelled (${broken} pending installment(s) broken)`, by]);
      const cur = get('SELECT status FROM cases WHERE id=?', [caseId]).status;
      const pending = get("SELECT COUNT(*) c FROM ptps WHERE case_id=? AND status='pending'", [caseId]).c;
      if (cur === 'ptp' && pending === 0) {
        run("UPDATE cases SET status='negotiation', updated_at=datetime('now') WHERE id=?", [caseId]);
        run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
          [caseId, 'status_change', 'Status changed ptp → negotiation', by]);
      }
    }
  })();
  logAction(req, 'ptp_plan_cancel', 'case', caseId, `Cancelled installment plan ${planId} (${broken} broken)`);
  return { ok: true, broken };
}

router.post('/:id/ptp-plans/:planId/cancel', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = cancelPtpPlan(c.id, req.params.planId, req);
  if (!r.ok) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${c.id}?ok=Installment+plan+cancelled`);
});

router.post('/:id/calls', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const frozen = frozenError(c);
  if (frozen) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(frozen)}`);
  const by = req.session.user.full_name;
  const dur = blank(req.body.duration_seconds) ? 0 : Number(req.body.duration_seconds);
  if (!Number.isInteger(dur) || dur < 0) return res.redirect(`/cases/${c.id}?err=Invalid+duration`);
  if (req.body.result && !CALL_RESULTS.includes(req.body.result)) return res.redirect(`/cases/${c.id}?err=Invalid+call+result`);
  const channel = blank(req.body.channel) ? 'phone' : req.body.channel, contact = blank(req.body.contact) ? 'debtor' : req.body.contact;
  if (!CALL_CHANNELS.includes(channel) || !CALL_CONTACTS.includes(contact)) return res.redirect(`/cases/${c.id}?err=Invalid+channel+or+contact`);
  const phone = blank(req.body.phone) ? null : String(req.body.phone).trim().slice(0, 40);
  // Credited to whoever made the contact: an agent's own id, none when a manager logs it (F-33).
  run('INSERT INTO call_logs (case_id,agent_id,duration_seconds,result,notes,channel,contact,phone,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [c.id, req.session.user.agent_id || null, dur, req.body.result||'no_answer', req.body.notes||null, channel, contact, phone, by]);
  const how = channel === 'phone' && contact === 'debtor' && !phone ? '' : ` · ${channel} to ${contact}${phone ? ' ' + phone : ''}`;
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
    [c.id,'call',`Call: ${req.body.result||'no_answer'} (${dur}s)${how}${req.body.notes?' — '+req.body.notes:''}`, by]);
  logAction(req,'call','case',c.id,`Logged call for ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=Call+logged`);
});

// Notes: the audit log keeps the text, so an edited or deleted note leaves a trace.
const MAX_NOTE = 5000;
const noteText = b => String(b.content ?? '').trim();
const findNote = (c, id) => get("SELECT * FROM timeline_events WHERE id=? AND case_id=? AND event_type='note'", [id, c.id]);
// Agents change only their own notes (D-12). Notes store the author's name.
// ponytail: matched on full_name; store the user id if two staff share a name.
const notOwnNote = (req, note) => req.session.user.role === 'agent' && note.created_by !== req.session.user.full_name;
router.post('/:id/notes', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const content = noteText(req.body);
  if (!content || content.length > MAX_NOTE) return res.redirect(`/cases/${c.id}?err=Note+must+be+1–${MAX_NOTE}+characters`);
  const r = run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'note',content,req.session.user.full_name]);
  logAction(req, 'note_add', 'case', c.id, `Note ${r.lastInsertRowid}: ${content}`);
  res.redirect(`/cases/${c.id}?ok=Note+added`);
});
router.post('/:id/notes/:noteId', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const note = findNote(c, req.params.noteId);
  if (!note) return res.redirect(`/cases/${c.id}?err=Note+not+found`);
  if (notOwnNote(req, note)) return res.redirect(`/cases/${c.id}?err=You+can+only+change+your+own+notes`);
  const content = noteText(req.body);
  if (!content || content.length > MAX_NOTE) return res.redirect(`/cases/${c.id}?err=Note+must+be+1–${MAX_NOTE}+characters`);
  run('UPDATE timeline_events SET content=? WHERE id=?', [content, note.id]);
  logAction(req, 'note_edit', 'case', c.id, `Note ${note.id}: ${note.content} → ${content}`);
  res.redirect(`/cases/${c.id}?ok=Note+updated`);
});
router.post('/:id/notes/:noteId/delete', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const note = findNote(c, req.params.noteId);
  if (!note) return res.redirect(`/cases/${c.id}?err=Note+not+found`);
  if (notOwnNote(req, note)) return res.redirect(`/cases/${c.id}?err=You+can+only+change+your+own+notes`);
  run('DELETE FROM timeline_events WHERE id=?', [note.id]);
  logAction(req, 'note_delete', 'case', c.id, `Deleted note ${note.id} (by ${note.created_by || '—'}): ${note.content}`);
  res.redirect(`/cases/${c.id}?ok=Note+deleted`);
});
router.post('/:id/status', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const ns = req.body.status;
  if (!CASE_STATUSES.includes(ns)) return res.redirect(`/cases/${c.id}?err=Invalid+status`);
  const fail = msg => res.redirect(`/cases/${c.id}?err=${encodeURIComponent(msg)}`);
  // O-6: re-sending the current status changes nothing, so it leaves no timeline or audit entry.
  if (ns === c.status) return res.redirect(`/cases/${c.id}?ok=Status+unchanged`);
  if (req.session.user.role === 'agent') {
    // D-12 / G-02: an agent neither sets nor lifts a terminal or paid-off status.
    if (ns !== c.status && !AGENT_STATUSES.includes(c.status)) return fail(`Only a manager can change a ${caseStatusLabel(c.status)} case`);
    if (!AGENT_STATUSES.includes(ns)) return fail(`Only a manager can set ${caseStatusLabel(ns)}`);
  }
  if (ns === 'fully_paid' && c.outstanding_amount > 0.005) return fail(`Cannot mark Fully Paid: RM ${money(c.outstanding_amount)} is still owed`);
  // N-08: lifting bankruptcy / deceased must say why (e.g. "bankruptcy order annulled").
  const reason = String(req.body.reason ?? '').trim();
  if (FROZEN.includes(c.status) && !FROZEN.includes(ns) && !reason) return fail(`A reason is required to lift ${caseStatusLabel(c.status)}`);
  const by = req.session.user.full_name;
  const note = reason ? ` — ${reason}` : '';
  db.transaction(() => {
    // closed_at follows the status: set when it closes, cleared when it reopens.
    run(`UPDATE cases SET status=?, closed_at=CASE WHEN ? IN ('closed','fully_paid','cancelled') THEN datetime('now') ELSE NULL END,
      updated_at=datetime('now') WHERE id=?`, [ns, ns, c.id]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id, 'status_change', `Status changed ${c.status} → ${ns}${note}`, by]);
    // N-08: freezing a case closes its open promises — they can't be collected on.
    if (FROZEN.includes(ns) && !FROZEN.includes(c.status)) {
      const n = run("UPDATE ptps SET status='broken' WHERE case_id=? AND status='pending'", [c.id]).changes;
      if (n) run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
        [c.id, 'ptp_broken', `${n} pending promise(s) closed: case marked ${caseStatusLabel(ns)}`, by]);
    }
  })();
  logAction(req, 'status_change', 'case', c.id, `Status ${c.status} → ${ns}${reason ? ' — reason: ' + reason : ''}`);
  res.redirect(`/cases/${c.id}?ok=Status+updated`);
});

router.post('/:id/restructures', requireLogin, requireRole('admin','manager'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = createRestructure(c.id, req.body, req);
  if (!r.ok) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${c.id}?ok=Restructured`);
});
router.post('/:id/restructures/:rid/undo', requireLogin, requireRole('admin','manager'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = undoRestructure(c.id, req.params.rid, req);
  if (!r.ok) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${c.id}?ok=Restructure+undone`);
});

module.exports = { router, loadCase, createPtpPlan, cancelPtpPlan };
