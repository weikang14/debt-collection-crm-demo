# RESUME HANDOFF — Debt Collection CRM Demo

This file lets a fresh conversation resume building this project with zero prior context.
Last updated after **Task 3** completed and reviewed. Paused at user request.

## What this project is

An offline, runnable full-stack debt-collection CRM demo: Express + `node:sqlite` (SQLite)
+ EJS server-rendered views, session auth with RBAC + row-level scoping. Single command to run.

- **Spec (source of truth for WHAT):** `debt-collection-crm-demo-spec.md` — see §4.1 for resolved business rules.
- **Plan (source of truth for HOW, task-by-task with full code):** `docs/superpowers/plans/2026-07-02-debt-collection-crm-demo.md`
- **Execution method:** superpowers **subagent-driven-development** — one implementer subagent per plan task, then a task-reviewer subagent (spec + quality gate), fix loop if needed, mark complete. Broad whole-branch code review after ALL tasks, then finishing-a-development-branch.

## Environment facts (verified)

- Windows. Use the **Bash tool** (Git Bash) for the helper scripts and git; PowerShell also available. Forward slashes in paths. No `rm` in reset scripts.
- **Node v22.20.0** — `node:sqlite` loads WITHOUT `--experimental-sqlite` (only an experimental warning, silenced by `--no-warnings`). Do NOT add the flag.
- Deps allowed: bcryptjs, dayjs, ejs, ejs-mate, express, express-session. NO uuid. Tests use built-in `node:test` (run via `npm test` = `node --no-warnings --test`).
- Git initialized (user: DebtCollectionCRM Dev / 3fstechmlk@gmail.com). Baseline commit `08c1bfb`.
- Commit-message footer to append: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Progress so far (DONE + reviewed clean)

Plan-task order executed with the one dependency caveat honored (**Task 8 audit built before Tasks 3 & 7**):

| Plan Task | What | Commit | Review |
|---|---|---|---|
| Task 1 | Scaffold + DB layer (schema.sql, db/index.js, app.js, package.json, /health) | `8641d3e` | ✅ clean |
| Task 2 | Presentation helpers + tests (src/utils/helpers.js) | `bc4519e` | ✅ clean |
| Task 8 | Audit utility (src/utils/audit.js) | `5dc8d09` | ✅ clean |
| Task 3 | Auth: login/logout, RBAC middleware, login/error views | `0c5caf6` | ✅ clean |

Current HEAD = `0c5caf6`. Progress ledger (durable, on disk, gitignored): `.superpowers/sdd/progress.md`.
Verify with `git log --oneline` if in doubt — trust git + ledger over memory.

## Minor findings accumulated (hand to the FINAL whole-branch review, not fixed yet)

- Task 1: no `package.json` `engines` field; hardcoded session secret (both plan-inherited).
- Task 2: dead `toMYT` helper in helpers.js; MYT display not actually applied — dates render in server-local time (accepted as cosmetic for demo).
- Task 3: login username-enumeration timing side-channel (plan-inherited); `bcrypt.compareSync` unguarded if a hash is malformed (low risk).

## Remaining tasks — exact execution order

Next up = **Plan Task 4 (Layout, sidebar, base CSS)**. Then:

`4 → 5 → 6 → 7 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24`

(Task 8 already done. Dependency note: Task 7 payments needs Task 6 numbering + Task 8 audit — both done/ordered. Tasks 11/12/20/21/22 need Task 5 scope. Task 12 cases needs Task 6 numbering + Task 7 payments. Tasks 13–17 add routes to the SAME `src/routes/cases.js` router built in Task 12.)

### Task-tracker (TaskCreate) ID → Plan Task mapping

taskId 1→T1, 2→T2, 3→T8, 4→T3 (all completed). taskId 5→**T4**, 6→T5, 7→T6, 8→T7, 9→T9, and taskId N→plan Task N for N in 10..24.

## How to resume (mechanical steps per task)

Skill scripts dir: `C:/Users/user/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.0/skills/subagent-driven-development/scripts/`

For each remaining plan task **N** (start with N=4):

1. Record BASE = current HEAD: `git rev-parse HEAD`.
2. Generate the brief:
   `scripts/task-brief docs/superpowers/plans/2026-07-02-debt-collection-crm-demo.md N`
   (prints a path like `.superpowers/sdd/task-N-brief.md`).
3. Dispatch an **implementer** subagent (general-purpose). Point it at the brief file, give scene-setting (what exists, dependency interfaces), report path `.superpowers/sdd/task-N-report.md`, and the report contract (return only status/commits/1-line test summary/concerns). Have it follow TDD where the brief has tests, run `npm test`/smoke as specified, commit with the Co-Authored-By footer.
4. On DONE: `scripts/review-package BASE HEAD` → dispatch a **task-reviewer** subagent (template at the skill's `task-reviewer-prompt.md`) with the brief, report, diff file, and verbatim global constraints.
5. Fix loop for Critical/Important findings (dispatch fix subagent, re-review). Record Minor findings in the ledger for the final review.
6. Append `Task N: complete (commits <base7>..<head7>, review clean)` to `.superpowers/sdd/progress.md`, mark the tracker task completed, proceed to next N.

**Model selection:** transcription tasks (complete code in brief) → `haiku`; integration/judgment (cases module T12, dashboard T20, reports T21) → `sonnet`; final whole-branch review → most capable (`opus`). Always set the model explicitly.

### After all tasks
- Run full manual run-through: `npm run reset && npm start`, log in as each demo role, touch every module, `npm test`.
- Dispatch the FINAL whole-branch review: `scripts/review-package 08c1bfb HEAD` (merge-base = baseline `08c1bfb`), reviewer on `opus`. Include the accumulated Minor findings list above for triage.
- Then superpowers:finishing-a-development-branch.

## Demo accounts (from seed, Task 9)

admin/admin123 · manager/manager123 · agent1|2|3/agent123 · finance/finance123 · auditor/auditor123 · client1/client123.
Run at http://localhost:3000 after `npm install && npm run seed && npm start`.
