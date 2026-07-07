# Debt Collection CRM — Remaining Backlog / 待办事项

Outstanding items from the 2026-07 audit. Numbers (#4…#10) match the original
audit report. **Done** items are listed at the bottom for reference.

Priority: 🔴 correctness/robustness · 🟠 logic · 🟡 hardening · 💡 feature.

---

## 🟠 Logic

### recordFulfillment orphan-atomicity（PTP 兑现的原子性）
- **What:** In `src/routes/ptps.js`, `recordFulfillment` marks the PTP
  `fulfilled` and writes a `ptp_fulfilled` timeline event *outside*
  `applyPayment`'s transaction. If `applyPayment` throws, its own 4 writes roll
  back but the PTP is already flipped → orphaned "fulfilled PTP, no payment."
- **中文:** 兑现 PTP 时，PTP 状态更新和 timeline 在付款事务之外，付款一旦抛错就留下「已兑现但无付款」的孤儿记录。
- **Why deferred:** `node:sqlite` has no nested transactions/savepoints, so
  wrapping the whole `recordFulfillment` in one transaction needs restructuring
  (`applyPayment` would need an "already in a transaction" path). Medium effort.
- **Fix sketch:** give `applyPayment` an internal `_writes()` that both the
  standalone txn wrapper and a combined `recordFulfillment` txn can call.

---

## 🟡 Robustness / Security

### #8 — Receipt/case numbering is COUNT-based（编号用 COUNT 生成）
- **What:** `src/utils/numbering.js` derives the next number from
  `COUNT(*) + 1`. Deleting a row lets the next insert reuse an existing number →
  `UNIQUE` violation (500); also not concurrency-safe.
- **中文:** 收据号/案件号用「总数+1」生成，删记录后会重用号码撞 UNIQUE 报错，且非并发安全。
- **Blocks:** payment edit/void (below) — can't safely delete a payment while
  numbering reuses gaps.
- **Fix sketch:** track a per-year max (or a dedicated sequence table /
  `MAX(...)+1` with a retry), so numbers are never reused.

### #9 — Audit logging swallows errors（审计日志静默吞异常）
- **What:** `src/utils/audit.js` `logAction` wraps the insert in
  `try/catch` and only `console.error`s on failure → audit entries can be
  silently dropped on unexpected input (e.g. a `req` missing a field).
- **中文:** 审计写入失败只打印、不报错，异常输入时会悄悄漏记。
- **Fix sketch:** coerce/guard the bound values (username/ip default to `null`),
  and surface repeated failures rather than swallowing silently. Very small.

### #10 — Authentication hardening（认证加固）
- **What:** `src/routes/auth.js` — no login rate-limiting/lockout; username
  enumeration via response timing; session secret is hardcoded.
- **中文:** 登录无限流/锁定；用户名枚举时间差；session secret 硬编码。
- **Fix sketch:** basic attempt throttling, constant-time-ish failure, and read
  the session secret from an env var. Do before any real deployment.

### Test hygiene — `audit failed` noise（测试噪音）
- **What:** `test/payment_correctness.test.js`'s fake `req` lacks `username`, so
  `applyPayment` → `logAction` prints swallowed `audit failed:` lines in test
  output. Add `username` (and `ip`) to that fake `req`. Trivial.

---

## 🟠 Status-machine polish (from audit #4/#5, partially done)

### Edit re-run edge: principal=0 with no payments → fully_paid
- **What:** Editing a case to `principal=0` (no payments) yields
  `outstanding <= 0` → `fully_paid` via the shared status rule. Accepted as an
  admin-only edge in the 2026-07-07 batch; revisit only if it bites.
- **中文:** 把本金改成 0 且无付款会直接变 `fully_paid`（管理员操作的边角，已接受）。

---

## 💡 Features

### Aging buckets（账龄分桶）
- **What:** Group outstanding by age of debt (0–30 / 31–60 / 61–90 / 90+ days)
  — a core collection view. Pairs well with the case "ledger strip" and the
  new overdue-PTP dashboard tile.
- **中文:** 按欠款账龄分桶展示，催收核心视图，跟 ledger 条和逾期 PTP 卡片最搭。

### Payment edit / void（付款编辑 / 作废）
- **What:** Ability to correct or void a recorded payment. **Depends on #8** —
  deleting/voiding must not break receipt numbering.
- **中文:** 能改/作废已记录的付款；要先解决 #8 编号问题。

### Case "next action / follow-up date"（下次跟进日期）
- **What:** A `next_action_at` field on cases so agents can see what's due next
  without opening every case; could drive a dashboard "due for follow-up" list.
- **中文:** 案件加「下次跟进日期」字段，方便看接下来要跟进什么。

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

Specs & plans for the done work live in `docs/superpowers/specs/` and
`docs/superpowers/plans/` (dated `2026-07-06` and `2026-07-07`).
