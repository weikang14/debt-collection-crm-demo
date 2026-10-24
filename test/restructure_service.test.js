process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsservice-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const { recomputeOutstanding } = require('../src/services/payments');
const rs = require('../src/services/restructure');
const { todayMYT } = require('../src/utils/helpers');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);
const req = { session: { user: { username: 'mgr', full_name: 'Manager' } }, ip: '127.0.0.1' };
const terms = (o = {}) => ({ effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'hardship', ...o });

db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
let seq = 0;
// 3000 @ 3%/month from 2026-01-01 (3.00/day), 3-month term.
function newCase(o = {}) {
  const r = db.run(`INSERT INTO cases (case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from,opened_at,maturity_date)
    VALUES (?,1,1,3000,0,3000,?,'monthly',3,'2026-01-01','2026-01-01 00:00:00','2026-04-01')`, ['S' + (++seq), o.status || 'negotiation']);
  const id = Number(r.lastInsertRowid);
  recomputeOutstanding(id);
  return id;
}
const pay = (id, amount, date) => { db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (?,?,?,?)", [id, 'P' + (++seq), date, amount]); recomputeOutstanding(id); };
const caseRow = id => db.get('SELECT * FROM cases WHERE id=?', [id]);

test('createRestructure stores the cut snapshot, recomputes, and logs', () => {
  const id = newCase();
  pay(id, 103, '2026-01-06'); // 15 interest + 88 principal -> 2912; 01-06->01-11 accrues 14.56
  const r = rs.createRestructure(id, terms(), req);
  assert.ok(r.ok, r.error);
  const row = db.get('SELECT * FROM case_restructures WHERE id=?', [r.id]);
  near(row.principal_at_cut, 2912, 'principal_at_cut');
  near(row.arrears_at_cut, 14.56, 'arrears_at_cut');
  assert.strictEqual(row.maturity_date, '2027-01-11');
  assert.strictEqual(row.created_by, 'Manager');
  near(caseRow(id).outstanding_amount, 2912 + 14.56 + 531.44, 'outstanding = principal + arrears + 365d x 1.456');
  assert.ok(db.get("SELECT 1 x FROM timeline_events WHERE case_id=? AND event_type='note' AND content LIKE 'Restructure:%'", [id]));
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action='restructure' AND entity_id=?", [id]));
});

test('a payment ON the effective date is excluded from the snapshot (new segment)', () => {
  const id = newCase();
  pay(id, 40, '2026-01-11');
  const r = rs.createRestructure(id, terms(), req);
  assert.ok(r.ok, r.error);
  const row = db.get('SELECT * FROM case_restructures WHERE id=?', [r.id]);
  near(row.principal_at_cut, 3000, 'principal untouched by the same-day payment');
  near(row.arrears_at_cut, 30, 'arrears = 10 days x 3.00');
});

test('effective date bounds: after loan start, not before last payment, not after today, after previous restructure', () => {
  const id = newCase();
  assert.match(rs.createRestructure(id, terms({ effective_date: '2025-12-31' }), req).error, /between/);
  pay(id, 10, '2026-01-20');
  assert.match(rs.createRestructure(id, terms({ effective_date: '2026-01-19' }), req).error, /between/);
  const tomorrow = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  assert.match(rs.createRestructure(id, terms({ effective_date: tomorrow }), req).error, /between/);
  assert.ok(rs.createRestructure(id, terms({ effective_date: '2026-01-20' }), req).ok);
  assert.match(rs.createRestructure(id, terms({ effective_date: '2026-01-20' }), req).error, /between/);
  assert.ok(rs.createRestructure(id, terms({ effective_date: '2026-01-21' }), req).ok);
});

test('restructuring twice on the same day leaves no valid date', () => {
  const id = newCase();
  assert.ok(rs.createRestructure(id, terms({ effective_date: todayMYT() }), req).ok);
  const range = rs.effectiveDateRange(caseRow(id), [], rs.restructuresOf(id));
  assert.ok(range.min > range.max);
});

test('eligibility: no outstanding, closed or cancelled cases are refused', () => {
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 0, status: 'negotiation' }), false);
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 10, status: 'closed' }), false);
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 10, status: 'cancelled' }), false);
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 10, status: 'legal' }), true);
  const id = newCase({ status: 'closed' });
  assert.match(rs.createRestructure(id, terms(), req).error, /cannot be restructured/);
});

test('parseTerms rejects bad input', () => {
  assert.match(rs.parseTerms(terms({ effective_date: '2026-02-30' })).error, /date/);
  assert.match(rs.parseTerms(terms({ interest_mode: 'weekly' })).error, /mode/);
  assert.match(rs.parseTerms(terms({ interest_rate: '-1' })).error, /rate/);
  assert.match(rs.parseTerms(terms({ interest_mode: 'fixed', interest_amount: '-5' })).error, /amount/);
  for (const t of ['0', '121', '1.5', '']) assert.match(rs.parseTerms(terms({ tenure: t })).error, /Tenure/);
  assert.match(rs.parseTerms(terms({ reason: '   ' })).error, /Reason/);
  const ok = rs.parseTerms(terms({ interest_mode: 'fixed', interest_amount: '250', interest_rate: '9' }));
  assert.strictEqual(ok.interest_rate, 0);
  assert.strictEqual(ok.interest_amount, 250);
  assert.strictEqual(ok.tenure, 12);
});

test('undo: only the latest, only with no payments on/after it, and restores the balance', () => {
  const id = newCase();
  const before = caseRow(id).outstanding_amount;
  const a = rs.createRestructure(id, terms({ effective_date: '2026-01-11' }), req);
  const b = rs.createRestructure(id, terms({ effective_date: '2026-01-15' }), req);
  assert.match(rs.undoRestructure(id, a.id, req).error, /latest/);
  pay(id, 5, '2026-01-15');
  assert.match(rs.undoRestructure(id, b.id, req).error, /Payments exist/);
  db.run('DELETE FROM payments WHERE case_id=?', [id]);
  assert.ok(rs.undoRestructure(id, b.id, req).ok);
  assert.ok(rs.undoRestructure(id, a.id, req).ok);
  near(caseRow(id).outstanding_amount, before, 'balance back to pre-restructure');
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action='restructure_undo' AND entity_id=?", [id]));
});

test('payment locks: dates before the latest effective date are frozen', () => {
  const id = newCase();
  assert.strictEqual(rs.paymentDateError(id, '2026-01-01'), null);
  rs.createRestructure(id, terms({ effective_date: '2026-01-11' }), req);
  assert.match(rs.paymentDateError(id, '2026-01-10'), /restructure date/);
  assert.strictEqual(rs.paymentDateError(id, '2026-01-11'), null);
  assert.match(rs.lockedPaymentError(id, { payment_date: '2026-01-10' }), /restructured period/);
  assert.strictEqual(rs.lockedPaymentError(id, { payment_date: '2026-01-11' }), null);
});

test('lockedTerms keeps the stored loan terms once a case is restructured', () => {
  const id = newCase();
  const form = { principal_amount: 9999, interest_amount: 0, interest_mode: 'fixed', interest_rate: 0, interest_from: null,
    loan_start_date: null, tenure: null, tenure_unit: 'months', maturity_date: null };
  assert.deepStrictEqual(rs.lockedTerms(id, form), form);
  rs.createRestructure(id, terms(), req);
  const t = rs.lockedTerms(id, form);
  assert.strictEqual(t.principal_amount, 3000);
  assert.strictEqual(t.interest_mode, 'monthly');
  assert.strictEqual(t.maturity_date, '2026-04-01');
});

test('scheduleView: current segment with arrears row, history with the superseded schedule', () => {
  const c = { interest_mode: 'monthly', interest_rate: 3, interest_from: '2026-01-01', loan_start_date: '2026-01-01',
    tenure: 3, tenure_unit: 'months', principal_amount: 3000, interest_amount: 0, outstanding_amount: 3000 };
  const r = { id: 1, effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: 1.5, interest_amount: 0,
    tenure: 3, principal_at_cut: 3000, arrears_at_cut: 30 };
  const payments = [{ amount: 35, payment_date: '2026-01-12' }, { amount: 50, payment_date: '2026-01-05' }];
  const v = rs.scheduleView(c, payments, [r]);
  assert.strictEqual(v.history.length, 1);
  assert.strictEqual(v.history[0].restructure, r);
  near(v.history[0].rows[0].paid_amount, 50, 'old segment only sees the 01-05 payment');
  assert.strictEqual(v.history[0].rows[0].status, 'restructured');
  assert.strictEqual(v.current.length, 4);
  assert.strictEqual(v.current[0].kind, 'arrears');
  assert.strictEqual(v.current[0].status, 'paid');
  near(v.current[1].paid_amount, 5, 'new segment sees only the 01-12 payment');
  near(v.current[1].expected_amount, 46.5, '3000 x 0.0005 x 31 days');
});

test('scheduleView: original terms without a tenure give an empty superseded table', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1000, interest_amount: 80, opened_at: '2026-01-01 00:00:00', outstanding_amount: 1080 };
  const r = { id: 2, effective_date: '2026-01-11', interest_mode: 'fixed', interest_rate: 0, interest_amount: 0,
    tenure: 2, principal_at_cut: 1000, arrears_at_cut: 80 };
  const v = rs.scheduleView(c, [], [r]);
  assert.deepStrictEqual(v.history[0].rows, []);
  assert.deepStrictEqual(v.current.map(x => x.expected_amount), [80, 500, 500]);
});

test('scheduleView without restructures is the plain schedule', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1000, interest_amount: 0, loan_start_date: '2026-01-01',
    tenure: 2, tenure_unit: 'months', outstanding_amount: 1000 };
  const v = rs.scheduleView(c, [], []);
  assert.deepStrictEqual(v.history, []);
  assert.deepStrictEqual(v.current.map(x => x.expected_amount), [500, 500]);
});

test('timestamped payment dates (demo data) still allow an effective date on the payment day', () => {
  const id = newCase();
  pay(id, 10, '2026-01-20 10:00:00');
  const range = rs.effectiveDateRange(caseRow(id), [{ payment_date: '2026-01-20 10:00:00' }], []);
  assert.strictEqual(range.min, '2026-01-20');
  assert.ok(rs.createRestructure(id, terms({ effective_date: '2026-01-20' }), req).ok);
});

test('a blank rate or fixed amount is refused instead of silently meaning 0', () => {
  assert.match(rs.parseTerms(terms({ interest_rate: '' })).error, /rate is required/);
  assert.match(rs.parseTerms(terms({ interest_mode: 'fixed', interest_amount: '' })).error, /amount is required/);
  assert.strictEqual(rs.parseTerms(terms({ interest_rate: '0' })).interest_rate, 0);
});
