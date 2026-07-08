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

test('monthly mode accrues rate /30 per day (pro-rata)', () => {
  const c = { interest_mode: 'monthly', principal_amount: 3000, interest_rate: 2, interest_from: '2026-01-01' };
  // 2%/mo on 3000 = 60/mo = 2.00/day. 15 days => 30.00.
  const b = caseBalance(c, [], new Date('2026-01-16'));
  near(b.interest, 30, 'interest');
});

test('recomputeOutstanding caches derived interest for accrual cases', () => {
  db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
  db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from)
    VALUES (1,'C1',1,1,36500,0,36500,'new','daily',10,'2000-01-01')`);
  const out = recomputeOutstanding(1);
  const row = db.get('SELECT interest_amount, outstanding_amount FROM cases WHERE id=1');
  assert.ok(row.interest_amount > 0, 'interest cached to column');           // years of accrual, well above 0
  assert.strictEqual(row.outstanding_amount, out);                           // returned value == cached column
  assert.strictEqual(row.outstanding_amount, db.get('SELECT 36500+interest_amount AS x FROM cases WHERE id=1').x); // no payments => principal + interest
});
