# 设计：B 组剩余 —— 移除 client 角色 + 案件对账单 PDF

## 背景与目标

B 组还剩两项独立小功能（默认按用户离开前的推荐选项，评审时可改）：

1. **移除 client 角色**：内部系统不给顾客登录，`client` 角色不再可用。采用**界面级移除**：不能创建/编辑出 client 用户、种子不再建 client 账号、demo-accounts 无 client；底层 scope/报表里的 `client` 分支作为无害死代码保留（没有 client 账号就永远走不到）。
2. **案件对账单 PDF**：在案件详情加「打印 / 存 PDF」，生成该案件的**打印友好对账单**页（债务人信息 + 本金/利息/已还/欠款 + 还款明细），用户浏览器 Ctrl+P → 存为 PDF 发给顾客。零依赖（不加 PDF 库）。

一个 spec / 一个实现计划。两项相互独立。无 schema 变更、零新依赖。

## 现状（已核对）

- `src/routes/users.js`：`const ROLES = ['admin','manager','agent','finance','auditor','client'];`（用户创建/编辑的角色下拉来源）。
- `src/db/seed.js:107`：`INSERT ... users ... 'client1' ... 'client' ... client_id=1`（会建一个 client 账号）。
- `src/app.js` 的 `/demo-accounts`：账号数组**已无** client1（早前移除）。
- README 有 3 处 "client" 提及（多为演示账号说明）。
- `src/utils/scope.js`、`src/routes/{reports,tasks,search,cases}.js`、`src/views/reports/index.ejs` 有 `client` 角色的 scope/隐藏判断——**保留不动**（无害）。
- `src/routes/cases.js`：`loadCase(req,res)` 按 scope 取案件（含 debtor 名/电话/IC、agent 名），404 越权。`GET /:id` 已查 `payments`（`ORDER BY payment_date DESC`）。

## 功能 1：移除 client 角色（界面级）

- **`src/routes/users.js`**：从 `ROLES` 去掉 `'client'` → 变 `['admin','manager','agent','finance','auditor']`。这样 new/edit 用户表单的角色下拉不再有 client；后端校验 `ROLES.includes(b.role)` 也拒绝 client。create/edit 里 `role === 'client'` 的 client_id 关联分支自然永不触发（保留，无害）。
- **`src/db/seed.js`**：删除第 107 行创建 client1 用户的那条 `run(...)`。种子用户变 7 个（admin/manager/agent1-3/finance/auditor）。
  - 注意：seed 里 clients（公司）表不动（Sinar 等是"客户公司"，与 `client` 用户角色无关）；内置"自营"客户不受影响。
- **`src/db/seed.js`** 末尾 console 文案「6 users」→「7 users」（当前其实建 7 个非 client + 1 client = 8；去掉 client1 后是 7）。核对实际数量并更新文案。
- **`src/views/users/edit.ejs` 与 `form.ejs`**：角色下拉由 ROLES 驱动，自动少 client；其中 client-field（关联客户下拉）区块保留但永不显示（inert），可保留以减少改动。
- **README.md**：演示账号表去掉 client1 行；其它 client 提及按需更正为"无 client 角色/内部系统"。
- **`docs/使用手册.md`**：角色表去掉 client 行（若有）。
- 不改 scope.js/报表/任务/搜索/案件里的 client 分支（死代码、无害；日后彻底清理可另做）。

## 功能 2：案件对账单 PDF（打印友好页）

- **路由** `src/routes/cases.js`：新增 `GET /:id/statement`（`requireLogin`）：用 `loadCase(req,res)` 取案件（自带 scope + 404）；查 `payments`（该案件全部，按日期）；算 `paid = SUM(payments)`；渲染独立视图 `cases/statement`。
- **视图** `src/views/cases/statement.ejs`：**独立页**（不套带侧边栏的 `layout`，像登录/demo-accounts 那样自带 `<!doctype>`），打印友好排版：
  - 抬头：公司名「Debt Collection CRM」+ 「Case Statement」+ 案号 + 生成日期（MYT）。
  - 债务人：姓名、电话、IC/护照。
  - 金额:本金、利息、已还、**欠款**(用 `c.outstanding_amount`)。
  - 还款明细表：收据号、日期、金额、方式。
  - 顶部一个「Print / Save as PDF」按钮（`onclick="window.print()"`）和「← Back」链接；两者在 `@media print` 下隐藏。
  - `@media print` CSS：隐藏按钮/链接、去背景色、A4 友好边距。可内联在该页 `<style>` 或复用 `/css/style.css` + 页面内联 print 规则。
- **入口按钮**：`src/views/cases/show.ejs` 页头加一个 `Print statement` 链接指向 `/cases/<%= c.id %>/statement`（对所有能看该案件的角色可见，含只读/审计——它是只读导出）。
- 权限：`loadCase` 已保证只有能看该案件的人能生成（agent 只能自己案件）。
- 零依赖：不生成服务端 PDF，靠浏览器打印。

## 不做（YAGNI）
- 不引 PDF 库、不做服务端 PDF 生成（打印页足够，Render 免费版也能用）。
- 不删 scope/报表里的 client 死代码（无害；彻底清理可日后单独做）。
- 不改 schema 的 users.role CHECK（保留 'client' 无害；删除需迁移）。

## 测试
- **单元**（`node:test`，隔离 DB）：
  1. ROLES 不含 client：`require('../src/routes/users')` 后无法……（ROLES 是内部常量；改测"创建 client 用户被拒"较重）。改为断言 seed 后不存在 client 账号：`seedDemo()` 后 `SELECT COUNT(*) FROM users WHERE role='client'` = 0。
  2. 对账单数据：seed 后取一个有还款的案件，断言 `paid = SUM(payments)`、`outstanding = c.outstanding_amount`（与页面口径一致）。
- **手动冒烟**：
  - 用户管理：新建/编辑用户的角色下拉无 client。
  - `npm run seed` 后无 client 账号；用 client1/client123 登录失败。
  - 案件详情有「Print statement」；点开对账单页,金额/还款明细正确;Ctrl+P 预览时按钮/侧栏隐藏、排版干净。
  - agent 只能对自己案件生成对账单;越权 /cases/:id/statement → 404。

## 迁移
无 schema 变更。`npm run seed` 后 client 账号消失。
