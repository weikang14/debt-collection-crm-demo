#!/usr/bin/env bash
# 角色 1 全量回放。前提：QA 服务已在 :3301 用 data/qa/tester.db 运行：
#   CRM_DB_PATH=data/qa/tester.db PORT=3301 node --no-warnings src/app.js
# 每个文件开头都会对 data/qa/tester.db 重新 seed（显式设置 CRM_DB_PATH，不碰 data/crm.db）。
set -u
cd "$(dirname "$0")/../.."
mkdir -p tests/qa/results
for f in m1-auth-nav-dash-deb m2-case-int-pay-sch m3-ptp-rs m4-task-agt-usr-rpt-com-misc m5-e2e-sec-smoke x1-outside-manual p1-nonfunctional; do
  node --no-warnings --test "tests/qa/$f.qa.js" > "tests/qa/results/$f.tap" 2>&1
  echo "$f: $(grep -E '^# (pass|fail)' "tests/qa/results/$f.tap" | tr '\n' ' ')"
done
PYTHONIOENCODING=utf-8 python tests/qa/ui.qa.py > tests/qa/results/ui.log 2>&1; tail -1 tests/qa/results/ui.log
