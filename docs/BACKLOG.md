# Debt Collection CRM — Remaining Backlog / 待办事项

Outstanding items from the 2026-07 audit. Numbers (#4…#10) match the original
audit report. **Done** items are listed at the bottom for reference.

Priority: 🔴 correctness/robustness · 🟠 logic · 🟡 hardening · 💡 feature.

---

## 🟠 Status-machine polish (from audit #4/#5, partially done)

### Edit re-run edge: principal=0 with no payments → fully_paid
- **What:** Editing a case to `principal=0` (no payments) yields
  `outstanding <= 0` → `fully_paid` via the shared status rule. Accepted as an
  admin-only edge in the 2026-07-07 batch; revisit only if it bites.
- **中文:** 把本金改成 0 且无付款会直接变 `fully_paid`（管理员操作的边角，已接受）。

---

## 🟡 Robustness (newly noted)

### Receipt numbers share one namespace across demo + customer（收据号命名空间共用）
- **What:** Case numbers isolate demo data with a `D` namespace
  (`CASE-YYYY-D001`), but **receipts do not** — both demo seed
  (`RCPT-YYYY-0001..`) and customer payments (`nextReceiptNo` = `MAX+1`) draw
  from the same `RCPT-YYYY-NNNN` space. Normally fine (customer numbers land
  above demo via MAX+1), but a "reload demo" after a customer took a low number,
  or a restore, can re-mint a demo `RCPT` that a customer row already holds.
- **中文:** 案件号用 `D` 命名空间隔离演示数据，但收据号没有——演示与客户付款共用
  `RCPT-YYYY-NNNN`，重载演示或恢复数据时可能撞号。
- **Fix sketch:** give demo receipts a `D` namespace too (`RCPT-YYYY-D001`),
  mirroring the case-number fix, so the two sets can never collide.

---

## ✅ Done (for reference)

- **#1 Float money** → derived outstanding rounded to cents; `<= 0` status
  check; fully-paid detection fixed. Payment amounts never rounded. *(merged cb2cca1 range)*
- **#2 Payment validation + overpayment block** → `validatePayment` on payment,
  PTP-fulfill, and PTP-create entry points.
- **#3 Transaction** → `applyPayment`'s 4 writes are atomic (`db.transaction`).
- **#6 Dashboard timezone** → today/overdue KPIs use MYT (`+8 hours`).
- **#4 Break-PTP revert** → breaking the last pending PTP reverts `ptp` →
  `negotiation`; **overdue-PTP dashboard tile** added.
- **#5 Case edit re-runs status** → with a guard so a live `ptp` case (pending
  PTP + payment) isn't wrongly downgraded to `partial_paid`.
- **#7 Dashboard overdue tasks** → scoped like the Tasks page (`isScoped`),
  includes case-less tasks.
- **A PTP-create validation** → block invalid / over-outstanding PTP amounts.
- **recordFulfillment atomicity** → PTP flip + payment writes + timeline now run
  in one `db.transaction` (payments exposes `paymentWrites` for the shared body).
  A payment failure reverts the PTP flip (test: atomic rollback).
- **#8 Numbering** → `nextCaseNo`/`nextReceiptNo` use per-year `MAX(suffix)+1`,
  never reuse a deleted number (test: no-reuse). Unblocks payment edit/void.
- **#9 Audit logging** → `logAction` coerces `undefined` bindings to `null` so a
  `req` missing a field still logs instead of silently dropping. This also fixed
  the `audit failed:` test noise (fake `req` now has `username`/`ip`).
- **#10 Auth hardening** → per-IP login throttle (5 fails → 15-min lock),
  constant-time-ish failure via a dummy bcrypt compare (no username enumeration),
  and `SESSION_SECRET` required in production.
- **Feature: Aging buckets** → dashboard tiles group active outstanding by debt
  age (0–30/31–60/61–90/90+ days, MYT); pure `utils/aging.js` (unit-tested).
- **Feature: Payment edit / void** → correct or void a recorded payment
  (admin/manager/finance); recompute outstanding + status via shared
  `resyncCaseStatus`; a voided payment reverts a stale `fully_paid`.
- **Feature: Next follow-up date** → `next_action_at` on cases (form + case
  detail); dashboard "Due for Follow-up" list of active cases due today/overdue.

Specs & plans for the done work live in `docs/superpowers/specs/` and
`docs/superpowers/plans/` (dated `2026-07-06` and `2026-07-07`).
