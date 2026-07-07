# 分期还款计划（Installment Repayment Plans）— Design

**Date:** 2026-07-07
**Status:** Spec — awaiting user review before plan/implementation.

## 目标 / Goal

PTP 现在只支持**单次**承诺（一笔 amount + due_date）。真实催收里债务人常常
承诺「分 N 期、每期多少、每月一期」。本设计加入**分期还款计划**：一次生成一个
排期，逐期跟踪履约/违约。

## 核心思路：计划 = 一组 PTP（Approach A）

一条 PTP 已经是「有到期日、可 fulfill/可 break」的承诺，且状态机已经处理：
- 有 pending PTP → case 状态为 `ptp`；
- 最后一条 pending PTP 被 break/resolve 且无其它 pending → 回退到 `negotiation`
  （`services/payments.js` 的 live-PTP guard 与 `ptps.js` 的 revert 逻辑）。

因此一个分期计划**就是 N 条共享分组的 PTP 行**。fulfill/break/状态机**全部复用**，
不新建独立子系统。

被否的替代方案：
- **B（独立 installment 子系统）**：自建排期表 + 计划级状态 + 自己的 fulfill 逻辑。
  重复了 PTP 已经做好的 90%，对一个 demo 过重。
- **C（什么都不加）**：用户已能逐条手建 PTP，但没有**排期生成**和**分组跟踪**，
  等于没交付这个功能。

## Schema 变更

在 `ptps` 表加 3 个可空列（`plan_id` 为空 = 现有的独立单次 PTP，所有旧数据/旧行为
不变）：

| 列 | 类型 | 说明 |
|----|------|------|
| `plan_id` | TEXT | 同一计划的所有分期共享的分组键（`crypto.randomUUID()`）；NULL = 独立 PTP |
| `installment_no` | INTEGER | 期序 1..N；NULL = 独立 PTP |
| `plan_size` | INTEGER | 计划总期数 N；NULL = 独立 PTP |

**迁移**：沿用 `src/db/index.js` `init()` 里现有的 `ALTER TABLE ... ADD COLUMN`
try/catch 模式（与 `is_demo`、`next_action_at` 一致）。同时更新 `schema.sql` 的
`ptps` 建表语句，使全新库直接带这三列。

## 纯函数工具 `src/utils/installments.js`

无 DB 依赖、可单测（对齐现有 `utils/aging.js` 的纯函数风格）：

- `splitInstallments(total, n)` → 长度 N 的金额数组。
  - `base = Math.floor(total / n * 100) / 100`（向下取整到分）；前 N-1 期 = base，
    **末期 = total − base×(N−1)** 吸收余数，使数组之和**精确等于** total。
  - 例：`splitInstallments(10003, 3)` → `[3334.33, 3334.33, 3334.34]`，和 = 10003.00。
  - 前置条件：`total > 0`、`n` 为 2..60 的整数；否则抛错（由路由先校验，函数只管拆分）。
- `dueDates(firstDate, n)` → N 个「每月一期」的日期字符串（`YYYY-MM-DD`）。
  用 `dayjs`（已是依赖）做 `.add(k, 'month')`，天然处理月末（如 1/31 → 2/28）。

## 路由

### 生成计划 — `POST /cases/:id/ptp-plans`
- 权限：`admin, manager, agent`（同 New PTP）。
- 输入：`total_amount`、`num_installments`、`first_due_date`。
- 校验：
  - `validatePayment(total_amount, c.outstanding_amount)`（复用现有；拦截 ≤0 与超欠款）。
  - `num_installments` 为 2..60 的整数，否则报错重定向。
  - `first_due_date` 必填。
- 生成：`plan_id = crypto.randomUUID()`；`amounts = splitInstallments(...)`；
  `dates = dueDates(...)`。
- 一个 `db.transaction`：
  - 插入 N 条 `ptps`（同 `plan_id`、`installment_no` 1..N、`plan_size` N、
    `status='pending'`、`amount`、`due_date`）。
  - 若 `c.status` 非 terminal → `UPDATE cases SET status='ptp'`（与单条 PTP 一致）。
  - 一条 timeline：`Installment plan created: RM {total} in {N} installments`。
- `logAction('ptp_plan_create', ...)`。

### 逐期 fulfill / break — **零新代码**
现有 `POST /ptps/:id/fulfill` 与 `POST /ptps/:id/break` 直接作用于单行：
- fulfill 记一笔 payment、跑状态机；live-PTP guard 保证还有 pending 兄弟期时
  case 仍为 `ptp`。
- break 单行；已有「无 pending 且 case=ptp → negotiation」的回退。

### 取消整个计划 — `POST /cases/:id/ptp-plans/:planId/cancel`
- 权限同上。避免 12 期要点 12 次 Break。
- 一个 transaction：
  - `UPDATE ptps SET status='broken' WHERE case_id=? AND plan_id=? AND status='pending'`。
  - 一条 timeline：`Installment plan cancelled (k pending installments broken)`。
  - 复用回退检查：若 case=`ptp` 且已无 pending → `negotiation`。
- `logAction('ptp_plan_cancel', ...)`。

## 显示（`cases/show.ejs` 的 Records 弹窗 · Promise to Pay 区）

- PTP 查询按 `(plan_id, installment_no)` 排序（独立 PTP 的 NULL plan_id 单独成组）。
- 遍历时 `plan_id` 变化即输出一行**分组表头**：
  `Installment Plan · RM {planTotal} · {paidCount}/{N} paid`，右侧一个
  **Cancel plan** 按钮（当该计划还有 pending 且角色允许时显示）。
- 分期行**复用现有 PTP 行标记**，只在期号列显示 `2/5`，其余（金额/到期/状态/
  Fulfill/Break）不变。
- 独立 PTP（`plan_id` 为空）显示与现在完全一致。
- 表单：Case 页新增按钮 **New Plan** 与对应 `dialog`（Total / Installments /
  First due date），置于 **New PTP** 旁。

## 仪表盘：不改

分期**就是** PTP，现有的「逾期 PTP」tile 已经把它们计入。无需改动。

## 测试（`node:test`，隔离临时库 via `CRM_DB_PATH`）

- **纯函数**（无 DB）：
  - `splitInstallments(10000,5)` → 5×2000，和=10000。
  - `splitInstallments(10003,3)` → 和精确=10003，每项>0。
  - `dueDates('2026-08-01',5)` → 每月一期，长度 5，含月末进位一例。
- **集成**：
  - 生成计划：DB 里出现 N 条同 `plan_id` 的 pending PTP，金额之和=total，case 变 `ptp`。
  - 总额超欠款 → 被 `validatePayment` 拦截，未插入任何行。
  - fulfill 其中一期：outstanding 下降；仍有 pending 兄弟期时 case 保持 `ptp`。
  - cancel plan：pending 清零；无付款时 case `ptp → negotiation`。

## 不做（YAGNI，日后可加）

- **违约级联**（缺一期即整计划 default/break 全部）——保持逐期独立，需要时再加。
- **周/自定义频率**——先只做每月一期 + 首期日期。
- **建后编辑单期金额**——先不支持；要改就 Cancel plan 重建。

## 影响面小结

- 改：`ptps`（+3 列 & 迁移）、`schema.sql`、`routes/cases.js`（+2 路由）、
  `cases/show.ejs`（分组显示 + New Plan/Cancel 表单）、新增 `utils/installments.js`。
- **不改**：`services/payments.js`、`routes/ptps.js`（fulfill/break/状态机全复用）、
  仪表盘。
