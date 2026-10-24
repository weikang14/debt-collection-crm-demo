# Extension / Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** case 上新增「Restructure」：在生效日把剩余本金按新条款重新安排成新还款计划，欠息单独挂账，原始条款、原计划、历史付款全部保留可查。

**Architecture:** 新表 `case_restructures` 每次重组一行；`caseBalance()` 改为按段（原条款 + 每次重组）计算先息后本账面；新服务 `src/services/restructure.js` 负责资格、生效日范围、快照、创建/撤销、锁定规则和详情页的计划组装；路由只做薄封装。新增 `cases.interest_charged` 缓存利息总额，`interest_amount` 回归为 fixed 模式的输入。

**Tech Stack:** Node ≥22.5、`node:sqlite`、Express 4、EJS（ejs-mate）、dayjs、`node --test`。

**Spec:** `docs/superpowers/specs/2026-10-23-restructure-design.md`

## Global Constraints

- 不新增任何依赖。
- 日期一律 `YYYY-MM-DD` 字符串、马来西亚时间（UTC+8）；"今天" 用 `todayMYT()`。
- 金额落库/比较前用 `round2()`。
- 重组、撤销：仅 `admin`、`manager`。
- 新期限：整数 1–120 个月；利率、固定利息 ≥ 0；原因必填。
- 付款归属：`payment_date < E` 属于 E 之前的段；`payment_date ≥ E` 属于从 E 开始的段（快照、锁定、撤销同一规则）。
- 生效日范围：`min = max(第 0 段起算日, 所有付款日, 上次重组生效日 + 1 天)`，`max = 今天`。
- 资格：`outstanding_amount > 0` 且状态不是 `closed` / `cancelled`。
- 测试每个文件自设 `CRM_DB_PATH` 到 tmpdir；**绝不对 `data/crm.db` 跑 seed**。
- 每次改代码后跑 `graphify update .`；commit message 末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. **原始条款没有期限的 case 被重组**（所有 demo fixed case、老数据）：历史区只显示条款不显示表格，当前计划正常生成 —— Task 4 测试。
2. **生效日当天的付款**（重组当天的首付款）：允许生效日 = 该付款日；快照不含它；它落入新段、先抵欠息行 —— Task 3 测试。
3. **同一天重组两次**：第二次因 `min = 上次 + 1 天 > 今天` 被拒，且对话框提示无可选日期 —— Task 3 测试。
4. **重组后作废/编辑付款**：生效日之前的被拒，之后的照常 —— Task 3 测试（`lockedPaymentError`）。
5. **重组后在 Edit Case 只改 agent/优先级**：只读输入照常提交、原始条款不变、不报 "principal required" —— Task 3 测试（`lockedTerms`）+ Task 6 浏览器验证。

---

### Task 1: `interest_charged` 缓存列 + `case_restructures` 表

**Files:**
- Modify: `src/db/schema.sql`（cases 加列；新表 + 索引）
- Modify: `src/db/index.js`（迁移 + 回填，放在 `init()` 末尾）
- Modify: `src/services/payments.js:80-93`（`recomputeOutstanding` 写 `interest_charged`）
- Modify: `src/routes/cases.js:104-106`、`src/db/seed.js:73-75`（INSERT 带 `interest_charged`）
- Modify: `src/views/cases/show.ejs:21,38`、`src/views/cases/statement.ejs:37`、`src/routes/reports.js:24,29`（读 `interest_charged`）
- Test: `test/interest_accrual.test.js:55-64`（改）、`test/interest_charged_migration.test.js`（新）

**Interfaces:**
- Produces: 列 `cases.interest_charged REAL NOT NULL DEFAULT 0`；表 `case_restructures`（列见 Step 3）。

- [ ] **Step 1: 改现有缓存测试并新增"输入不被覆盖"测试**

`test/interest_accrual.test.js` 把 `recomputeOutstanding caches derived interest for accrual cases` 整个替换为：

```js
test('recomputeOutstanding caches derived interest in interest_charged for accrual cases', () => {
  db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
  db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from)
    VALUES (1,'C1',1,1,36500,0,36500,'new','daily',10,'2000-01-01')`);
  const out = recomputeOutstanding(1);
  const row = db.get('SELECT interest_charged, outstanding_amount FROM cases WHERE id=1');
  assert.ok(row.interest_charged > 0, 'interest cached to column');
  assert.strictEqual(row.outstanding_amount, out);
  assert.strictEqual(row.outstanding_amount, db.get('SELECT 36500+interest_charged AS x FROM cases WHERE id=1').x);
});

test('recomputeOutstanding never overwrites the interest_amount input', () => {
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from)
    VALUES (2,'C2',1,1,36500,123,36500,'new','daily',10,'2000-01-01')`);
  recomputeOutstanding(2);
  const row = db.get('SELECT interest_amount, interest_charged FROM cases WHERE id=2');
  assert.strictEqual(row.interest_amount, 123);
  assert.ok(row.interest_charged > 123);
});
```

新建 `test/interest_charged_migration.test.js`：

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-intcharged-migration-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

// A pre-migration cases table (no interest_charged), created before init()
// runs schema.sql, whose CREATE TABLE IF NOT EXISTS then leaves it alone.
db.exec(`
  CREATE TABLE clients (id INTEGER PRIMARY KEY, company_name TEXT);
  CREATE TABLE debtors (id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO clients VALUES (1, 'C');
  INSERT INTO debtors VALUES (1, 'D');
  CREATE TABLE cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_no TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL, debtor_id INTEGER NOT NULL, agent_id INTEGER,
    principal_amount REAL NOT NULL DEFAULT 0, interest_amount REAL NOT NULL DEFAULT 0,
    outstanding_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new');
  INSERT INTO cases (case_no, client_id, debtor_id, principal_amount, interest_amount, outstanding_amount)
    VALUES ('OLD-1', 1, 1, 1000, 250, 1250);
`);
db.init();

test('interest_charged is added and backfilled from interest_amount', () => {
  const r = db.get("SELECT interest_amount, interest_charged FROM cases WHERE case_no='OLD-1'");
  assert.strictEqual(r.interest_charged, 250);
  assert.strictEqual(r.interest_amount, 250);
});

test('case_restructures table exists', () => {
  assert.ok(db.all('PRAGMA table_info(case_restructures)').some(c => c.name === 'arrears_at_cut'));
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --no-warnings --test test/interest_accrual.test.js test/interest_charged_migration.test.js`
Expected: FAIL（`no such column: interest_charged` / `case_restructures` 不存在）

- [ ] **Step 3: schema**

`src/db/schema.sql` cases 表 `outstanding_amount` 行后插入：

```sql
  -- Cache of total interest charged (every mode, every restructure segment),
  -- written by recomputeOutstanding(). interest_amount stays the fixed-mode input.
  interest_charged REAL NOT NULL DEFAULT 0,
```

在 `payments` 表定义之后加：

```sql
-- One row per Extension / Restructure (docs/superpowers/specs/2026-10-23-restructure-design.md).
-- The case's own columns stay the original loan terms; each row starts a new
-- ledger segment at effective_date. *_at_cut are display/audit snapshots.
CREATE TABLE IF NOT EXISTS case_restructures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  effective_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  interest_mode TEXT NOT NULL CHECK (interest_mode IN ('fixed','monthly','daily')),
  interest_rate REAL NOT NULL DEFAULT 0,
  interest_amount REAL NOT NULL DEFAULT 0,
  tenure INTEGER NOT NULL CHECK (tenure BETWEEN 1 AND 120),
  maturity_date TEXT NOT NULL,
  principal_at_cut REAL NOT NULL,
  arrears_at_cut REAL NOT NULL,
  created_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

索引区加：`CREATE INDEX IF NOT EXISTS idx_restructures_case ON case_restructures(case_id, effective_date);`

- [ ] **Step 4: 迁移**

`src/db/index.js` `init()` 末尾（`maturity_date` 那行 ALTER 之后、`}` 之前）加：

```js
  // Migration: interest_charged = cached total interest (see schema.sql). The
  // one-time backfill copies interest_amount, which held that cache for accrual
  // cases and the charged lump for fixed ones — correct either way. Runs only
  // when the ALTER succeeds.
  try {
    db.prepare('ALTER TABLE cases ADD COLUMN interest_charged REAL NOT NULL DEFAULT 0').run();
    db.prepare('UPDATE cases SET interest_charged = interest_amount').run();
  } catch (e) { /* exists */ }
```

- [ ] **Step 5: `recomputeOutstanding` 改写**

`src/services/payments.js` 中 `const b = caseBalance(c, payments);` 之后的 if/else 整段替换为：

```js
  // interest_charged caches total interest for every mode. interest_amount is the
  // fixed-mode input and is never overwritten: a restructure can switch a fixed
  // loan to an accrual mode, and segment 0 still needs its original lump.
  run("UPDATE cases SET outstanding_amount=?, interest_charged=?, updated_at=datetime('now') WHERE id=?", [b.outstanding, b.interest, caseId]);
```

- [ ] **Step 6: INSERT 与读取方**

先确认没有别的建 case 入口：`grep -rn "INSERT INTO cases\|INSERT OR IGNORE INTO cases" src` 应只命中下面两处。

- `src/routes/cases.js` 新建 case 的 INSERT 整句替换为：
  ```js
  const r = run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,interest_charged,outstanding_amount,priority,status,remark,interest_mode,interest_rate,interest_from,loan_start_date,tenure,tenure_unit,maturity_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [case_no, internalClientId(), b.debtor_id, b.agent_id||null, principal, interest, interest, principal+interest, b.priority||'medium', b.status||'new', b.remark||null, mode, rate, from, loanStart, tenure, tenureUnit, maturity]);
  ```
- `src/db/seed.js` cases INSERT 整句替换为：
  ```js
    run(`INSERT OR IGNORE INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,interest_charged,outstanding_amount,priority,status,opened_at,closed_at,is_demo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [id, case_no, client_id, debtor_id, agent_id, principal, interest, interest, outstanding, PRIOS[i % 4], st, ago(60 - i),
       ['fully_paid','closed','cancelled'].includes(st) ? ago(5) : null]);
  ```
- `src/views/cases/show.ejs:21`：`(c.interest_amount || 0)` → `(c.interest_charged || 0)`；`:38`：`h.money(c.interest_amount)` → `h.money(c.interest_charged)`。
- `src/views/cases/statement.ejs:37`：`c.interest_amount` → `c.interest_charged`。
- `src/routes/reports.js:24`：`cases.interest_amount` → `cases.interest_charged`；`:29`：`c.interest_amount` → `c.interest_charged`。

- [ ] **Step 7: 运行，确认通过；再跑全量**

Run: `node --no-warnings --test test/interest_accrual.test.js test/interest_charged_migration.test.js` → PASS
Run: `npm test` → 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql src/db/index.js src/services/payments.js src/routes/cases.js src/db/seed.js src/views/cases/show.ejs src/views/cases/statement.ejs src/routes/reports.js test/interest_accrual.test.js test/interest_charged_migration.test.js
git commit -m "feat: interest_charged cache column and case_restructures table"
```

---

### Task 2: 分段的 `caseBalance()`

**Files:**
- Modify: `src/services/payments.js:48-78`（`caseBalance` 重写 + 新 `loanSegments`），`recomputeOutstanding` 读重组
- Test: `test/restructure_ledger.test.js`（新）

**Interfaces:**
- Consumes: Task 1 的 `case_restructures` 表。
- Produces: `caseBalance(c, payments, asOf?, restructures = [])` → `{ principal, interest, paid, outstanding, principalRemaining, interestUnpaid }`。`restructures` 元素字段：`effective_date, interest_mode, interest_rate, interest_amount, maturity_date`，按 `effective_date` 升序；`payments` 按 `payment_date` 升序。

- [ ] **Step 1: 写失败测试**

新建 `test/restructure_ledger.test.js`：

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsledger-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const { caseBalance, recomputeOutstanding } = require('../src/services/payments');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

// 3000 @ 3%/month => 3.00/day. 1.5%/month => 1.50/day on 3000.
const base = { interest_mode: 'monthly', principal_amount: 3000, interest_rate: 3, interest_from: '2026-01-01', maturity_date: '2026-04-01' };
const r1 = { effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: 1.5, interest_amount: 0, maturity_date: '2026-01-21' };

test('cut snapshot: balance as of the effective date', () => {
  const b = caseBalance(base, [], '2026-01-11');
  near(b.principalRemaining, 3000, 'principal');
  near(b.interestUnpaid, 30, 'arrears = 10 days x 3.00');
});

test('restructure: arrears carried without accruing, principal continues under new terms', () => {
  const b = caseBalance(base, [], undefined, [r1]);
  near(b.interest, 45, '30 arrears + 10 days x 1.50');
  near(b.outstanding, 3045, 'outstanding');
  near(b.principalRemaining, 3000, 'principal');
  near(b.interestUnpaid, 45, 'unpaid interest');
});

test('after the cut a payment clears arrears, then new interest, then principal', () => {
  // 01-16: unpaid 30 + 5d x 1.50 = 37.50 -> pay 100 = 37.50 interest + 62.50 principal.
  // 01-16 -> 01-21: 5d x 2937.50 x 0.0005 = 7.34375.
  const b = caseBalance(base, [{ amount: 100, payment_date: '2026-01-16' }], undefined, [r1]);
  near(b.principalRemaining, 2937.5, 'principal');
  near(b.interest, 44.84, 'interest');
  near(b.outstanding, 2944.84, 'outstanding');
  near(b.principal + b.interest - b.paid, b.outstanding, 'identity');
});

test('a payment before the effective date belongs to the old segment', () => {
  // 01-06: 15.00 accrued -> pay 100 = 15 + 85 principal -> 2915.
  // 01-06 -> 01-11: 5d x 2.915 = 14.575 arrears. New: 10d x 2915 x 0.0005 = 14.575.
  const b = caseBalance(base, [{ amount: 100, payment_date: '2026-01-06' }], undefined, [r1]);
  near(b.principalRemaining, 2915, 'principal');
  near(b.interest, 44.15, 'interest');
  near(b.outstanding, 2944.15, 'outstanding');
});

test('fixed -> monthly: the original lump is charged once and carried as arrears', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1000, interest_amount: 200, opened_at: '2026-01-01' };
  const r = { effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: 3, interest_amount: 0, maturity_date: '2026-01-21' };
  const b = caseBalance(c, [{ amount: 150, payment_date: '2026-01-05' }], undefined, [r]);
  near(b.principalRemaining, 1000, 'payment went to the lump, not principal');
  near(b.interest, 210, '200 lump + 10 days x 1.00');
  near(b.outstanding, 1060, 'outstanding');
});

test('monthly -> fixed: the new lump is charged at the effective date on top of arrears', () => {
  const r = { effective_date: '2026-01-11', interest_mode: 'fixed', interest_rate: 0, interest_amount: 100, maturity_date: '2026-07-11' };
  const b = caseBalance(base, [], undefined, [r]);
  near(b.interest, 130, '30 arrears + 100 lump');
  near(b.outstanding, 3130, 'outstanding');
});

test('two restructures: segment 1 ends where segment 2 begins', () => {
  const ra = { ...r1, maturity_date: '2026-12-31' };
  const rb = { effective_date: '2026-01-21', interest_mode: 'daily', interest_rate: 36.5, interest_amount: 0, maturity_date: '2026-01-31' };
  const b = caseBalance(base, [], undefined, [ra, rb]);
  near(b.interest, 75, '30 + 10d x 1.50 + 10d x 3.00 (36.5%/365 = 0.001/day)');
});

test('a payment dated before interest starts does not pull the accrual origin backwards', () => {
  // Accrual must run 01-01 -> 01-11 on 2999 (10 days), not from 12-25 (17 days).
  const b = caseBalance(base, [{ amount: 1, payment_date: '2025-12-25' }], new Date('2026-01-11'));
  near(b.interest, 29.99, 'interest');
});

test('recomputeOutstanding applies stored restructures', () => {
  db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
  db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from,maturity_date)
    VALUES (1,'R1',1,1,3000,0,3000,'new','monthly',3,'2026-01-01','2026-04-01')`);
  db.run(`INSERT INTO case_restructures (case_id,effective_date,reason,interest_mode,interest_rate,interest_amount,tenure,maturity_date,principal_at_cut,arrears_at_cut)
    VALUES (1,'2026-01-11','t','monthly',1.5,0,1,'2026-01-21',3000,30)`);
  near(recomputeOutstanding(1), 3045, 'outstanding');
  const row = db.get('SELECT interest_charged, interest_amount FROM cases WHERE id=1');
  near(row.interest_charged, 45, 'interest_charged');
  assert.strictEqual(row.interest_amount, 0);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --no-warnings --test test/restructure_ledger.test.js`
Expected: FAIL（`principalRemaining` undefined、重组未生效、起算日被拉回 → 50.98）

- [ ] **Step 3: 实现**

`src/services/payments.js`：把 `caseBalance` 前的注释块和函数整体（`// Interest-first (先息后本) balance.` 起到函数结束）替换为：

```js
// A case's loan as consecutive segments: segment 0 is the case's own terms and
// each restructure (sorted by effective_date) starts the next. `lump` is the
// fixed-mode interest, charged in full when its segment starts.
function loanSegments(c, restructures) {
  return [
    { interest_mode: c.interest_mode, interest_rate: c.interest_rate, lump: c.interest_amount || 0,
      start: c.interest_from || c.opened_at, maturity: c.maturity_date },
    ...restructures.map(r => ({ interest_mode: r.interest_mode, interest_rate: r.interest_rate, lump: r.interest_amount || 0,
      start: r.effective_date, maturity: r.maturity_date })),
  ];
}

// Interest-first (先息后本) balance. Walks payments in date order: between events
// interest accrues on the *remaining* principal, and each payment clears unpaid
// interest before it touches principal — so paying down principal shrinks all
// future interest. The loan runs as segments (see loanSegments): at each
// restructure's effective date, unpaid interest is carried as arrears that no
// longer accrues and the remaining principal continues under the new terms. A
// payment belongs to the segment whose window holds its date (date < next
// segment's start → earlier segment). Pure; asOf is injectable for tests and
// otherwise defaults to the last segment's maturity — the loan's fixed term,
// not "today" — falling back to today when there is none. `payments` MUST be
// sorted ascending by payment_date and `restructures` by effective_date. The
// identity outstanding = principal + interest − paid holds.
function caseBalance(c, payments, asOf, restructures = []) {
  const segs = loanSegments(c, restructures);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  let remP = c.principal_amount, unpaidInt = 0, paidInt = 0, pi = 0;
  segs.forEach((s, k) => {
    const next = segs[k + 1];
    const end = next ? next.start : (asOf || s.maturity || new Date());
    const accrues = s.interest_mode === 'daily' || s.interest_mode === 'monthly';
    const r = dailyRate(s);
    if (!accrues) unpaidInt += s.lump; // fixed: allocation order can't change its totals
    let last = s.start;
    for (; pi < payments.length && (!next || payments[pi].payment_date < next.start); pi++) {
      const p = payments[pi];
      if (accrues) unpaidInt += remP * r * daysBetween(last, p.payment_date);
      const toInt = Math.min(p.amount, unpaidInt); unpaidInt -= toInt; paidInt += toInt;
      remP = Math.max(0, remP - (p.amount - toInt)); // any overpay is dropped (validatePayment blocks it)
      // Never move the accrual origin backwards: a payment dated before interest
      // starts must not make the days before the start count.
      if (accrues && localDay(p.payment_date) > localDay(last)) last = p.payment_date;
    }
    if (accrues) unpaidInt += remP * r * daysBetween(last, end);
  });
  return { principal: c.principal_amount, interest: round2(paidInt + unpaidInt), paid,
    outstanding: round2(Math.max(0, remP + unpaidInt)),
    principalRemaining: round2(remP), interestUnpaid: round2(unpaidInt) };
}
```

`recomputeOutstanding` 中 `const b = caseBalance(c, payments);` 替换为：

```js
  const restructures = all('SELECT * FROM case_restructures WHERE case_id = ? ORDER BY effective_date, id', [caseId]);
  const b = caseBalance(c, payments, undefined, restructures);
```

- [ ] **Step 4: 运行，确认通过；全量回归**

Run: `node --no-warnings --test test/restructure_ledger.test.js` → PASS
Run: `npm test` → 全部 PASS（无重组的结果必须与改动前一致；若 `interest_accrual` / `payment_correctness` / `schedule` 有失败，说明单段行为被改了，修实现而不是改断言）

- [ ] **Step 5: Commit**

```bash
git add src/services/payments.js test/restructure_ledger.test.js
git commit -m "feat: segmented interest-first ledger for restructures"
```

---

### Task 3: 重组服务（资格、生效日、快照、创建/撤销、锁定）

**Files:**
- Create: `src/services/restructure.js`
- Modify: `src/utils/helpers.js`（加 `todayMYT`、`interestTerms` 并导出）
- Modify: `src/utils/schedule.js:5-12,59`（`todayStr` 换成 `todayMYT`）
- Test: `test/restructure_service.test.js`（新）

**Interfaces:**
- Consumes: `caseBalance(c, payments, asOf, restructures)`、`resyncCaseStatus(caseId, by)`（`src/services/payments.js`）；`maturityDate(start, tenure, unit)`（`src/utils/installments.js`）；`logAction(req, action, entityType, entityId, details)`。
- Produces（`src/services/restructure.js` 导出）：
  - `restructuresOf(caseId) → Row[]`（升序）
  - `lockDate(caseId) → string|null`
  - `canRestructure(c) → boolean`
  - `effectiveDateRange(c, payments, restructures) → { min, max }`
  - `balanceAtCut(c, payments, restructures, effectiveDate) → { principal, arrears }`（`payments` 升序）
  - `parseTerms(body) → { error } | { effective_date, interest_mode, interest_rate, interest_amount, tenure, reason }`
  - `createRestructure(caseId, body, req) → { ok: true, id } | { ok: false, error }`
  - `undoRestructure(caseId, restructureId, req) → { ok: true } | { ok: false, error }`
  - `paymentDateError(caseId, date) → string|null`
  - `lockedPaymentError(caseId, payment) → string|null`
  - `lockedTerms(caseId, terms) → terms`（键为 cases 列名）
  - `src/utils/helpers.js`：`todayMYT() → 'YYYY-MM-DD'`、`interestTerms(mode, rate, amount) → string`

- [ ] **Step 1: 写失败测试**

新建 `test/restructure_service.test.js`：

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsservice-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const { recomputeOutstanding } = require('../src/services/payments');
const rs = require('../src/services/restructure');
const { todayMYT } = require('../src/utils/helpers');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);
const req = { session: { user: { username: 'mgr', full_name: 'Manager' } }, ip: '127.0.0.1' };
const terms = (o = {}) => ({ effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'hardship', ...o });

db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
let seq = 0;
// 3000 @ 3%/month from 2026-01-01 (3.00/day), 3-month term.
function newCase(o = {}) {
  const r = db.run(`INSERT INTO cases (case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from,opened_at,maturity_date)
    VALUES (?,1,1,3000,0,3000,?,'monthly',3,'2026-01-01','2026-01-01 00:00:00','2026-04-01')`, ['S' + (++seq), o.status || 'negotiation']);
  const id = Number(r.lastInsertRowid);
  recomputeOutstanding(id);
  return id;
}
const pay = (id, amount, date) => { db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (?,?,?,?)", [id, 'P' + (++seq), date, amount]); recomputeOutstanding(id); };
const caseRow = id => db.get('SELECT * FROM cases WHERE id=?', [id]);

test('createRestructure stores the cut snapshot, recomputes, and logs', () => {
  const id = newCase();
  pay(id, 103, '2026-01-06'); // 15 interest + 88 principal -> 2912; 01-06->01-11 accrues 14.56
  const r = rs.createRestructure(id, terms(), req);
  assert.ok(r.ok, r.error);
  const row = db.get('SELECT * FROM case_restructures WHERE id=?', [r.id]);
  near(row.principal_at_cut, 2912, 'principal_at_cut');
  near(row.arrears_at_cut, 14.56, 'arrears_at_cut');
  assert.strictEqual(row.maturity_date, '2027-01-11');
  assert.strictEqual(row.created_by, 'Manager');
  near(caseRow(id).outstanding_amount, 2912 + 14.56 + 531.44, 'outstanding = principal + arrears + 365d x 1.456');
  assert.ok(db.get("SELECT 1 x FROM timeline_events WHERE case_id=? AND event_type='note' AND content LIKE 'Restructure:%'", [id]));
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action='restructure' AND entity_id=?", [id]));
});

test('a payment ON the effective date is excluded from the snapshot (new segment)', () => {
  const id = newCase();
  pay(id, 40, '2026-01-11');
  const r = rs.createRestructure(id, terms(), req);
  assert.ok(r.ok, r.error);
  const row = db.get('SELECT * FROM case_restructures WHERE id=?', [r.id]);
  near(row.principal_at_cut, 3000, 'principal untouched by the same-day payment');
  near(row.arrears_at_cut, 30, 'arrears = 10 days x 3.00');
});

test('effective date bounds: after loan start, not before last payment, not after today, after previous restructure', () => {
  const id = newCase();
  assert.match(rs.createRestructure(id, terms({ effective_date: '2025-12-31' }), req).error, /between/);
  pay(id, 10, '2026-01-20');
  assert.match(rs.createRestructure(id, terms({ effective_date: '2026-01-19' }), req).error, /between/);
  const tomorrow = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  assert.match(rs.createRestructure(id, terms({ effective_date: tomorrow }), req).error, /between/);
  assert.ok(rs.createRestructure(id, terms({ effective_date: '2026-01-20' }), req).ok);
  assert.match(rs.createRestructure(id, terms({ effective_date: '2026-01-20' }), req).error, /between/);
  assert.ok(rs.createRestructure(id, terms({ effective_date: '2026-01-21' }), req).ok);
});

test('restructuring twice on the same day leaves no valid date', () => {
  const id = newCase();
  assert.ok(rs.createRestructure(id, terms({ effective_date: todayMYT() }), req).ok);
  const range = rs.effectiveDateRange(caseRow(id), [], rs.restructuresOf(id));
  assert.ok(range.min > range.max);
});

test('eligibility: no outstanding, closed or cancelled cases are refused', () => {
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 0, status: 'negotiation' }), false);
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 10, status: 'closed' }), false);
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 10, status: 'cancelled' }), false);
  assert.strictEqual(rs.canRestructure({ outstanding_amount: 10, status: 'legal' }), true);
  const id = newCase({ status: 'closed' });
  assert.match(rs.createRestructure(id, terms(), req).error, /cannot be restructured/);
});

test('parseTerms rejects bad input', () => {
  assert.match(rs.parseTerms(terms({ effective_date: '2026-02-30' })).error, /date/);
  assert.match(rs.parseTerms(terms({ interest_mode: 'weekly' })).error, /mode/);
  assert.match(rs.parseTerms(terms({ interest_rate: '-1' })).error, /rate/);
  assert.match(rs.parseTerms(terms({ interest_mode: 'fixed', interest_amount: '-5' })).error, /amount/);
  for (const t of ['0', '121', '1.5', '']) assert.match(rs.parseTerms(terms({ tenure: t })).error, /Tenure/);
  assert.match(rs.parseTerms(terms({ reason: '   ' })).error, /Reason/);
  const ok = rs.parseTerms(terms({ interest_mode: 'fixed', interest_amount: '250', interest_rate: '9' }));
  assert.strictEqual(ok.interest_rate, 0);
  assert.strictEqual(ok.interest_amount, 250);
  assert.strictEqual(ok.tenure, 12);
});

test('undo: only the latest, only with no payments on/after it, and restores the balance', () => {
  const id = newCase();
  const before = caseRow(id).outstanding_amount;
  const a = rs.createRestructure(id, terms({ effective_date: '2026-01-11' }), req);
  const b = rs.createRestructure(id, terms({ effective_date: '2026-01-15' }), req);
  assert.match(rs.undoRestructure(id, a.id, req).error, /latest/);
  pay(id, 5, '2026-01-15');
  assert.match(rs.undoRestructure(id, b.id, req).error, /Payments exist/);
  db.run('DELETE FROM payments WHERE case_id=?', [id]);
  assert.ok(rs.undoRestructure(id, b.id, req).ok);
  assert.ok(rs.undoRestructure(id, a.id, req).ok);
  near(caseRow(id).outstanding_amount, before, 'balance back to pre-restructure');
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action='restructure_undo' AND entity_id=?", [id]));
});

test('payment locks: dates before the latest effective date are frozen', () => {
  const id = newCase();
  assert.strictEqual(rs.paymentDateError(id, '2026-01-01'), null);
  rs.createRestructure(id, terms({ effective_date: '2026-01-11' }), req);
  assert.match(rs.paymentDateError(id, '2026-01-10'), /restructure date/);
  assert.strictEqual(rs.paymentDateError(id, '2026-01-11'), null);
  assert.match(rs.lockedPaymentError(id, { payment_date: '2026-01-10' }), /restructured period/);
  assert.strictEqual(rs.lockedPaymentError(id, { payment_date: '2026-01-11' }), null);
});

test('lockedTerms keeps the stored loan terms once a case is restructured', () => {
  const id = newCase();
  const form = { principal_amount: 9999, interest_amount: 0, interest_mode: 'fixed', interest_rate: 0, interest_from: null,
    loan_start_date: null, tenure: null, tenure_unit: 'months', maturity_date: null };
  assert.deepStrictEqual(rs.lockedTerms(id, form), form);
  rs.createRestructure(id, terms(), req);
  const t = rs.lockedTerms(id, form);
  assert.strictEqual(t.principal_amount, 3000);
  assert.strictEqual(t.interest_mode, 'monthly');
  assert.strictEqual(t.maturity_date, '2026-04-01');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --no-warnings --test test/restructure_service.test.js`
Expected: FAIL（`Cannot find module '../src/services/restructure'`）

- [ ] **Step 3: helpers**

`src/utils/helpers.js` 在 `round2` 定义后加：

```js
// Today in Malaysia local time (UTC+8) as YYYY-MM-DD — the format of every
// user-entered date (payment_date, effective_date, due_date).
const todayMYT = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

// One-line label for a loan segment's interest terms (restructure history, timeline).
const interestTerms = (mode, rate, amount) =>
  mode === 'monthly' ? `${rate}%/month` : mode === 'daily' ? `${rate}%/year (daily)` : `fixed RM ${money(amount)}`;
```

`module.exports` 加上 `todayMYT, interestTerms`。

`src/utils/schedule.js`：删掉 `todayStr` 函数及其上方注释（含 ponytail 行），`require('./helpers')` 改为 `const { round2, todayMYT } = require('./helpers');`，`const today = todayStr();` 改为 `const today = todayMYT();`。

- [ ] **Step 4: 服务**

新建 `src/services/restructure.js`：

```js
const dayjs = require('dayjs');
const { db, get, all, run } = require('../db');
const { caseBalance, resyncCaseStatus } = require('./payments');
const { maturityDate } = require('../utils/installments');
const { logAction } = require('../utils/audit');
const { todayMYT, interestTerms, money } = require('../utils/helpers');

// Extension / Restructure (docs/superpowers/specs/2026-10-23-restructure-design.md).
// Each row starts a new ledger segment at effective_date; the case row keeps the
// original terms. Payment ownership: payment_date < E → earlier segment.

const MODES = ['fixed', 'monthly', 'daily'];

function restructuresOf(caseId) {
  return all('SELECT * FROM case_restructures WHERE case_id = ? ORDER BY effective_date, id', [caseId]);
}

// Payments dated before this belong to a superseded segment and are frozen.
function lockDate(caseId) {
  const r = get('SELECT effective_date FROM case_restructures WHERE case_id = ? ORDER BY effective_date DESC, id DESC LIMIT 1', [caseId]);
  return r ? r.effective_date : null;
}

function canRestructure(c) {
  return c.outstanding_amount > 0 && !['closed', 'cancelled'].includes(c.status);
}

// Allowed effective dates for a new restructure. min > max means none today.
function effectiveDateRange(c, payments, restructures) {
  const prev = restructures[restructures.length - 1];
  const candidates = [
    String(c.interest_from || c.opened_at || '').slice(0, 10),
    ...payments.map(p => p.payment_date),
    prev ? dayjs(prev.effective_date).add(1, 'day').format('YYYY-MM-DD') : '',
  ];
  return { min: candidates.reduce((m, d) => (d > m ? d : m), ''), max: todayMYT() };
}

// What is owed at the cut, from payments strictly before it — a payment ON the
// effective date belongs to the new segment. `payments` sorted ascending.
function balanceAtCut(c, payments, restructures, effectiveDate) {
  const b = caseBalance(c, payments.filter(p => p.payment_date < effectiveDate), effectiveDate, restructures);
  return { principal: b.principalRemaining, arrears: b.interestUnpaid };
}

function parseTerms(body) {
  const effective_date = String(body.effective_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_date) || dayjs(effective_date).format('YYYY-MM-DD') !== effective_date) {
    return { error: 'Invalid effective date' };
  }
  const interest_mode = body.interest_mode;
  if (!MODES.includes(interest_mode)) return { error: 'Invalid interest mode' };
  const num = v => (v === undefined || v === '' ? 0 : Number(v));
  const interest_rate = interest_mode === 'fixed' ? 0 : num(body.interest_rate);
  const interest_amount = interest_mode === 'fixed' ? num(body.interest_amount) : 0;
  if (!Number.isFinite(interest_rate) || interest_rate < 0) return { error: 'Invalid interest rate' };
  if (!Number.isFinite(interest_amount) || interest_amount < 0) return { error: 'Invalid interest amount' };
  const tenure = body.tenure === '' || body.tenure === undefined ? NaN : Number(body.tenure);
  if (!Number.isInteger(tenure) || tenure < 1 || tenure > 120) return { error: 'Tenure must be 1–120 months' };
  const reason = String(body.reason || '').trim();
  if (!reason) return { error: 'Reason is required' };
  return { effective_date, interest_mode, interest_rate, interest_amount, tenure, reason };
}

function createRestructure(caseId, body, req) {
  const c = get('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) return { ok: false, error: 'Case not found' };
  if (!canRestructure(c)) return { ok: false, error: 'This case cannot be restructured' };
  const t = parseTerms(body);
  if (t.error) return { ok: false, error: t.error };
  const payments = all('SELECT amount, payment_date FROM payments WHERE case_id = ? ORDER BY payment_date, id', [caseId]);
  const prior = restructuresOf(caseId);
  const range = effectiveDateRange(c, payments, prior);
  if (t.effective_date < range.min || t.effective_date > range.max) {
    return { ok: false, error: `Effective date must be between ${range.min} and ${range.max}` };
  }
  const cut = balanceAtCut(c, payments, prior, t.effective_date);
  const by = req.session.user.full_name;
  let id;
  db.transaction(() => {
    id = Number(run(`INSERT INTO case_restructures (case_id,effective_date,reason,interest_mode,interest_rate,interest_amount,tenure,maturity_date,principal_at_cut,arrears_at_cut,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId, t.effective_date, t.reason, t.interest_mode, t.interest_rate, t.interest_amount, t.tenure,
        maturityDate(t.effective_date, t.tenure, 'months'), cut.principal, cut.arrears, by]).lastInsertRowid);
    resyncCaseStatus(caseId, by);
    // ponytail: 'note' because timeline_events.event_type has a CHECK list and adding
    // a type needs a table rebuild; case_restructures + audit_logs are the record.
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
      [caseId, 'note', `Restructure: from ${t.effective_date}, ${interestTerms(t.interest_mode, t.interest_rate, t.interest_amount)}, ${t.tenure} months. `
        + `Principal RM ${money(cut.principal)}, arrears RM ${money(cut.arrears)} carried. Reason: ${t.reason}`, by]);
  })();
  logAction(req, 'restructure', 'case', caseId, `Restructured from ${t.effective_date} (${t.tenure} months)`);
  return { ok: true, id };
}

function undoRestructure(caseId, restructureId, req) {
  const all_ = restructuresOf(caseId);
  const latest = all_[all_.length - 1];
  if (!latest || latest.id !== Number(restructureId)) return { ok: false, error: 'Only the latest restructure can be undone' };
  const after = get('SELECT COUNT(*) AS n FROM payments WHERE case_id = ? AND payment_date >= ?', [caseId, latest.effective_date]).n;
  if (after > 0) return { ok: false, error: 'Payments exist on or after the effective date; void them first' };
  const by = req.session.user.full_name;
  db.transaction(() => {
    run('DELETE FROM case_restructures WHERE id = ?', [latest.id]);
    resyncCaseStatus(caseId, by);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
      [caseId, 'note', `Restructure undone: from ${latest.effective_date}`, by]);
  })();
  logAction(req, 'restructure_undo', 'case', caseId, `Undid restructure from ${latest.effective_date}`);
  return { ok: true };
}

function paymentDateError(caseId, date) {
  const lock = lockDate(caseId);
  return lock && date && date < lock ? `Payment date must be on or after the restructure date (${lock})` : null;
}

function lockedPaymentError(caseId, payment) {
  const lock = lockDate(caseId);
  return lock && payment.payment_date < lock ? 'This payment belongs to a restructured period; undo the restructure first' : null;
}

// After a restructure the original loan terms are history: Edit Case keeps the
// stored values whatever the form sent. Keys are cases column names.
function lockedTerms(caseId, terms) {
  if (!lockDate(caseId)) return terms;
  return get(`SELECT principal_amount, interest_amount, interest_mode, interest_rate, interest_from,
    loan_start_date, tenure, tenure_unit, maturity_date FROM cases WHERE id = ?`, [caseId]);
}

module.exports = { restructuresOf, lockDate, canRestructure, effectiveDateRange, balanceAtCut, parseTerms,
  createRestructure, undoRestructure, paymentDateError, lockedPaymentError, lockedTerms };
```

- [ ] **Step 5: 运行，确认通过；全量回归**

Run: `node --no-warnings --test test/restructure_service.test.js` → PASS
Run: `npm test` → 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/restructure.js src/utils/helpers.js src/utils/schedule.js test/restructure_service.test.js
git commit -m "feat: restructure service — eligibility, cut snapshot, create/undo, locks"
```

---

### Task 4: 计划组装（欠息行、被取代的段）

**Files:**
- Modify: `src/utils/schedule.js`（`repaymentSchedule(c, payments, opts)`）
- Modify: `src/services/restructure.js`（加 `scheduleView` 并导出）
- Test: `test/schedule.test.js`（追加）、`test/restructure_service.test.js`（追加）

**Interfaces:**
- Consumes: Task 3 的 `restructuresOf` 行结构（`effective_date, interest_mode, interest_rate, interest_amount, tenure, principal_at_cut, arrears_at_cut`）。
- Produces:
  - `repaymentSchedule(c, payments, opts = {})`：`opts.arrears`（number）在首行插入 `kind: 'arrears'` 行（到期日 = `c.loan_start_date`）；`opts.superseded`（boolean）跳过 settled 逻辑、未还清行状态为 `'restructured'`。每行新增 `kind: 'regular' | 'arrears'`。
  - `scheduleView(c, payments, restructures) → { current: Row[], history: [{ restructure, rows }] }`

- [ ] **Step 1: 写失败测试**

`test/schedule.test.js` 末尾追加：

```js
test('arrears row comes first and is paid first (FIFO)', () => {
  const rows = repaymentSchedule(baseCase(), [{ amount: 50, payment_date: '2026-02-01' }], { arrears: 40 });
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].kind, 'arrears');
  assert.strictEqual(rows[0].due_date, '2026-01-01');
  assert.strictEqual(rows[0].status, 'paid');
  near(rows[1].paid_amount, 10, 'remaining 10 goes to period 1');
  assert.strictEqual(rows[1].kind, 'regular');
});

test('superseded schedule: unpaid rows read "restructured" and settled logic is skipped', () => {
  const rows = repaymentSchedule(baseCase({ outstanding_amount: 0 }), [{ amount: 100, payment_date: '2026-01-15' }], { superseded: true });
  assert.deepStrictEqual(rows.map(r => r.status), ['paid', 'restructured', 'restructured']);
  near(rows[2].outstanding_amount, 3093, 'not zeroed by a settled ledger');
});
```

`test/restructure_service.test.js` 末尾追加：

```js
test('scheduleView: current segment with arrears row, history with the superseded schedule', () => {
  const c = { interest_mode: 'monthly', interest_rate: 3, interest_from: '2026-01-01', loan_start_date: '2026-01-01',
    tenure: 3, tenure_unit: 'months', principal_amount: 3000, interest_amount: 0, outstanding_amount: 3000 };
  const r = { id: 1, effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: 1.5, interest_amount: 0,
    tenure: 3, principal_at_cut: 3000, arrears_at_cut: 30 };
  const payments = [{ amount: 35, payment_date: '2026-01-12' }, { amount: 50, payment_date: '2026-01-05' }];
  const v = rs.scheduleView(c, payments, [r]);
  assert.strictEqual(v.history.length, 1);
  assert.strictEqual(v.history[0].restructure, r);
  near(v.history[0].rows[0].paid_amount, 50, 'old segment only sees the 01-05 payment');
  assert.strictEqual(v.history[0].rows[0].status, 'restructured');
  assert.strictEqual(v.current.length, 4);
  assert.strictEqual(v.current[0].kind, 'arrears');
  assert.strictEqual(v.current[0].status, 'paid');
  near(v.current[1].paid_amount, 5, 'new segment sees only the 01-12 payment');
  near(v.current[1].expected_amount, 46.5, '3000 x 0.0005 x 31 days');
});

test('scheduleView: original terms without a tenure give an empty superseded table', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1000, interest_amount: 80, opened_at: '2026-01-01 00:00:00', outstanding_amount: 1080 };
  const r = { id: 2, effective_date: '2026-01-11', interest_mode: 'fixed', interest_rate: 0, interest_amount: 0,
    tenure: 2, principal_at_cut: 1000, arrears_at_cut: 80 };
  const v = rs.scheduleView(c, [], [r]);
  assert.deepStrictEqual(v.history[0].rows, []);
  assert.deepStrictEqual(v.current.map(x => x.expected_amount), [80, 500, 500]);
});

test('scheduleView without restructures is the plain schedule', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1000, interest_amount: 0, loan_start_date: '2026-01-01',
    tenure: 2, tenure_unit: 'months', outstanding_amount: 1000 };
  const v = rs.scheduleView(c, [], []);
  assert.deepStrictEqual(v.history, []);
  assert.deepStrictEqual(v.current.map(x => x.expected_amount), [500, 500]);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --no-warnings --test test/schedule.test.js test/restructure_service.test.js`
Expected: FAIL（无 `kind`、无 `restructured` 状态、`rs.scheduleView is not a function`）

- [ ] **Step 3: `repaymentSchedule` 支持 `opts`**

`src/utils/schedule.js`：函数签名改为 `function repaymentSchedule(c, payments, opts = {}) {`；顶部注释末尾加：

```js
// opts.arrears: a restructure's carried unpaid interest, owed first on the
//   segment's start date (kind 'arrears'), ahead of the regular rows in FIFO.
// opts.superseded: a schedule replaced by a restructure — shown as history, so
//   the ledger-settled override is skipped and unpaid rows read 'restructured'.
```

从 `let pool = payments.reduce(...)` 到函数结束整段替换为：

```js
  const periods = dates.map((due, i) => ({ due, expected: expectedList[i], kind: 'regular' }));
  if (opts.arrears > 0) periods.unshift({ due: c.loan_start_date, expected: round2(opts.arrears), kind: 'arrears' });
  let pool = payments.reduce((s, p) => s + p.amount, 0);
  // The schedule projects on-time payment, but the ledger accrues by actual
  // payment date — paying early cuts interest below the projection. Once the
  // ledger is settled, nothing is owed on any row (paid_amount stays truthful).
  // ponytail: only the fully-settled case is reconciled; a partial prepayment is
  // re-planned through an explicit restructure.
  const settled = !opts.superseded && c.outstanding_amount <= 0;
  const today = todayMYT();
  return periods.map(({ due, expected, kind }) => {
    const paid = round2(Math.min(expected, Math.max(0, pool)));
    pool -= paid;
    const outstanding = settled ? 0 : round2(Math.max(0, expected - paid));
    // A period with expected_amount === 0 (e.g. interest_rate: 0) has nothing owed,
    // so paid(0) >= expected(0) is intentionally 'paid' even with zero actual payment.
    const status = settled || paid >= expected ? 'paid'
      : opts.superseded ? 'restructured'
      : due < today ? 'overdue'
      : paid > 0 ? 'partial'
      : 'pending';
    return { due_date: due, expected_amount: expected, paid_amount: paid, outstanding_amount: outstanding, status, kind };
  });
}
```

（Task 3 已把 `todayStr` 换成 `todayMYT`；原 `settled` 注释与新注释合并，不要重复保留两份。）

- [ ] **Step 4: `scheduleView`**

`src/services/restructure.js` 顶部加 `const { repaymentSchedule } = require('../utils/schedule');`，在 `module.exports` 前加：

```js
// Repayment schedules for the case page: the current segment's (led by its
// carried-arrears row) plus, per restructure, the schedule it superseded —
// each fed only the payments inside its own date window.
function scheduleView(c, payments, restructures) {
  if (!restructures.length) return { current: repaymentSchedule(c, payments), history: [] };
  const inWindow = (from, to) => payments.filter(p => (!from || p.payment_date >= from) && (!to || p.payment_date < to));
  const segCase = r => ({ interest_mode: r.interest_mode, interest_rate: r.interest_rate, interest_amount: r.interest_amount,
    principal_amount: r.principal_at_cut, loan_start_date: r.effective_date, interest_from: r.effective_date,
    tenure: r.tenure, tenure_unit: 'months', outstanding_amount: c.outstanding_amount });
  const history = restructures.map((r, k) => {
    const prev = restructures[k - 1];
    const rows = repaymentSchedule(prev ? segCase(prev) : c, inWindow(prev && prev.effective_date, r.effective_date),
      { superseded: true, arrears: prev ? prev.arrears_at_cut : 0 });
    return { restructure: r, rows };
  });
  const last = restructures[restructures.length - 1];
  return { current: repaymentSchedule(segCase(last), inWindow(last.effective_date), { arrears: last.arrears_at_cut }), history };
}
```

`module.exports` 加 `scheduleView`。

- [ ] **Step 5: 运行，确认通过；全量回归**

Run: `node --no-warnings --test test/schedule.test.js test/restructure_service.test.js` → PASS
Run: `npm test` → 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/utils/schedule.js src/services/restructure.js test/schedule.test.js test/restructure_service.test.js
git commit -m "feat: arrears row and superseded schedules for restructured cases"
```

---

### Task 5: 路由（重组/撤销、付款锁定、Edit Case 锁定、详情页数据）

**Files:**
- Modify: `src/routes/cases.js`（imports；`GET /:id/edit`；`POST /:id`；`GET /:id`；付款 create/edit/void；新增两条重组路由）
- Modify: `src/routes/ptps.js:13-36`（`recordFulfillment` 日期锁定）
- Test: `test/restructure_routes.test.js`（新）

**Interfaces:**
- Consumes: Task 3/4 的全部导出；`todayMYT`。
- Produces（给 Task 6 视图的 locals）：`schedule`（当前计划行）、`scheduleHistory`（`[{ restructure, rows }]`）、`lastRestructure`（行或 null）、`lock`（字符串或 null）、`restructureForm`（`{ range: {min,max}, cut: {principal, arrears} }` 或 null）、`canUndo`（boolean）；`cases/form` 的 `termsLocked`（boolean）。

- [ ] **Step 1: 写失败测试**

新建 `test/restructure_routes.test.js`：

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsroutes-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const { router } = require('../src/routes/cases');
const { recordFulfillment } = require('../src/routes/ptps');
const { recomputeOutstanding } = require('../src/services/payments');
const { createRestructure } = require('../src/services/restructure');

const req = { session: { user: { username: 'mgr', full_name: 'Manager', role: 'manager' } }, ip: '127.0.0.1' };

// Each route's stack is [requireLogin, requireRole(...), handler].
function roleGuard(path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods.post);
  assert.ok(layer, `route ${path} exists`);
  return layer.route.stack[1].handle;
}
function allowed(mw, role) {
  let passed = false;
  const res = { status() { return this; }, render() {}, redirect() {} };
  mw({ session: { user: { role } } }, res, () => { passed = true; });
  return passed;
}

test('only admin and manager can restructure or undo', () => {
  for (const p of ['/:id/restructures', '/:id/restructures/:rid/undo']) {
    const mw = roleGuard(p);
    const roles = ['admin', 'manager', 'finance', 'agent', 'auditor', 'client'].filter(r => allowed(mw, r));
    assert.deepStrictEqual(roles, ['admin', 'manager'], p);
  }
});

test('fulfilling a PTP with a payment dated before the restructure is refused', () => {
  db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
  db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from,opened_at,maturity_date)
    VALUES (1,'RT1',1,1,3000,0,3000,'ptp','monthly',3,'2026-01-01','2026-01-01 00:00:00','2026-04-01')`);
  recomputeOutstanding(1);
  assert.ok(createRestructure(1, { effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'r' }, req).ok);
  const ptp = Number(db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (1,10,'2026-02-01','pending','t')").lastInsertRowid);
  const bad = recordFulfillment(ptp, { amount: 10, payment_date: '2026-01-10' }, req);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /restructure date/);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [ptp]).status, 'pending');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payments WHERE case_id=1').n, 0);
  assert.ok(recordFulfillment(ptp, { amount: 10, payment_date: '2026-01-11' }, req).ok);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --no-warnings --test test/restructure_routes.test.js`
Expected: FAIL（`route /:id/restructures exists`；fulfil 未拦截）

- [ ] **Step 3: `ptps.js`**

顶部加 `const { paymentDateError } = require('../services/restructure');`；`recordFulfillment` 中 `const payment_date = ...;` 之后加：

```js
  const dateErr = paymentDateError(ptp.case_id, payment_date);
  if (dateErr) return { ok: false, error: dateErr };
```

- [ ] **Step 4: `cases.js` imports 与 Edit Case**

imports 加：

```js
const { restructuresOf, lockDate, canRestructure, effectiveDateRange, balanceAtCut, createRestructure, undoRestructure,
  paymentDateError, lockedPaymentError, lockedTerms, scheduleView } = require('../services/restructure');
const { todayMYT } = require('../utils/helpers');
```

（`../utils/helpers` 已有一行 require，把 `todayMYT` 并入那一行的解构即可。）

`GET /:id/edit` 的 render 参数加 `termsLocked: !!lockDate(c.id)`。

`POST /:id`：在 `const { start: loanStart, ... } = tenureFields(b);` 之后、`run(UPDATE ...)` 之前加：

```js
  const t = lockedTerms(req.params.id, { principal_amount: principal, interest_amount: interest, interest_mode: mode,
    interest_rate: rate, interest_from: from, loan_start_date: loanStart, tenure, tenure_unit: tenureUnit, maturity_date: maturity });
```

并把 UPDATE 参数数组改为：

```js
    [b.debtor_id,b.agent_id||null,t.principal_amount,t.interest_amount,b.priority||'medium',b.remark||null,t.interest_mode,t.interest_rate,t.interest_from,t.loan_start_date,t.tenure,t.tenure_unit,t.maturity_date,req.params.id]);
```

- [ ] **Step 5: 详情页数据**

`GET /:id` 中 `const schedule = repaymentSchedule(c, payments);` 和 `res.render(...)` 替换为：

```js
  const restructures = restructuresOf(c.id);
  const { current: schedule, history: scheduleHistory } = scheduleView(c, payments, restructures);
  const lastRestructure = restructures[restructures.length - 1] || null;
  const asc = payments.slice().sort((a, b) => a.payment_date.localeCompare(b.payment_date));
  const restructureForm = canRestructure(c)
    ? { range: effectiveDateRange(c, asc, restructures), cut: balanceAtCut(c, asc, restructures, todayMYT()) }
    : null;
  const canUndo = !!lastRestructure && !payments.some(p => p.payment_date >= lastRestructure.effective_date);
  res.render('cases/show', { title: c.case_no, c, timeline, payments, ptps, tasks, calls, schedule,
    scheduleHistory, lastRestructure, lock: lastRestructure ? lastRestructure.effective_date : null, restructureForm, canUndo,
    statuses: CASE_STATUSES, terminal: TERMINAL_STATUSES,
    readOnly: ['auditor','client'].includes(req.session.user.role) });
```

若 `repaymentSchedule` 在 cases.js 不再被使用，删掉它的 require。

- [ ] **Step 6: 付款锁定**

- `POST /:id/payments`：`if (v.error) ...` 之后加：
  ```js
  const dateErr = paymentDateError(c.id, req.body.payment_date);
  if (dateErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(dateErr)}`);
  ```
- `POST /:id/payments/:pid`（编辑）：`if (!pay) ...` 之后加：
  ```js
  const lockErr = lockedPaymentError(c.id, pay) || paymentDateError(c.id, req.body.payment_date || pay.payment_date);
  if (lockErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(lockErr)}`);
  ```
- `POST /:id/payments/:pid/void`：`if (!pay) ...` 之后加：
  ```js
  const lockErr = lockedPaymentError(c.id, pay);
  if (lockErr) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(lockErr)}`);
  ```

- [ ] **Step 7: 重组路由**

`module.exports` 之前加：

```js
router.post('/:id/restructures', requireLogin, requireRole('admin','manager'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = createRestructure(c.id, req.body, req);
  if (!r.ok) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${c.id}?ok=Restructured`);
});
router.post('/:id/restructures/:rid/undo', requireLogin, requireRole('admin','manager'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = undoRestructure(c.id, req.params.rid, req);
  if (!r.ok) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${c.id}?ok=Restructure+undone`);
});
```

- [ ] **Step 8: 运行，确认通过；全量回归**

Run: `node --no-warnings --test test/restructure_routes.test.js` → PASS
Run: `npm test` → 全部 PASS

- [ ] **Step 9: Commit**

```bash
git add src/routes/cases.js src/routes/ptps.js test/restructure_routes.test.js
git commit -m "feat: restructure routes, payment date locks, Edit Case term lock"
```

---

### Task 6: 视图（按钮、对话框、计划/历史、锁定显示）

**Files:**
- Create: `src/views/partials/scheduleTable.ejs`
- Modify: `src/views/cases/show.ejs`
- Modify: `src/views/cases/form.ejs`

**Interfaces:**
- Consumes: Task 5 的 locals；`h.interestTerms`、`h.dateFmt`、`h.money`。

- [ ] **Step 1: 计划表 partial**

新建 `src/views/partials/scheduleTable.ejs`（`pay` 为 null 时不显示操作列）：

```ejs
<% const schedClass = { paid:'is-green', overdue:'is-red', partial:'is-gold', pending:'is-neutral', restructured:'is-neutral' }; %>
<% const schedLabel = { paid:'Paid', overdue:'Overdue', partial:'Partially Paid', pending:'Pending', restructured:'Restructured' }; %>
<table class="data"><thead><tr><th>Due Date</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th><% if (pay) { %><th>Actions</th><% } %></tr></thead>
<tbody><% rows.forEach((row, i) => { %><tr>
  <td><%= h.dateFmt(row.due_date) %><% if (row.kind === 'arrears') { %> <small style="color:var(--muted)">· Arrears (carried)</small><% } %></td>
  <td class="num"><%= h.money(row.expected_amount) %></td>
  <td class="num"><%= h.money(row.paid_amount) %></td>
  <td class="num"><%= h.money(row.outstanding_amount) %></td>
  <td><span class="badge <%= schedClass[row.status] %>"><%= schedLabel[row.status] %></span></td>
  <% if (pay) { %><td><% if (i === pay.nextDue) { %><button type="button" class="btn btn-sm btn-gold" onclick="payInstallment(<%= Math.min(row.outstanding_amount, pay.cap) %>)">Pay</button><% } else { %>—<% } %></td><% } %>
</tr><% }) %></tbody></table>
```

- [ ] **Step 2: show.ejs —— 当前计划与历史**

把 Records 弹窗里 `<% if (schedule.length) { %>` 到其 `<% } %>` 的整个 Repayment Schedule section 替换为：

```ejs
    <% if (schedule.length) { %>
    <section class="rec-section">
    <h2>Repayment Schedule<% if (lastRestructure) { %> <small style="color:var(--muted)">· since restructure on <%= h.dateFmt(lastRestructure.effective_date) %></small><% } %></h2>
    <%
      // Payments fill periods oldest-first (FIFO in schedule.js), so only the
      // earliest unpaid period gets a Pay button — paying a later row would
      // still land on the earlier ones. The prefill is capped at the ledger
      // outstanding: per-period cent rounding can leave the schedule a few cents
      // above it, and the payment validator rejects any overpay.
      const canPay = !readOnly && ['admin','manager','finance','agent'].includes(currentUser.role);
      const nextDue = schedule.findIndex(r => r.outstanding_amount > 0);
    %>
    <%- include('../partials/scheduleTable', { rows: schedule, pay: canPay ? { nextDue, cap: c.outstanding_amount } : null }) %>
    </section>
    <% } %>

    <% if (scheduleHistory.length) { %>
    <section class="rec-section">
    <h2>Restructure History</h2>
    <% const canManageRs = !readOnly && ['admin','manager'].includes(currentUser.role); %>
    <% scheduleHistory.slice().reverse().forEach(({ restructure: r, rows }) => { %>
      <div class="card" style="margin-bottom:0.75rem;">
        <div><b><%= h.dateFmt(r.effective_date) %></b> · <%= h.interestTerms(r.interest_mode, r.interest_rate, r.interest_amount) %> · <%= r.tenure %> months · by <%= r.created_by || '—' %></div>
        <div>Principal at cut RM <%= h.money(r.principal_at_cut) %> · Arrears carried RM <%= h.money(r.arrears_at_cut) %></div>
        <div>Reason: <%= r.reason %></div>
        <% if (canManageRs && canUndo && r.id === lastRestructure.id) { %>
        <form method="post" action="/cases/<%= c.id %>/restructures/<%= r.id %>/undo" style="margin:0.5rem 0 0;" onsubmit="return confirm('Undo this restructure?')"><button class="btn btn-sm" type="submit">Undo</button></form>
        <% } %>
        <% if (rows.length) { %>
        <details style="margin-top:0.5rem;"><summary>Superseded schedule (<%= rows.length %> rows)</summary>
          <%- include('../partials/scheduleTable', { rows, pay: null }) %>
        </details>
        <% } %>
      </div>
    <% }) %>
    </section>
    <% } %>
```

- [ ] **Step 3: show.ejs —— 头部按钮、到期日、付款锁定**

- 头部 Record Payment 按钮那行之后（仍在 `if (!readOnly)` 内）加：
  ```ejs
      <% if (restructureForm && ['admin','manager'].includes(currentUser.role)) { %><button type="button" class="btn" onclick="dlg('dlg-restructure')">Restructure</button><% } %>
  ```
- Ledger 区 `<% if (c.maturity_date) { %> ... <% } %>` 替换为：
  ```ejs
    <% const maturity = lastRestructure ? lastRestructure.maturity_date : c.maturity_date; %>
    <% if (maturity) { %>
    <div><div class="ledger-lbl">Maturity Date</div><div class="ledger-val"><%= h.dateFmt(maturity) %></div>
      <% if (lastRestructure) { %><small style="color:var(--muted)">Restructured on <%= h.dateFmt(lastRestructure.effective_date) %></small><% } %></div>
    <% } %>
  ```
- Payments 表的操作单元格（`<% if (canEditPay) { %><td><div ...>` 到 `</div></td><% } %>`）整段替换为：
  ```ejs
    <% if (canEditPay) { %><td><% if (lock && p.payment_date < lock) { %><small style="color:var(--muted)">Locked · restructured</small><% } else { %><div style="display:flex; gap:0.5rem;">
      <button type="button" class="btn btn-sm" onclick="openEditPayment(<%= p.id %>, <%= p.amount %>, '<%= p.payment_date %>', '<%= p.method %>', '<%= p.reference||'' %>', '<%= p.bank||'' %>')">Edit</button>
      <form method="post" action="/cases/<%= c.id %>/payments/<%= p.id %>/void" style="margin:0;" onsubmit="return confirm('Void payment <%= p.receipt_no %>?')"><button class="btn btn-sm" type="submit">Void</button></form>
    </div><% } %></td><% } %>
  ```
- 三个付款日期输入加 `min`：`dlg-payment` 的 `name="payment_date"`、`dlg-payment-edit` 的 `id="pe-date"`、`dlg-ptp-fulfill` 的 `name="payment_date"`，各在 `required` 后追加 `<% if (lock) { %> min="<%= lock %>"<% } %>`。

- [ ] **Step 4: show.ejs —— 重组对话框**

在 `<% if (!readOnly) { %>` 对话框区内、`dlg-payment` 之前加：

```ejs
<% if (restructureForm && ['admin','manager'].includes(currentUser.role)) { %>
<dialog id="dlg-restructure" class="modal"><form class="form" method="post" action="/cases/<%= c.id %>/restructures">
  <h3>Restructure Loan</h3>
  <p style="margin:0 0 0.5rem;color:var(--muted);font-size:13px;">Remaining principal RM <%= h.money(restructureForm.cut.principal) %> · unpaid interest RM <%= h.money(restructureForm.cut.arrears) %> as of today. Unpaid interest is carried as arrears (recalculated for the effective date you pick) and does not earn further interest.</p>
  <% if (restructureForm.range.min > restructureForm.range.max) { %>
  <div class="alert is-red">No valid effective date today — it must be on or after <%= restructureForm.range.min %>.</div>
  <% } %>
  <label>Effective Date <input type="date" name="effective_date" min="<%= restructureForm.range.min %>" max="<%= restructureForm.range.max %>" value="<%= restructureForm.range.max %>" required></label>
  <label>Interest Mode <select name="interest_mode" id="rs-mode">
    <option value="monthly">Monthly rate %</option><option value="daily">Annual rate % (÷365 daily)</option><option value="fixed">Fixed amount</option>
  </select></label>
  <label class="rs-accrual">Interest Rate % <input type="number" step="0.01" min="0" name="interest_rate"></label>
  <label class="rs-fixed">Interest Amount (RM) <input type="number" step="0.01" min="0" name="interest_amount"></label>
  <label>Tenure (months) <input type="number" step="1" min="1" max="120" name="tenure" required></label>
  <label>Reason <textarea name="reason" required></textarea></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Restructure</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<% } %>
```

底部 `<script>` 内（`document.querySelectorAll('dialog.modal')` 之前）加：

```js
  (function(){
    var s = document.getElementById('rs-mode'); if (!s) return;
    function sync(){ var fixed = s.value === 'fixed';
      document.querySelectorAll('.rs-accrual').forEach(function(e){ e.style.display = fixed ? 'none' : ''; });
      document.querySelectorAll('.rs-fixed').forEach(function(e){ e.style.display = fixed ? '' : 'none'; }); }
    s.addEventListener('change', sync); sync();
  })();
```

- [ ] **Step 5: form.ejs 锁定原始条款**

`<% layout('layout'); -%>` 之后加 `<% const locked = locals.termsLocked; %>`；`<form ...>` 之后加：

```ejs
  <% if (locked) { %><p style="margin:0;color:var(--muted);">Loan terms are locked after a restructure — re-plan them with a new restructure on the case page.</p><% } %>
```

- Principal、Loan Start Date、Tenure、Interest Amount、Interest Rate 五个 `<input>` 各加 `<%= locked ? 'readonly' : '' %>`（只读仍会提交，服务端用 `lockedTerms` 保留原值）。
- `interest_mode` 的 `<select>` 加 `<%= locked ? 'disabled' : '' %>`。
- 期限快捷按钮行 `<div class="chip-row" ...>` 外包 `<% if (!locked) { %> ... <% } %>`。

- [ ] **Step 6: 浏览器验证（本地临时库，不碰 data/crm.db）**

```bash
export CRM_DB_PATH="$SCRATCH/rs-preview.db"; rm -f "$CRM_DB_PATH"; export PORT=3200
node --no-warnings src/db/seed.js && node --no-warnings src/app.js
```

用 manager 登录 `http://localhost:3200`，逐项确认：
1. case 2：Restructure 按钮可见；对话框显示剩余本金与欠息；切 fixed 时利率栏隐藏、固定利息栏出现。
2. 生效日选今天、monthly 1%、6 个月、填原因 → 提交后：Records 当前计划首行「Arrears (carried)」、其后 6 行；Restructure History 一块，可展开被取代的计划；头部到期日显示新到期日与「Restructured on」。
3. 时间线有 `Restructure:` note。
4. Record Payment 日期框 `min` 为生效日。
5. Undo 按钮可见并成功恢复；再次重组后，在生效日记一笔付款 → Undo 消失。
6. Edit Case：条款字段只读、提示文字可见；只改 Priority 保存成功且本金/条款不变。
7. agent 登录：看不到 Restructure 按钮和 Undo。

- [ ] **Step 7: 全量回归并 Commit**

Run: `npm test` → 全部 PASS

```bash
git add src/views/partials/scheduleTable.ejs src/views/cases/show.ejs src/views/cases/form.ejs
git commit -m "feat: restructure dialog, current/superseded schedules, locked terms UI"
```

---

### Task 7: Demo 数据

**Files:**
- Modify: `src/db/seed.js`（case 14 重组；`clearAllTables`、`deleteDemo` 表列表）
- Test: `test/restructure_demo.test.js`（新）

**Interfaces:**
- Consumes: `balanceAtCut`（Task 3）、`maturityDate`、`recomputeOutstanding`、`interestTerms`。

- [ ] **Step 1: 写失败测试**

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsdemo-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();

test('demo seed restructures case 14 with carried arrears', () => {
  const r = db.get('SELECT * FROM case_restructures WHERE case_id=14');
  assert.ok(r, 'restructure row exists');
  assert.strictEqual(r.is_demo, 1);
  assert.strictEqual(r.tenure, 18);
  assert.ok(r.arrears_at_cut > 0);
  const c = db.get('SELECT outstanding_amount FROM cases WHERE id=14');
  assert.ok(c.outstanding_amount > r.principal_at_cut + r.arrears_at_cut, 'new-term interest on top');
});

test('deleteDemo removes demo restructures together with their case', () => {
  seed.deleteDemo();
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM case_restructures').n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM cases WHERE id=14').n, 0);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --no-warnings --test test/restructure_demo.test.js`
Expected: FAIL（`restructure row exists`）

- [ ] **Step 3: 实现**

`src/db/seed.js` imports 加 `const { balanceAtCut } = require('../services/restructure');`。

`STATUSES.forEach(...)` 循环结束后加：

```js
  // Case 14 (monthly, see above) is also restructured 10 days ago so the demo
  // shows a carried-arrears row, the new schedule and the restructure history.
  const c14 = db.prepare('SELECT * FROM cases WHERE id=14 AND is_demo=1').get();
  if (c14 && c14.interest_mode === 'monthly' && !db.prepare('SELECT 1 FROM case_restructures WHERE case_id=14').get()) {
    const eff = ago(10).slice(0, 10);
    const cut = balanceAtCut(c14, [], [], eff);
    const reason = 'Debtor requested lower instalments';
    run(`INSERT INTO case_restructures (case_id,effective_date,reason,interest_mode,interest_rate,interest_amount,tenure,maturity_date,principal_at_cut,arrears_at_cut,created_by,is_demo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`, [14, eff, reason, 'monthly', 1.2, 0, 18, maturityDate(eff, 18, 'months'), cut.principal, cut.arrears, 'Collection Manager']);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by,is_demo) VALUES (?,?,?,?,1)',
      [14, 'note', `Restructure: from ${eff}, 1.2%/month, 18 months. Reason: ${reason}`, 'Collection Manager']);
    recomputeOutstanding(14);
  }
```

`clearAllTables` 的表数组在 `'cases'` 前插入 `'case_restructures'`。

`deleteDemo`：子表数组加 `'case_restructures'`；`DELETE FROM cases WHERE is_demo=1 ...` 的条件加一行 `AND id NOT IN (SELECT case_id FROM case_restructures)`。

- [ ] **Step 4: 运行，确认通过；全量回归**

Run: `node --no-warnings --test test/restructure_demo.test.js` → PASS
Run: `npm test` → 全部 PASS（`demo.test.js` 的计数断言不受影响；若受影响先查原因）

- [ ] **Step 5: Commit**

```bash
git add src/db/seed.js test/restructure_demo.test.js
git commit -m "feat: demo restructure on case 14"
```

---

### Task 8: 收尾验证

- [ ] **Step 1:** `npm test`（临时 `CRM_DB_PATH`）→ 全部 PASS，记录通过数。
- [ ] **Step 2:** 本地预览（同 Task 6 Step 6 的命令）打开 case 14：欠息行、18 期新计划、历史块、到期日提示都在；Pay 按钮在欠息行，点击预填欠息金额，付款后转到下一行。
- [ ] **Step 3:** `graphify update .`
- [ ] **Step 4:** 停掉预览服务；向用户汇报结果，**等确认后再 `git push`**（推送会触发 Render 部署）。
