process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-interest-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const { caseBalance, recomputeOutstanding } = require('../src/services/payments');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

test('fixed mode: interest is the lump sum, outstanding = principal + interest - paid', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1000, interest_amount: 200 };
  const b = caseBalance(c, [{ amount: 500, payment_date: '2026-01-10' }]);
  assert.strictEqual(b.interest, 200);
  assert.strictEqual(b.outstanding, 700);
});

test('daily mode: no payments accrues annual rate /365 on principal', () => {
  // 36500 @ 10%/yr => exactly 10.00/day. 10 days => 100.00 interest.
  const c = { interest_mode: 'daily', principal_amount: 36500, interest_rate: 10, interest_from: '2026-01-01' };
  const b = caseBalance(c, [], new Date('2026-01-11'));
  near(b.interest, 100, 'interest');
  near(b.outstanding, 36600, 'outstanding');
});

test('daily mode is 先息后本: a payment clears interest first, then principal, shrinking later interest', () => {
  const c = { interest_mode: 'daily', principal_amount: 36500, interest_rate: 10, interest_from: '2026-01-01' };
  // Day 5: 50.00 accrued. Pay 3700 => 50 interest + 3650 principal => remP 32850.
  // Day 5->11 (5d): 32850 @ 10%/yr = 9.00/day => 45.00.
  const b = caseBalance(c, [{ amount: 3700, payment_date: '2026-01-06' }], new Date('2026-01-11'));
  near(b.interest, 95, 'total interest charged');      // 50 + 45, NOT 100 — proves accrual on remaining principal
  near(b.outstanding, 32895, 'outstanding');           // 32850 principal + 45 unpaid interest
  near(b.principal + b.interest - b.paid, b.outstanding, 'identity holds'); // 36500+95-3700
});

test('monthly mode accrues rate × whole months; a part month by its share of days (D-01)', () => {
  const c = { interest_mode: 'monthly', principal_amount: 3000, interest_rate: 2, interest_from: '2026-01-01' };
  // 2%/mo on 3000 = 60.00 per month. 01-01 -> 01-16 is 15 of January's 31 days.
  near(caseBalance(c, [], new Date('2026-01-16')).interest, 60 * 15 / 31, 'part month');
  near(caseBalance(c, [], new Date('2026-03-01')).interest, 120, 'two whole months, February included');
});

test('same-day case accrues 0 and does not creep with wall-clock time', () => {
  // Regression: daysBetween must count whole local days, not fractional hours.
  const c = { interest_mode: 'monthly', principal_amount: 50000, interest_rate: 5, interest_from: '2026-07-14' };
  const noon = caseBalance(c, [], new Date('2026-07-14T04:00:00Z'));   // Malaysia noon, same day
  const eve  = caseBalance(c, [], new Date('2026-07-14T14:00:00Z'));   // Malaysia 10pm, same day
  near(noon.interest, 0, 'same-day interest is 0');
  assert.strictEqual(noon.interest, eve.interest);                     // no creep within the day
  // Next day steps by one day of the 07-14 -> 08-14 month (31 days): 2500 / 31.
  const next = caseBalance(c, [], new Date('2026-07-15T04:00:00Z'));
  near(next.interest, 2500 / 31, 'one whole day accrues one day of interest');
});

test('recomputeOutstanding caches derived interest in interest_charged for accrual cases', () => {
  db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
  db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from)
    VALUES (1,'C1',1,1,36500,0,36500,'new','daily',10,'2000-01-01')`);
  const out = recomputeOutstanding(1);
  const row = db.get('SELECT interest_charged, outstanding_amount FROM cases WHERE id=1');
  assert.ok(row.interest_charged > 0, 'interest cached to column');          // years of accrual, well above 0
  assert.strictEqual(row.outstanding_amount, out);                           // returned value == cached column
  assert.strictEqual(row.outstanding_amount, db.get('SELECT 36500+interest_charged AS x FROM cases WHERE id=1').x); // no payments => principal + interest
});

test('recomputeOutstanding never overwrites the interest_amount input', () => {
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from)
    VALUES (2,'C2',1,1,36500,123,36500,'new','daily',10,'2000-01-01')`);
  recomputeOutstanding(2);
  const row = db.get('SELECT interest_amount, interest_charged FROM cases WHERE id=2');
  assert.strictEqual(row.interest_amount, 123);
  assert.ok(row.interest_charged > 123);
});
