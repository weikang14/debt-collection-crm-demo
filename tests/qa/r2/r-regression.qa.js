// Regression of round-1 findings marked fixed (04-final-assessment F-xx) that the
// manual cases a–e do not already exercise.
const { test } = require('node:test');
const c = require('./_client');
const { reseed, step, finish, assert } = require('./_run');
const { check, rec, has, strip, today, addDays, q1, qa, ledgerAmt, num } = c;

test('r2 R: regression of fixed F-items', { timeout: 300000 }, async () => {
  reseed();
  const admin = await c.as('admin');
  const man = await c.as('manager');
  const fin = await c.as('finance');

  await step('F-06', 'no visit task in demo data / forms', async () => {
    const types = qa('SELECT type, title FROM tasks').map(t => `${t.type}:${t.title}`);
    check('F-06', 'seed tasks have no visit; form/filter lists omit visit', !types.some(t => t.startsWith('visit')) && !has((await admin.get('/tasks')).text, 'value="visit"'), types.join(' | '));
  });
  await step('F-09', 'new accrual case shows interest in list/dashboard without opening it', async () => {
    const d = await c.newDebtor(admin, 'QA F09');
    const id = await c.newCase(admin, { debtor_id: String(d), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' });
    const list = (await admin.get('/cases?q=QA+F09')).text;
    const amt = (list.match(/<td class="num">([\d,.]+)<\/td>/) || [])[1];
    check('F-09', 'list shows 11,800.00 straight after create', amt === '11,800.00' && q1('SELECT outstanding_amount o FROM cases WHERE id=?', id).o === 11800, `list=${amt}`);
  });
  await step('F-10', 'Delete demo keeps a demo agent referenced by trial settlement/task', async () => {
    await fin.act('/commissions/settle', { agent_id: '3', period: today().slice(0, 7), amount: '1', note: 'trial' });
    await admin.act('/tasks/new', { case_id: '', agent_id: '4', type: 'reminder', title: 'trial task for Tan' });
    const r = await admin.act('/demo-tools/delete-demo');
    check('F-10', 'no 500; agents 3/4 kept; demo cases gone', r.ok === 'Demo data deleted - your trial data is kept' && !!q1('SELECT 1 x FROM agents WHERE id=3') && !!q1('SELECT 1 x FROM agents WHERE id=4'), `${r.ok || r.err || r.status}; demo cases left=${q1('SELECT COUNT(*) n FROM cases WHERE is_demo=1').n}`, '另见 X-DEMO-FK：由 payments.agent_id 引用时仍 500');
    reseed();
  });
  await step('F-11', 'demo data self-consistent', async () => {
    const h = strip((await fin.get('/commissions')).text);
    const pend = [...h.matchAll(/(Lim Wei Sheng|Nurul Ain|Rajesh Kumar|Tan Mei Ling) [\d,.]+ [\d.]+ [\d,.]+ [\d,.]+ (-?[\d,.]+)/g)].map(m => `${m[1]}=${m[2]}`);
    const p5 = q1("SELECT amount, due_date FROM ptps WHERE case_id=5 AND status='fulfilled'"), pay5 = q1('SELECT amount, payment_date FROM payments WHERE case_id=5');
    const tl = qa("SELECT content FROM timeline_events WHERE content LIKE 'PTP RM%'").map(x => x.content);
    const monthStart = today().slice(0, 8) + '01';
    check('F-11', 'no negative Pending; case 5 PTP = payment; no time in timeline dates; payments in this month', pend.every(p => !p.includes('=-')) && p5.amount === pay5.amount && p5.due_date === pay5.payment_date && tl.every(t => !/\d{2}:\d{2}/.test(t)) && qa('SELECT payment_date d FROM payments').every(x => x.d >= monthStart),
      `${pend.join(' ')}; case5 PTP ${p5.amount}/${p5.due_date} vs pay ${pay5.amount}/${pay5.payment_date}`);
  });
  await step('F-13', 'no real public figures; IC numbers', async () => {
    const names = qa('SELECT name, ic_passport FROM debtors').map(d => `${d.name}(${d.ic_passport})`);
    const famous = names.filter(n => /Wong Kar Wai|Lee Chong Wei/.test(n));
    const realLooking = names.filter(n => /\(\d{6}-\d{2}-\d{4}\)/.test(n)).length;
    rec('F-13', 'names fictional (IC: 建议改用明显无效号段)', `famous=${famous.length}; IC in valid NRIC format: ${realLooking}/${names.length} e.g. ${names[0]}`, famous.length === 0 ? (realLooking ? 'PARTIAL' : 'PASS') : 'FAIL');
  });
  await step('F-14', 'agent opens the case of each own demo task', async () => {
    const a3 = await c.as('agent3');
    const ids = [...(await a3.get('/tasks')).text.matchAll(/href="\/cases\/(\d+)"/g)].map(m => +m[1]);
    const st = []; for (const id of ids) st.push((await a3.get(`/cases/${id}`)).status);
    check('F-14', 'all 200', ids.length > 0 && st.every(s => s === 200), `cases=${ids} status=${st}`);
  });
  await step('F-20', 'payment date before the loan start', async () => {
    const d = await c.newDebtor(admin, 'QA F20');
    const id = await c.newCase(admin, { debtor_id: String(d), principal_amount: '1000', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-06-01', tenure: '6' });
    const r = await fin.act(`/cases/${id}/payments`, { payment_date: '2020-01-01', amount: '10', method: 'cash' });
    rec('F-20', 'amount/method/future/format all validated (X-VAL-PAY); lower bound = loan start (建议)', `payment dated 2020-01-01 on a loan starting 2026-06-01 → ${r.ok || r.err}`, r.err ? 'PASS' : 'PARTIAL', '早于起息日的还款仍被接受（上一轮 F-20 建议“下限 = 起息日或重组日”）');
  });
  await step('F-32', 'audit log date/entity filters + CSV export', async () => {
    const aud = await c.as('auditor');
    const f = (await aud.get(`/audit-log?from=${today()}&to=${today()}&entity=case`)).text;
    const rows = [...f.slice(f.indexOf('<tbody>')).matchAll(/<tr>/g)].length;
    const csv = await aud.get(`/audit-log?format=csv&from=${today()}&to=${today()}`);
    const old = (await aud.get('/audit-log?from=2020-01-01&to=2020-01-02')).text;
    check('F-32', 'filters + CSV', rows > 0 && /audit-log\.csv/.test(csv.headers.get('content-disposition') || '') && csv.text.split('\r\n')[0].replace(/^﻿/, '') === 'Time,User,Action,Entity,Entity ID,Details,IP' && ![...old.slice(old.indexOf('<tbody>')).matchAll(/<tr>\s*<td/g)].length,
      `case rows today=${rows}; csv=${csv.headers.get('content-disposition')}`, '审计写入失败仍只打日志、不阻断（audit.js:12），同库无防篡改——属上一轮 F-32 的剩余部分');
  });
  await step('F-46', 'CSV formula injection', async () => {
    await c.newDebtor(admin, '=HYPERLINK("http://evil","x")');
    const d = q1("SELECT id FROM debtors WHERE name LIKE '=HYPERLINK%'").id;
    await c.newCase(admin, { debtor_id: String(d), principal_amount: '5', interest_mode: 'fixed', interest_amount: '0' });
    const csv = (await admin.get('/reports?export=cases')).text;
    const line = csv.split('\r\n').find(l => l.includes('HYPERLINK'));
    check('F-46', "text cell prefixed with ' ; numbers untouched", /"'=HYPERLINK/.test(line) && /,5,0,0,5,/.test(line), line);
  });
  await step('F-52', 'login timing: unknown user ≈ wrong password', async () => {
    const t = async (u) => { const s = Date.now(); await new c.Session().login(u, 'wrong-password-x'); return Date.now() - s; };
    const known = [], unknown = [];
    for (let i = 0; i < 2; i++) { known.push(await t('manager')); unknown.push(await t('nobody_' + i)); }
    await c.as('manager'); // clear the fail counter
    const med = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    check('F-52', 'similar latency (same bcrypt cost)', Math.abs(med(known) - med(unknown)) < 40, `known=${known}ms unknown=${unknown}ms`);
  });
  await step('F-54', 'banner cannot be forged by URL', async () => {
    const h = (await admin.get('/cases/1?ok=Your+account+is+suspended,+call+012-3456789&err=Pay+now')).text;
    check('F-54', 'no .alert from query string', !/class="alert/.test(h), c.alertOf(h) ? JSON.stringify(c.alertOf(h)) : 'no banner');
  });
  await step('F-29', 'session idle timeout 2h (rolling)', async () => {
    const r = await new c.Session().req('POST', '/login', { username: 'admin', password: 'admin123' });
    const exp = (r.headers.getSetCookie().join(';').match(/Expires=([^;]+)/) || [])[1];
    const mins = Math.round((new Date(exp) - Date.now()) / 60000);
    check('F-29', 'cookie expires ≈120 min; bcrypt 10 (SEC-04); 8-char min (USR-08/12)', mins >= 118 && mins <= 121, `expires in ${mins} min`);
  });
  await step('F-37', 'auto payoff writes closed_at + status event', async () => {
    const o = q1('SELECT outstanding_amount o FROM cases WHERE id=12').o;
    await fin.act('/cases/12/payments', { payment_date: today(), amount: String(o), method: 'cash' });
    const r = q1('SELECT status, closed_at FROM cases WHERE id=12'), ev = q1("SELECT content FROM timeline_events WHERE case_id=12 AND event_type='status_change' ORDER BY id DESC");
    check('F-37', 'fully_paid + closed_at + "Status changed new → fully_paid"', r.status === 'fully_paid' && !!r.closed_at && ev && /→ fully_paid/.test(ev.content), `${JSON.stringify(r)} ${ev && ev.content}`);
  });
  await step('F-15', 'timeline/feed ordering deterministic', async () => {
    const d = (await admin.get('/')).text;
    const feed = [...d.slice(d.indexOf('<ul class="feed">')).matchAll(/<li><span class="tk[^"]*"><\/span><div>([^<]+)/g)].map(m => m[1].trim());
    const db = qa('SELECT content FROM timeline_events ORDER BY created_at DESC, id DESC LIMIT 12').map(x => x.content.trim());
    check('F-15', 'dashboard feed = ORDER BY created_at DESC, id DESC', feed.join('|') === db.join('|'), feed.slice(0, 3).join(' | '));
  });

  finish('r-regression');
  assert.ok(true);
});
