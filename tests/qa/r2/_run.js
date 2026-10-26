// Shared runner for the r2 *.qa.js files: reseed the tester DB, run named steps,
// record crashes as BLOCKED, save results, and fail the node:test if any FAIL.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const c = require('./_client');

function reseed() {
  // CRM_DB_PATH is always set explicitly — never touches data/crm.db.
  execFileSync(process.execPath, ['--no-warnings', 'src/db/seed.js'], { cwd: c.ROOT, env: { ...process.env, CRM_DB_PATH: c.DB_PATH }, stdio: 'pipe' });
}

async function step(id, expected, fn) {
  try { await fn(); } catch (e) { c.rec(id, expected, 'ERROR: ' + (e && e.stack || e).toString().slice(0, 400), 'BLOCKED', 'script error'); }
}

function finish(name) {
  const res = c.saveResults(name);
  const tally = res.reduce((m, r) => ((m[r.result] = (m[r.result] || 0) + 1), m), {});
  console.log(name, JSON.stringify(tally));
  for (const r of res.filter(r => r.result !== 'PASS')) console.log(`  ${r.result} ${r.id}: ${r.actual.slice(0, 220)}`);
  return res;
}

module.exports = { reseed, step, finish, assert, path };
