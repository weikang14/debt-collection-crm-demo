// Manual v1.1 §8 smoke (local column), §6 E2E-01…06, §7.1 SEC-01…09 — HTTP level.
// AUTH-05 / SEC-07 run last against http://[::1]:3301 (a separate client IP), so
// the 15-minute lock never blocks the 127.0.0.1 sessions used everywhere else.
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const c = require('./_client');
const { reseed, step, finish, assert } = require('./_run');
const { check, rec, has, strip, today, addDays, q1, qa, ledgerAmt, ledgerVal, num, scheduleRows } = c;

const show = async (s, id) => (await s.get(`/cases/${id}`)).text;
const M = (extra = {}) => ({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', ...extra });
const dashNums = (h) => { const t = strip(h); const g = (re) => Number(((t.match(re) || [])[1] || 'NaN').replace(/,/g, '')); return { due: g(/PTP (\d+) due/), closed: g(/opened · (\d+) closed/), legal: g(/active · (\d+) legal/), active: g(/Cases (\d+) active/) }; };

test('r2 E: smoke / E2E / SEC', { timeout: 400000 }, async () => {
  reseed();
  const admin = await c.as('admin');
  const man = await c.as('manager');
  const fin = await c.as('finance');
  const aud = await c.as('auditor');
  const a1 = await c.as('agent1');

  // ---------------- §8 smoke, local column ----------------
  await step('SMOKE', '19 items', async () => {
    const s = [];
    // 1 five accounts + menu (menu matrix itself: NAV-01)
    let ok1 = true; for (const u of ['admin', 'manager', 'agent1', 'finance', 'auditor']) { try { await c.as(u); } catch { ok1 = false; } }
    s.push(['S01', ok1]);
    const dh = await admin.get('/'); s.push(['S02', dh.status === 200 && /Collected Today/.test(dh.text)]);
    const deb = await c.newDebtor(man, 'QA Smoke');
    const id = await c.newCase(man, { debtor_id: String(deb), agent_id: '1', ...M() });
    const rows = scheduleRows(await show(man, id)); s.push(['S03', rows.length === 12 && rows[0].expected === 150 && rows[11].expected === 10150]);
    const p = await fin.act(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    s.push(['S04', /recorded/.test(p.ok || '') && ledgerAmt(p.html) === '10,696.06' && q1('SELECT status FROM cases WHERE id=?', id).status === 'partial_paid']);
    const id2 = await c.newCase(man, { debtor_id: String(deb), ...M() });
    const o = await fin.act(`/cases/${id2}/payments`, { payment_date: '2026-03-02', amount: '11800', method: 'cash' });
    const o2 = await fin.act(`/cases/${id2}/payments`, { payment_date: '2026-03-02', amount: '10304.84', method: 'cash' });
    s.push(['S05', /at most RM 10304\.84/.test(o.err || '') && q1('SELECT status FROM cases WHERE id=?', id2).status === 'fully_paid' && /recorded/.test(o2.ok || '')]);
    s.push(['S06', /exceeds the 18% p\.a\. limit/.test((await man.act('/cases', { debtor_id: String(deb), ...M({ interest_rate: '1.6' }) })).err || '')]);
    await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '50', method: 'cash' });
    const pay = q1('SELECT id FROM payments WHERE case_id=? AND payment_date=?', id, today()).id;
    const before = q1('SELECT outstanding_amount o FROM cases WHERE id=?', id).o;
    const e = await fin.act(`/cases/${id}/payments/${pay}`, { amount: '60', payment_date: today(), method: 'cash' });
    const v = await fin.act(`/cases/${id}/payments/${pay}/void`);
    s.push(['S07', e.ok === 'Payment updated' && v.ok === 'Payment voided' && Math.abs(q1('SELECT outstanding_amount o FROM cases WHERE id=?', id).o - (before + 50)) < 0.005]);
    s.push(['S08', /payInstallment\([\d.]+\)/.test(await show(fin, 2))]);
    const pt = await a1.act(`/cases/${id}/ptps`, { amount: '100', due_date: today() });
    const ptp = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id).id;
    const f = await a1.act(`/ptps/${ptp}/fulfill`, { amount: '100', payment_date: today(), method: 'cash' });
    const pl = await a1.act(`/cases/${id}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: today() });
    const plan = q1('SELECT plan_id FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', id).plan_id;
    const cp = await a1.act(`/cases/${id}/ptp-plans/${plan}/cancel`);
    s.push(['S09', pt.ok === 'PTP created' && f.ok === 'PTP payment recorded' && pl.ok === 'Installment plan created' && cp.ok === 'Installment plan cancelled']);
    const id3 = await c.newCase(man, { debtor_id: String(deb), ...M() });
    await fin.act(`/cases/${id3}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const rs = await man.act(`/cases/${id3}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'smoke' });
    const lk = has(await show(fin, id3), 'Locked · restructured');
    const un = await man.act(`/cases/${id3}/restructures/${q1('SELECT id FROM case_restructures WHERE case_id=?', id3).id}/undo`);
    s.push(['S10', rs.ok === 'Restructured' && lk && un.ok === 'Restructure undone']);
    const cl = await a1.act(`/cases/${id}/calls`, { result: 'answered', duration_seconds: '5' });
    const nt = await a1.act(`/cases/${id}/notes`, { content: 'smoke note' });
    const st = await a1.act(`/cases/${id}/status`, { status: 'assigned' }); // a real change: the plan cancel already set negotiation (O-6)
    const tl = qa('SELECT event_type FROM timeline_events WHERE case_id=? ORDER BY created_at DESC, id DESC LIMIT 3', id).map(x => x.event_type).join();
    s.push(['S11', cl.ok === 'Call logged' && nt.ok === 'Note added' && st.ok === 'Status updated' && tl === 'status_change,note,call']);
    const tc = await a1.act('/tasks/new', { case_id: String(id), type: 'follow_up', title: 'smoke task', due_date: today() });
    const tdone = await a1.act(`/tasks/${q1("SELECT id FROM tasks WHERE title='smoke task'").id}/complete`);
    s.push(['S12', tc.ok === 'Task created' && tdone.ok === 'Task completed']);
    const rp = await admin.get('/reports'); const csv = await Promise.all(['cases', 'outstanding', 'performance'].map(x => admin.get('/reports?export=' + x)));
    s.push(['S13', rp.status === 200 && csv.every(x => /attachment/.test(x.headers.get('content-disposition') || ''))]);
    const se = await fin.act('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: '10' });
    const sv = await fin.act(`/commissions/${q1('SELECT id FROM commission_settlements ORDER BY id DESC').id}/void`);
    s.push(['S14', se.ok === 'Settlement recorded' && sv.ok === 'Settlement voided']);
    s.push(['S15', (await admin.get(`/cases/${id}/statement`)).status === 200]);
    s.push(['S16', (await a1.get('/cases/2')).status === 404]);
    s.push(['S17', !has(await show(aud, 2), "onclick=\"dlg('dlg-payment')\"") && !has(await show(aud, 2), 'name="status"')]);
    s.push(['S18', ['payment', 'payment_edit', 'payment_void', 'ptp_create', 'ptp_fulfilled', 'restructure', 'restructure_undo', 'call', 'note_add', 'status_change', 'task_create', 'task_complete', 'commission_settle', 'commission_void'].every(a => q1('SELECT 1 x FROM audit_logs WHERE action=?', a))]);
    s.push(['S19', 'see §6 npm test']);
    for (const [k, v] of s) rec(`SMOKE-${k.slice(1)}`, 'smoke item', String(v), v === true ? 'PASS' : v === false ? 'FAIL' : '见 npm test');
  });

  // ---------------- E2E-01 ----------------
  await step('E2E-01', 'new case lifecycle', async () => {
    reseed();
    const notes = [];
    const deb = await c.newDebtor(man, 'QA 张三');
    const lastNo = q1("SELECT MAX(case_no) m FROM cases WHERE case_no NOT LIKE '%-D%'").m;
    const id = await c.newCase(man, { debtor_id: String(deb), agent_id: '1', ...M({ loan_start_date: today() }) });
    const row = q1('SELECT * FROM cases WHERE id=?', id);
    const s1 = row.status === 'new' && row.case_no === 'CASE-2026-0001' && scheduleRows(await show(man, id)).length === 12;
    notes.push(`1:${row.case_no} prev=${lastNo} ${row.status}`);
    await man.act(`/cases/${id}/status`, { status: 'assigned' });
    const a1d = await a1.get('/'), a1c = await a1.get('/cases');
    const s2 = has(a1c.text, `href="/cases/${id}"`) && has(a1d.text, row.case_no);
    const d0 = dashNums(a1d.text);
    await a1.act(`/cases/${id}/calls`, { result: 'answered', duration_seconds: '45', notes: 'E2E call' });
    const pr = await a1.act(`/cases/${id}/ptps`, { amount: '500', due_date: today(), remark: 'E2E' });
    const d1 = dashNums((await a1.get('/')).text);
    const s3 = pr.ok === 'PTP created' && q1('SELECT status FROM cases WHERE id=?', id).status === 'ptp' && d1.due === d0.due + 1;
    notes.push(`3:due ${d0.due}→${d1.due}`);
    const p = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id).id;
    const fr = await a1.act(`/ptps/${p}/fulfill`, { amount: '500', payment_date: today(), method: 'cash' });
    const rc = q1('SELECT receipt_no FROM payments WHERE case_id=?', id).receipt_no;
    const s4 = fr.ok === 'PTP payment recorded' && /^RCPT-2026-\d{4}$/.test(rc) && q1('SELECT status FROM cases WHERE id=?', id).status === 'partial_paid' && ledgerAmt(fr.html) === '11,210.00' /* 9,500 left × 1.5% × 12 = 1,710 */;
    notes.push(`4:${rc} ${ledgerAmt(fr.html)} ${q1('SELECT status FROM cases WHERE id=?', id).status}`);
    const fh = await show(fin, id);
    const pre = Number((fh.match(/payInstallment\(([\d.]+)\)/) || [])[1]);
    const closed0 = dashNums((await admin.get('/')).text).closed;
    const pp = await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: String(pre), method: 'bank_transfer' });
    const h2 = await show(fin, id);
    const settle = num(ledgerVal(h2, 'Settlement Today'));
    const maxAttr = (h2.match(/max="([\d.]+)" name="amount" id="pay-amount"/) || [])[1];
    const full = await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: maxAttr, method: 'bank_transfer' });
    const r5 = q1('SELECT status, outstanding_amount o FROM cases WHERE id=?', id);
    const closed1 = dashNums((await admin.get('/')).text).closed;
    const paidTotal = q1('SELECT SUM(amount) s FROM payments WHERE case_id=?', id).s;
    const s5 = /recorded/.test(pp.ok || '') && pre === 100 && settle === 9400 && /recorded/.test(full.ok || '') && r5.status === 'fully_paid' && scheduleRows(full.html).every(x => x.status === 'Paid') && closed1 === closed0 + 1 && paidTotal === 10000;
    notes.push(`5:prefill=${pre} settle=${settle} paid=${paidTotal} (interest 0 — start today) closed ${closed0}→${closed1} ${r5.status}`);
    const sc0 = q1("SELECT COUNT(*) n FROM timeline_events WHERE case_id=? AND event_type='status_change'", id).n;
    const sa0 = q1("SELECT COUNT(*) n FROM audit_logs WHERE action='status_change' AND entity_id=?", id).n;
    await man.act(`/cases/${id}/status`, { status: 'closed' });
    const s6 = q1("SELECT COUNT(*) n FROM timeline_events WHERE case_id=? AND event_type='status_change'", id).n === sc0 + 1 && q1("SELECT COUNT(*) n FROM audit_logs WHERE action='status_change' AND entity_id=?", id).n === sa0 + 1;
    const h = (await aud.get('/audit-log')).text;
    const seq = qa("SELECT action FROM audit_logs WHERE entity_type='case' AND entity_id=? ORDER BY id", id).map(x => x.action);
    const want = ['create', 'status_change', 'call', 'ptp_create', 'payment', 'ptp_fulfilled', 'payment', 'payment', 'status_change'];
    const s7 = seq.join() === want.join() && (await aud.get('/audit-log')).status === 200 && has(h, 'ptp_fulfilled');
    notes.push(`7:${seq.join(',')}`);
    const steps = [s1, s2, s3, s4, s5, s6, s7];
    check('E2E-01', 'all 7 checkpoints', steps.every(Boolean), `steps=${steps.map(x => (x ? 'Y' : 'N')).join('')}; ${notes.join(' | ')}`);
  });

  // ---------------- E2E-02 ----------------
  await step('E2E-02', 'plan default → legal', async () => {
    const id = 13; // agent1, assigned
    const r = await a1.act(`/cases/${id}/ptp-plans`, { total_amount: '1000', num_installments: '3', first_due_date: today() });
    const amts = qa('SELECT amount FROM ptps WHERE case_id=? AND plan_id IS NOT NULL ORDER BY installment_no', id).map(x => x.amount);
    const s1 = r.ok === 'Installment plan created' && amts.join() === '333.33,333.33,333.34' && q1('SELECT status FROM cases WHERE id=?', id).status === 'ptp';
    const p1 = q1('SELECT id, amount FROM ptps WHERE case_id=? AND installment_no=1', id);
    const f = await a1.act(`/ptps/${p1.id}/fulfill`, { amount: String(p1.amount), payment_date: today(), method: 'cash' });
    const s2 = /1\/3 kept/.test(strip(f.html)) && q1('SELECT status FROM cases WHERE id=?', id).status === 'ptp';
    const plan = q1('SELECT plan_id FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', id).plan_id;
    await a1.act(`/cases/${id}/ptp-plans/${plan}/cancel`);
    const s3 = qa('SELECT status FROM ptps WHERE case_id=? AND plan_id IS NOT NULL ORDER BY installment_no', id).map(x => x.status).join() === 'fulfilled,broken,broken' && q1('SELECT status FROM cases WHERE id=?', id).status === 'negotiation';
    const l0 = dashNums((await man.get('/')).text).legal;
    const t = await a1.act('/tasks/new', { case_id: String(id), type: 'legal', title: 'E2E-02 LOD', due_date: addDays(today(), 7) });
    const agentLegal = await a1.act(`/cases/${id}/status`, { status: 'legal' });
    await man.act(`/cases/${id}/status`, { status: 'legal' });
    const l1 = dashNums((await man.get('/')).text).legal;
    await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '10', method: 'cash' });
    const s4 = t.ok === 'Task created' && agentLegal.err === 'Only a manager can set Legal' && l1 === l0 + 1 && q1('SELECT status FROM cases WHERE id=?', id).status === 'legal';
    check('E2E-02', '4 checkpoints', s1 && s2 && s3 && s4, `${[s1, s2, s3, s4].map(x => (x ? 'Y' : 'N')).join('')}; legal ${l0}→${l1}; agent set legal → ${agentLegal.err}`, '手册第 2 步写“1/3 paid”，页面实际为“1/3 kept”（手册文字）；第 4 步“改为 Legal”须由 manager 执行（D-12）');
  });

  // ---------------- E2E-03 ----------------
  await step('E2E-03', 'restructure + undo', async () => {
    const deb = await c.newDebtor(man, 'QA E2E-03');
    const id = await c.newCase(man, { debtor_id: String(deb), agent_id: '1', ...M() });
    await man.act(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const s1 = ledgerAmt(await show(man, id)) === '10,696.06';
    const r = await man.act(`/cases/${id}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'E2E-03' });
    const fh = await show(fin, id);
    const s2 = r.ok === 'Restructured' && ledgerAmt(r.html) === '11,449.75' && scheduleRows(r.html)[0].expected === 135.07 && has((await man.get(`/cases/${id}/edit`)).text, 'Loan terms are locked') && has(fh, 'Locked · restructured');
    const e1 = await fin.act(`/cases/${id}/payments`, { payment_date: '2026-04-01', amount: '10', method: 'cash' });
    const ok = await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '200', method: 'cash' });
    const s3 = /must be after the restructure date/.test(e1.err || '') && /recorded/.test(ok.ok || '');
    const rid = q1('SELECT id FROM case_restructures WHERE case_id=?', id).id;
    const mh = await show(man, id);
    const ue = await man.act(`/cases/${id}/restructures/${rid}/undo`);
    const s4 = !has(mh, '/undo"') && ue.err === 'Payments exist after the effective date; void them first';
    const pid = q1('SELECT id FROM payments WHERE case_id=? AND payment_date=?', id, today()).id;
    await fin.act(`/cases/${id}/payments/${pid}/void`);
    const u = await man.act(`/cases/${id}/restructures/${rid}/undo`);
    // v1.12.0 (F-24): after the undo the terms stay locked — by the 1,000 payment, not the restructure.
    const eh = (await man.get(`/cases/${id}/edit`)).text;
    const s5 = u.ok === 'Restructure undone' && ledgerAmt(u.html) === '10,696.06' && !has(eh, 'locked after a restructure') && has(eh, 'locked once a payment is recorded') && q1("SELECT COUNT(*) n FROM timeline_events WHERE case_id=? AND event_type='restructure'", id).n === 2;
    check('E2E-03', '5 checkpoints', s1 && s2 && s3 && s4 && s5, [s1, s2, s3, s4, s5].map(x => (x ? 'Y' : 'N')).join('') + ` ${ledgerAmt(r.html)} / ${ledgerAmt(u.html)}`);
  });

  // ---------------- E2E-04 ----------------
  await step('E2E-04', 'onboarding / offboarding', async () => {
    await admin.act('/agents', { name: 'QA 新人', commission_rate: '5' });
    const ag = q1("SELECT id FROM agents WHERE name='QA 新人'").id;
    const u = await admin.act('/users', { username: 'qa_newbie', full_name: 'QA 新人', password: 'Newbie123', role: 'agent', agent_id: String(ag) });
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'E2E-04 open', due_date: addDays(today(), 2) });
    const cs = q1('SELECT * FROM cases WHERE id=19');
    await man.act('/cases/19', c.editForm(19, { agent_id: String(ag) })); // the full form (N-02)
    const s2 = qa("SELECT agent_id FROM tasks WHERE case_id=19 AND status='pending'").every(t => t.agent_id === ag);
    const nb = await c.as('qa_newbie', 'Newbie123');
    const cases = [...(await nb.get('/cases')).text.matchAll(/<a class="mono" href="\/cases\/(\d+)">/g)].map(m => +m[1]);
    const debs = [...new Set([...(await nb.get('/debtors')).text.matchAll(/href="\/debtors\/(\d+)"/g)].map(m => +m[1]))];
    const tasks = (await nb.get('/tasks')).text;
    const s3 = cases.join() === '19' && debs.join() === String(cs.debtor_id) && has(tasks, 'E2E-04 open') && (await nb.get('/cases/2')).status === 404;
    const uid = q1("SELECT id FROM users WHERE username='qa_newbie'").id;
    await admin.act(`/users/${uid}/toggle`);
    await nb.get('/logout');
    const l = await new c.Session().login('qa_newbie', 'Newbie123');
    const s4 = l.status === 401;
    await admin.act(`/agents/${ag}`, { name: 'QA 新人', commission_rate: '5', target_amount: '0', active: '0' });
    const s5 = !has((await man.get('/cases/new')).text, 'QA 新人');
    check('E2E-04', '5 checkpoints', u.ok === 'User qa_newbie created' && s2 && s3 && s4 && s5, [true, s2, s3, s4, s5].map(x => (x ? 'Y' : 'N')).join('') + ` cases=${cases} debtors=${debs}`);
  });

  // ---------------- E2E-05 ----------------
  await step('E2E-05', 'month-end commissions', async () => {
    const row = (h, n) => { const m = strip(h).match(new RegExp(n + ' ([\\d,.]+) ([\\d.]+) ([\\d,.]+) ([\\d,.]+) (-?[\\d,.]+)')); return m && { collected: num(m[1]), earned: num(m[3]), settled: num(m[4]), pending: num(m[5]) }; };
    const h0 = (await fin.get('/commissions')).text;
    const r0 = row(h0, 'Lim Wei Sheng');
    const s1 = Math.abs(r0.earned - r0.collected * 0.05) < 0.006 && Math.abs(r0.pending - (r0.earned - r0.settled)) < 0.006;
    const st = await fin.act('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: r0.pending.toFixed(2), note: 'E2E-05 full' });
    const s2 = st.ok === 'Settlement recorded' && row(st.html, 'Lim Wei Sheng').pending === 0;
    const sid = q1("SELECT id FROM commission_settlements WHERE note='E2E-05 full'").id;
    await fin.act(`/commissions/${sid}/void`);
    const part = await fin.act('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: '10.00', note: 'E2E-05 part' });
    const s3 = part.ok === 'Settlement recorded' && Math.abs(row(part.html, 'Lim Wei Sheng').pending - (r0.pending - 10)) < 0.006;
    const ah = (await a1.get('/commissions')).text;
    const s4 = !has(ah, 'Nurul Ain') && has(ah, 'Lim Wei Sheng') && !has(ah, 'Advance');
    const from = today().slice(0, 8) + '01';
    const csv = (await fin.get(`/reports?from=${from}&to=${today()}&export=performance`)).text.split('\r\n').slice(1).map(l => l.split(','));
    const ch = (await fin.get('/commissions')).text;
    const mism = csv.filter(r => { const x = row(ch, r[0]); return !x || Math.abs(x.earned - Number(r[3])) > 0.005; });
    const s5 = csv.length === q1('SELECT COUNT(*) n FROM agents').n && mism.length === 0;
    check('E2E-05', '5 checkpoints', s1 && s2 && s3 && s4 && s5, [s1, s2, s3, s4, s5].map(x => (x ? 'Y' : 'N')).join('') + ` Lim ${JSON.stringify(r0)}; csv mismatch=${mism.map(r => r[0])}`);
  });

  // ---------------- E2E-06 / SEC-09 ----------------
  await step('E2E-06', 'agent1 privilege sweep', async () => {
    const snap = () => JSON.stringify([qa('SELECT id, status, outstanding_amount FROM cases ORDER BY id'), qa('SELECT id, status FROM ptps ORDER BY id'), qa('SELECT id, status FROM tasks ORDER BY id'), qa('SELECT id, amount FROM payments ORDER BY id')]);
    const before = snap();
    const ptp = q1("SELECT id FROM ptps WHERE case_id=14 AND status='pending'").id;
    const task = q1("SELECT id FROM tasks WHERE case_id=2 AND status='pending'").id;
    const res = {
      case2: (await a1.get('/cases/2')).status, stmt: (await a1.get('/cases/2/statement')).status, edit: (await a1.get('/cases/2/edit')).status,
      debtor: (await a1.get('/debtors/2')).status, fulfill: (await a1.post(`/ptps/${ptp}/fulfill`, { amount: '1', payment_date: today() })).status,
      brk: (await a1.post(`/ptps/${ptp}/break`)).status, task: (await a1.act(`/tasks/${task}/complete`)).err,
      users: (await a1.get('/users')).status, settings: (await a1.get('/settings')).status, audit: (await a1.get('/audit-log')).status, agents: (await a1.get('/agents')).status,
      pay2: (await a1.post('/cases/2/payments', { payment_date: today(), amount: '1', method: 'cash' })).status, status2: (await a1.post('/cases/2/status', { status: 'negotiation' })).status,
    };
    const after = snap();
    const search = [...(await a1.get('/search?q=Sarah')).text.matchAll(/href="\/cases\/(\d+)"/g)].length;
    const rep = strip((await a1.get('/reports')).text);
    const com = (await a1.get('/commissions')).text;
    const ok = [res.case2, res.stmt].every(x => x === 404) && [res.edit, res.debtor, res.fulfill, res.brk, res.users, res.settings, res.audit, res.agents].every(x => x === 403) && res.task === 'Forbidden' && [res.pay2, res.status2].every(x => x === 404)
      && before === after && search === 0 && !/Nurul Ain/.test(rep) && !has(com, 'Nurul Ain');
    check('E2E-06', 'all refused, nothing changed, no agent2 data in search/reports/commissions', ok, JSON.stringify(res) + ` unchanged=${before === after} search=${search}`);
    rec('SEC-09', '= E2E-06', ok ? 'see E2E-06' : 'see E2E-06', ok ? 'PASS' : 'FAIL');
  });

  // ---------------- SEC ----------------
  await step('SEC-01', "' OR 1=1 -- everywhere", async () => {
    const inj = encodeURIComponent("' OR 1=1 --");
    const urls = [`/search?q=${inj}`, `/cases?q=${inj}`, `/cases?status=${inj}`, `/cases?priority=${inj}`, `/debtors?q=${inj}`, `/debtors?risk=${inj}`, `/tasks?status=${inj}`, `/tasks?type=${inj}`, `/agents?department=${inj}`, `/audit-log?action=${inj}`, `/reports?from=${inj}`, `/commissions?month=${inj}`];
    const out = [];
    for (const u of urls) { const r = await admin.get(u); out.push(`${u.split('?')[0]}:${r.status}:${(r.text.match(/href="\/(cases|debtors)\/\d+"/g) || []).length}`); }
    const a1s = (await a1.get(`/search?q=${inj}`)).text.match(/href="\/cases\/\d+"/g) || [];
    const allDeb = q1('SELECT COUNT(*) n FROM debtors').n;
    // An unknown risk value is ignored (whitelist), so /debtors?risk=… lists what admin already sees — not injected rows.
    check('SEC-01', 'all 200, no injected rows', out.every(o => /:200:0$/.test(o) || o === `/debtors:200:${allDeb}`) && out.filter(o => /^\/debtors:200:/.test(o) && !/:0$/.test(o)).length === 1 && a1s.length === 0, out.join(' ') + ` (debtors total=${allDeb}; agent1 search rows=${a1s.length})`);
  });
  await step('SEC-02', '<script>alert(1)</script> escaped everywhere', async () => {
    const X = '<script>alert(1)</script>';
    const d = await c.newDebtor(admin, X);
    const id = await c.newCase(admin, { debtor_id: String(d), agent_id: '1', principal_amount: '100', interest_mode: 'fixed', interest_amount: '0', remark: X });
    await admin.act(`/cases/${id}/notes`, { content: X });
    await admin.act('/tasks/new', { case_id: String(id), type: 'follow_up', title: X, due_date: today(), notes: X });
    await admin.act(`/cases/${id}/calls`, { result: 'answered', duration_seconds: '1', notes: X });
    await admin.act(`/cases/${id}/ptps`, { amount: '10', due_date: today(), remark: X });
    await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '1', method: 'cash', reference: X, bank: X, remark: X });
    await admin.act('/settings', { company_name: X, address: X, phone: X, email: X, reg_no: X, max_annual_rate: '18' });
    await admin.act('/agents', { name: X, department: X, contact: X });
    const pages = ['/', `/cases/${id}`, `/cases/${id}/statement`, '/cases', `/debtors/${d}`, '/debtors', '/tasks', '/search?q=script', '/audit-log', '/settings', '/agents', '/reports', '/commissions', `/agents/${q1('SELECT id FROM agents ORDER BY id DESC').id}`];
    const raw = [];
    for (const p of pages) if ((await admin.get(p)).text.includes(X)) raw.push(p);
    for (const p of ['/', `/cases/${id}`, '/tasks']) if ((await a1.get(p)).text.includes(X)) raw.push('agent1' + p);
    await admin.act('/settings', { company_name: '', max_annual_rate: '18' });
    check('SEC-02', 'no raw payload in any page', raw.length === 0, raw.length ? 'raw in: ' + raw.join(',') : `${pages.length + 3} pages escaped (browser alert check: ui.qa.py)`);
  });
  await step('SEC-03', "x');alert(1);// in Reference/Bank (HTTP part)", async () => {
    await fin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash', reference: "x');alert(1);//", bank: "x');alert(1);//" });
    const h = await show(fin, 16);
    check('SEC-03', 'only inside escaped data-* attributes', has(h, 'data-ref="x&#39;);alert(1);//"') && !/onclick="[^"]*alert\(1\)/.test(h), 'data-ref escaped', '浏览器弹窗验证见 ui.qa.py');
  });
  await step('SEC-04', 'bcrypt hashes', async () => {
    const hs = qa('SELECT username, password_hash h FROM users');
    check('SEC-04', '$2a$/$2b$ cost ≥10, no plaintext', hs.every(u => /^\$2[aby]\$(1[0-9]|[2-9]\d)\$/.test(u.h) && !/admin123|agent123|manager123|finance123|auditor123/.test(u.h)), hs.map(u => `${u.username}:${u.h.slice(0, 7)}`).join(' '));
  });
  await step('SEC-05', 'production without SESSION_SECRET refuses to start', async () => {
    const r = spawnSync(process.execPath, ['--no-warnings', 'src/app.js'], { cwd: c.ROOT, env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: '', CRM_DB_PATH: c.DB_PATH, PORT: '3399' }, timeout: 8000, encoding: 'utf8' });
    check('SEC-05', 'exits with "SESSION_SECRET must be set in production"', r.status !== 0 && /SESSION_SECRET must be set in production/.test(r.stderr), `exit=${r.status} stderr=${(r.stderr.match(/Error: [^\n]+/) || [''])[0]}`);
  });
  await step('SEC-06', 'cross-site POST → 403', async () => {
    const evil = await admin.post('/cases/1/notes', { content: 'csrf' }, { origin: 'http://evil.example' });
    const ref = await admin.post('/cases/1/notes', { content: 'csrf' }, { referer: 'http://evil.example/x' });
    const bad = await admin.post('/cases/1/notes', { content: 'csrf' }, { origin: 'null' });
    const same = await admin.post('/cases/1/notes', { content: 'same-origin ok' }, { origin: c.BASE });
    const login = await new c.Session().req('POST', '/login', { username: 'admin', password: 'admin123' }, { origin: 'http://evil.example' });
    check('SEC-06', '403 "Cross-site request blocked"; same-origin ok', evil.status === 403 && evil.text === 'Cross-site request blocked' && ref.status === 403 && bad.status === 403 && same.status === 302 && login.status === 403 && !q1("SELECT 1 x FROM timeline_events WHERE content='csrf'"),
      `origin=${evil.status} referer=${ref.status} null=${bad.status} same=${same.status} login=${login.status}`);
  });
  rec('SEC-08', '正式环境演示账号停用 / 移除 /demo-accounts 与 Demo Data', '本轮不访问 Render；本地 demo 构建仍开放 /demo-accounts 与 Demo Data（设计如此）', '未执行', '【已知延后】K-07；上线前必须');

  // ---------------- AUTH-05 / SEC-07 (last; [::1]) ----------------
  await step('AUTH-05', '5 fails → 6th correct refused (429)', async () => {
    const v6 = 'http://[::1]:3301';
    const s = new c.Session(v6);
    const fails = [];
    for (let i = 0; i < 5; i++) fails.push((await s.login('admin', 'bad' + i)).status);
    const sixth = await s.login('admin', 'admin123');
    const other = await new c.Session().login('admin', 'admin123'); // 127.0.0.1 unaffected
    check('AUTH-05', '6th: "Too many attempts. Try again later."; per IP', fails.every(x => x === 401) && sixth.status === 429 && has(sixth.text, 'Too many attempts. Try again later.') && other.status === 302, `fails=${fails} sixth=${sixth.status}; 127.0.0.1 login=${other.status}`, '“锁 15 分钟”未等待验证；“重启清零”见报告第 6 节');
    rec('SEC-07', '= AUTH-05', 'see AUTH-05', sixth.status === 429 ? 'PASS' : 'FAIL');
  });

  finish('e-smoke-e2e-sec');
  assert.ok(true);
});
