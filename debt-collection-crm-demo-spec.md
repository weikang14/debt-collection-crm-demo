# Debt Collection CRM — 可运行 Demo 建设规格书

> 目的：面向顾客演示的**可运行完整系统雏形**（真实前后端 + 数据库，可实际录入测试数据）。
> 合规约束（催收行为限制、DNC名单、争议处理等）与部分业务边界情况（分期还款计划等）**本阶段暂不实现**，留到正式开发阶段补充——本规格书末尾有清单。
> 本文档可直接交给 Claude Code 按章节实现。

---

## 1. Demo 范围确认

- **形态**：可运行的完整系统雏形，真实前端 + 后端 + 数据库，顾客可实际操作、录入数据。
- **模块覆盖**：尽量覆盖大部分模块 —— Dashboard、Client、Debtor、Case、Timeline、Payment、PTP、Agent、Call Log、Task、Reports、Audit Log、RBAC、Search。
- **部署方式**：延续原始报告"全本地部署、不依赖云服务"的原则 —— 技术选型全部使用**零外部依赖**的方案，`npm install && npm start` 即可在本机跑起来，无需 Docker / 云数据库 / 外部 API Key。

---

## 2. 技术栈（Demo 版，轻量但可直接跑）

原始报告的正式生产架构是 Django + PostgreSQL + Docker + React，这对"先给顾客看demo"来说过重。Demo 阶段建议：

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 22.5 | 内置 `node:sqlite` 模块，零第三方数据库依赖 |
| 后端框架 | Express | 轻量、路由清晰、生态成熟 |
| 数据库 | SQLite（通过内置 `node:sqlite` 的 `DatabaseSync`） | 文件型数据库，无需单独装 PostgreSQL/Docker；`import { DatabaseSync } from 'node:sqlite'` |
| 视图渲染 | EJS + `ejs-mate`（布局/局部模板支持） | 服务端渲染，单一端口，不需要单独跑前端dev server，方便顾客本机演示 |
| 鉴权 | `express-session` + `bcryptjs`（纯JS，避免原生编译依赖） | 简单可靠 |
| 时间处理 | `dayjs` | 轻量 |
| 样式 | 自写 CSS（不依赖 Tailwind CDN / Google Fonts CDN） | 保持"全本地、离线可用"原则；字体用系统字体栈 |

> 说明：这套技术栈是为了让 demo **一条命令跑起来、且离线可用**。等顾客认可方向后，正式版可以按原始报告迁移到 Django + PostgreSQL + Docker（数据模型基本可以直接迁移，见第4节）。

### package.json 关键依赖
```json
{
  "scripts": {
    "start": "node --no-warnings src/app.js",
    "seed": "node --no-warnings src/db/seed.js",
    "reset": "node -e \"require('fs').rmSync('data/crm.db',{force:true})\" && npm run seed"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "dayjs": "^1.11.13",
    "ejs": "^3.1.10",
    "ejs-mate": "^4.0.0",
    "express": "^4.21.2",
    "express-session": "^1.18.1"
  }
}
```

> **审阅补充（环境验证）**：
> - 本机已确认 **Node v22.20.0**，`node:sqlite` 无需 `--experimental-sqlite` 标志即可加载，`--no-warnings` 会屏蔽实验性告警——`npm start` 可直接运行。
> - `reset` 脚本原用 `rm -f`，在 Windows（cmd/PowerShell）下不存在，已改为跨平台的 `node -e fs.rmSync`。
> - 移除 `uuid` 依赖：主键均为 `INTEGER AUTOINCREMENT`，`case_no/receipt_no` 用按年自增编号（见 §4.1），session secret 用固定常量即可，demo 无需 uuid。

---

## 3. 角色与权限（RBAC，Demo 简化版）

原始报告有 9 种角色，demo 阶段简化为 6 种，覆盖核心权限差异即可：

| 角色 | Demo 账号 | 权限范围 |
|---|---|---|
| admin | admin / admin123 | 全部模块，含用户管理、审计日志 |
| manager | manager / manager123 | 案件/客户/债务人/催收员管理，报表 |
| agent（催收员） | agent1~3 / agent123 | **仅本人名下案件**，可记录通话/PTP/付款/任务 |
| finance | finance / finance123 | 记录付款，查看报表 |
| auditor | auditor / auditor123 | 全部**只读**，含审计日志 |
| client（委托客户门户） | client1 / client123 | **仅本公司名下案件**，只读 |

行级权限规则（后端每次查询都要带上这个过滤）：
```js
// agent  -> WHERE cases.agent_id = 当前用户绑定的 agent_id
// client -> WHERE cases.client_id = 当前用户绑定的 client_id
// 其余角色 -> 不限制
```

---

## 4. 数据模型（SQLite schema，可直接迁移到 PostgreSQL）

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','agent','finance','auditor','client')),
  agent_id INTEGER,
  client_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  pic_name TEXT, phone TEXT, email TEXT,
  agreement_no TEXT,
  commission_rate REAL NOT NULL DEFAULT 15,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE debtors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ic_passport TEXT, company TEXT, phone TEXT, email TEXT, address TEXT,
  employer TEXT, salary REAL,
  risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
  guarantor_name TEXT, guarantor_phone TEXT,   -- 担保人：原报告缺失，审阅时补充
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, contact TEXT, department TEXT,
  target_amount REAL NOT NULL DEFAULT 0,
  commission_rate REAL NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  debtor_id INTEGER NOT NULL REFERENCES debtors(id),
  agent_id INTEGER REFERENCES agents(id),
  principal_amount REAL NOT NULL DEFAULT 0,
  interest_amount REAL NOT NULL DEFAULT 0,
  outstanding_amount REAL NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT, remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('call','whatsapp','email','payment','ptp_created','ptp_fulfilled','ptp_broken','note','status_change','legal')),
  content TEXT NOT NULL, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  receipt_no TEXT UNIQUE NOT NULL,
  payment_date TEXT NOT NULL, amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'bank_transfer',
  reference TEXT, bank TEXT, remark TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 付款写入后需联动：更新 cases.outstanding_amount，若降到0则 status='fully_paid'，
-- 若>0但已有付款则 status='partial_paid'；同时写一条 timeline_events(event_type='payment')

CREATE TABLE ptps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  amount REAL NOT NULL, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','broken')),
  remark TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER REFERENCES cases(id),
  agent_id INTEGER REFERENCES agents(id),
  type TEXT NOT NULL DEFAULT 'follow_up' CHECK (type IN ('visit','legal','follow_up','reminder')),
  title TEXT NOT NULL, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  agent_id INTEGER REFERENCES agents(id),
  call_time TEXT NOT NULL DEFAULT (datetime('now')),
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT 'no_answer' CHECK (result IN ('answered','no_answer','busy','wrong_number','refused')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER,
  details TEXT, ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

关键索引：`cases(status, agent_id, client_id, debtor_id)`、`timeline_events(case_id)`、`payments(case_id)`、`ptps(case_id, status)`。

---

## 4.1 业务规则澄清（审阅补充，实现时按此执行）

这些是原 spec 未写明、但直接影响实现一致性的规则。已确定的口径如下：

**① 未收金额（outstanding）的计算 —— 重算，不做增减**
- 每次付款后重新计算：`outstanding = principal_amount + interest_amount − SUM(payments.amount)`，结果 `< 0` 时钳制为 `0`（demo 不处理超额/退款）。
- 案件创建时初始 `outstanding_amount = principal_amount + interest_amount`（表单可只填本金+利息，outstanding 自动算出）。

**② 付款 ↔ 案件状态的联动（不覆盖终态）**
- 定义**终态/特殊状态**集合：`legal / closed / cancelled / bankruptcy / deceased`。
- 付款写入后：
  - 若当前状态属于上述终态集合 → **状态保持不变**（仍更新 outstanding、仍写 timeline），避免把 legal/破产等语义静默抹掉。
  - 否则：`outstanding == 0` → `fully_paid`；`outstanding > 0` 且已存在付款 → `partial_paid`。
- 每次付款写一条 `timeline_events(event_type='payment')`。

**③ PTP ↔ 案件状态**
- 创建 PTP：若当前状态不属于终态集合，则 `case.status → 'ptp'`；写 `timeline_events(event_type='ptp_created')`。
- 履约 `fulfill` / 违约 `break`：更新 `ptps.status`，写对应 `ptp_fulfilled` / `ptp_broken` timeline，但**不自动改案件状态**（由 agent 手动决定后续），保持业务灵活性。

**④ 编号生成（按年自增，零填充）**
- `case_no`：`CASE-YYYY-####`（如 `CASE-2026-0001`）。
- `receipt_no`：`RCPT-YYYY-####`。
- 序号按当年已有记录数 + 1 生成；生成后依赖表上的 UNIQUE 约束兜底。

**⑤ 行级权限的完整口径（不止 cases 表）**
- `agent` / `client` 角色：只能看到**通过自己名下案件可达**的 Debtor 与 Client（用 `WHERE debtor_id IN (SELECT debtor_id FROM cases WHERE <scope>)` 之类的子查询过滤）。
- **全局搜索** `/search` 对 agent/client 应用同样的 scope 过滤。
- **Dashboard**：agent 只统计本人名下、client 只统计本公司名下；「催收员排行榜」对 agent/client **隐藏**（对其无意义且会泄露他人数据）。
- `client` 角色无 `/debtors`、`/clients` 独立入口（§5 未列 client），债务人信息只在其可见的 case 详情页内展示。

**⑥ 审计日志触发点（`logAction()` 记录哪些动作）**
- 登录 / 登出；
- client / debtor / case / agent 的**创建与更新**；
- 记录付款、案件状态变更、PTP 创建/履约/违约。
- 记录字段：`username, action, entity_type, entity_id, details, ip_address`（ip 取 `req.ip`）。

**⑦ 金额与时间显示**
- demo 用 `REAL` 存金额（正式版改 Decimal，见 §10）；展示时保留 2 位小数 + 千分位。
- SQLite `datetime('now')` 存 **UTC**；页面通过 `dayjs` 以本地时区（马来西亚 MYT，UTC+8）格式化展示。

**⑧ 状态机（demo 简化）**
- `POST /cases/:id/status` 允许在 11 种状态间自由切换（demo 不做严格状态转移约束），每次切换写 `timeline_events(event_type='status_change')` 并记审计。

---

## 5. 功能模块与路由清单

| 模块 | 路由 | 说明 |
|---|---|---|
| 登录/登出 | `GET/POST /login`, `GET /logout` | session 鉴权 |
| Dashboard | `GET /` | 按角色范围统计：今日回款、今日PTP、未收金额、新增/关闭案件、法律案件、破约PTP、今日/逾期跟进、催收员排行榜、最近动态 |
| Clients | `GET /clients`, `/clients/new`, `/clients/:id`, `/clients/:id/edit` | admin/manager/finance/auditor 可见 |
| Debtors | `GET /debtors`, `/debtors/new`, `/debtors/:id`, `/debtors/:id/edit` | 含担保人字段；admin/manager/agent/finance/auditor 可见 |
| Cases | `GET /cases`（列表+筛选）, `/cases/new`, `/cases/:id`（详情：客户/债务人信息+Timeline+付款+PTP+任务+状态变更）, `/cases/:id/edit` | 核心模块，agent 只看自己名下 |
| ├─ 记录付款 | `POST /cases/:id/payments` | 联动更新 outstanding + status + timeline |
| ├─ 创建PTP | `POST /cases/:id/ptps`，`POST /ptps/:id/fulfill`，`POST /ptps/:id/break` | |
| ├─ 通话记录 | `POST /cases/:id/calls` | 写入 call_logs + timeline |
| ├─ 备注/状态变更 | `POST /cases/:id/notes`, `POST /cases/:id/status` | |
| Agents | `GET /agents`, `/agents/new`, `/agents/:id`, `/agents/:id/edit` | 含绩效统计：回款金额、案件数、达标率；admin/manager/auditor 可见 |
| Tasks | `GET /tasks`（我的任务/全部）, `POST /tasks/new`, `POST /tasks/:id/complete` | |
| Reports | `GET /reports` | Collection Report、Outstanding Report、Agent Performance Report（按日期范围筛选，表格+简单进度条图） |
| Audit Log | `GET /audit-log` | admin/auditor 可见，只读 |
| Search | `GET /search?q=` | 按 Case No / 债务人姓名 / IC / 电话 全局搜索 |

---

## 6. Demo 种子数据规划

- **5 家 Client**（消费贷、车贷、信用卡、物业管理费、小额贷款各一家，营造多行业感）
- **12 位 Debtor**（含担保人信息、不同风险等级）
- **4 位 Agent**（分属 Consumer/Commercial/Legal 三个部门）
- **20 个 Case**，状态覆盖全部 11 种状态（new/assigned/negotiation/ptp/partial_paid/fully_paid/legal/closed/cancelled/bankruptcy/deceased），金额、优先级、逾期天数都做出差异
- 对应生成 **payments / ptps / call_logs / tasks / timeline_events / audit_logs** 样例数据，保证顾客打开每个模块都有真实数据可看，而不是空列表
- `npm run seed` 一键生成；`npm run reset` 清空重来

---

## 7. 视觉设计方向

给顾客看的是"值得信赖的金融催收作业台"感觉，不是通用后台模板：

- **主基调**：深墨蓝/炭黑侧边栏（`#10151f`） + 暖白/米色内容区（`#faf6ee`） + 金铜色强调色（`#b7842a`），呼应"账本/资金"主题
- **字体**：标题用衬线字体（Georgia/系统衬线栈，营造"账本"编辑感），正文用系统无衬线字体栈，金额/编号用等宽字体（`ui-monospace`）—— **全部用系统字体栈，不依赖 Google Fonts 等外部CDN**，符合"全本地部署"定位
- **语义色**：绿=已结清，金黄=PTP/待处理，红=法律/逾期，蓝灰=中性状态
- **图标**：自绘极简线性 SVG 图标（不依赖图标字体CDN）
- **数据密度**：表格优先，等宽数字对齐，状态用小圆点+文字徽章（pill）区分，不用花哨卡片堆砌

CSS 变量示例：
```css
:root {
  --ink: #10151f; --paper: #faf6ee; --gold: #b7842a;
  --green: #1e7a4c; --red: #a8342c; --blue: #395a80;
  --font-display: Georgia, 'Iowan Old Style', serif;
  --font-body: -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', 'Roboto Mono', monospace;
}
```

---

## 8. 建议项目结构

```
debt-collection-crm/
├── package.json
├── data/                  # SQLite 数据库文件（.gitignore）
├── src/
│   ├── app.js             # Express 入口
│   ├── db/
│   │   ├── schema.sql
│   │   ├── index.js       # node:sqlite 连接封装
│   │   └── seed.js
│   ├── middleware/
│   │   └── auth.js        # requireLogin / requireRole
│   ├── utils/
│   │   ├── helpers.js     # 格式化、状态label、图标
│   │   ├── audit.js       # logAction()
│   │   └── scope.js       # 按角色生成行级过滤条件
│   ├── routes/
│   │   ├── auth.js dashboard.js clients.js debtors.js
│   │   ├── cases.js agents.js tasks.js reports.js
│   │   └── audit.js search.js
│   └── views/
│       ├── layout.ejs partials/ auth/ dashboard/
│       └── clients/ debtors/ cases/ agents/ reports/ tasks/ audit/
└── public/css/style.css
```

---

## 9. 实施优先级（建议 Claude Code 按此顺序实现）

1. **地基**：项目脚手架 + schema + seed + 登录鉴权 + layout/侧边栏（角色可见性）
2. **主干**：Client / Debtor / Case 三个模块的增删查改
3. **业务闭环**：Case 详情页内的 Timeline / 付款记录（联动更新余额与状态）/ PTP / 通话记录
4. **管理面**：Agent 模块 + 绩效统计、Task 模块
5. **洞察面**：Dashboard 统计卡片、Reports、全局 Search、Audit Log
6. **打磨**：空状态、表单校验提示、demo 账号说明页、README 使用说明

---

## 10. 暂缓事项（正式开发阶段必须补上，demo 阶段先不做）

来自此前的审阅结论，避免遗漏：

- **合规约束**：禁止联系时段/频次限制、DNC（禁止联系）名单与冻结机制、债务人投诉/争议（Dispute）模块、通话录音合规（告知与访问控制）、数据保留期限与删除请求处理、催收牌照/从业资格字段
- **业务边界**：分期还款计划（Repayment Plan，PTP目前只支持单次承诺）、案件自动分配规则、佣金自动计算与结算、法律案件子模块（开庭日期/代理律师/诉讼进度）、多债权人场景下 Debtor↔Case 的一对多关系确认
- **数据与架构**：金额字段生产环境需用 Decimal 而非 Float、部分支付/重复支付/退款冲正逻辑、附件存储生命周期规划、静态与传输加密、MFA、备份与灾难恢复、API 限流、AI 生成话术的合规扫描

---

*本规格书基于此前对原始项目报告的审阅结论与本次 demo 范围确认整理而成，可直接作为 Claude Code 的实现依据。*
