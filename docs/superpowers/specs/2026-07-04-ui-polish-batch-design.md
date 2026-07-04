# 设计：界面优化批次（agent active、明细 CSV、任务表单收起）

## 背景与目标

四项独立的界面/逻辑小优化，提升清晰度与实用性：

1. 创建催收员时的 **active 控件更明显**，且默认启用（Active）。
2. **Reports 增加「逐案明细」CSV 导出**（案号、债务人、催收员、本金、利息、已还、欠款、状态等）。
3. **Cases 列表的 CSV 导出也补足明细列**（与 #2 同一套列，保持一致）。
4. **新建任务表单默认收起**，用可展开的「+ New Task」呈现，让任务表格更清晰。

全部为现有页面的小改，放一个 spec / 一个实现计划一起做。已确认的取舍：Reports 保留现有 3 个汇总导出，**新增**一个逐案明细导出；agent active 改成 Status 下拉。**Reports 与 Cases 的明细列各自按用途设计，不强求相同**（Reports 偏财务视角，Cases 偏案件运营视角）。

> **利息模型（用户新增的第 5 点）暂缓** —— 见文末「待定：利息计算模型」。当前利息仍为建案时手填的固定金额，本批 CSV 只读取已存金额，不受利息模型影响，可独立先做。

## 明细列的取值口径（公用工具）

- **Paid（已还）** = 该案件所有还款之和，用相关子查询取，保证准确：
  `(SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid`
- Principal/Interest/Outstanding 直接取 `cases.*`。金额在 CSV 里输出**原始数值**（不加千分位，方便 Excel 计算）。
- Agent 为空输出空字符串。Status 用 `caseStatusLabel(status)` 可读文案。日期用 `dateFmt`（MYT）。
- 全部经 `caseWhere` 行级过滤（催收员/客户只导出自己范围内的案件）。CSV 走现有 `src/utils/csv.js` 的 `toCsv`/`sendCsv`（已带 UTF-8 BOM，Excel 中文不乱码）。

### 两套明细列（各自合理，不相同）

- **Reports 逐案明细（财务视角）**：
  `Case No, Debtor, Agent, Principal, Interest, Paid, Outstanding, Status, Opened`
- **Cases 列表导出（运营视角）**：
  `Case No, Debtor, Debtor Phone, Agent, Outstanding, Paid, Priority, Status, Opened`
  （运营更关心联系方式和优先级，故加 Debtor Phone、保留 Priority；本金/利息在财务报表里看，这里从简。）

## 各项设计

### #1 催收员 active → Status 下拉，默认 Active

- **表单** `src/views/agents/form.ejs`：把当前的 `<input type="checkbox" name="active">` 换成一个 Status 下拉：value="1" Active / value="0" Inactive；新建时 `agent.active` 为 `undefined`（不等于 0）→ 默认选 Active，编辑时按现值回填（`agent.active===0` 时选 Inactive）。
- **路由** `src/routes/agents.js`（POST `/` 和 POST `/:id`）：现有 `b.active?1:0` 在下拉下会出错——字符串 `"0"` 是 truthy，会把 Inactive 误存成启用。改为按值精确判断：`const active = b.active === '0' ? 0 : 1;`（下拉只会给 '0' 或 '1'；缺省视为启用）。create 与 update 都用 `active`。抽一个小函数 `parseActive(v)` 便于测试。

### #2 Reports 逐案明细导出

- **路由** `src/routes/reports.js`：在现有两个 `export` 分支旁，新增 `if (req.query.export === 'cases')` 分支：查询本用户 `caseWhere` 范围内的所有案件（带 debtor/agent 名和 paid 子查询），用 **Reports 财务视角列** 导出 `cases-detailed.csv`。此明细为**当前快照**（非日期范围），与「按状态欠款」报表口径一致。
- **视图** `src/views/reports/index.ejs`：在页面顶部（日期筛选表单附近）加「Export detailed cases (CSV)」按钮，链接 `/reports?export=cases`。现有 3 个汇总导出按钮保留不变。

### #3 Cases 列表 CSV 补明细

- **路由** `src/routes/cases.js` 的 `format === 'csv'` 分支：把 paid 子查询并入导出查询，改用 **Cases 运营视角列**（含 Debtor Phone、Paid），文件名 `cases.csv` 不变。导出**继续遵守当前筛选**（status/priority/q）与行级范围。
- **视图** `src/views/cases/list.ejs`：现有「Export CSV」按钮已带上筛选参数，不用改。

### #4 新建任务表单收起（原生 `<details>`）

- **视图** `src/views/tasks/index.ejs`：把现有那段 `<form class="card form" action="/tasks/new">…</form>`（含角色判断）用原生 `<details class="new-panel">` 包起来，`<summary class="btn btn-gold">+ New Task</summary>`，默认收起，放在 `.page-head` 下方、任务表格上方。字段、必填、提交逻辑一律不变，仅外层包裹 + 默认收起。
- **CSS** `public/css/style.css`：加少量样式让 `<summary>` 像按钮、去掉默认三角、展开时留上边距：
  ```css
  .new-panel { margin-bottom: 16px; }
  .new-panel > summary { display: inline-flex; align-items: center; cursor: pointer; list-style: none; }
  .new-panel > summary::-webkit-details-marker { display: none; }
  .new-panel[open] > summary { margin-bottom: 12px; }
  ```
  纯 CSS，无 JS，无新依赖。

## 不做（YAGNI）

- 不改其它模块的表单/导出（debtors/clients 列表当前没有导出按钮，本批不新增）。
- 明细 CSV 不做「按日期范围过滤逐案」——保持当前快照，简单够用。
- 任务表单收起用原生 `<details>`，不引入任何 JS 折叠库。

## 测试

- **单元/集成**（`node:test`，隔离临时库 via CRM_DB_PATH）：
  1. `parseActive(v)`：`'0'`→0；`'1'`/`undefined`/`'on'`→1。
  2. Paid 取值：给一个案件加两笔还款后，查询返回的 `paid` 等于两笔之和（子查询正确）。测一个小函数 `caseCsvRow(row)`（把一行数据映射成 CSV 列数组）以覆盖两套列的取值/顺序。
- **手动冒烟**：
  - 新建催收员：Status 默认 Active；选 Inactive 保存后显示停用；编辑回 Active 正常。
  - Reports：点「Export detailed cases」下载 CSV 含 Paid/Outstanding 等列且数值正确；催收员登录只导出自己范围。
  - Cases 列表：带筛选导出，列已含明细，中文不乱码。
  - Tasks：进页面时创建表单收起，点「+ New Task」展开、能正常建任务；表格更清爽。

## 迁移

无 schema 变更，无需迁移。

---

## 待定：利息计算模型（用户第 5 点，等确认后单独做）

现状：利息是建案时**手填的固定金额**（`cases.interest_amount`），不随时间变。用户希望改为「按月计息，利息由本金算出」。这是业务模型变更，比本批 UI 优化影响大（涉及建案表单、余额重算 `recomputeOutstanding`、显示层），需先由用户在下列模型中选一个，再单独出 spec/plan：

- **A. 按月自动计息（随时间增长）**：建案填「月利率%」，利息 = 本金 × 月利率 × 已过月数；欠款随时间变大。最贴近真实借贷，改动最大（余额需按当前日期动态算或定时结算）。
- **B. 建案时按利率算一次（之后固定）**：建案填「月利率%」和「月数」，当场算出 `interest_amount = 本金 × 月利率 × 月数` 存下来，之后不变。改动小，仅建案表单 + 一处计算。
- **C. 维持现状**：继续手填固定利息金额。

本批（#1–#4）不依赖此决定，先行实现。
