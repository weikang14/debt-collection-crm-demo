# Debt Collection CRM (Demo)

## What it is

An offline, full-stack debt-collection CRM demo built with Express, `node:sqlite`,
and EJS (via `ejs-mate`). It has session-based authentication, role-based access
control (RBAC) across six roles, and row-level scoping (agents only see their own
cases, clients only see their own company's cases). Modules cover clients,
debtors, cases (with timeline, payments, PTPs, call logs, status), agents +
performance, tasks, a dashboard, reports, global search, and an audit log.

## Requirements

- Node.js ≥ 22.5 (verified on v22.20.0, where `node:sqlite` loads without
  `--experimental-sqlite`). No other database or external services needed —
  everything runs offline.
- The `--no-warnings` flag (already set in the npm scripts) silences the
  experimental-module notice for `node:sqlite`.

## Setup

```bash
npm install
npm run seed
npm start
```

Then open http://localhost:3000

## Demo accounts

Also viewable in-app at `/demo-accounts` (linked from the login page).

| Username | Password    | Access                                          |
|----------|-------------|--------------------------------------------------|
| admin    | admin123    | Full access + user mgmt + audit                  |
| manager  | manager123  | Cases/clients/debtors/agents + reports            |
| agent1   | agent123    | Only own cases                                    |
| agent2   | agent123    | Only own cases                                    |
| agent3   | agent123    | Only own cases                                    |
| finance  | finance123  | Record payments, view reports                     |
| auditor  | auditor123  | Read-only everything + audit log                  |
| client1  | client123   | Only own company's cases (read-only)              |

## Reset data

```bash
npm run reset
```

Wipes `data/crm.db` and re-seeds from scratch.

## Run tests

```bash
npm test
```

## Deferred / out-of-scope

This is a demo; the following are intentionally not implemented (see
`debt-collection-crm-demo-spec.md` §10 for the full list):

- **Compliance**: contact-time/frequency restrictions, DNC (do-not-contact)
  lists and holds, debtor dispute/complaint handling, call-recording
  compliance (consent + access control), data-retention/deletion requests,
  collector licensing fields.
- **Business scope**: installment repayment plans (PTPs support only a single
  promise), automatic case assignment rules, automatic commission
  calculation/settlement, a legal-case sub-module (hearing dates, counsel,
  litigation progress), multi-creditor debtor↔case relationships.
- **Data & architecture**: production-grade `Decimal` money type (instead of
  float), partial/duplicate-payment and refund-reversal logic, attachment
  storage lifecycle, encryption at rest/in transit, MFA, backup/disaster
  recovery, API rate limiting, compliance scanning of AI-generated scripts.

## Demo caveats

- Money amounts are stored as SQLite `REAL` (floating point), not a decimal
  type — fine for a demo, not for production accounting.
- Dates/times render in the server's local timezone, not Malaysia time (MYT).
- No real security hardening: session secret is hardcoded in `src/app.js`,
  passwords are demo-strength, and there's no rate limiting, CSRF protection,
  or transport encryption.
