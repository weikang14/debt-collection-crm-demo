# 设计:演示数据控制（删除演示 / 重载演示，不影响试用新数据）

## 背景与目标

给 admin 一个"演示数据控制"页,让顾客试用时能把**演示样例**和**自己新建的数据**当成两套独立的东西来管理:

- **删除演示数据**：只移除 seed 生成的演示样例,顾客试用时新建的数据保留。
- **重载演示数据**：把原始演示样例加回来,不覆盖、不影响顾客新建的数据。
- 演示数据来自 `seed.js`（相当于"配方"）,删除只删当前库里的行,配方不丢 → 随时能重载。

作用域：**运行中的会话内**。这与"Render 免费版重启会重置整库"是两回事——后者是数据持久化问题（见 `docs/正式上线待办.md`），不在本设计范围。

本设计**替换**当前 `src/routes/demo.js` 里那版（"清空全部 / 重载覆盖"，会误删新数据）。

## 核心机制：`is_demo` 标记

给这些表加一列 `is_demo INTEGER NOT NULL DEFAULT 0`：
`clients, agents, debtors, cases, payments, ptps, tasks, call_logs, timeline_events`。

- **演示数据**（seed 生成）：`is_demo = 1`。
- **顾客新建**（经界面路由）：`is_demo = 0`（靠列默认值自动生效，各路由的 INSERT 无需改动）。
- **不加标记 / 不参与删除或重载的表**：`users`（账号始终保留，保证登录）、`audit_logs`（审计日志保持完整、不删）。

## 两个操作的精确规则

### ① 删除演示数据（`deleteDemo()`）——只删演示、保留新数据与被引用的演示父记录

按 子 → 父 顺序：

1. 删除所有 `is_demo=1` 的**子记录**（叶子，无人引用，安全）：
   `timeline_events, call_logs, tasks, ptps, payments`。
   删完后，库里剩下的子记录都是顾客的（`is_demo=0`）。
2. 删除 `is_demo=1` 的**案件**，但**跳过**仍被顾客子记录引用的：
   ```sql
   DELETE FROM cases WHERE is_demo=1
     AND id NOT IN (SELECT case_id FROM payments)
     AND id NOT IN (SELECT case_id FROM ptps)
     AND id NOT IN (SELECT case_id FROM tasks WHERE case_id IS NOT NULL)
     AND id NOT IN (SELECT case_id FROM call_logs)
     AND id NOT IN (SELECT case_id FROM timeline_events);
   ```
3. 删除 `is_demo=1` 的**债务人/催收员/客户**，但跳过仍被"存活案件"（顾客案件 + 上一步保留的演示案件）引用的：
   ```sql
   DELETE FROM debtors WHERE is_demo=1 AND id NOT IN (SELECT debtor_id FROM cases);
   DELETE FROM agents  WHERE is_demo=1 AND id NOT IN (SELECT agent_id FROM cases WHERE agent_id IS NOT NULL);
   DELETE FROM clients WHERE is_demo=1 AND id NOT IN (SELECT client_id FROM cases);
   ```

保证：顾客数据（`is_demo=0`）一条不动；全程无外键报错（被引用的演示父记录被保留）。
注意 SQL 陷阱：`tasks.case_id` 与 `cases.agent_id` 可空，`NOT IN` 子查询必须加 `IS NOT NULL` 过滤，否则 NULL 会让整个 `NOT IN` 失效。

### ② 重载演示数据（`deleteDemo()` + `insertDemoRows()`）——补回演示、不碰新数据

1. 先跑 `deleteDemo()`（刷新掉可删的演示数据，被引用的保留）。
2. 再跑 `insertDemoRows()` 幂等地补齐演示数据：
   - **父记录**（clients/agents/debtors/cases）用**固定 ID** + `INSERT OR IGNORE`：已存在（被保留的）跳过，被删掉的按原样补回。
   - **子记录**（payments/ptps/tasks/call_logs/timeline_events）普通 `INSERT`（`is_demo=1`），且只挂到**演示案件**（选取时用 `WHERE is_demo=1`，绝不挂到顾客案件上）。

保证：不重复；顾客的 `is_demo=0` 数据完全不受影响。

### 固定 ID 与 ID 空间

- 演示父记录用固定小 ID（客户 1–5、催收员 1–4、债务人 1–12、案件 1–20，与现有 seed 计算出的 ID 一致）。
- 顾客新记录走 AUTOINCREMENT，自然落在演示 ID 之上；**在会话内的删除/重载中不重置 `sqlite_sequence`**，保证新记录 ID 永远高于演示 ID、不冲突。
- 内置"自营"客户（新案件用）是 `is_demo=0`，不受删除/重载影响。

## 代码结构

- **`src/db/schema.sql`**：9 张表加 `is_demo INTEGER NOT NULL DEFAULT 0`。
- **`src/db/seed.js`** 重构为可复用函数并导出：
  - `clearAllTables()`：清空所有表 + 重置 `sqlite_sequence`（仅整库重置用）。
  - `insertDemoRows()`：幂等插入演示数据（父记录固定 ID + `INSERT OR IGNORE` + `is_demo=1`；子记录只挂演示案件）。
  - `deleteDemo()`：上面 ① 的删除逻辑。
  - `seedDemo()` = `clearAllTables()` + `insertDemoRows()`（`npm run seed` / `reset` / 部署启动用；CLI 行为不变）。
- **`src/routes/demo.js`**（admin only，替换现有实现）：
  - `GET /demo-tools`：两个按钮（删除演示 / 重载演示），带说明与二次确认。
  - `POST /demo-tools/delete-demo` → `deleteDemo()`，审计 `demo_delete`。
  - `POST /demo-tools/reload-demo` → `deleteDemo()` + `insertDemoRows()`，审计 `demo_reload`。
- **`src/views/demo/tools.ejs`**：文案改为"删除演示数据 / 重载演示数据"，说明"不影响你试用时新建的数据"。

## 边界与不做的事（YAGNI）

- 不改各业务路由的 INSERT（靠 `is_demo` 列默认 0 自动区分）。
- 不做线上数据持久化（是另一项，见待办清单）。
- 不支持"逐条恢复某个演示记录"——重载是整套演示补齐。
- 生产环境应移除整个 Demo Data 功能（已在 `docs/正式上线待办.md` 记录）。

## 测试

- **单元/集成**（`node:test`，跑真实临时库）：
  1. 全量 `seedDemo()` 后：演示行都 `is_demo=1`，父记录为固定 ID。
  2. 建一条"新数据"（`is_demo=0` 债务人 + 案件），`deleteDemo()` 后：演示数据没了、新数据还在、无报错。
  3. "被引用"场景：给某演示案件加一条 `is_demo=0` 还款 → `deleteDemo()` 后该演示案件（及其债务人/客户）被保留、其余演示删除。
  4. `insertDemoRows()` 幂等：连续跑两次不产生重复（父记录数不变）。
  5. 重载：`deleteDemo()` + `insertDemoRows()` 后演示数据齐全，且步骤 2 建的新数据仍在。
- **手动冒烟**：admin 登录 → 删除演示（列表只剩自己建的）→ 重载演示（演示回来、自己建的还在）；非 admin 访问 `/demo-tools` 得 403。

## 迁移

- `data/` 已被 git 忽略；本地改完 schema 后 `npm run reset` 重建库；线上部署时启动即重灌，自动带上新列。无需手写迁移脚本。
