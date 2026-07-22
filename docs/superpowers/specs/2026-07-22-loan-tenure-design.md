# Loan Tenure & Maturity Date — Design (Phase 1)

## Background

`Case_Loan_Tenure_Repayment_Action_Plan.md` (repo root) lays out a 6-phase plan
to add loan tenure, interest calculation, a repayment schedule, payment
allocation, PTP integration, and extension/restructure to the `Case` model.

Codebase review before this design surfaced conflicts between that plan and
the current implementation that must be resolved before later phases can be
designed:

- **Interest is already dynamic, not upfront.** `interest_mode` is
  `fixed` (manual lump), `daily`, or `monthly` (interest-first accrual on
  remaining principal, recomputed from full payment history on every read via
  `caseBalance()` in `src/services/payments.js`). The plan's Phase 2/3 assume
  a classic EMI model — total interest computed once from principal/rate/tenure,
  then split into N fixed installments. These two models conflict for
  daily/monthly-mode cases, since future interest depends on when/how much the
  customer actually pays.
- **A repayment-schedule-like feature already exists, but lives on `ptps`.**
  `ptps` has `plan_id` / `installment_no` / `plan_size`, and
  `createPtpPlan()` in `src/routes/cases.js` already splits an amount into N
  dated installments using `splitInstallments()` / `dueDates()` from
  `src/utils/installments.js`. The plan's Phase 3/5 propose a schedule
  independent of PTP — that would need to be reconciled with this existing
  feature, not built alongside it blind.
- **`payments` has no principal/interest split columns.** The split is
  computed on the fly (daily/monthly mode only); `fixed` mode has no split
  concept at all. Phase 4/6 assume a stored split.

Given this, the plan is being executed one phase at a time, each with its own
design. **This document covers Phase 1 only: Loan Tenure & Maturity Date.**
It is purely additive — new nullable fields, no interaction with the interest
engine, PTP plans, or payment allocation. Later phases (interest calc tied to
tenure, a true repayment schedule, extension/restructure) will each get their
own brainstorming pass, informed by the conflicts above.

## Goal

Let a case record how long the loan runs (`loan_start_date` + `tenure` +
`tenure_unit`) and automatically derive `maturity_date`. Nothing else reads
or depends on these fields yet.

## Data Model

Add four nullable columns to `cases` (schema.sql, via a migration statement
consistent with how the table is currently evolved — `ALTER TABLE` since the
table already has data):

```sql
ALTER TABLE cases ADD COLUMN loan_start_date TEXT;
ALTER TABLE cases ADD COLUMN tenure INTEGER;
ALTER TABLE cases ADD COLUMN tenure_unit TEXT NOT NULL DEFAULT 'months'
  CHECK (tenure_unit IN ('days','months','years'));
ALTER TABLE cases ADD COLUMN maturity_date TEXT;
```

- `loan_start_date`: the loan's actual disbursement date, entered by the
  user. Distinct from `opened_at` (when the case was created in the CRM —
  a case can be opened for collection long after the loan was disbursed).
- `tenure` / `tenure_unit`: loan duration, unit is days/months/years.
- `maturity_date`: derived, cached, read-only. Computed only when both
  `loan_start_date` and `tenure` are present; otherwise stays `NULL` and the
  UI shows nothing.
- All existing (and new, if left blank) cases keep these fields `NULL` —
  no backfill, no required-field enforcement anywhere in the create/edit flow.

## Calculation

New pure function in `src/utils/installments.js` (already the home for
dayjs-based loan date math — `dueDates()` lives there):

```js
function maturityDate(startDate, tenure, unit) {
  const u = unit === 'years' ? 'year' : unit === 'days' ? 'day' : 'month';
  return dayjs(startDate).add(tenure, u).format('YYYY-MM-DD');
}
```

Exported alongside `splitInstallments` / `dueDates`. Relies on dayjs's
existing month-end handling (e.g. Jan 31 + 1 month → Feb 28/29), same as
`dueDates()` already does.

## Request Flow

`src/routes/cases.js` gets a `tenureFields(b)` helper, mirroring the existing
`interestFields(b)` pattern:

```js
function tenureFields(b) {
  const unit = ['days','months','years'].includes(b.tenure_unit) ? b.tenure_unit : 'months';
  const start = b.loan_start_date || null;
  const tenure = b.tenure !== undefined && b.tenure !== '' ? Number(b.tenure) : null;
  const maturity = (start && tenure) ? maturityDate(start, tenure, unit) : null;
  return { start, tenure, unit, maturity };
}
```

Called from both `POST /cases` (create) and `POST /cases/:id` (update),
writing `loan_start_date, tenure, tenure_unit, maturity_date` alongside the
existing insert/update columns. No validation beyond "both present or
neither" — a negative or non-integer `tenure` is not specially rejected
(consistent with how `principal_amount` is handled elsewhere in the same
routes: `Number(...)||0`, no range check).

## UI

`src/views/cases/form.ejs`: three new inputs after the Principal Amount
field — `Loan Start Date` (date input), `Tenure` (number input), `Tenure
Unit` (select: days/months/years, default months). No maturity date input —
it's never user-editable.

`src/views/cases/show.ejs`: the existing ledger-break row (Principal /
Interest / Paid) gets a fourth cell, `Maturity Date`, rendered only when
`c.maturity_date` is set:

```ejs
<% if (c.maturity_date) { %>
<div><div class="ledger-lbl">Maturity Date</div><div class="ledger-val"><%= h.dateFmt(c.maturity_date) %></div></div>
<% } %>
```

## Error Handling

Nothing new to guard against beyond what `tenureFields` already does by
construction: missing/partial input degrades to `maturity_date = NULL`
rather than throwing. No new failure modes are introduced — this phase does
not touch payments, interest, or status transitions.

## Testing

New `test/tenure.test.js` (flat file, matching existing `test/*.test.js`
convention) asserting `maturityDate()`:

- days: `2026-07-01` + 30 days
- months: `2026-07-01` + 12 months
- years: `2026-07-01` + 1 year
- month-end edge case: `2026-01-31` + 1 month → `2026-02-28`

## Out of Scope (deferred to later phases)

- Total Interest / Total Payable calculated from tenure (Phase 2) — blocked
  on reconciling with the existing daily/monthly accrual engine.
- A true Repayment Schedule entity (Phase 3) — blocked on reconciling with
  the existing PTP-plan feature (`plan_id`/`installment_no`/`plan_size` on
  `ptps`).
- Payment principal/interest portion columns (Phase 4).
- PTP-to-schedule linkage (Phase 5).
- Extension / Restructure (Phase 6).
