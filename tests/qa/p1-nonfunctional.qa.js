// 第 7 章非功能：7.2 时区、7.5 性能、7.6 数据（迁移；备份见报告）。
// Run: node --test tests/qa/p1-nonfunctional.qa.js
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test, before, after } = require('node:test');
const C = require('./_client');
const { as, check, rec, q1, qa, has, strip, today, addDays, newDebtor, newCase } = C;

before(() => C.reseed());
after(() => C.saveResults('p1'));
const S = {};
test('setup', async () => { S.admin = await as('admin'); S.agent1 = await as('agent1'); });

test('PERF-01 页面响应时间（本地，演示数据量）', async () => {
  const pages = ['/', '/debtors', '/cases', '/tasks', '/agents', '/users', '/reports', '/commissions', '/audit-log', '/settings', '/search?q=a', '/reports?export=cases'];
  for (let i = 1; i <= 20; i++) pages.push(`/cases/${i}`, `/cases/${i}/statement`);
  const slow = []; let max = 0, maxP = '';
  for (const p of pages) { const t0 = performance.now(); const r = await S.admin.get(p); const dt = performance.now() - t0; if (dt > max) { max = dt; maxP = p; } if (dt > 1000 || r.status !== 200) slow.push(`${p}:${r.status}:${dt.toFixed(0)}ms`); }
  check('PERF-01', '各页面本地 1 秒内打开（计息案件详情每次重算）', slow.length === 0, `${pages.length} 个页面；最慢 ${maxP} ${max.toFixed(0)}ms；超时/异常 ${slow.join(',') || '无'}`);
});
test('TZ-01 页面时间按 MYT 显示', async () => {
  const id = await newCase(S.admin, { debtor_id: '1', principal_amount: '1', interest_mode: 'fixed', interest_amount: '0' });
  const ev = q1("SELECT created_at FROM timeline_events WHERE case_id=? AND event_type='note'", id).created_at; // UTC
  const myt = new Date(Date.parse(ev.replace(' ', 'T') + 'Z') + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  const t = (await S.admin.get(`/cases/${id}`)).text;
  check('TZ-01', '时间线/审计显示 MYT', has(t, myt), `库内 UTC ${ev} → 页面应为 ${myt}；页面包含=${has(t, myt)}`);
});
test('TZ-02 MYT 00:00–08:00 新开案件的“今日新开”统计（模拟，E-09 复核）', async () => {
  const id = await newCase(S.admin, { debtor_id: '1', principal_amount: '1', interest_mode: 'fixed', interest_amount: '0' });
  const before_ = Number(strip((await S.admin.get('/')).text).match(/(\d+) opened/)[1]);
  // 把 opened_at 改成今天 MYT 03:00（= 前一天 UTC 19:00），模拟凌晨开案。只改 QA 库。
  const w = new DatabaseSync(C.DB_PATH);
  const utc = addDays(today(), -1) + ' 19:00:00';
  w.prepare('UPDATE cases SET opened_at=? WHERE id=?').run(utc, id); w.close();
  const after_ = Number(strip((await S.admin.get('/')).text).match(/(\d+) opened/)[1]);
  check('TZ-02', 'MYT 当天凌晨开的案件计入今日新开', after_ === before_, `opened_at=${utc} UTC（= ${today()} 03:00 MYT）；今日新开 ${before_} → ${after_}`, '代码：src/routes/dashboard.js:16-17 date(opened_at) 未 +8 小时');
});
test('TZ-03 时区相关代码审阅', async () => {
  const src = f => fs.readFileSync(path.join(C.ROOT, f), 'utf8');
  const items = [
    ['reports 默认 To 用服务器时区 dayjs()', /dayjs\(\)\.format\('YYYY-MM-DD'\)/.test(src('src/routes/reports.js'))],
    ['收据号/案件号年份用服务器时区 new Date().getFullYear()', /new Date\(\)\.getFullYear\(\)/.test(src('src/utils/numbering.js'))],
    ['seed 演示日期用服务器时区 dayjs()', /dayjs\(\)\.subtract/.test(src('src/db/seed.js'))],
    ['佣金默认月份用 MYT', /dayjs\.utc\(\)\.add\(8, 'hour'\)/.test(src('src/routes/commissions.js'))],
  ];
  rec('TZ-03', '所有“今天”按 MYT', items.map(([k, v]) => `${k}=${v}`).join('; '), items.slice(0, 3).some(([, v]) => v) ? 'FAIL' : 'PASS', '服务器为 UTC（如 Render）时生效；本机为 UTC+8 无法实测');
});
test('DATA-01 旧版本数据库升级（c2355cd → 当前）', async () => {
  const dir = path.join(os.tmpdir(), 'qa-old-src'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  execSync(`git archive c2355cd src | tar -x -C "${dir.replace(/\\/g, '/')}"`, { cwd: C.ROOT, shell: 'bash' });
  const oldDb = path.join(os.tmpdir(), 'qa-old.db'); fs.rmSync(oldDb, { force: true });
  const env = { ...process.env, CRM_DB_PATH: oldDb, NODE_PATH: path.join(C.ROOT, 'node_modules') };
  const s1 = spawnSync(process.execPath, ['--no-warnings', path.join(dir, 'src', 'db', 'seed.js')], { env, encoding: 'utf8' });
  const o = new DatabaseSync(oldDb);
  const cnt = () => Object.fromEntries(['cases', 'payments', 'ptps', 'tasks', 'timeline_events', 'users'].map(t => [t, o.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
  const before_ = cnt(); const hadNext = o.prepare("SELECT COUNT(*) c FROM pragma_table_info('cases') WHERE name='next_action_at'").get().c; o.close();
  const s2 = spawnSync(process.execPath, ['--no-warnings', '-e', "require('./src/db').init(); const {recomputeOutstanding}=require('./src/services/payments'); const {all}=require('./src/db'); for (const c of all('SELECT id FROM cases')) recomputeOutstanding(c.id); console.log('ok')"], { cwd: C.ROOT, env, encoding: 'utf8' });
  const n = new DatabaseSync(oldDb);
  const after_ = Object.fromEntries(['cases', 'payments', 'ptps', 'timeline_events', 'users'].map(t => [t, n.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
  const cols = n.prepare("SELECT name FROM pragma_table_info('cases')").all().map(r => r.name);
  const tl = n.prepare("SELECT sql FROM sqlite_master WHERE name='timeline_events'").get().sql.includes("'restructure'");
  const rs = !!n.prepare("SELECT 1 x FROM sqlite_master WHERE name='case_restructures'").get();
  n.close();
  const ok = s1.status === 0 && s2.status === 0 && ['cases', 'payments', 'ptps', 'timeline_events', 'users'].every(k => after_[k] === before_[k]) && cols.includes('interest_charged') && !cols.includes('next_action_at') && tl && rs;
  check('DATA-01', '旧库自动迁移，原有数据不丢失', ok, `旧 seed exit=${s1.status}，迁移 exit=${s2.status} ${(s2.stderr || '').slice(0, 120)}；迁移前 ${JSON.stringify(before_)}（next_action_at 列=${hadNext}）；迁移后 ${JSON.stringify(after_)}；interest_charged=${cols.includes('interest_charged')} timeline 含 restructure=${tl} case_restructures=${rs}`);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(oldDb, { force: true });
});
test('DATA-02 npm run backup', async () => {
  const src = fs.readFileSync(path.join(C.ROOT, 'src/db/backup.js'), 'utf8');
  rec('DATA-02', 'data/backups 生成带时间戳副本，可还原', `未执行：src/db/backup.js:7 写死 data/crm.db，不读 CRM_DB_PATH（含 CRM_DB_PATH=${src.includes('CRM_DB_PATH')}）；按安全规则不得读写 data/crm.db`, 'BLOCKED');
});
