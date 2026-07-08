# 佣金结算台账（Commission Settlement Ledger）— Design

**Date:** 2026-07-08
**Status:** Spec — awaiting user review before plan/implementation.

## 目标 / Goal

佣金**计算**已存在（Reports → Agent Performance 显示每个坐坐的 Collected × 费率 =
Commission）。缺的是**结算跟踪**：记录实际发放，算出「应结 / 已结 / 待结」。

一个坐坐、一个月的三个数：
- **应结（Earned）** = 该坐坐名下案件、付款日期落在该月的回款之和 × 坐坐 `commission_rate`。
- **已结（Settled）** = 该坐坐该月已记录的发放金额之和。
- **待结（Pending）** = 应结 − 已结。

## 方案：独立 `/commissions` 页 + 一张 `commission_settlements` 表

被否的替代：
- **B（塞进 Reports 页）**：Reports 现在是只读报表；结算要 POST 发放 + 作废 + 历史，
  会把只读报表搞乱。否。
- **C（按每笔付款结算）**：太细，UI 复杂，YAGNI。按月整额对账即可，贴合用户预期。

## 数据模型

全新表（因为是新表，只需加进 `src/db/schema.sql` 的 `CREATE TABLE IF NOT EXISTS`——
`init()` 用 `db.exec(schema)` 跑整份 schema，无需额外 ALTER 迁移）：

```sql
CREATE TABLE IF NOT EXISTS commission_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  period TEXT NOT NULL,               -- 结算所属月份 'YYYY-MM'
  amount REAL NOT NULL,               -- 本次发放金额（按录入存，不四舍五入）
  note TEXT,
  settled_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commission_agent_period
  ON commission_settlements(agent_id, period);
```

一条记录 = 一笔发放。同一坐坐同一月可有多条（分次发放）。`period` 是佣金**归属**的
月份；`created_at` 是发放时间。

## 权限（关键）

| 角色 | 看到 | 能操作 |
|------|------|--------|
| admin / manager / finance | 全部坐坐 | 录发放、作废 |
| auditor | 全部坐坐 | 只读 |
| **agent（坐坐）** | **只有自己那一行** | 只读（无发放/作废按钮） |
| client | 无权访问 | — |

坐坐范围限制：列表查询在 `user.role === 'agent'` 时加 `agents.id = user.agent_id`。
坐坐若未关联 `agent_id` → 看到空/零行，不报错。发放与作废路由仅
`admin/manager/finance`（坐坐即使直接 POST 也被 `requireRole` 挡下）。

## 路由

### `GET /commissions?month=YYYY-MM`
- 访问：`requireLogin`（agent 允许，client 拒绝——见权限表）。
- `month` 默认当前**马来西亚时间**月份（`dayjs.utc().add(8,'hour').format('YYYY-MM')`）。
- 对每个在范围内的坐坐算：
  - `collected` = `SUM(p.amount)`，p 属于该坐坐案件且 `substr(p.payment_date,1,7)=month`。
  - `earned` = `round2(collected × a.commission_rate / 100)`（复用 `helpers.commission` + round2）。
  - `settled` = `SUM(cs.amount) WHERE cs.agent_id=a.id AND cs.period=month`。
  - `pending` = `round2(earned − settled)`（可为负——超额发放，允许）。
- 渲染表：Agent · Collected · Rate% · Earned · Settled · Pending ·（可操作时）[Settle]。
- 该月**发放历史**列表：`commission_settlements WHERE period=month`（agent 范围内），
  每条 Agent · Amount · Note · 发放时间 ·（可操作时）[Void]。

### `POST /commissions/settle`
- 权限：`requireRole('admin','manager','finance')`。
- body：`agent_id`、`period`（YYYY-MM）、`amount`、`note`。
- 校验：`amount` 为有限数且 `> 0`，否则 `?err=`（**不**拦超额）。`agent_id` 存在。
- 插入一条 settlement，`settled_by = 用户全名`；`logAction('commission_settle', 'agent', agent_id, ...)`。
- 重定向回 `/commissions?month=<period>&ok=...`。

### `POST /commissions/:id/void`
- 权限：`requireRole('admin','manager','finance')`。
- 删除该发放记录 + `logAction('commission_void', ...)`（镜像 payment void）。
- 重定向回 `/commissions?month=<该记录的 period>&ok=...`。

## 金额规则

- Earned / Pending 是派生值 → `round2`（复用 `services/payments.js` 的 round2 语义；
  在本路由内 `const round2 = n => Math.round((Number(n)||0)*100)/100`，或从 helpers 提取——
  实现时择一，避免重复）。
- Settlement `amount` 按录入存，不四舍五入（与付款一致）。
- Settle 表单金额输入框**默认值 = 该坐坐当前 Pending**（方便一键结清），但可改。

## 导航

侧边栏加 "Commissions" 链接，展示给 admin/manager/finance/auditor **和 agent**；
client 不展示。放在 Reports 附近。

## 演示数据

`seed.js` 加 1–2 条 `is_demo=1` 的 settlement（挑一个 demo 坐坐、当前月、部分金额），
使演示时结算页非空、能看出"待结 = 应结 − 已结"。

## 测试（`node:test`，隔离临时库 via `CRM_DB_PATH`）

- 播种：一个坐坐（rate 5%）+ 一个案件 + 该月两笔回款（合计 RM 10,000）。
  - 断言 earned = round2(10000 × 5%) = 500。
- 录一笔 settlement（amount 300，period=该月）→ 断言 settled=300、pending=200。
- 再录 250（超额，pending 变 -50）→ 断言允许、pending=round2(500-550)=-50。
- 作废第一笔（300）→ 断言 settled=250、pending=250。
- `amount<=0` / 非数字 → settle 被拒，无记录写入。
- 权限：断言 agent 范围查询只返回自己那一行（与 authz-boundary 子项目呼应，但此处
  就地覆盖 commissions 列表的 agent 范围）。

把「按月算 collected/earned/settled/pending」的核心逻辑放进一个可单测的函数
`commissionRows(users_scope, month)`（返回每个坐坐的行对象），路由只负责渲染 + 权限，
便于上面这些断言直接调函数、不需要 HTTP。

## 影响面

- 新增：`src/db/schema.sql`（1 张表 + 索引）、`src/routes/commissions.js`（3 路由 +
  `commissionRows` 逻辑）、`src/views/commissions/index.ejs`、`test/commissions.test.js`。
- 改：`src/app.js`（挂载 `/commissions`）、`src/views/layout.ejs`（侧边栏链接 + 角色判断）、
  `src/db/seed.js`（1–2 条演示 settlement）。
- 不改：付款/PTP/状态机、其它报表。

## 不做（YAGNI）

- 超额发放硬拦截（Pending 可为负，仅提示，管理层自行判断）。
- 费率变更快照（Earned 按当前费率实时重算；demo 可接受，此处声明）。
- 跨月自动结转、佣金审批流、发放导出 PDF——需要再单独做。
