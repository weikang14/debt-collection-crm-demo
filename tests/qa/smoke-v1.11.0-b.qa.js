// v1.11.0 冒烟测试 B 部分（B-1…B-17，见 05-v1.11.0-修复报告与线上冒烟测试.pdf 第 8 节），
// 以及第二轮脚本因 v1.11.0 规则变更而 BLOCKED 的用例按新规则补测（S-xx）。HTTP 级，本地执行。
// Run: CRM_DB_PATH=data/qa/tester-r2.db PORT=3301 node --no-warnings src/app.js   （另开终端）
//      node --no-warnings tests/qa/smoke-v1.11.0-b.qa.js
// 开头重新 seed data/qa/tester-r2.db（不碰 data/crm.db）；结果写 docs/qa-reports/2026-10-25/06-artifacts/smoke-B-local.json。
const fs = require('node:fs');
const path = require('node:path');
const c = require('./r2/_client');
const { reseed, step } = require('./r2/_run');
const { check, rec, has, strip, today, addDays, q1, qa, ledgerAmt, ledgerVal, num, scheduleRows } = c;

const OUT = path.join(c.ROOT, 'docs', 'qa-reports', '2026-10-25', '06-artifacts');
const show = async (s, id) => (await s.get(`/cases/${id}`)).text;
const M = (extra = {}) => ({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', ...extra });
// the edit form posts every field; scripts that post only a few now hit "Tenure is required"
const editForm = (cs, extra = {}) => ({ debtor_id: String(cs.debtor_id), agent_id: cs.agent_id ? String(cs.agent_id) : '', principal_amount: String(cs.principal_amount), interest_mode: cs.interest_mode,
  interest_amount: String(cs.interest_amount ?? ''), interest_rate: String(cs.interest_rate ?? ''), loan_start_date: cs.loan_start_date || '', tenure: String(cs.tenure ?? ''), priority: cs.priority, remark: cs.remark || '', ...extra });

(async () => {
  reseed();
  const admin = await c.as('admin'), man = await c.as('manager'), fin = await c.as('finance'), aud = await c.as('auditor'), a1 = await c.as('agent1');

  await step('B-1', 'all 7 accounts log in; menus = role matrix', async () => {
    const expect = {
      admin: ['/debtors', '/cases', '/tasks', '/agents', '/users', '/reports', '/commissions', '/settings', '/demo-tools', '/audit-log', '/search'],
      manager: ['/debtors', '/cases', '/tasks', '/agents', '/reports', '/commissions', '/search'],
      agent1: ['/debtors', '/cases', '/tasks', '/reports', '/commissions', '/search'], agent2: ['/debtors', '/cases', '/tasks', '/reports', '/commissions', '/search'], agent3: ['/debtors', '/cases', '/tasks', '/reports', '/commissions', '/search'],
      finance: ['/debtors', '/cases', '/tasks', '/reports', '/commissions', '/search'],
      auditor: ['/debtors', '/cases', '/tasks', '/agents', '/reports', '/commissions', '/audit-log', '/search'],
    };
    const all = expect.admin; const bad = [];
    for (const [u, want] of Object.entries(expect)) {
      let s; try { s = await c.as(u); } catch (e) { bad.push(`${u}: login failed`); continue; }
      const side = (await s.get('/')).text; const nav = side.slice(side.indexOf('class="sidebar'), side.indexOf('</aside>') > 0 ? side.indexOf('</aside>') : undefined);
      const got = all.filter(p => nav.includes(`href="${p}"`));
      if (got.join() !== want.join()) bad.push(`${u}: ${got.join(',')}`);
    }
    check('B-1', 'login + menus', bad.length === 0, bad.join(' | ') || '7 accounts log in, menus match');
  });
  await step('B-2', 'dashboard renders for every role', async () => {
    const out = [];
    for (const u of ['admin', 'manager', 'agent1', 'agent2', 'agent3', 'finance', 'auditor']) { const r = await (await c.as(u)).get('/'); out.push(`${u}:${r.status}${/Collected Today/.test(r.text) && !/NaN|undefined|Error/.test(strip(r.text)) ? '' : ' BAD'}`); }
    check('B-2', 'all 200, figures, no NaN/undefined/Error', out.every(x => !x.includes('BAD') && x.includes(':200')), out.join(' '));
  });
  let deb, id;
  await step('B-3', 'new debtor + Monthly 12m case; schedule', async () => {
    deb = await c.newDebtor(man, 'QA Smoke 虚构');
    id = await c.newCase(man, { debtor_id: String(deb), agent_id: '1', ...M() });
    const rows = scheduleRows(await show(man, id));
    check('B-3', '12 rows; 150 × 11, last 10,150', rows.length === 12 && rows.slice(0, 11).every(r => r.expected === 150) && rows[11].expected === 10150, `rows=${rows.length} first=${rows[0]?.expected} last=${rows[11]?.expected}`);
  });
  await step('B-4', 'partial payment: status + balances', async () => {
    const p = await fin.act(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const h = p.html;
    check('B-4', 'Partial Paid; contract 10,696.06; settlement shown', /recorded/.test(p.ok || '') && ledgerAmt(h) === '10,696.06' && q1('SELECT status FROM cases WHERE id=?', id).status === 'partial_paid' && num(ledgerVal(h, 'Settlement Today')) > 0,
      `${p.ok}; contract=${ledgerAmt(h)} settle=${ledgerVal(h, 'Settlement Today')} status=${q1('SELECT status FROM cases WHERE id=?', id).status}`);
  });
  await step('B-5', 'overpayment refused; early settlement = interest to date', async () => {
    const id2 = await c.newCase(man, { debtor_id: String(deb), ...M() });
    const o = await fin.act(`/cases/${id2}/payments`, { payment_date: '2026-03-02', amount: '11800', method: 'cash' });
    const o2 = await fin.act(`/cases/${id2}/payments`, { payment_date: '2026-03-02', amount: '10304.84', method: 'cash' });
    const maxAttr = ((await show(fin, id)).match(/max="([\d.]+)" name="amount" id="pay-amount"/) || [])[1];
    check('B-5', 'at most RM 10304.84 (= 10,000 + 2 months 1.5% to 2026-03-02); then fully paid; dialog max = settlement',
      /at most RM 10304\.84/.test(o.err || '') && /recorded/.test(o2.ok || '') && q1('SELECT status FROM cases WHERE id=?', id2).status === 'fully_paid' && Number(maxAttr) === num(ledgerVal(await show(fin, id), 'Settlement Today')),
      `11800 → ${o.err}; 10304.84 → ${o2.ok}, status ${q1('SELECT status FROM cases WHERE id=?', id2).status}; dialog max=${maxAttr}`);
  });
  await step('B-6', 'edit + void a payment restores the balance', async () => {
    await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '50', method: 'cash', reference: 'B6' });
    const pay = q1('SELECT id FROM payments WHERE case_id=? AND reference=?', id, 'B6').id;
    const before = q1('SELECT outstanding_amount o FROM cases WHERE id=?', id).o;
    const e = await fin.act(`/cases/${id}/payments/${pay}`, { amount: '60', payment_date: today(), method: 'cash', reference: 'B6' });
    const v = await fin.act(`/cases/${id}/payments/${pay}/void`);
    const after = q1('SELECT outstanding_amount o FROM cases WHERE id=?', id).o;
    check('B-6', 'Payment updated; Payment voided; balance back', e.ok === 'Payment updated' && v.ok === 'Payment voided' && Math.abs(after - (before + 50)) < 0.005, `${e.ok || e.err}; ${v.ok || v.err}; ${before} → ${after}`);
  });
  await step('B-7', 'first instalment Pay prefill', async () => {
    const h = await show(fin, 2); const rows = scheduleRows(h);
    const first = rows.findIndex(r => r.outstanding > 0); const pre = Number((rows[first]?.action?.match(/payInstallment\(([\d.]+)\)/) || [])[1]);
    const settle = num(ledgerVal(h, 'Settlement Today'));
    check('B-7', 'one Pay button on the first unpaid row; amount = min(row, settlement)', pre === Math.min(rows[first].outstanding, settle), `row ${first} ${rows[first]?.due} outstanding=${rows[first]?.outstanding} prefill=${pre} settle=${settle}`);
  });
  await step('B-8', 'PTP → fulfil → plan → cancel', async () => {
    const pt = await a1.act(`/cases/${id}/ptps`, { amount: '100', due_date: today() });
    const ptp = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id).id;
    const f = await a1.act(`/ptps/${ptp}/fulfill`, { amount: '100', payment_date: today(), method: 'cash' });
    const pl = await a1.act(`/cases/${id}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: today() });
    const plan = q1('SELECT plan_id FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', id).plan_id;
    const cp = await a1.act(`/cases/${id}/ptp-plans/${plan}/cancel`);
    check('B-8', 'PTP created / PTP payment recorded / plan created / plan cancelled', pt.ok === 'PTP created' && f.ok === 'PTP payment recorded' && pl.ok === 'Installment plan created' && cp.ok === 'Installment plan cancelled', `${pt.ok || pt.err} / ${f.ok || f.err} / ${pl.ok || pl.err} / ${cp.ok || cp.err}`);
  });
  await step('B-9', 'restructure → locked → undo', async () => {
    const id3 = await c.newCase(man, { debtor_id: String(deb), ...M() });
    await fin.act(`/cases/${id3}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const rs = await man.act(`/cases/${id3}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'smoke' });
    const lk = has(await show(fin, id3), 'Locked · restructured') && has((await man.get(`/cases/${id3}/edit`)).text, 'Loan terms are locked');
    const un = await man.act(`/cases/${id3}/restructures/${q1('SELECT id FROM case_restructures WHERE case_id=?', id3).id}/undo`);
    check('B-9', 'Restructured; locked; Restructure undone; balance back to 10,696.06', rs.ok === 'Restructured' && lk && un.ok === 'Restructure undone' && ledgerAmt(un.html) === '10,696.06', `${rs.ok || rs.err}; locked=${lk}; ${un.ok || un.err}; contract=${ledgerAmt(un.html)}`);
  });
  await step('B-10', 'call + note + status; timeline', async () => {
    const cl = await a1.act(`/cases/${id}/calls`, { result: 'answered', duration_seconds: '5' });
    const nt = await a1.act(`/cases/${id}/notes`, { content: 'smoke note' });
    const st = await a1.act(`/cases/${id}/status`, { status: 'negotiation' });
    const tl = qa('SELECT event_type FROM timeline_events WHERE case_id=? ORDER BY created_at DESC, id DESC LIMIT 3', id).map(x => x.event_type).join();
    check('B-10', 'Call logged / Note added / Status updated; timeline newest first', cl.ok === 'Call logged' && nt.ok === 'Note added' && st.ok === 'Status updated' && tl === 'status_change,note,call', `${cl.ok} / ${nt.ok} / ${st.ok}; ${tl}`);
  });
  await step('B-11', 'task create + complete', async () => {
    const tc = await a1.act('/tasks/new', { case_id: String(id), type: 'follow_up', title: 'smoke task', due_date: today() });
    const td = await a1.act(`/tasks/${q1("SELECT id FROM tasks WHERE title='smoke task'").id}/complete`);
    check('B-11', 'Task created / Task completed', tc.ok === 'Task created' && td.ok === 'Task completed', `${tc.ok || tc.err} / ${td.ok || td.err}`);
  });
  await step('B-12', 'reports + 3 CSV', async () => {
    const rp = await admin.get('/reports'); const csv = await Promise.all(['cases', 'outstanding', 'performance'].map(x => admin.get('/reports?export=' + x)));
    check('B-12', '200 + three attachments with rows', rp.status === 200 && csv.every(x => /attachment/.test(x.headers.get('content-disposition') || '') && x.text.split('\n').length > 2),
      `reports ${rp.status}; ` + csv.map(x => `${(x.headers.get('content-disposition') || '').replace(/.*filename=/, '')} ${x.text.split('\n').length - 1} lines`).join('; '));
  });
  await step('B-13', 'commission settle + void', async () => {
    const se = await fin.act('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: '10' });
    const sv = await fin.act(`/commissions/${q1('SELECT id FROM commission_settlements ORDER BY id DESC').id}/void`);
    check('B-13', 'Settlement recorded / Settlement voided', se.ok === 'Settlement recorded' && sv.ok === 'Settlement voided', `${se.ok || se.err} / ${sv.ok || sv.err}`);
  });
  await step('B-14', 'statement printable (HTTP part; PDF from the browser in smoke-v1.11.0.qa.py)', async () => {
    const r = await admin.get(`/cases/14/statement`); const t = strip(r.text);
    check('B-14', '200; print button; key figures', r.status === 200 && /window\.print\(\)/.test(r.text) && /Settlement Amount as of/.test(t) && /Overdue RM [\d,.]+/.test(t), `${r.status}; print=${/window\.print\(\)/.test(r.text)}; overdue line="${(t.match(/Overdue RM [\d,.]+( · \d+ days? past due)?/) || [''])[0]}"`);
  });
  await step('B-15', 'agent1 GET /cases/2 refused', async () => {
    const r = await a1.get('/cases/2'); check('B-15', '404/403, no data', [403, 404].includes(r.status) && !has(r.text, 'CASE-2026-D002'), `${r.status}`);
  });
  await step('B-16', 'auditor case page read-only', async () => {
    const h = await show(aud, 2); const posts = [`/cases/2/payments`, `/cases/2/status`, `/cases/2/notes`].map(u => aud.post(u, { amount: '1', status: 'legal', content: 'x', payment_date: today(), method: 'cash' }));
    const st = (await Promise.all(posts)).map(r => r.status);
    check('B-16', 'no action buttons/status select; writes 403', !has(h, "onclick=\"dlg('dlg-payment')\"") && !has(h, 'name="status"') && st.every(s => s === 403), `buttons=${has(h, "dlg('dlg-payment')")} select=${has(h, 'name="status"')} posts=${st}`);
  });
  await step('B-17', 'audit log has this run', async () => {
    const want = ['payment', 'payment_edit', 'payment_void', 'ptp_create', 'ptp_fulfilled', 'restructure', 'restructure_undo', 'call', 'note_add', 'status_change', 'task_create', 'task_complete', 'commission_settle', 'commission_void'];
    const miss = want.filter(a => !q1('SELECT 1 x FROM audit_logs WHERE action=?', a));
    const page = (await admin.get('/audit-log')).text;
    check('B-17', 'every action of B-3…B-13 logged and visible on /audit-log', miss.length === 0 && has(page, 'Voided payment') || has(page, 'void'), miss.length ? 'missing ' + miss.join(',') : `all ${want.length} actions logged`);
  });

  // ---- S: round-2 items BLOCKED by v1.11.0 rule changes, re-run with v1.11.0 inputs ----
  await step('S-CASE-04', 'case numbering / timeline / audit (Fixed 200 now needs a tenure)', async () => {
    const r = await admin.act('/cases', { debtor_id: String(deb), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200', loan_start_date: today(), tenure: '14', priority: 'medium', status: 'new' });  // 200/1000 over 14 months = 17.1% p.a. (6 months would be 40% > cap)
    const cid = Number(r.location.split('/').pop()); const row = q1('SELECT case_no FROM cases WHERE id=?', cid);
    const tl = q1('SELECT content FROM timeline_events WHERE case_id=? ORDER BY id LIMIT 1', cid);
    const log = q1("SELECT 1 x FROM audit_logs WHERE action='create' AND entity_type='case' AND entity_id=?", cid);
    check('S-CASE-04', 'Case created; CASE-2026-NNNN; timeline; audit', r.ok === 'Case created' && /^CASE-2026-\d{4}$/.test(row?.case_no) && tl?.content === `Case ${row.case_no} created` && !!log, `${r.ok || r.err}; ${row?.case_no}; "${tl?.content}"; audit=${!!log}`);
    const cs = q1('SELECT * FROM cases WHERE id=?', cid);
    const e = await admin.act(`/cases/${cid}`, editForm(cs, { agent_id: '2', priority: 'high', remark: 'S-CASE-08 remark' }));
    const elog = q1("SELECT details FROM audit_logs WHERE action='update' AND entity_type='case' AND entity_id=? ORDER BY id DESC", cid);
    check('S-CASE-08', 'edit agent/priority/remark → Saved; audit old→new', e.ok === 'Saved' && /agent_id: 1 → 2/.test(elog?.details || ''), `${e.ok || e.err}; audit="${elog?.details}"`);
  });
  await step('S-INT-03', 'Fixed 1000 + 200 → 1,200.00 (with tenure)', async () => {
    const cid = await c.newCase(admin, { debtor_id: String(deb), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200', loan_start_date: today(), tenure: '14' });
    check('S-INT-03', 'contract 1,200.00', ledgerAmt(await show(admin, cid)) === '1,200.00', ledgerAmt(await show(admin, cid)));
  });
  await step('S-INT-07', 'start today → interest 0.00; start yesterday → 1/31 of a month', async () => {
    const t = await c.newCase(admin, { debtor_id: String(deb), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: today(), tenure: '12' });
    const y = await c.newCase(admin, { debtor_id: String(deb), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: addDays(today(), -1), tenure: '12' });
    const it = num(ledgerVal(await show(admin, t), 'Interest')); const sy = num(ledgerVal(await show(admin, y), 'Settlement Today'));
    const dim = new Date(Date.UTC(+addDays(today(), -1).slice(0, 4), +addDays(today(), -1).slice(5, 7), 0)).getUTCDate();
    const want = Math.round(10000 * 0.015 / dim * 100) / 100;
    check('S-INT-07', `today: settlement 10,000.00; yesterday: 10,000 + ${want}`, num(ledgerVal(await show(admin, t), 'Settlement Today')) === 10000 && Math.abs(sy - 10000 - want) < 0.011, `today settle=${ledgerVal(await show(admin, t), 'Settlement Today')} (contract interest ${it}); yesterday settle=${sy} (want +${want}, ${dim}-day month)`);
  });
  await step('S-INT-09', 'no start date → defaults to opened', async () => {
    const r = await admin.act('/cases', { debtor_id: String(deb), principal_amount: '5000', interest_mode: 'monthly', interest_rate: '1', tenure: '12', priority: 'medium', status: 'new' });
    const cid = Number((r.location.match(/\/cases\/(\d+)$/) || [])[1]); const row = cid ? q1('SELECT loan_start_date, opened_at FROM cases WHERE id=?', cid) : null;
    const h = cid ? await show(admin, cid) : '';
    check('S-INT-09', 'created; Loan Start Date shows the opened date "(unset, defaults to opened)"', !!cid && has(h, 'defaults to opened'), `${r.ok || r.err}; ${JSON.stringify(row)}`);
  });
  await step('S-INT-12', 'cap 24 refused (v1.11.0: max 18, lower only); 12 → existing 18% loans listed; back to 18', async () => {
    const r24 = await admin.act('/settings', { company_name: q1('SELECT company_name n FROM settings WHERE id=1').n || 'X', max_annual_rate: '24' });
    const r12 = await admin.act('/settings', { company_name: q1('SELECT company_name n FROM settings WHERE id=1').n || 'X', max_annual_rate: '12' });
    const box = (strip(r12.html).match(/Open loans above the 12% p\.a\. cap:[^—]*/) || [''])[0];
    const nw = await admin.act('/cases', { debtor_id: String(deb), ...M({ interest_rate: '1.1' }) });
    const r18 = await admin.act('/settings', { company_name: q1('SELECT company_name n FROM settings WHERE id=1').n || 'X', max_annual_rate: '18' });
    check('S-INT-12', '24 → error; 12 → saved + list; new 13.2% loan refused under 12; back to 18 → saved', /at most 18%/.test(r24.err || '') && r12.ok === 'Company settings saved' && box && /exceeds the 12% p\.a\. limit/.test(nw.err || '') && r18.ok === 'Company settings saved',
      `24 → ${r24.err}; 12 → ${r12.ok}; "${box.trim()}"; 1.1%/月 → ${nw.err || nw.ok}; 18 → ${r18.ok}`);
  });
  await step('S-INT-14', 'over-cap legacy loan: edit agent only → Saved; term change → cap error', async () => {
    // (a) a loan created through the form at 18%, then the cap lowered to 12
    const nid = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M() });
    await admin.act('/settings', { company_name: 'X', max_annual_rate: '12' });
    const ncs = q1('SELECT * FROM cases WHERE id=?', nid);
    const ra = await admin.act(`/cases/${nid}`, editForm(ncs, { agent_id: '2' }));
    const ra2 = await admin.act(`/cases/${nid}`, editForm(ncs, { agent_id: '2', tenure: '13' }));
    // (b) demo case 2 (seeded 1.5%/月), listed in the red box once the cap is 12 — the real edit form posts its stored interest_amount
    const cs = q1('SELECT * FROM cases WHERE id=2');
    const rb = await admin.act('/cases/2', editForm(cs, { agent_id: '1' }));
    await admin.act('/settings', { company_name: 'X', max_annual_rate: '18' });
    rec('S-INT-14a', 'new 18% case under cap 12: agent change Saved; term change refused', `${ra.ok || ra.err} / ${ra2.err || ra2.ok}`, ra.ok === 'Saved' && /exceeds the 12% p\.a\. limit/.test(ra2.err || '') ? 'PASS' : 'FAIL');
    rec('S-INT-14b', 'demo case 2 under cap 12: agent change Saved', `${rb.ok || rb.err} (stored interest_amount=${cs.interest_amount} on a ${cs.interest_mode} loan; the server treats it as 0 → "terms changed")`, rb.ok === 'Saved' ? 'PASS' : 'FAIL');
  });
  await step('S-PAY-12', 'receipt numbers +1 (two different payments)', async () => {
    const r1 = await admin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash', reference: 'S12-a' });
    const r2 = await admin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash', reference: 'S12-b' });
    const n1 = +(r1.ok || '').match(/RCPT-2026-(\d{4})/)?.[1], n2 = +(r2.ok || '').match(/RCPT-2026-(\d{4})/)?.[1];
    const r3 = await admin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash', reference: 'S12-b' });
    const n3 = +(r3.ok || '').match(/RCPT-2026-(\d{4})/)?.[1];
    const rows = q1("SELECT COUNT(*) n FROM payments WHERE case_id=16 AND reference='S12-b'").n;
    check('S-PAY-12', 'consecutive; an identical resubmit within 10 s returns the same receipt (G-21)', n2 === n1 + 1 && n3 === n2 && rows === 1, `${n1} → ${n2}; identical resubmit → ${n3}, rows with S12-b=${rows}`);
  });
  await step('S-SCH-06', 'Paid / Overdue / Partially Paid / Pending (distinct references)', async () => {
    const start = addDays(today(), -60).slice(0, 8) + '01';
    const cid = await c.newCase(admin, { debtor_id: String(deb), principal_amount: '600', interest_mode: 'fixed', interest_amount: '0', loan_start_date: start, tenure: '6' });
    await admin.act(`/cases/${cid}/payments`, { payment_date: today(), amount: '150', method: 'cash', reference: 's1' });
    const r1 = scheduleRows(await show(admin, cid));
    await admin.act(`/cases/${cid}/payments`, { payment_date: today(), amount: '50', method: 'cash', reference: 's2' });
    await admin.act(`/cases/${cid}/payments`, { payment_date: today(), amount: '50', method: 'cash', reference: 's3' });
    const r2 = scheduleRows(await show(admin, cid)); const i = r2.findIndex(r => r.due >= today());
    check('S-SCH-06', 'statuses', r1[0].status === 'Paid' && r1[1].status === 'Overdue' && r2[i].status === 'Partially Paid' && r2[i + 1].status === 'Pending', `after150=${r1.map(r => r.status).join(',')} | after250=${r2.map(r => r.status).join(',')}`);
  });
  await step('S-TASK-11', 'reassign moves open tasks only (full edit form)', async () => {
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'S11 open', due_date: addDays(today(), 2) });
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'S11 done', due_date: addDays(today(), 2) });
    await man.act(`/tasks/${q1("SELECT id FROM tasks WHERE title='S11 done'").id}/complete`);
    const r = await man.act('/cases/19', editForm(q1('SELECT * FROM cases WHERE id=19'), { agent_id: '1' }));
    const t = qa('SELECT title, agent_id FROM tasks WHERE case_id=19 AND title LIKE ? ORDER BY id', 'S11%');
    const log = q1("SELECT details FROM audit_logs WHERE action='update' AND entity_type='case' AND entity_id=19 ORDER BY id DESC");
    check('S-TASK-11', 'open → agent 1; done stays 3; audit "N open task(s) reassigned"', r.ok === 'Saved' && t[0].agent_id === 1 && t[1].agent_id === 3 && /open task\(s\) reassigned/.test(log?.details || ''), `${r.ok || r.err}; ${JSON.stringify(t)}; "${log?.details}"`);
  });
  await step('S-DEB-01', 'search by the new (invalid-range) demo IC', async () => {
    const ic = q1("SELECT ic_passport FROM debtors WHERE name='Ravi Chandran'").ic_passport;
    const byIc = [...(await admin.get('/debtors?q=' + encodeURIComponent(ic.slice(0, 6)))).text.matchAll(/<tr><td><a href="\/debtors\/\d+">([^<]+)<\/a>/g)].map(m => m[1]);
    const srch = [...(await admin.get('/search?q=' + encodeURIComponent(ic.slice(0, 9)))).text.matchAll(/href="\/cases\/(\d+)"/g)].map(m => +m[1]);
    const mm = ic.slice(2, 4);
    check('S-DEB-01', 'debtor list + global search find Ravi by IC; IC month 00', byIc.includes('Ravi Chandran') && srch.length > 0 && mm === '00', `IC=${ic}; /debtors?q=${ic.slice(0, 6)} → ${byIc}; /search?q=${ic.slice(0, 9)} → cases ${srch}`);
  });
  await step('S-SET-06', 'statement case 14 (v1.11.0: up to date after restructure)', async () => {
    const st = strip((await admin.get('/cases/14/statement')).text);
    const want = ['CASE-2026-D014', 'IC/Passport', 'Principal RM', 'Interest RM', 'Paid RM', `Settlement Amount as of ${today()} RM`, 'Overdue RM 0.00', 'Loan Start Date', 'Interest Terms', 'Tenure 12 months', 'Maturity Date', 'Restructured From', 'Payment History'];
    const miss = want.filter(w => !st.includes(w));
    check('S-SET-06', 'all present', miss.length === 0, miss.length ? 'missing: ' + miss.join(' | ') : `all ${want.length} present; contract line="${(st.match(/Outstanding[^R]*RM [\d,.]+/) || [''])[0]}"`);
  });
  await step('S-E2E-04', 'onboarding / offboarding (full edit form)', async () => {
    await admin.act('/agents', { name: 'QA 新人', commission_rate: '5' });
    const ag = q1("SELECT id FROM agents WHERE name='QA 新人'").id;
    await admin.act('/users', { username: 'qa_newbie', full_name: 'QA 新人', password: 'Newbie123', role: 'agent', agent_id: String(ag) });
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'E2E-04 open', due_date: addDays(today(), 2) });
    const r = await man.act('/cases/19', editForm(q1('SELECT * FROM cases WHERE id=19'), { agent_id: String(ag) }));
    const s2 = qa("SELECT agent_id FROM tasks WHERE case_id=19 AND status='pending'").every(t => t.agent_id === ag);
    const nb = await c.as('qa_newbie', 'Newbie123');
    const cases = [...(await nb.get('/cases')).text.matchAll(/<a class="mono" href="\/cases\/(\d+)">/g)].map(m => +m[1]);
    const s3 = cases.join() === '19' && has((await nb.get('/tasks')).text, 'E2E-04 open') && (await nb.get('/cases/2')).status === 404;
    await admin.act(`/users/${q1("SELECT id FROM users WHERE username='qa_newbie'").id}/toggle`);
    const s4 = (await nb.get('/')).status === 302;
    check('S-E2E-04', 'reassign moves pending tasks; newbie sees only case 19; disable → logged out', r.ok === 'Saved' && s2 && s3 && s4, `${r.ok || r.err}; tasks moved=${s2}; newbie cases=${cases}; scope ok=${s3}; disabled→logout=${s4}`);
  });
  await step('S-AUTH-05', '5 wrong passwords → 6th refused (429), per IP (source 127.0.0.2; the container has no IPv6 loopback)', async () => {
    const http = require('node:http');
    const post = (body, localAddress) => new Promise((resolve, reject) => {
      const data = new URLSearchParams(body).toString();
      const rq = http.request({ host: '127.0.0.1', port: 3301, path: '/login', method: 'POST', localAddress, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, text: t }));
      });
      rq.on('error', reject); rq.end(data);
    });
    const fails = [];
    for (let i = 0; i < 5; i++) fails.push((await post({ username: 'agent3', password: 'wrong-' + i }, '127.0.0.2')).status);
    const sixth = await post({ username: 'agent3', password: 'agent123' }, '127.0.0.2');
    const other = await post({ username: 'agent3', password: 'agent123' }, '127.0.0.1');
    check('S-AUTH-05', '401 × 5; 6th 429 "Too many attempts. Try again later."; other IP unaffected', fails.every(x => x === 401) && sixth.status === 429 && has(sixth.text, 'Too many attempts') && other.status === 302, `fails=${fails} sixth=${sixth.status}; from 127.0.0.1=${other.status}`);
  });

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'smoke-B-local.json'), JSON.stringify(c.results, null, 1));
  const tally = c.results.reduce((m, r) => ((m[r.result] = (m[r.result] || 0) + 1), m), {});
  for (const r of c.results) console.log(`${r.result} ${r.id}: ${r.actual.slice(0, 260)}`);
  console.log('B+S', JSON.stringify(tally));
})();
