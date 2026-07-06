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
- **Overpayment policy (#2):** *allowed*. A payment larger than the current
  outstanding is accepted; outstanding floors at 0 and the case becomes
  `fully_paid`. The full payment amount is still recorded exactly. (Rationale:
  real collections overpay; blocking legitimate overpayment is worse than
  allowing it. The floor already existed via `Math.max(0, …)`.) Chosen as
  default when the user was away; revisit if the user prefers strict blocking.
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

## Fix 2 — Payment amount validation (`src/utils/forms.js` helper + `src/routes/cases.js`, `src/routes/ptps.js`)

**Problem (verified):** no validation. Negative amount accepted (outstanding
went *up* to 1500); zero accepted; non-numeric (`"abc"`) → `NaN` → 500 crash
(`NOT NULL constraint failed`).

**Fix:**
- Add a pure helper `parseAmount(x)`: returns the amount **exactly as given**
  (no rounding) if it is a finite number `> 0`, else `null`.
  - Implementation: `const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null;`
  - Location: `src/utils/forms.js` (existing small helper module) — exported and unit-tested.
- `POST /cases/:id/payments` (`cases.js`): parse `req.body.amount` with
  `parseAmount`; if `null`, `redirect('/cases/'+c.id+'?err=Invalid+amount')`
  before calling `applyPayment`. Pass the parsed number through.
- `POST /ptps/:id/fulfill` (`ptps.js` → `recordFulfillment`): same guard. When
  the fulfill form omits an amount, fall back to the PTP's own amount (existing
  behavior); only reject when an explicit amount is present and invalid.

**Note:** `applyPayment` still applies `round2` defensively (Fix 1), so it is
safe even if a future caller forgets to pre-validate.

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
- **Fix 2 (`test/forms.test.js` additions):** unit-test `parseAmount` — invalid
  cases `"abc"`, `""`, `0`, `-5` → `null`; valid cases `"100"` → `100`,
  `"12.34"` → `12.34`, `"12.345"` → `12.345` (returned exactly, **not** rounded).
- **Fix 3:** covered indirectly by Fix 1's `applyPayment` test (the happy path
  still commits all four writes); no separate rollback test (would require
  fault injection the repo has no harness for).
- **Fix 4:** verified by reasoning/inspection — timezone `date()` queries are
  not cleanly unit-testable without freezing the clock, which the repo doesn't
  do.

## Files touched

- `src/services/payments.js` — round2, `<= 0`, transaction.
- `src/utils/forms.js` — `parseAmount` helper.
- `src/routes/cases.js` — validate payment amount.
- `src/routes/ptps.js` — validate fulfill amount.
- `src/routes/dashboard.js` — MYT `date('now','+8 hours')`.
- `test/payments.test.js`, `test/forms.test.js` — new assertions.

## Out of scope

- Integer-cents money migration.
- #4/#5 status-machine gaps, #7 dashboard join, #8 numbering, #9 audit swallow,
  #10 auth hardening, and the aging-bucket feature — all deferred.
