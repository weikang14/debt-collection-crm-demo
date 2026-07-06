# Payment / Data-Correctness Fixes — Design

Date: 2026-07-06

## Goal

Fix four data-correctness issues found in the audit, all in the payment path
and dashboard. No schema migration, no new dependencies, no UI redesign.

Selected batch: #1 float money, #2 amount validation, #3 transaction, #6
dashboard timezone.

## Decisions

- **Payment amounts are never rounded or altered.** This is a *collection*
  system — the amount a debtor pays is recorded exactly as entered, to the
  digit. No rounding, no truncation, no "snap to cents" on the payment. (User
  decision, 2026-07-06.)
- **Only the *derived* outstanding balance is rounded to the cent.**
  `outstanding = principal + interest − paid` is a computed value that cannot
  legitimately be a fraction of a cent; the float residue it accumulates
  (e.g. `5.5e-17`) is a computer artifact, not money. Rounding this derived
  number to 2 decimals is not "changing a payment" — payments stay exact.
- **Overpayment policy (#2):** *blocked*. A payment greater than the current
  outstanding balance is rejected with an error; nothing is written. A payment
  equal to the outstanding (pays the case off) is allowed. (User decision,
  2026-07-06.) Comparison tolerates sub-cent float noise: reject when
  `amount > outstanding + 0.005`.
- **No integer-cents migration.** Money stays `REAL`; correctness is enforced
  by rounding only the *derived outstanding* at the compute boundary. Far
  smaller than migrating every amount column and all reads.

## Fix 1 — Float money → fully-paid detection (`src/services/payments.js`)

**Problem (verified):** amounts are `REAL`; paying the exact total leaves a
float residue (`0.3 - 0.3 = 5.5e-17`), so `outstanding === 0` is false and a
fully-paid case stays `partial_paid` forever.

**Fix:**
- Add `round2(n) = Math.round((Number(n) || 0) * 100) / 100`.
- `recomputeOutstanding`: `outstanding = round2(Math.max(0, (principal + interest) - paid))`
  — rounds only the **derived balance**, not any payment.
- `statusAfterPayment`: change `outstanding === 0` → `outstanding <= 0`.
- **Payment `amount` is inserted exactly as entered — no rounding.** (See
  Decisions.)

## Fix 2 — Payment amount validation + overpayment block (`src/utils/forms.js` helper + `src/routes/cases.js`, `src/routes/ptps.js`)

**Problem (verified):** no validation. Negative amount accepted (outstanding
went *up* to 1500); zero accepted; non-numeric (`"abc"`) → `NaN` → 500 crash
(`NOT NULL constraint failed`); and any amount over the balance was silently
accepted.

**Fix — one pure, testable validator used by both payment entry points:**
- Add `validatePayment(rawAmount, outstanding)` to `src/utils/forms.js`:
  - `const n = Number(rawAmount);`
  - not a finite number, or `n <= 0` → `{ error: 'Invalid amount' }`
  - `n > outstanding + 0.005` → `{ error: 'Amount exceeds outstanding' }`
  - otherwise → `{ amount: n }` (exact, **not** rounded)
  - Exported and unit-tested.
- `POST /cases/:id/payments` (`cases.js`): call
  `validatePayment(req.body.amount, c.outstanding_amount)` (`c` from `loadCase`);
  on `error`, `redirect('/cases/'+c.id+'?err='+encodeURIComponent(error))`
  before touching `applyPayment`. Pass `result.amount` through.
- `POST /ptps/:id/fulfill` (`ptps.js` → `recordFulfillment`): the fulfill
  amount is `body.amount` when present, else the PTP's own `amount`. Validate
  that value against the case's current `outstanding_amount` via
  `validatePayment`; on `error`, return `{ ok: false, error }` (the route
  already redirects with `?err=`). This also blocks fulfilling a PTP whose
  amount now exceeds the (already partly paid down) balance.

**Note:** `applyPayment` records the amount exactly (no rounding); the derived
outstanding is rounded by Fix 1.

## Fix 3 — Transaction wrap (`src/services/payments.js`)

**Problem:** `applyPayment` performs 4 separate writes (insert payment,
recompute outstanding, update status, insert timeline). A mid-sequence failure
leaves the case inconsistent.

**Fix:** wrap the 4 writes in a `db.transaction(() => { … })()` (better-sqlite3,
already the driver; `db` is exported from `src/db`). `logAction` (audit) and the
return value stay outside the transaction — an audit-log hiccup must not roll
back a recorded payment. `recomputeOutstanding` is called inside the
transaction; it returns the outstanding used for the status decision.

## Fix 4 — Dashboard timezone (`src/routes/dashboard.js`)

**Problem:** dashboard "today"/overdue KPIs use `date('now')` (UTC) while the
Tasks page uses `date('now','+8 hours')` (MYT). Near midnight MYT the dashboard
shows the wrong day, and its overdue count disagrees with the Tasks page.

**Fix:** replace every `date('now')` in `dashboard.js` with
`date('now','+8 hours')` for the today/overdue comparisons
(`openedToday`, `closedToday`, `collectedToday`, `ptpToday`, `overdueTasks`).
Pure query change, no logic change.

Out of scope (not in this batch): #7 dashboard overdue INNER JOIN excludes
tasks with no `case_id`.

## Testing

- **Fix 1 (`test/payments.test.js` additions):** seed a case with
  `principal+interest` that triggers float residue (e.g. 0.1 + 0.2); apply a
  payment of the exact total; assert `outstanding_amount === 0` and
  `status === 'fully_paid'`.
- **Fix 2 (`test/forms.test.js` additions):** unit-test `validatePayment` —
  invalid amount `("abc", 100)`, `("", 100)`, `(0, 100)`, `(-5, 100)` → `{error:'Invalid amount'}`;
  overpayment `(150, 100)` → `{error:'Amount exceeds outstanding'}`;
  exact payoff `(100, 100)` → `{amount:100}`; partial `(30, 100)` → `{amount:30}`;
  exact-but-fractional `(12.345, 100)` → `{amount:12.345}` (returned exactly, not rounded).
- **Fix 3:** covered indirectly by Fix 1's `applyPayment` test (the happy path
  still commits all four writes); no separate rollback test (would require
  fault injection the repo has no harness for).
- **Fix 4:** verified by reasoning/inspection — timezone `date()` queries are
  not cleanly unit-testable without freezing the clock, which the repo doesn't
  do.

## Files touched

- `src/services/payments.js` — round2, `<= 0`, transaction.
- `src/utils/forms.js` — `validatePayment(rawAmount, outstanding)` helper.
- `src/routes/cases.js` — validate payment amount + overpayment block.
- `src/routes/ptps.js` — validate fulfill amount + overpayment block.
- `src/routes/dashboard.js` — MYT `date('now','+8 hours')`.
- `test/payments.test.js`, `test/forms.test.js` — new assertions.

## Out of scope

- Integer-cents money migration.
- #4/#5 status-machine gaps, #7 dashboard join, #8 numbering, #9 audit swallow,
  #10 auth hardening, and the aging-bucket feature — all deferred.
