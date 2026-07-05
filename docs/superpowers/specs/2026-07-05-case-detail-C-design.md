# 设计：C 组 —— PTP 记款修复 + 案件详情弹窗重构

## 背景与目标

用户 8 项批次的 **C 组**，两件相关的事，都在案件详情页：

1. **PTP Fulfill 自动记还款（修 bug）**：当前点 Fulfill 只把 PTP 标记为 fulfilled，不记还款、欠款不减。改为：Fulfill 时弹出小框确认/输入实收金额（预填 PTP 金额）→ 自动记一笔还款 → 欠款减少、收款增加、状态按规则更新。
2. **案件详情重构**：把右侧常驻的 Payment/PTP/Calls/Notes/Status 五个操作面板，改成**案件资料卡里的一排操作按钮 + 弹窗**（原生 `<dialog>`）；只读列表保留在下方。

一个 spec / 一个实现计划。零新依赖（用原生 `<dialog>`）。复用已测的 `applyPayment`。

## 现状（关键）

- `src/services/payments.js`：`applyPayment(caseId, {payment_date, amount, method, reference, bank, remark}, req)` 记还款、`recomputeOutstanding`（欠款=max(0, 本金+利息-已还)）、按 `statusAfterPayment` 更新状态（终态不覆盖）、写时间线、审计。已测。
- `src/routes/ptps.js`：`transition()` 只 `UPDATE ptps SET status` + 时间线 + 审计，**不记款**（这就是 bug）。`POST /ptps/:id/fulfill`、`POST /ptps/:id/break`。
- `src/routes/cases.js`：案件详情 `GET /:id`（`loadCase` 带 scope）渲染 `cases/show.ejs`，传 `c, timeline, payments, ptps, tasks, calls, statuses, terminal, readOnly`。操作路由都在 cases 路由：`POST /:id/payments`(→applyPayment)、`/:id/ptps`、`/:id/calls`、`/:id/notes`、`/:id/status`。
- `src/views/cases/show.ejs`：`.detail-grid`（左=资料卡`.kv`+时间线；右=5 个 `.panel`，各含 inline 表单 + 只读列表）。`readOnly`=auditor/client。

## C1：PTP Fulfill → 记还款

- **路由** `src/routes/ptps.js`：改 `POST /:id/fulfill`：
  - 取 PTP + 用 `caseWhere` 校验案件可达（403 保留）。
  - 若 PTP 已非 pending（重复提交）→ 重定向带 `?err=`，不重复记款。
  - 读取表单：`amount`（默认用 PTP 金额，可改）、`payment_date`（默认今天）、`method`。
  - `UPDATE ptps SET status='fulfilled'`。
  - 调 `applyPayment(ptp.case_id, { payment_date, amount, method, remark: 'PTP fulfilled' }, req)` —— 记还款、减欠款、更新状态、写 payment 时间线。
  - 再写一条 `ptp_fulfilled` 时间线 + `logAction('ptp_fulfilled',...)`（保留原有语义）。
  - 重定向 `/cases/:caseId?ok=PTP+fulfilled+and+payment+recorded`。
  - `POST /:id/break` 不变。
- **不改** `applyPayment` 本体（复用）。
- 说明：终态案件（legal/closed…）Fulfill 仍会记款并减欠款，但 `statusAfterPayment` 不会把终态改成 paid（符合既有业务规则）。

## C2：案件详情弹窗重构

### 布局
- 保留页头：`case_no` + 状态徽章 + Edit Case。
- **案件资料卡（第一个框 `.kv`）**：卡片里在资料下方（或顶部）放一排**操作按钮**（仅 `!readOnly` 且角色允许时显示）：
  - `记还款 Record Payment`（admin/manager/finance/agent）
  - `加 PTP Add PTP`、`记通话 Log Call`、`加备注 Add Note`、`改状态 Change Status`（admin/manager/agent）
  - 每个按钮 `type="button"`，`onclick` 打开对应的 `<dialog>`。
- **弹窗**：每个操作一个 `<dialog class="modal" id="dlg-payment">…</dialog>`（放在页面末尾统一渲染），内含**现有的那份表单**（字段、`action`、`method` 不变，只是从常驻面板搬进 dialog）。每个 dialog 底部有 `Cancel`（`type="button"` 调 `dialog.close()`）+ 原提交按钮。按 Esc 或点背景也关闭（原生行为 + 一小段背景点击关闭 JS）。
- **只读列表**保留在资料卡下方/右侧：还款表、PTP 表（每行 pending 的 Fulfill/Break）、通话表、任务、时间线 —— 展示不变。
- PTP 行的 **Fulfill** 按钮改为打开一个 fulfill 弹窗（`<dialog id="dlg-ptp-fulfill">`），表单预填该 PTP 的金额并 `action="/ptps/<id>/fulfill"`。因为一页可能多条 pending PTP，用一小段 JS：点某行 Fulfill → 设置弹窗表单的 action 和预填金额 → `showModal()`。Break 仍是直接提交的小表单。

### 交互/JS（原生，零依赖）
- 打开：`document.getElementById('dlg-x').showModal()`。
- 关闭：`dialog.close()`（Cancel 按钮 / Esc）。
- 点背景关闭：给 dialog 加一个 `click` 监听，若点击目标是 dialog 本身（backdrop）则 close。
- fulfill 弹窗：一个函数 `openFulfill(ptpId, amount)` 设置 form.action=`/ptps/${ptpId}/fulfill` 和金额输入值，再 showModal。
- 所有 JS 内联在 show.ejs 末尾的 `<script>`，不引外部文件/框架。

### CSS
- `public/css/style.css` 加 `.modal`（`<dialog>`）样式：宽度、圆角、`::backdrop` 半透明、内边距，配合现有 `.form`/`.btn`。少量、契合设计系统。

## 不做（YAGNI）
- 不引 modal/JS 框架；用原生 `<dialog>`。
- 不改 `applyPayment`/`recomputeOutstanding`/`statusAfterPayment` 逻辑（复用）。
- 不改其它页面。

## 测试
- **单元/集成**（`node:test`，隔离 DB via CRM_DB_PATH）：
  1. PTP fulfill 记款：seed 后，对一个 pending PTP 调用 fulfill 逻辑（可把"fulfill 后应记一笔还款且欠款下降"抽成可测路径，或直接在测试里插 PTP→调用 applyPayment 断言）。断言：fulfill 后该案件出现一条 payment、`outstanding_amount` 下降对应金额、PTP.status='fulfilled'。
  2. 重复 fulfill 不重复记款：对已 fulfilled 的 PTP 再 fulfill → 不新增 payment。
- **手动冒烟**：
  - 案件详情：资料卡里有操作按钮；点「记还款」弹窗出现，取消/Esc 关闭；提交后欠款更新。
  - PTP：点某行 Fulfill → 弹窗预填该 PTP 金额；提交后欠款减少、收款增加、PTP=fulfilled、状态更新；Break 仍只标记。
  - 只读用户（auditor）看不到操作按钮和弹窗触发。
  - 各角色权限与原路由一致。

## 迁移
无 schema 变更。
