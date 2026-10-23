# Extension / Restructure — 设计（Phase 6）

## 背景

依据 `Case_Loan_Tenure_Repayment_Action_Plan.md` 第 7、8、10（Phase 6）节。
Phase 1–3 已上线：贷款期限、先息后本账面（`caseBalance()`）、三种计息模式
（monthly / daily / fixed）的 Repayment Schedule 和 Pay 按钮。

Action Plan 的原则：

- Repayment Schedule = 按**原始**贷款规则，客户原本应该还什么。不因提前还款
  自动改写。
- 重新安排只能通过显式的 Extension / Restructure：
  剩余本金 + 新利息规则 + 新期限 → 新还款计划。
- 不允许删除旧还款计划、旧付款记录，不允许覆盖原始贷款资料。

## 目标

case 上新增「Restructure」操作：在某个生效日，把当时的剩余本金按新条款
（计息模式、利率或固定利息、期限）重新安排成新的还款计划，继续催收。
原始条款、原计划、所有付款保持可查；每次重组的原因、当时剩余本金、欠息、
新条款都有记录。

## 已确认的决定

| 问题 | 决定 |
|---|---|
| 实现方式 | 分段记录：新表存每次重组，`cases` 上的原始条款不动 |
| 重组时的欠息（已产生未还的利息） | **单独挂账**：不并入本金、不再生息；作为新计划第一行「欠息」仍需偿还 |
| 可否多次重组 | 可以，按生效日顺序形成多段 |
| 谁能操作 | admin、manager |
| 新条款计息模式 | monthly / daily / fixed 任选；期限一律按月 |
| 撤销 | 只能撤销**最近一次**，且其生效日之后没有付款 |

## 不做（YAGNI）

- 付款记录拆分本金/利息部分并持久化（Action Plan Phase 4）。剩余本金由
  账面实时推导，不需要存；报表需要时再加列。
- 未来生效日的重组（生效日最晚为今天）。
- 资本化欠息、豁免欠息。
- 自动根据提前还款重算计划。

## 数据模型

### 新表 `case_restructures`

```sql
CREATE TABLE IF NOT EXISTS case_restructures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  effective_date TEXT NOT NULL,          -- 新条款起算日，也是新计划的 loan start
  reason TEXT NOT NULL,
  interest_mode TEXT NOT NULL CHECK (interest_mode IN ('fixed','monthly','daily')),
  interest_rate REAL NOT NULL DEFAULT 0, -- monthly: 月 %；daily: 年 %
  interest_amount REAL NOT NULL DEFAULT 0, -- 仅 fixed：新条款的固定利息总额
  tenure INTEGER NOT NULL CHECK (tenure BETWEEN 1 AND 120), -- 月
  maturity_date TEXT NOT NULL,           -- effective_date + tenure 月
  principal_at_cut REAL NOT NULL,        -- 快照：生效日的剩余本金
  arrears_at_cut REAL NOT NULL,          -- 快照：生效日的欠息
  created_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

快照只用于显示和审计。账面始终实时计算；下面的「锁定」规则保证快照和实时
计算不会分歧。

### `cases` 新增列 `interest_charged`

`cases.interest_amount` 目前一词两义：fixed 模式是用户输入的固定利息，
monthly/daily 模式被 `recomputeOutstanding()` 覆盖成「累计应收利息」缓存。
重组后可能出现「原条款 fixed、新条款 monthly」，此时缓存会覆盖第一段的固定
利息输入，算错第一段。

改为：

- `interest_amount`：只作输入（fixed 的固定利息），`recomputeOutstanding()`
  不再写它。
- `interest_charged REAL`：新列，累计应收利息缓存（所有模式、所有段合计），
  由 `recomputeOutstanding()` 写入。
- 迁移：`ALTER TABLE cases ADD COLUMN interest_charged REAL`，随后一次性回填
  `UPDATE cases SET interest_charged = interest_amount WHERE interest_charged IS NULL`
  （fixed 时等于固定利息；accrual 时等于原缓存，两者都正确）。
- 读「利息总额」的 3 处改读 `interest_charged`：`views/cases/show.ejs`
  （Interest 和 recovered %）、`views/cases/statement.ejs`、`routes/reports.js`
  导出。

### 时间线

`timeline_events.event_type` 有 CHECK 约束，新增类型需要重建表（项目无先例）。
重组和撤销用 `note` 类型记录，内容以 `Restructure:` / `Restructure undone:`
开头。权威记录是 `case_restructures` 和 `audit_logs`。

## 账面计算：分段的 `caseBalance()`

### 段（segment）

- 第 0 段：来自 `cases` —— 模式、利率、固定利息 `interest_amount`、起算日
  `interest_from || opened_at`、到期日 `maturity_date`。
- 第 k 段（k ≥ 1）：来自第 k 次重组 —— 模式、利率、固定利息、起算日
  `effective_date`、到期日 `maturity_date`。
- 段按 `effective_date` 升序；第 k 段的结束 = 第 k+1 段的起算日；最后一段的
  结束 = `asOf`，默认为最后一段的到期日，没有到期日时为今天（与现有行为一致）。
- **付款归属（全文统一）**：`payment_date < E` 属于 E 之前的段；
  `payment_date ≥ E` 属于从 E 开始的段。快照、锁定、撤销条件都按这条判断。

### 算法

签名向后兼容：`caseBalance(c, payments, asOf, restructures = [])`。

```
remP = c.principal_amount; unpaidInt = 0; paidInt = 0
for each segment s (with end as above):
  if s.mode == fixed: unpaidInt += s.lump      # 固定利息在段起点一次计入
  r = dailyRate(s); last = s.start
  for each not-yet-applied payment p (date-sorted) while no next segment or p.date < next.start:
    unpaidInt += remP * r * daysBetween(last, p.date)
    toInt = min(p.amount, unpaidInt); unpaidInt -= toInt; paidInt += toInt
    remP = max(0, remP - (p.amount - toInt))
    last = max(last, p.date)                   # 不倒退（顺带修复：起算日前的付款
                                               #  原先会把计息起点拉回去）
  unpaidInt += remP * r * daysBetween(last, end)
  # 段末：remP 原样进入下一段；unpaidInt 即「欠息」，原样挂账、不再生息
return { principal: c.principal_amount, paid,
         interest: round2(paidInt + unpaidInt),
         outstanding: round2(remP + unpaidInt),
         principalRemaining: round2(remP), interestUnpaid: round2(unpaidInt) }
```

要点：

- 没有重组时，结果与现在完全一致（fixed：`outstanding = P + I − paid`，
  `interest = I`；accrual：原先息后本逻辑）。用现有测试守住。
- 下一段先还欠息，是先息后本的自然延续：欠息就是 `unpaidInt` 里的一部分。
- 恒等式 `outstanding = principal + interest − paid` 继续成立。
- 新增的 `principalRemaining` / `interestUnpaid` 用于计算重组快照。

`recomputeOutstanding(caseId)` 读取该 case 的重组记录并传入；写
`outstanding_amount` 和 `interest_charged`。

## 还款计划显示

`repaymentSchedule(c, payments, opts)` 增加可选 `opts`：

- `opts.arrears`（金额）：在第一行前插入一行 `{ kind: 'arrears' }`，
  到期日 = 段起算日，参与 FIFO 抵扣（最先被还）。
- `opts.superseded`：历史段专用 —— 跳过 settled 逻辑；未还清的行状态记为
  `restructured`（灰色徽章「Restructured」），不显示 Pay。

case 详情的 Records 弹窗：

1. **当前计划**（最后一段）：
   - 无重组：同现在。
   - 有重组：用最后一次重组构造段对象（principal = `principal_at_cut`，
     loan start / interest_from = `effective_date`，模式、利率、固定利息、
     期限）+ `opts.arrears = arrears_at_cut`，付款只取生效日及之后的。
     欠息行标签「Arrears (carried)」。Pay 按钮规则不变（最早未还的一行）。
2. **Restructure History**（有重组时）：每次重组一块，显示生效日、原因、
   操作人、当时剩余本金、欠息、新条款；可展开（`<details>`）查看被取代的
   那一段计划（只取该段时间窗内的付款，`opts.superseded`）。第 0 段若原本
   没有计划（缺期限等），只显示条款，不显示表格。
3. 账面头部的 Maturity Date 显示当前段到期日；旁边小字「Restructured on
   {date}」。

## 重组操作

### 入口与资格

- case 头部按钮「Restructure」：admin / manager，非只读。
- 资格：`outstanding_amount > 0`，且状态不是 `closed` / `cancelled`。不满足时
  按钮不显示，服务端同样拒绝。

### 表单（对话框）

- 顶部只读信息：当前剩余本金（生效日窗口内没有付款，所以与生效日无关，是
  准确值）、截至今天的欠息（注明「按所选生效日计算」）。
- 字段：
  - 生效日 `effective_date`：必填；`min` = max(最后一次付款日, 上一次重组生效日
    + 1 天, 第 0 段起算日)，`max` = 今天，默认今天。可以等于最后一次付款日：
    那笔付款按「付款归属」规则落入新段，先抵欠息（例如重组当天的首付款）。
  - 计息模式：monthly / daily / fixed。
  - 利率（monthly/daily）或固定利息（fixed），≥ 0。
  - 期限（月）：整数 1–120。
  - 原因：必填。
- 沿用上次修复的做法：原生 `min`/`max`/`required` 在对话框内拦截。

### 服务端 `POST /cases/:id/restructures`

1. 角色 + 资格校验；字段校验（同上界限）；生效日不在范围内 → `?err=`。
2. 用 `caseBalance(c, payment_date < effective_date 的付款, effective_date, 既有重组)`
   求 `principalRemaining`、`interestUnpaid` 作为快照。
3. 事务内：插入 `case_restructures`；`recomputeOutstanding`；`resyncCaseStatus`；
   时间线 note。事务后写 audit log。
4. 重定向 `?ok=Restructured`。

逻辑放在新文件 `src/services/restructure.js`（加载段、资格、生效日范围、
创建、撤销），路由只做薄封装，便于单测。

### 撤销 `POST /cases/:id/restructures/:rid/undo`

- admin / manager；只能是该 case 最近一次重组；且没有 `payment_date ≥
  effective_date` 的付款。否则 `?err=`。
- 删除该行；`recomputeOutstanding`；`resyncCaseStatus`；时间线 note；audit。

## 锁定规则（保证历史不被改写）

设 `E` = 该 case 最近一次重组的生效日。

1. **新付款**（Record Payment、Pay、Fulfill PTP）：`payment_date ≥ E`。
   服务端校验（`cases.js` 付款路由、`ptps.js` recordFulfillment）；
   对话框日期输入加 `min`。
2. **编辑/作废付款**：付款现有日期 `< E` 的不可编辑、不可作废（按钮隐藏，
   服务端拒绝：「该付款属于已重组的期间，请先撤销重组」）。编辑时新日期
   同样须 `≥ E`。
3. **Edit Case**：有重组时，原始贷款条款（本金、计息模式、利率、固定利息、
   loan start date、期限）在表单中禁用并提示原因；服务端忽略这些字段、保留
   数据库原值（由它们推导的 `interest_from`、`maturity_date` 也不变）。其他字段
   （债务人、agent、优先级、备注）照常可改。

## Demo 数据

- `seed.js`：case 14（monthly）加一次重组：生效日 = 10 天前，新条款 monthly
  1.2%、18 个月，原因「Debtor requested lower instalments」，快照按算法计算。
  这样线上 demo 能看到欠息行、新计划和历史。
- `clearAllTables` 和 `deleteDemo` 的表列表加入 `case_restructures`（需先于
  `cases` 删除）。

## 测试

纯函数（`test/restructure.test.js`、更新 `test/schedule.test.js`）：

- 无重组：`caseBalance` 结果与改动前一致（现有测试全部保持通过）。
- 单次重组 monthly→monthly：快照正确；欠息挂账不生息；之后付款先还欠息；
  `outstanding = principal + interest − paid` 恒等。
- fixed→monthly、monthly→fixed、daily→fixed：段间本金接续、固定利息只计入
  其所属段。
- 两次重组：第二段的结束 = 第三段起算日。
- 起算日前的付款不再把计息起点拉回去（`last` 不倒退）。
- 当前计划：欠息行在首行、FIFO 先抵欠息；新计划合计 = 账面 outstanding
  （fixed 精确；accrual 允许分位误差）。
- 历史段：未还行状态为 `restructured`，无 settled 覆盖。

路由 / 服务（沿用现有临时 DB 测试模式）：

- 角色：agent / finance / auditor 不能重组、不能撤销。
- 资格：outstanding = 0、closed、cancelled 被拒。
- 生效日：早于最后付款日、晚于今天、不晚于上次重组 → 拒绝。
- 锁定：重组后早于 E 的付款日期被拒；编辑/作废 E 之前的付款被拒；
  Edit Case 不改动原始条款。
- 撤销：非最近一次被拒；生效日后已有付款被拒；成功后余额恢复为重组前。
- `interest_charged` 回填与写入；fixed 第 0 段的 `interest_amount` 在重组后
  保持不变。

## 涉及文件

- `src/db/schema.sql`、`src/db/index.js`：新表、`interest_charged` 列与回填。
- `src/services/payments.js`：分段 `caseBalance`；`recomputeOutstanding`
  读重组、写 `interest_charged`。
- `src/services/restructure.js`（新）：段加载、资格、生效日范围、创建、撤销。
- `src/utils/schedule.js`：`opts.arrears`、`opts.superseded`。
- `src/routes/cases.js`：重组/撤销路由；付款日期与锁定校验；Edit Case 锁定；
  详情页组装当前计划和历史。
- `src/routes/ptps.js`：Fulfill 付款日期校验。
- `src/routes/reports.js`、`src/views/cases/statement.ejs`：读 `interest_charged`。
- `src/views/cases/show.ejs`：按钮、对话框、当前计划/历史、锁定显示。
- `src/views/cases/form.ejs`：条款字段禁用。
- `src/db/seed.js`：demo 重组、表列表。
- `test/restructure.test.js`（新）、`test/schedule.test.js`。
