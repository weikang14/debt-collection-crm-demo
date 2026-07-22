# Repayment Schedule — Design (Phase 3)

## Background

Follows [2026-07-22-loan-tenure-design.md](2026-07-22-loan-tenure-design.md)
(Phase 1) and the Phase 2 work landed alongside it (`caseBalance()` now
defaults `asOf` to `maturity_date`, so daily/monthly interest is the full
start-to-end total). This document covers Phase 3: a projected Repayment
Schedule shown on the case detail page.

Phase 1's design doc flagged that the plan's Phase 3 assumes a classic EMI
(equal-installment) model, which conflicts with the interest-first accrual
engine already in `caseBalance()`. This design resolves that conflict by
**not** introducing a second interest model: the schedule is a projection of
the existing interest-first (先息后本) engine, not a new amortization
formula.

## Goal

Show, on the case detail page, what the customer is expected to pay each
month if they pay on schedule: interest only for months 1..n-1, interest +
full principal at maturity (month n). Each row's actual paid/outstanding/status
is derived live from the case's real payment history — no new persisted
state, no new failure modes for existing flows.

## Scope

Generated only when all of:
- `interest_mode === 'monthly'`
- `tenure_unit === 'months'`
- `tenure` and `loan_start_date` are both set

Everything else (`fixed`, `daily`, or `tenure_unit` of `days`/`years`)
renders no schedule — same as today. Reasons documented inline as
`ponytail:` comments:
- `daily` mode has no natural period boundary to project onto.
- `fixed` mode has no periodic rate to project — the whole loan is a single
  lump.
- `days`/`years` tenure would need an arbitrary day→month conversion to
  produce monthly rows; rather than guess, no schedule is shown.

## Data Model

None. No new table, no new columns. A repayment schedule row is computed
on read, the same way `caseBalance()` computes outstanding on read — this
keeps it consistent by construction (same rate, same day-count) and means
editing tenure/rate takes effect immediately with no migration or
regeneration step.

## Calculation

New pure function in `src/utils/schedule.js`:

```js
function repaymentSchedule(c, payments) {
  if (c.interest_mode !== 'monthly' || c.tenure_unit !== 'months' || !c.tenure || !c.loan_start_date) {
    return [];
  }
  const rate = dailyRate(c); // reuse payments.js's per-day monthly rate
  const dates = dueDates(c.loan_start_date, c.tenure); // existing util
  const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
  let pool = paidTotal;
  let periodStart = c.loan_start_date;
  return dates.map((due, i) => {
    const isLast = i === dates.length - 1;
    let expected = round2(c.principal_amount * rate * daysBetween(periodStart, due));
    if (isLast) expected = round2(expected + c.principal_amount);
    const paid = round2(Math.min(expected, Math.max(0, pool)));
    pool -= paid;
    periodStart = due;
    const outstanding = round2(Math.max(0, expected - paid));
    const status = paid >= expected ? 'paid'
      : due < todayStr() ? 'overdue'
      : paid > 0 ? 'partial'
      : 'pending';
    return { due_date: due, expected_amount: expected, paid_amount: paid, outstanding_amount: outstanding, status };
  });
}
```

- `dailyRate` and `daysBetween` are exported from `src/services/payments.js`
  (currently module-private) instead of being reimplemented — single source
  of truth for the interest-rate/day-count math.
- `todayStr()` is a small local helper (`YYYY-MM-DD` in the same Malaysia
  local time convention as `daysBetween`), so "overdue" compares like-for-like
  against `due_date`.
- Waterfall allocation is intentionally date-agnostic: the customer's total
  payments fill periods in schedule order (oldest first), regardless of which
  calendar date each individual payment landed on. This matches how
  `caseBalance()` already treats payments — as a pool against the loan, not
  earmarked to a specific period.
- Because `expected` for a would-be-unpaid case sums to exactly what
  `caseBalance(c, [], maturity_date)` returns (same rate, same day-count,
  same principal), the schedule and the ledger totals never disagree.

## Request Flow

`GET /cases/:id` (`src/routes/cases.js:140-149`) already loads `payments`
for the page. One line added:

```js
const schedule = repaymentSchedule(c, payments);
```

passed to the template. No new route, no new permission check — read-only,
same visibility as the rest of the case detail page (including the existing
`readOnly` role gate, which already hides forms, not tables).

## UI

`src/views/cases/show.ejs`: new table section, rendered only when
`schedule.length > 0`, placed near the existing Payments/PTP tables.
Columns: Due Date, Expected Amount, Paid Amount, Outstanding, Status.
Status badge reuses the existing `badge`/`is-*` CSS classes already used for
Payments/PTP/Tasks status pills:

```ejs
<% if (schedule.length) { %>
<h3>Repayment Schedule</h3>
<table><thead><tr><th>Due Date</th><th>Expected</th><th>Paid</th><th>Outstanding</th><th>Status</th></tr></thead>
<tbody>
<% schedule.forEach(row => { %>
<tr>
  <td><%= h.dateFmt(row.due_date) %></td>
  <td><%= h.money(row.expected_amount) %></td>
  <td><%= h.money(row.paid_amount) %></td>
  <td><%= h.money(row.outstanding_amount) %></td>
  <td><span class="badge <%= {paid:'is-green',overdue:'is-red',partial:'is-gold',pending:'is-neutral'}[row.status] %>"><%= row.status %></span></td>
</tr>
<% }) %>
</tbody></table>
<% } %>
```

No form, no write actions — purely informational, matching the plan's
"PTP should not replace Repayment Schedule" principle (section 5): PTP stays
the customer's actual promise, this table stays the original plan.

## Error Handling

- `repaymentSchedule` returns `[]` by construction for every ineligible
  case shape (missing tenure, wrong mode/unit) — no exceptions, no partial
  rows.
- Division-by-zero / negative tenure can't reach this function: `tenureFields()`
  (Phase 1, `src/routes/cases.js`) already only ever writes a positive
  finite `tenure`, guarded by the fix in `43cb613`.
- Nothing here writes to the database, so a bug in the projection can't
  corrupt `payments`, `cases`, or trigger a bad status transition.

## Testing

New `test/schedule.test.js`:

- Zero payments: all rows `pending` (future due dates) — last row includes
  principal in `expected_amount`.
- Zero payments, some due dates in the past: those rows `overdue`.
- One lump payment covering the first 3 periods exactly: rows 1-3 `paid`,
  row 4 `pending`/`partial` depending on remainder.
- Payments summing to more than total expected: no row's `paid_amount`
  exceeds its `expected_amount` (excess is simply unused, matching
  `validatePayment` blocking overpayment elsewhere — not this function's
  job to re-check).
- `interest_mode: 'daily'` or `'fixed'` → `[]`.
- `tenure_unit: 'days'` or `'years'` → `[]`.
- Sum of all `expected_amount` (zero-payment case) equals
  `caseBalance(c, [], c.maturity_date).interest + c.principal_amount`,
  proving the two models agree.

## Out of Scope (deferred to later phases)

- Payment principal/interest portion columns (Phase 4) — this schedule
  reads the existing `payments` table as-is (just `amount`/`payment_date`),
  no new columns.
- PTP-to-schedule linkage (Phase 5).
- Extension / Restructure, including freezing/versioning old schedules
  (Phase 6) — moot for now since nothing is persisted; when Phase 6 lands,
  "the old schedule" is simply this same function re-run against the
  original (pre-extension) loan terms and the payments made before the
  extension date.
