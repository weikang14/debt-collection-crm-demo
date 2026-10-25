process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsledger-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const { caseBalance, recomputeOutstanding } = require('../src/services/payments');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

// Segment mechanics, so the fixtures use the daily (annual %) mode for clean
// per-day numbers: 3000 @ 36.5% p.a. => 3.00/day; 18.25% p.a. => 1.50/day.
// Whole-month accrual of the monthly mode is covered at the end of this file.
const base = { interest_mode: 'daily', principal_amount: 3000, interest_rate: 36.5, interest_from: '2026-01-01', maturity_date: '2026-04-01' };
const r1 = { effective_date: '2026-01-11', interest_mode: 'daily', interest_rate: 18.25, interest_amount: 0, maturity_date: '2026-01-21' };

test('cut snapshot: balance as of the effective date', () => {
  const b = caseBalance(base, [], '2026-01-11');
  near(b.principalRemaining, 3000, 'principal');
  near(b.interestUnpaid, 30, 'arrears = 10 days x 3.00');
});

test('restructure: arrears carried without accruing, principal continues under new terms', () => {
  const b = caseBalance(base, [], undefined, [r1]);
  near(b.interest, 45, '30 arrears + 10 days x 1.50');
  near(b.outstanding, 3045, 'outstanding');
  near(b.principalRemaining, 3000, 'principal');
  near(b.interestUnpaid, 45, 'unpaid interest');
});

test('after the cut a payment clears arrears, then new interest, then principal', () => {
  // 01-16: unpaid 30 + 5d x 1.50 = 37.50 -> pay 100 = 37.50 interest + 62.50 principal.
  // 01-16 -> 01-21: 5d x 2937.50 x 0.0005 = 7.34375.
  const b = caseBalance(base, [{ amount: 100, payment_date: '2026-01-16' }], undefined, [r1]);
  near(b.principalRemaining, 2937.5, 'principal');
  near(b.interest, 44.84, 'interest');
  near(b.outstanding, 2944.84, 'outstanding');
  near(b.principal + b.interest - b.paid, b.outstanding, 'identity');
});

test('a payment before the effective date belongs to the old segment', () => {
  // 01-06: 15.00 accrued -> pay 100 = 15 + 85 principal -> 2915.
  // 01-06 -> 01-11: 5d x 2.915 = 14.575 arrears. New: 10d x 2915 x 0.0005 = 14.575.
  const b = caseBalance(base, [{ amount: 100, payment_date: '2026-01-06' }], undefined, [r1]);
  near(b.principalRemaining, 2915, 'principal');
  near(b.interest, 44.15, 'interest');
  near(b.outstanding, 2944.15, 'outstanding');
});

test('fixed -> daily: the original lump is charged once and carried as arrears', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1000, interest_amount: 200, opened_at: '2026-01-01' };
  const r = { effective_date: '2026-01-11', interest_mode: 'daily', interest_rate: 36.5, interest_amount: 0, maturity_date: '2026-01-21' };
  const b = caseBalance(c, [{ amount: 150, payment_date: '2026-01-05' }], undefined, [r]);
  near(b.principalRemaining, 1000, 'payment went to the lump, not principal');
  near(b.interest, 210, '200 lump + 10 days x 1.00');
  near(b.outstanding, 1060, 'outstanding');
});

test('daily -> fixed: the new lump is charged at the effective date on top of arrears', () => {
  const r = { effective_date: '2026-01-11', interest_mode: 'fixed', interest_rate: 0, interest_amount: 100, maturity_date: '2026-07-11' };
  const b = caseBalance(base, [], undefined, [r]);
  near(b.interest, 130, '30 arrears + 100 lump');
  near(b.outstanding, 3130, 'outstanding');
});

test('two restructures: segment 1 ends where segment 2 begins', () => {
  const ra = { ...r1, maturity_date: '2026-12-31' };
  const rb = { effective_date: '2026-01-21', interest_mode: 'daily', interest_rate: 36.5, interest_amount: 0, maturity_date: '2026-01-31' };
  const b = caseBalance(base, [], undefined, [ra, rb]);
  near(b.interest, 75, '30 + 10d x 1.50 + 10d x 3.00 (36.5%/365 = 0.001/day)');
});

test('a payment dated before interest starts does not pull the accrual origin backwards', () => {
  // Accrual must run 01-01 -> 01-11 on 2999 (10 days), not from 12-25 (17 days).
  const b = caseBalance(base, [{ amount: 1, payment_date: '2025-12-25' }], new Date('2026-01-11'));
  near(b.interest, 29.99, 'interest');
});

test('recomputeOutstanding applies stored restructures', () => {
  db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
  db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from,maturity_date)
    VALUES (1,'R1',1,1,3000,0,3000,'new','daily',36.5,'2026-01-01','2026-04-01')`);
  db.run(`INSERT INTO case_restructures (case_id,effective_date,reason,interest_mode,interest_rate,interest_amount,tenure,maturity_date,principal_at_cut,arrears_at_cut)
    VALUES (1,'2026-01-11','t','daily',18.25,0,1,'2026-01-21',3000,30)`);
  near(recomputeOutstanding(1), 3045, 'outstanding');
  const row = db.get('SELECT interest_charged, interest_amount FROM cases WHERE id=1');
  near(row.interest_charged, 45, 'interest_charged');
  assert.strictEqual(row.interest_amount, 0);
});

test('interest stops at a segment maturity, so restructuring a matured loan adds nothing', () => {
  // base matures 2026-04-01 after 90 days x 3.00 = 270. A cut two months later must not
  // charge 04-01 -> 06-01, and a 0% restructure must leave the debt unchanged.
  near(caseBalance(base, [], '2026-06-01').interestUnpaid, 270, 'snapshot stops at maturity');
  const r = { effective_date: '2026-06-01', interest_mode: 'fixed', interest_rate: 0, interest_amount: 0, maturity_date: '2026-12-01' };
  near(caseBalance(base, [], undefined, [r]).outstanding, 3270, '0% restructure keeps the debt');
});

test('a payment after maturity does not accrue interest past maturity', () => {
  const b = caseBalance(base, [{ amount: 100, payment_date: '2026-05-01' }]);
  near(b.interest, 270, 'interest stops at 04-01 even though the payment came a month later');
  near(b.outstanding, 3170, 'outstanding');
});

test('D-04: a payment ON the effective date belongs to the old segment', () => {
  // 01-11: 30.00 accrued -> pay 100 = 30 interest + 70 principal -> 2930, no arrears.
  // New segment 01-11 -> 01-21: 10d x 2930 x 0.0005 = 14.65.
  const b = caseBalance(base, [{ amount: 100, payment_date: '2026-01-11' }], undefined, [r1]);
  near(b.principalRemaining, 2930, 'principal');
  near(b.interest, 44.65, 'interest');
  near(b.outstanding, 2944.65, 'outstanding');
});

test('D-01: a monthly-rate segment accrues whole months from its own effective date', () => {
  // 30.00 carried at 01-11, then 3000 x 1.5% x 2 months (01-11 -> 03-11) = 90.00.
  const r = { effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: 1.5, interest_amount: 0, maturity_date: '2026-03-11' };
  near(caseBalance(base, [], undefined, [r]).interest, 120, '30 arrears + 2 months x 45.00');
});
