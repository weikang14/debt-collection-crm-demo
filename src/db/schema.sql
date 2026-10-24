CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  pic_name TEXT, phone TEXT, email TEXT,
  agreement_no TEXT,
  commission_rate REAL NOT NULL DEFAULT 15,
  remark TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS debtors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ic_passport TEXT, company TEXT, phone TEXT, email TEXT, address TEXT,
  employer TEXT, salary REAL,
  risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
  guarantor_name TEXT, guarantor_phone TEXT,
  remark TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, contact TEXT, department TEXT,
  target_amount REAL NOT NULL DEFAULT 0,
  commission_rate REAL NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  debtor_id INTEGER NOT NULL REFERENCES debtors(id),
  agent_id INTEGER REFERENCES agents(id),
  principal_amount REAL NOT NULL DEFAULT 0,
  interest_amount REAL NOT NULL DEFAULT 0,
  outstanding_amount REAL NOT NULL DEFAULT 0,
  -- Cache of total interest charged (every mode, every restructure segment),
  -- written by recomputeOutstanding(). interest_amount stays the fixed-mode input.
  interest_charged REAL NOT NULL DEFAULT 0,
  -- Interest model, per case. 'fixed': interest_amount is a manual lump (default,
  -- unchanged behaviour). 'daily': interest_rate is an ANNUAL % accrued /365 on
  -- remaining principal. 'monthly': interest_rate is a MONTHLY % accrued /30.
  -- daily/monthly use interest-first (先息后本) allocation. interest_from =
  -- accrual start (falls back to opened_at when null).
  interest_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (interest_mode IN ('fixed','monthly','daily')),
  interest_rate REAL NOT NULL DEFAULT 0,
  interest_from TEXT,
  loan_start_date TEXT,
  tenure INTEGER,
  tenure_unit TEXT NOT NULL DEFAULT 'months' CHECK (tenure_unit IN ('days','months','years')),
  maturity_date TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT, remark TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('call','whatsapp','email','payment','ptp_created','ptp_fulfilled','ptp_broken','note','status_change','legal','restructure')),
  content TEXT NOT NULL, created_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  receipt_no TEXT UNIQUE NOT NULL,
  payment_date TEXT NOT NULL, amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'bank_transfer',
  reference TEXT, bank TEXT, remark TEXT, created_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS ptps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  amount REAL NOT NULL, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','broken')),
  remark TEXT, created_by TEXT,
  plan_id TEXT, installment_no INTEGER, plan_size INTEGER,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER REFERENCES cases(id),
  agent_id INTEGER REFERENCES agents(id),
  type TEXT NOT NULL DEFAULT 'follow_up' CHECK (type IN ('visit','legal','follow_up','reminder')),
  title TEXT NOT NULL, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  agent_id INTEGER REFERENCES agents(id),
  call_time TEXT NOT NULL DEFAULT (datetime('now')),
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT 'no_answer' CHECK (result IN ('answered','no_answer','busy','wrong_number','refused')),
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER,
  details TEXT, ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commission_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  period TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT, settled_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commission_agent_period ON commission_settlements(agent_id, period);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_agent ON cases(agent_id);
CREATE INDEX IF NOT EXISTS idx_cases_client ON cases(client_id);
CREATE INDEX IF NOT EXISTS idx_cases_debtor ON cases(debtor_id);
CREATE INDEX IF NOT EXISTS idx_timeline_case ON timeline_events(case_id);
CREATE INDEX IF NOT EXISTS idx_payments_case ON payments(case_id);
CREATE INDEX IF NOT EXISTS idx_ptps_case_status ON ptps(case_id, status);
CREATE INDEX IF NOT EXISTS idx_restructures_case ON case_restructures(case_id, effective_date);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  reg_no TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
