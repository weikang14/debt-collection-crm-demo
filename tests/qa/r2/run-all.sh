#!/usr/bin/env bash
# Round-2 QA (role 1). Needs the tester server: CRM_DB_PATH=data/qa/tester-r2.db PORT=3301 node --no-warnings src/app.js
# Each *.qa.js reseeds data/qa/tester-r2.db (never data/crm.db). e-*.qa.js locks [::1] for 15 min (AUTH-05) — restart the server before re-running it.
cd "$(dirname "$0")/../../.."
for f in a-auth-nav-dash-deb b-case-int-pay-sch c-ptp-rs d-task-agt-usr-rpt-com-misc x-outside-manual r-regression e-smoke-e2e-sec; do
  node --no-warnings --test "tests/qa/r2/$f.qa.js" 2>&1 | grep -E "^# $f "
done
node --no-warnings -e "require('./tests/qa/r2/_run').reseed()" && PYTHONIOENCODING=utf-8 python tests/qa/r2/ui.qa.py | head -1
