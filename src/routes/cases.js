const express = require('express');
const { db, all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const { nextCaseNo } = require('../utils/numbering');
const { resyncCaseStatus, recomputeOutstanding, TERMINAL_STATUSES } = require('../services/payments');
const { toCsv, sendCsv } = require('../utils/csv');
const { caseStatusLabel, dateFmt, round2 } = require('../utils/helpers');
const { splitInstallments, dueDates } = require('../utils/installments');
const crypto = require('node:crypto');
const router = express.Router();

const CASE_STATUSES = ['new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased'];
const PRIORITIES = ['low','medium','high','urgent'];
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
    debtors.phone AS debtor_phone, debtors.ic_passport, agents.name AS agent_name
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE cases.id=? AND ${w.clause}`, [req.params.id, ...w.params]);
  if (!c) { res.status(404).render('error', { message: 'Case not found or access denied' }); return null; }
  return c;
}

// Parse the interest-model form fields. Unknown mode falls back to 'fixed';
// rate/from only matter for accrual modes (blanked otherwise so a mode switch
// back to fixed doesn't leave stale values).
function interestFields(b) {
  const mode = ['fixed', 'monthly', 'daily'].includes(b.interest_mode) ? b.interest_mode : 'fixed';
  if (mode === 'fixed') return { mode, rate: 0, from: null };
  return { mode, rate: Number(b.interest_rate) || 0, from: b.interest_from || null };
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
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE ${filters.join(' AND ')} ORDER BY cases.opened_at DESC`, params);
  if (req.query.format === 'csv') {
    const rows = cases.map(c => [c.case_no, c.debtor_name, c.debtor_phone || '', c.agent_name || '', c.outstanding_amount, round2(c.paid), c.priority, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
    return sendCsv(res, 'cases.csv', toCsv(['Case No', 'Debtor', 'Debtor Phone', 'Agent', 'Outstanding', 'Paid', 'Priority', 'Status', 'Opened'], rows));
  }
  res.render('cases/list', { title: 'Cases', cases, statuses: CASE_STATUSES, priorities: PRIORITIES });
});

router.get('/new', requireLogin, noAgentCreate, (req, res) => {
  res.render('cases/form', { title: 'New Case', c: {}, action: '/cases',
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES });
});
router.post('/', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  if (!b.debtor_id || b.principal_amount === undefined || b.principal_amount === '') {
    return res.redirect('/cases/new?err=Debtor+and+principal+are+required');
  }
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  // Accrual modes start with ~0 interest; the manual interest field only applies to fixed.
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  const case_no = nextCaseNo();
  const r = run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,remark,next_action_at,interest_mode,interest_rate,interest_from)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [case_no, internalClientId(), b.debtor_id, b.agent_id||null, principal, interest, principal+interest, b.priority||'medium', b.status||'new', b.remark||null, b.next_action_at||null, mode, rate, from]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [r.lastInsertRowid,'note',`Case ${case_no} created`,req.session.user.full_name]);
  logAction(req,'create','case',r.lastInsertRowid,`Created case ${case_no}`);
  res.redirect(`/cases/${r.lastInsertRowid}?ok=Case+created`);
});
router.get('/:id/edit', requireLogin, noAgentCreate, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  res.render('cases/form', { title: 'Edit Case', c, action: `/cases/${c.id}`,
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES });
});
router.get('/:id/statement', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date', [c.id]);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const company = get('SELECT * FROM settings WHERE id=1') || {};
  res.render('cases/statement', { c, payments, paid, today, company });
});
router.post('/:id', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  if (!b.debtor_id || b.principal_amount === undefined || b.principal_amount === '') {
    return res.redirect('/cases/'+req.params.id+'/edit?err=Debtor+and+principal+are+required');
  }
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  run(`UPDATE cases SET debtor_id=?,agent_id=?,principal_amount=?,interest_amount=?,priority=?,remark=?,next_action_at=?,interest_mode=?,interest_rate=?,interest_from=?,updated_at=datetime('now') WHERE id=?`,
    [b.debtor_id,b.agent_id||null,principal,interest,b.priority||'medium',b.remark||null,b.next_action_at||null,mode,rate,from,req.params.id]);
  const cid = Number(req.params.id);
  resyncCaseStatus(cid, req.session.user.full_name);
  logAction(req,'update','case',cid,`Updated case ${cid}`);
  res.redirect(`/cases/${cid}?ok=Saved`);
});

router.get('/:id', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const timeline = all('SELECT * FROM timeline_events WHERE case_id=? ORDER BY created_at DESC', [c.id]);
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date DESC', [c.id]);
  const ptps = all('SELECT * FROM ptps WHERE case_id=? ORDER BY (plan_id IS NULL), plan_id, installment_no, due_date DESC', [c.id]);
  const tasks = all('SELECT * FROM tasks WHERE case_id=? ORDER BY due_date', [c.id]);
  const calls = all('SELECT * FROM call_logs WHERE case_id=? ORDER BY call_time DESC', [c.id]);
  res.render('cases/show', { title: c.case_no, c, timeline, payments, ptps, tasks, calls,
    statuses: CASE_STATUSES, terminal: TERMINAL_STATUSES,
    readOnly: ['auditor','client'].includes(req.session.user.role) });
});

const { applyPayment } = require('../services/payments');
const { validatePayment } = require('../utils/forms');
router.post('/:id/payments', requireLogin, requireRole('admin','manager','finance','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const v = validatePayment(req.body.amount, c.outstanding_amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
  const r = applyPayment(c.id, { ...req.body, amount: v.amount }, req);
  res.redirect(`/cases/${c.id}?ok=Payment+${r.receipt_no}+recorded`);
});

// Correct a recorded payment. New amount is validated against what outstanding
// WOULD be without this payment (current outstanding + this payment's amount).
router.post('/:id/payments/:pid', requireLogin, requireRole('admin','manager','finance'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const pay = get('SELECT * FROM payments WHERE id=? AND case_id=?', [req.params.pid, c.id]);
  if (!pay) return res.redirect(`/cases/${c.id}?err=Payment+not+found`);
  const v = validatePayment(req.body.amount, c.outstanding_amount + pay.amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
  const by = req.session.user.full_name;
  db.transaction(() => {
    run('UPDATE payments SET amount=?, payment_date=?, method=?, reference=?, bank=? WHERE id=?',
      [v.amount, req.body.payment_date || pay.payment_date, req.body.method || pay.method, req.body.reference || null, req.body.bank || null, pay.id]);
    resyncCaseStatus(c.id, by);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [c.id, 'payment', `Payment ${pay.receipt_no} edited: RM ${pay.amount.toFixed(2)} → RM ${v.amount.toFixed(2)}`, by]);
  })();
  logAction(req, 'payment_edit', 'case', c.id, `Edited payment ${pay.receipt_no}`);
  res.redirect(`/cases/${c.id}?ok=Payment+updated`);
});

// Void (delete) a recorded payment. MAX+1 numbering (#8) means the freed receipt
// number is never wrongly reused. The timeline + audit keep the paper trail.
// ponytail: hard delete; add a `voided` flag only if an immutable ledger is required.
router.post('/:id/payments/:pid/void', requireLogin, requireRole('admin','manager','finance'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const pay = get('SELECT * FROM payments WHERE id=? AND case_id=?', [req.params.pid, c.id]);
  if (!pay) return res.redirect(`/cases/${c.id}?err=Payment+not+found`);
  const by = req.session.user.full_name;
  db.transaction(() => {
    run('DELETE FROM payments WHERE id=?', [pay.id]);
    resyncCaseStatus(c.id, by);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [c.id, 'payment', `Payment ${pay.receipt_no} voided (RM ${pay.amount.toFixed(2)})`, by]);
  })();
  logAction(req, 'payment_void', 'case', c.id, `Voided payment ${pay.receipt_no}`);
  res.redirect(`/cases/${c.id}?ok=Payment+voided`);
});

router.post('/:id/ptps', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const v = validatePayment(req.body.amount, c.outstanding_amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
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
  const v = validatePayment(body.total_amount, c.outstanding_amount);
  if (v.error) return { ok: false, error: v.error };
  const n = Number(body.num_installments);
  if (!Number.isInteger(n) || n < 2 || n > 60) return { ok: false, error: 'Installments must be 2–60' };
  if (!body.first_due_date) return { ok: false, error: 'First due date is required' };
  if (v.amount < n * 0.01) return { ok: false, error: 'Total too small for the number of installments' };
  const amounts = splitInstallments(v.amount, n);
  const dates = dueDates(body.first_due_date, n);
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
  cancelPtpPlan(c.id, req.params.planId, req);
  res.redirect(`/cases/${c.id}?ok=Installment+plan+cancelled`);
});

router.post('/:id/calls', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const by = req.session.user.full_name;
  const dur = Number(req.body.duration_seconds)||0;
  run('INSERT INTO call_logs (case_id,agent_id,duration_seconds,result,notes) VALUES (?,?,?,?,?)',
    [c.id, req.session.user.agent_id||c.agent_id||null, dur, req.body.result||'no_answer', req.body.notes||null]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
    [c.id,'call',`Call: ${req.body.result||'no_answer'} (${dur}s)${req.body.notes?' — '+req.body.notes:''}`, by]);
  logAction(req,'call','case',c.id,`Logged call for ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=Call+logged`);
});

router.post('/:id/notes', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'note',req.body.content||'',req.session.user.full_name]);
  res.redirect(`/cases/${c.id}?ok=Note+added`);
});
router.post('/:id/notes/:noteId', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  run("UPDATE timeline_events SET content=? WHERE id=? AND case_id=? AND event_type='note'",
    [req.body.content || '', req.params.noteId, c.id]);
  res.redirect(`/cases/${c.id}?ok=Note+updated`);
});
router.post('/:id/notes/:noteId/delete', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  run("DELETE FROM timeline_events WHERE id=? AND case_id=? AND event_type='note'",
    [req.params.noteId, c.id]);
  res.redirect(`/cases/${c.id}?ok=Note+deleted`);
});
router.post('/:id/status', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const ns = req.body.status;
  if (!CASE_STATUSES.includes(ns)) return res.redirect(`/cases/${c.id}?err=Invalid+status`);
  run("UPDATE cases SET status=?, closed_at=CASE WHEN ? IN ('closed','fully_paid','cancelled') THEN datetime('now') ELSE closed_at END, updated_at=datetime('now') WHERE id=?", [ns, ns, c.id]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'status_change',`Status changed ${c.status} → ${ns}`,req.session.user.full_name]);
  logAction(req,'status_change','case',c.id,`Status ${c.status} → ${ns}`);
  res.redirect(`/cases/${c.id}?ok=Status+updated`);
});

module.exports = { router, loadCase, createPtpPlan, cancelPtpPlan };
