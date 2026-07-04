# 设计：A 组快速改进（任务提示条、债务人/催收员筛选、用户编辑）

## 背景与目标

来自用户的 8 项优化批次的 **A 组**（快速改进，低风险 UI）。B/C 组另行设计。本组四项：

1. **任务状态提示条**：任务页顶部显示当前用户可见任务的汇总（待办数、逾期数），像"未读提醒"，避免全埋在表格里被漏看。
2. **债务人列表筛选**：顶部加筛选栏（风险等级 + 关键字），方便快速分类/过滤。
3. **催收员列表筛选**：顶部加筛选栏（部门 + 启用状态）。
4. **用户编辑**：用户列表每行加铅笔编辑图标 →编辑页，可改用户名/姓名/角色/关联催收员、启停；密码重置沿用现有独立页（从编辑页链接过去）。

均遵守现有行级权限；无 schema 变更；零新依赖。

## 各项设计

### 1. 任务状态提示条

- **路由** `src/routes/tasks.js` GET `/`：无需新查询。`tasks` 已按角色 scope。
- **视图** `src/views/tasks/index.ejs`：在 `.page-head` 下方、`+ New Task` 折叠面板之前，加一个提示条，用已传入的 `tasks` 数组在模板里派生计数：
  - `pending` = `tasks.filter(t => t.status === 'pending').length`
  - `overdue` = pending 且 `t.due_date && h.daysOverdue(t.due_date) > 0` 的数量（逾期=紧急，任务表没有 priority 字段，用逾期代表紧急）
  - 展示：一个 `.taskbar` 条：`🔔 <pending> 待办 · <overdue> 逾期`。着色：overdue>0 → 红（`is-red`）；否则 pending>0 → 金（`is-gold`）；否则绿"全部处理完"（`is-green`）。
  - 复用现有 `.alert`/`.badge` 类，或加一个小 `.taskbar` 规则（沿用设计系统配色变量）。
- 说明：这是纯派生显示，不改任务数据；agent 只看到自己范围内的计数（因为 `tasks` 已 scope）。

### 2. 债务人列表筛选

- **路由** `src/routes/debtors.js` GET `/`：现有按 `reachableDebtorIds` 分支（null/空/列表）。改为统一构造 WHERE：
  - 基础 scope：unrestricted → `1=1`；scoped 空 → 直接返回空；scoped 有 id → `id IN (?,...)`。
  - 追加筛选（都用 `?` 参数）：
    - `req.query.risk`（low/medium/high）→ `AND risk_level = ?`
    - `req.query.q` → `AND (name LIKE ? OR ic_passport LIKE ? OR phone LIKE ?)`（`%q%`）
  - `ORDER BY name`。把 `query` 传给视图用于回填。
- **视图** `src/views/debtors/list.ejs`：`.page-head` 下加一个 `<form class="card filters" method="get">`：风险 `<select name="risk">`（All/Low/Medium/High，按 `query.risk` 回填）+ `<input name="q">`（按 `query.q` 回填）+ Filter 按钮。空结果用现有 empty partial。

### 3. 催收员列表筛选

- **路由** `src/routes/agents.js` GET `/`：现有 `STAT ... FROM agents a ORDER BY collected DESC`。加筛选 WHERE：
  - `req.query.department` → `AND a.department = ?`
  - `req.query.status`：`active` → `AND a.active=1`；`inactive` → `AND a.active=0`；空 → 不限。
  - 传 `departments`（`SELECT DISTINCT department FROM agents WHERE department IS NOT NULL ORDER BY department`）和 `query` 给视图。
- **视图** `src/views/agents/list.ejs`：加筛选栏：部门 `<select name="department">`（All + departments 列表，回填）+ 状态 `<select name="status">`（All/Active/Inactive，回填）+ Filter 按钮。

### 4. 用户编辑（铅笔图标 → 编辑页）

- **图标**：`src/utils/helpers.js` 的 `ICONS` 加一个 `edit`（铅笔 SVG）。
- **视图** `src/views/users/index.ejs`：每行 Action 区在 "Reset PW"/"Disable" 旁加一个铅笔链接 `<a class="btn btn-sm" href="/users/<%= u.id %>/edit"><%- h.icon('edit') %></a>`（Edit）。
- **新视图** `src/views/users/edit.ejs`：编辑表单（`POST /users/:id`），字段：
  - Username（`<input name="username" required>`，回填当前值）
  - Full Name（required，回填）
  - Role（`<select name="role">` 六种角色，回填；沿用 new 表单的 agent/client 联动显示——选 agent 显示关联催收员下拉，选 client 显示关联客户下拉）
  - 关联催收员/客户下拉（同 new 表单）
  - Active（`<select name="active">` Active/Inactive，回填；或复用 parseActive）
  - 底部：Save + Cancel(→/users)，另有一条"Reset password"链接指向现有 `/users/:id/password` 页。
- **路由** `src/routes/users.js`：
  - `GET /:id/edit`（adminOnly）：取用户 + agents/clients 列表，渲染 edit 视图；用户不存在 → 重定向 `/users?err=User+not+found`。
  - `POST /:id`（adminOnly）：校验 username/full_name/role（同 new 的校验）；agent/client 角色需关联；用 `parseActive` 解析 active。
    - **自我保护**：不允许把"当前登录的自己"从 admin 改成其它角色，也不允许把自己设为 inactive（否则会把自己锁死）。命中则重定向带 `?err=`。
    - UNIQUE 用户名冲突用 try/catch → 重定向带 `?err=`。
    - 成功 → `logAction('update','user',id,...)` → 重定向 `/users?ok=User+updated`。
  - 保留现有 `/:id/password`、`/:id/toggle` 路由不动（编辑页仅新增，不破坏原有入口）。
- 注意 `parseActive` 已存在于 `src/utils/forms.js`（返回 0 仅当值为 '0'）。

## 不做（YAGNI）

- 不在本组移除 client 角色（B 组处理）；用户编辑暂含 client 选项。
- 任务不加 priority 字段（用逾期代表紧急）。
- 不做保存后回填用户输入（校验失败重定向回空表单，靠前端 required 兜住常见情况）。

## 测试

- **单元**（`node:test`，隔离 DB via CRM_DB_PATH）：
  1. 债务人筛选查询：插入不同 risk 的债务人，按 `risk=high` 只返回 high；按 `q` 命中 name/ic/phone。抽一个构造 WHERE 的小函数或直接断言路由查询结果。
  2. 用户编辑自我保护：`parseActive` 已测；补一条断言"admin 不能把自己改 inactive"的逻辑（可在路由层测或抽判断函数）。
- **手动冒烟**：
  - 任务页：作为 agent，顶部提示条显示正确的待办/逾期数，颜色随状态变。
  - 债务人页：风险筛选 + 关键字都生效，且 agent 只看到自己范围。
  - 催收员页：部门/状态筛选生效。
  - 用户页：点铅笔 → 改用户名/姓名/角色/关联/启停都生效；改自己的 admin 角色/停用自己被拦下；密码重置链接可用。

## 迁移

无 schema 变更。

---

## 记录：B/C 组的默认决定（等用户确认后各自出 spec）

用户离开时按推荐默认记录，正式做 B/C 前再确认：

- **B 组**：移除 client 角色 = **从界面彻底移除**（建用户去掉 client 选项、去掉 client1 演示账号与 demo-accounts 里的 client、简化仪表盘/报表里隐藏排行榜的判断；数据库 CHECK 保留不动）。**佣金** = 催收员佣金汇总报表：某催收员佣金 = 其名下案件已收金额 × `agents.commission_rate%`。**导出 PDF** = 打印友好页（浏览器 Ctrl+P → 存为 PDF），零依赖。
- **C 组**：**PTP Fulfill** = 弹框让用户确认/输入实际收款金额（预填 PTP 金额）→ 自动记一笔还款 → 欠款减少、收款增加。**案件详情** = 把右侧 Payment/PTP/Calls/Notes/Status 操作面板重排到上方，"下一步操作"用弹窗（可取消返回）。
- **#6 日志**：不写入 GitHub。用 Render 的 Logs 标签看；如需可另做"管理员错误日志页"。
