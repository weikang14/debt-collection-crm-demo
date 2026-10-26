// Manual v1.1 §4.5 CASE, §4.6 INT, §4.7 PAY, §4.8 SCH — HTTP level.
// Browser-only parts (CASE-06, INT-01/02, PAY-04 dialog block, PAY-14 dialog, SCH-07 prefill) → ui.qa.py.
const { test } = require('node:test');
const c = require('./_client');
const { reseed, step, finish, assert } = require('./_run');
const { check, rec, has, strip, today, addDays, q1, qa, ledgerAmt, ledgerVal, ledgerSmall, num, scheduleRows } = c;

const show = async (s, id) => (await s.get(`/cases/${id}`)).text;
const amt = (html) => num(ledgerAmt(html));
const M = (extra = {}) => ({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', ...extra });

test('r2 B: CASE / INT / PAY / SCH', { timeout: 300000 }, async () => {
  reseed();
  const admin = await c.as('admin');
  const fin = await c.as('finance');
  const a1 = await c.as('agent1');
  const aud = await c.as('auditor');
  const debA = await c.newDebtor(admin, 'QA 月息测试');
  const debB = await c.newDebtor(admin, 'QA Fixed 测试');

  // ---------------- CASE ----------------
  await step('CASE-01', 'filters + newest first', async () => {
    const nos = (h) => [...h.matchAll(/<a class="mono" href="\/cases\/(\d+)">/g)].map(m => Number(m[1]));
    const st = nos((await admin.get('/cases?status=legal')).text);
    const pr = nos((await admin.get('/cases?priority=urgent')).text);
    const q = nos((await admin.get('/cases?q=D014')).text);
    const qn = nos((await admin.get('/cases?q=' + encodeURIComponent('Sarah'))).text);
    const all = nos((await admin.get('/cases')).text);
    const dbOrder = qa('SELECT id FROM cases ORDER BY opened_at DESC').map(r => r.id);
    check('CASE-01', 'status/priority/search correct; opened desc', st.sort().join() === qa("SELECT id FROM cases WHERE status='legal'").map(r => r.id).sort().join()
      && pr.sort().join() === qa("SELECT id FROM cases WHERE priority='urgent'").map(r => r.id).sort().join() && q.join() === '14' && qn.sort().join() === '14,2' && all.join() === dbOrder.join(),
    `legal=${st} urgent=${pr} q=D014→${q} Sarah→${qn}`);
  });
  await step('CASE-02', 'CSV honours filter; columns', async () => {
    const r = await admin.get('/cases?format=csv&status=legal');
    const lines = r.text.replace(/^﻿/, '').split('\r\n');
    check('CASE-02', 'cases.csv, filtered, 9 columns', /cases\.csv/.test(r.headers.get('content-disposition')) && lines[0] === 'Case No,Debtor,Debtor Phone,Agent,Outstanding,Paid,Priority,Status,Opened' && lines.length - 1 === 2 && lines.slice(1).every(l => /,Legal,/.test(l)),
      `${r.headers.get('content-disposition')}; header=${lines[0]}; rows=${lines.length - 1}`);
  });
  await step('CASE-03', 'missing debtor/principal (server)', async () => {
    const r1 = await admin.act('/cases', { principal_amount: '100' });
    const r2 = await admin.act('/cases', { debtor_id: String(debA) });
    check('CASE-03', '"Debtor and principal are required"', r1.err === 'Debtor and principal are required' && r2.err === 'Debtor and principal are required', `${r1.err} / ${r2.err}`);
  });
  let cid4;
  await step('CASE-04', 'Case created; CASE-YYYY-0001 (+1); timeline; audit', async () => {
    const r = await admin.act('/cases', { debtor_id: String(debB), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200', priority: 'medium', status: 'new' });
    cid4 = Number(r.location.split('/').pop());
    const r2 = await admin.act('/cases', { debtor_id: String(debB), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
    const c1 = q1('SELECT case_no FROM cases WHERE id=?', cid4).case_no, c2 = q1('SELECT case_no FROM cases WHERE id=?', Number(r2.location.split('/').pop())).case_no;
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? ORDER BY id LIMIT 1", cid4);
    const log = q1("SELECT 1 x FROM audit_logs WHERE action='create' AND entity_type='case' AND entity_id=?", cid4);
    check('CASE-04', 'banner, numbering, timeline, audit', r.ok === 'Case created' && c1 === 'CASE-2026-0001' && c2 === 'CASE-2026-0002' && tl.content === `Case ${c1} created` && !!log, `${r.ok}; ${c1}, ${c2}; tl="${tl.content}"; audit=${!!log}`);
  });
  await step('CASE-05', 'defaults medium / New', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '300', priority: '', status: '' });
    const row = q1('SELECT priority, status FROM cases WHERE id=?', id);
    check('CASE-05', 'priority=medium, status=new', row.priority === 'medium' && row.status === 'new', JSON.stringify(row));
  });
  await step('CASE-07', 'maturity 2026-01-31 +1 → 2026-02-28; hidden without start/tenure', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-31', tenure: '1' });
    const id2 = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-31' });
    const v = ledgerVal(await show(admin, id), 'Maturity Date');
    const v2 = ledgerVal(await show(admin, id2), 'Maturity Date');
    check('CASE-07', '2026-02-28; none when tenure missing', v === '2026-02-28' && v2 === null, `with=${v} without=${v2}`);
  });
  await step('CASE-08', 'edit agent/priority/remark → Saved; audit old→new', async () => {
    const r = await admin.act(`/cases/${cid4}`, { debtor_id: String(debB), agent_id: '2', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200', priority: 'high', remark: 'CASE-08 remark' });
    const row = q1('SELECT agent_id, priority, remark FROM cases WHERE id=?', cid4);
    const log = q1("SELECT details FROM audit_logs WHERE action='update' AND entity_type='case' AND entity_id=? ORDER BY id DESC", cid4);
    check('CASE-08', 'Saved + detail + audit with old→new', r.ok === 'Saved' && row.agent_id === 2 && row.priority === 'high' && has(r.html, 'CASE-08 remark') && /agent_id: 1 → 2/.test(log.details), `${r.ok}; ${JSON.stringify(row)}; audit="${log.details}"`);
  });
  await step('CASE-09', 'agent/finance/auditor: no New/Edit; /cases/new 403', async () => {
    const out = [];
    for (const [u, s] of [['agent1', a1], ['finance', fin], ['auditor', aud]]) {
      const l = (await s.get('/cases')).text; const d = (await s.get('/cases/5')).text;
      out.push({ u, newBtn: has(l, '+ New Case'), edit: has(d, '/cases/5/edit"'), nw: (await s.get('/cases/new')).status, ed: (await s.get('/cases/5/edit')).status, post: (await s.post('/cases', { debtor_id: '1', principal_amount: '1' })).status, upd: (await s.post('/cases/5', { debtor_id: '1', principal_amount: '1' })).status });
    }
    check('CASE-09', 'no buttons; GET/POST 403', out.every(o => !o.newBtn && !o.edit && o.nw === 403 && o.ed === 403 && o.post === 403 && o.upd === 403), JSON.stringify(out));
  });
  let cM;
  await step('CASE-10', 'ledger: contract / settlement / overdue / recovered / P,I,Paid / maturity / opened N days', async () => {
    cM = await c.newCase(admin, { debtor_id: String(debA), agent_id: '1', ...M() });
    await admin.act(`/cases/${cM}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const h = await show(admin, cM);
    const t = strip(h);
    check('CASE-10', 'all ledger items present', /Total Outstanding \(contract, to maturity\)/.test(t) && ledgerVal(h, 'Settlement Today') && ledgerVal(h, 'Overdue') && /days past due|up to date/.test(ledgerSmall(h, 'Overdue') || '')
      && /\d+% recovered/.test(t) && ledgerVal(h, 'Principal') === '10,000.00' && ledgerVal(h, 'Interest') && ledgerVal(h, 'Paid') === '1,000.00' && ledgerVal(h, 'Maturity Date') === '2027-01-01' && /opened \d+ days? ago/.test(t),
    `outstanding=${ledgerAmt(h)} settle=${ledgerVal(h, 'Settlement Today')} overdue=${ledgerVal(h, 'Overdue')} (${ledgerSmall(h, 'Overdue')}) ${(t.match(/\d+% recovered/) || [])[0]} I=${ledgerVal(h, 'Interest')} mat=${ledgerVal(h, 'Maturity Date')}`);
  });
  await step('CASE-11', 'status → Legal: banner, timeline, audit', async () => {
    const r = await admin.act('/cases/13/status', { status: 'legal' });
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=13 AND event_type='status_change' ORDER BY id DESC");
    const log = q1("SELECT details FROM audit_logs WHERE action='status_change' AND entity_id=13 ORDER BY id DESC");
    check('CASE-11', 'Status updated; status_change event; audit', r.ok === 'Status updated' && tl.content === 'Status changed assigned → legal' && /assigned → legal/.test(log.details) && /badge is-blue">status_change/.test(r.html), `${r.ok}; "${tl.content}"`);
  });
  await step('CASE-12', 'Closed/Fully Paid/Cancelled record closed_at', async () => {
    await admin.act('/cases/19/status', { status: 'closed' });
    await admin.act('/cases/15/status', { status: 'cancelled' });
    const r = qa('SELECT id, closed_at FROM cases WHERE id IN (15,19)');
    check('CASE-12', 'closed_at set (fully_paid covered by PAY-03/CASE-22)', r.every(x => x.closed_at), JSON.stringify(r));
  });
  await step('CASE-13', 'note add/edit/delete; only note events editable', async () => {
    const r1 = await admin.act(`/cases/${cM}/notes`, { content: 'CASE-13 note' });
    const nid = q1("SELECT id FROM timeline_events WHERE case_id=? AND content='CASE-13 note'", cM).id;
    const r2 = await admin.act(`/cases/${cM}/notes/${nid}`, { content: 'CASE-13 edited' });
    const pay = q1("SELECT id FROM timeline_events WHERE case_id=? AND event_type='payment'", cM).id;
    const r4 = await admin.act(`/cases/${cM}/notes/${pay}`, { content: 'tamper payment event' });
    const r3 = await admin.act(`/cases/${cM}/notes/${nid}/delete`);
    check('CASE-13', 'Note added / updated / deleted; non-note → Note not found', r1.ok === 'Note added' && r2.ok === 'Note updated' && r3.ok === 'Note deleted' && r4.err === 'Note not found' && !q1('SELECT 1 x FROM timeline_events WHERE id=?', nid),
      `${r1.ok}/${r2.ok}/${r3.ok}; payment event edit → ${r4.err}`);
  });
  await step('CASE-14', 'Log Call answered 60s', async () => {
    const r = await admin.act(`/cases/${cM}/calls`, { result: 'answered', duration_seconds: '60', notes: 'CASE-14 notes' });
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='call' ORDER BY id DESC", cM);
    const call = q1('SELECT * FROM call_logs WHERE case_id=? ORDER BY id DESC', cM);
    check('CASE-14', 'Call logged; Calls row; timeline text', r.ok === 'Call logged' && call.duration_seconds === 60 && tl.content === 'Call: answered (60s) — CASE-14 notes' && has(r.html, 'CASE-14 notes'), `${r.ok}; "${tl.content}"`);
  });
  await step('CASE-15', 'Records sections in order', async () => {
    const h = await show(admin, 14);
    const order = ['<h2>Repayment Schedule', '<h2>Restructure History', '<h2>Payments', '<h2>Promise to Pay', '<h2>Calls', '<h2>Tasks'].map(s => h.indexOf(s));
    const noSched = await show(admin, 1);
    check('CASE-15', 'Schedule, Restructure History, Payments, PTP, Calls, Tasks; schedule only with terms', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])) && !has(noSched, '<h2>Repayment Schedule') && !has(noSched, '<h2>Restructure History') && has(h, 'id="dlg-records"'),
      `positions=${order.join(',')}`);
  });
  await step('CASE-16', 'timeline newest first; badge colours', async () => {
    const h = await show(admin, cM);
    const tl = h.slice(h.indexOf('<ul class="timeline">'), h.indexOf('</ul>', h.indexOf('<ul class="timeline">')));
    const badges = [...tl.matchAll(/<span class="badge (is-\w+)">(\w+)<\/span>/g)].map(m => [m[2], m[1]]);
    const want = { payment: 'is-green', ptp_fulfilled: 'is-green', ptp_broken: 'is-red', legal: 'is-red', ptp_created: 'is-gold', restructure: 'is-gold', status_change: 'is-blue', call: 'is-blue', note: 'is-neutral' };
    const wrong = badges.filter(([t, cls]) => want[t] && want[t] !== cls);
    const ids = qa('SELECT id FROM timeline_events WHERE case_id=? ORDER BY created_at DESC, id DESC', cM).map(r => r.id);
    check('CASE-16', 'order + colours', wrong.length === 0 && badges[0][0] === 'call' && ids.length === badges.length, `badges=${badges.map(b => b.join(':')).join(' ')}`);
  });
  await step('CASE-17', 'Next Action = earliest pending task', async () => {
    await admin.act('/tasks/new', { case_id: String(cM), type: 'follow_up', title: 'later task', due_date: addDays(today(), 9) });
    await admin.act('/tasks/new', { case_id: String(cM), type: 'follow_up', title: 'sooner task', due_date: addDays(today(), 2) });
    const t = strip(await show(admin, cM));
    check('CASE-17', 'shows earliest (date · title)', t.includes(`Next Action ${addDays(today(), 2)} · sooner task`), (t.match(/Next Action [^R]+/) || [])[0]);
  });
  await step('CASE-18', 'agent1 → /cases/2, /statement → 404', async () => {
    const r1 = await a1.get('/cases/2'); const r2 = await a1.get('/cases/2/statement'); const r3 = await a1.get('/cases/2/edit');
    check('CASE-18', '404 "Case not found or access denied"', r1.status === 404 && r2.status === 404 && has(r1.text, 'Case not found or access denied') && has(r2.text, 'Case not found or access denied'), `${r1.status}/${r2.status}; edit=${r3.status}`);
  });
  await step('CASE-19', 'auditor read-only case page', async () => {
    const h = await show(aud, 14);
    const banned = ['Record Payment</button>', ">Restructure</button>", '>New PTP</button>', '>New Plan</button>', '>Log Call</button>', '/cases/14/edit"', 'name="status"', 'Add a note'];
    const found = banned.filter(b => has(h, b));
    check('CASE-19', 'no action buttons/status/note; Records + statement available', found.length === 0 && has(h, 'dlg-records') && has(h, '/cases/14/statement') && (await aud.get('/cases/14/statement')).status === 200, `found=${found.join(',') || 'none'}`);
  });
  await step('CASE-20', 'finance view', async () => {
    const h = await show(fin, 5);
    const okHas = has(h, 'Record Payment</button>') && has(h, 'openEditPayment(this)') && has(h, '/void"');
    const banned = ['>New PTP</button>', '>New Plan</button>', '>Log Call</button>', 'name="status"', 'Add a note'].filter(b => has(h, b));
    check('CASE-20', 'Record Payment + Edit/Void; no PTP/Plan/Call/status/note', okHas && banned.length === 0, `has=${okHas} banned=${banned.join(',') || 'none'}`);
  });
  await step('CASE-21', 'agent status list & server refusal', async () => {
    const h = await show(a1, 5);
    const sel = h.slice(h.indexOf('name="status"'), h.indexOf('</select>', h.indexOf('name="status"')));
    const opts = [...sel.matchAll(/<option value="(\w+)"/g)].map(m => m[1]);
    const r1 = await a1.act('/cases/5/status', { status: 'fully_paid' });
    const r2 = await a1.act('/cases/5/status', { status: 'closed' });
    check('CASE-21', 'only New..Partial Paid; "Only a manager can set …"', opts.join() === 'new,assigned,negotiation,ptp,partial_paid' && r1.err === 'Only a manager can set Fully Paid' && r2.err === 'Only a manager can set Closed', `opts=${opts}; ${r1.err}; ${r2.err}`);
  });
  await step('CASE-22', 'Fully Paid refused while owed', async () => {
    const before = q1('SELECT status, outstanding_amount o FROM cases WHERE id=20');
    const r = await admin.act('/cases/20/status', { status: 'fully_paid' });
    check('CASE-22', '"Cannot mark Fully Paid: RM x is still owed"; unchanged', r.err === `Cannot mark Fully Paid: RM ${c.money(before.o)} is still owed` && q1('SELECT status FROM cases WHERE id=20').status === before.status, `${r.err}`);
  });
  await step('CASE-23', 'agent only own notes', async () => {
    const man = await c.as('manager');
    await man.act('/cases/5/notes', { content: 'manager note C23' });
    await a1.act('/cases/5/notes', { content: 'agent1 note C23' });
    const mid = q1("SELECT id FROM timeline_events WHERE content='manager note C23'").id;
    const aid = q1("SELECT id FROM timeline_events WHERE content='agent1 note C23'").id;
    const h = await show(a1, 5);
    const noBtn = !has(h, `data-id="${mid}"`) && has(h, `data-id="${aid}"`);
    const r1 = await a1.act(`/cases/5/notes/${mid}`, { content: 'x' });
    const r2 = await a1.act(`/cases/5/notes/${mid}/delete`);
    const r3 = await a1.act(`/cases/5/notes/${aid}`, { content: 'agent1 note edited' });
    check('CASE-23', 'no Edit/Delete on others; refused; own OK', noBtn && r1.err === 'You can only change your own notes' && r2.err === 'You can only change your own notes' && r3.ok === 'Note updated', `btn=${noBtn}; ${r1.err}; ${r2.err}; own=${r3.ok}`);
  });
  await step('CASE-24', 'bankruptcy/deceased restrictions', async () => {
    const out = {};
    for (const id of [10, 11]) {
      const h = await show(admin, id);
      const label = id === 10 ? 'Bankruptcy' : 'Deceased';
      out[id] = {
        buttons: ["dlg('dlg-restructure')", "dlg('dlg-ptp')", "dlg('dlg-plan')", "dlg('dlg-call')"].filter(b => has(h, b)),
        alert: has(h, `This case is ${label}. Payments can still be received`), reasonReq: /name="remark" required/.test(h),
        noReason: (await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '1', method: 'cash' })).err,
        ptp: (await admin.act(`/cases/${id}/ptps`, { amount: '1', due_date: today() })).err,
        plan: (await admin.act(`/cases/${id}/ptp-plans`, { total_amount: '10', num_installments: '2', first_due_date: today() })).err,
        call: (await admin.act(`/cases/${id}/calls`, { result: 'answered', duration_seconds: '1' })).err,
        rs: (await admin.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'fixed', interest_amount: '0', tenure: '6', reason: 'x' })).err,
        withReason: (await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '1', method: 'cash', remark: 'estate paid' })).ok,
      };
      out[id].ok = out[id].buttons.length === 0 && out[id].alert && out[id].reasonReq && out[id].noReason === `A reason is required to accept a payment on a ${label} case`
        && out[id].ptp === `Not allowed while the case is ${label}` && out[id].call === `Not allowed while the case is ${label}` && out[id].plan === `Not allowed while the case is ${label}`
        && out[id].rs === 'This case cannot be restructured' && /recorded/.test(out[id].withReason || '');
    }
    check('CASE-24', 'no buttons; reason required; PTP/call refused', out[10].ok && out[11].ok, JSON.stringify(out));
  });

  // ---------------- INT ----------------
  await step('INT-03', 'Fixed 1000+200 → 1,200.00', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200' });
    check('INT-03', 'Total Outstanding 1,200.00', ledgerAmt(await show(admin, id)) === '1,200.00', ledgerAmt(await show(admin, id)));
  });
  let cA;
  await step('INT-04', 'Monthly 10000 1.5% 12m → 1,800 / 11,800.00', async () => {
    cA = await c.newCase(admin, { debtor_id: String(debA), agent_id: '1', ...M() });
    const h = await show(admin, cA);
    check('INT-04', 'Interest 1,800.00; Outstanding 11,800.00; maturity 2027-01-01', ledgerVal(h, 'Interest') === '1,800.00' && ledgerAmt(h) === '11,800.00' && ledgerVal(h, 'Maturity Date') === '2027-01-01', `I=${ledgerVal(h, 'Interest')} O=${ledgerAmt(h)} mat=${ledgerVal(h, 'Maturity Date')}`);
  });
  await step('INT-05', 'Annual 36500 18% 12m → 6,570 / 43,070.00', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), principal_amount: '36500', interest_mode: 'daily', interest_rate: '18', loan_start_date: '2026-01-01', tenure: '12' });
    const h = await show(admin, id);
    check('INT-05', 'Interest 6,570.00; Outstanding 43,070.00', ledgerVal(h, 'Interest') === '6,570.00' && ledgerAmt(h) === '43,070.00', `I=${ledgerVal(h, 'Interest')} O=${ledgerAmt(h)}`);
  });
  await step('INT-06', '03-02 pay 1000 → 10,696.06 / interest 1,696.06', async () => {
    const r = await admin.act(`/cases/${cA}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const h = await show(admin, cA);
    const cs = q1('SELECT principal_amount p FROM cases WHERE id=?', cA);
    check('INT-06', 'Interest 1,696.06; Outstanding 10,696.06', /recorded/.test(r.ok || '') && ledgerVal(h, 'Interest') === '1,696.06' && ledgerAmt(h) === '10,696.06' && cs.p === 10000, `${r.ok || r.err}; I=${ledgerVal(h, 'Interest')} O=${ledgerAmt(h)}`);
    // Example A row 5: 2026-06-15 settlement 9,784.19 — read back from the overpay message
    const p = await admin.act(`/cases/${cA}/payments`, { payment_date: '2026-06-15', amount: '10696.06', method: 'cash' });
    rec('EX-A-0615', '示例 A：2026-06-15 结清额 9,784.19', p.err, p.err === 'Amount exceeds what is owed on 2026-06-15: at most RM 9784.19' ? 'PASS' : 'FAIL');
  });
  await step('INT-07', 'start today, no tenure → 0.00; (proxy for next day) start yesterday → 1/31 month share', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: today() });
    const h1 = await show(admin, id), h2 = await show(admin, id);
    const y = addDays(today(), -1);
    const id2 = await c.newCase(admin, { debtor_id: String(debA), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: y });
    const daysInPeriod = (new Date(Date.UTC(+y.slice(0, 4), +y.slice(5, 7), +y.slice(8, 10))) - new Date(y + 'T00:00:00Z')) / 864e5;
    const exp = c.money(Math.round(10000 * 0.015 / daysInPeriod * 100) / 100);
    const h3 = await show(admin, id2);
    check('INT-07', 'today 0.00 stable; one day later = 150/days-in-period', ledgerVal(h1, 'Interest') === '0.00' && ledgerVal(h2, 'Interest') === '0.00' && ledgerVal(h3, 'Interest') === exp,
      `today I=${ledgerVal(h1, 'Interest')}/${ledgerVal(h2, 'Interest')}; yesterday-start I=${ledgerVal(h3, 'Interest')} (expect ${exp}, ${daysInPeriod}-day period)`, '“次日”用“起始日=昨天”代替（不能等一天）');
  });
  await step('INT-08', 'matured loan stops accruing', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2025-01-01', tenure: '6' });
    const h = await show(admin, id);
    check('INT-08', 'interest capped at maturity (900.00); settlement today 10,900.00', ledgerVal(h, 'Interest') === '900.00' && ledgerVal(h, 'Settlement Today') === '10,900.00', `I=${ledgerVal(h, 'Interest')} settle=${ledgerVal(h, 'Settlement Today')}`, '“隔几天再看”用已到期 1 年多的案件代替');
  });
  await step('INT-09', 'no start date → defaults to opened', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), principal_amount: '1000', interest_mode: 'monthly', interest_rate: '1' });
    const t = strip(await show(admin, id));
    check('INT-09', '"(unset, defaults to opened)"', /Loan Start Date \d{4}-\d{2}-\d{2} · interest accrues from this date \(unset, defaults to opened\)/.test(t), (t.match(/Loan Start Date[^N]+/) || [])[0]);
  });
  await step('INT-10', 'Monthly → Fixed: rate cleared, interest_amount used', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), ...M({ principal_amount: '2000' }) });
    const r = await admin.act(`/cases/${id}`, { debtor_id: String(debA), principal_amount: '2000', interest_mode: 'fixed', interest_rate: '1.5', interest_amount: '100', loan_start_date: '2026-01-01', tenure: '12' });
    const row = q1('SELECT interest_mode, interest_rate, interest_from, outstanding_amount o FROM cases WHERE id=?', id);
    check('INT-10', 'rate 0, outstanding = 2,100', r.ok === 'Saved' && row.interest_mode === 'fixed' && row.interest_rate === 0 && row.o === 2100, JSON.stringify(row));
  });
  await step('INT-11', 'rate cap 18% p.a.', async () => {
    const e1 = (await admin.act('/cases', { debtor_id: String(debA), ...M({ interest_rate: '1.6' }) })).err;
    const e2 = (await admin.act('/cases', { debtor_id: String(debA), principal_amount: '10000', interest_mode: 'daily', interest_rate: '18.5', loan_start_date: '2026-01-01', tenure: '12' })).err;
    const e3 = (await admin.act('/cases', { debtor_id: String(debA), principal_amount: '10000', interest_mode: 'fixed', interest_amount: '2000', tenure: '12', loan_start_date: '2026-01-01' })).err;
    check('INT-11', 'all three refused with limit message', e1 === 'Interest rate exceeds the 18% p.a. limit (this loan: 19.2% p.a.)' && e2 === 'Interest rate exceeds the 18% p.a. limit (this loan: 18.5% p.a.)' && e3 === 'Interest rate exceeds the 18% p.a. limit (this loan: 20% p.a.)', `${e1} | ${e2} | ${e3}`);
  });
  let oldCase;
  await step('INT-12', 'cap configurable', async () => {
    const s24 = await admin.act('/settings', { company_name: '', max_annual_rate: '24' });
    const r1 = await admin.post('/cases', { debtor_id: String(debA), priority: 'medium', status: 'new', ...M({ interest_rate: '1.6' }) });
    oldCase = Number((r1.location.match(/^\/cases\/(\d+)$/) || [])[1]) || null;
    const s18 = await admin.act('/settings', { company_name: '', max_annual_rate: '18' });
    const e = (await admin.act('/cases', { debtor_id: String(debA), ...M({ interest_rate: '1.6' }) })).err;
    check('INT-12', '24 → allowed; back to 18 → refused', s24.ok === 'Company settings saved' && !!oldCase && s18.ok === 'Company settings saved' && /exceeds the 18% p\.a\. limit/.test(e || ''), `24:${s24.ok} case=${oldCase}; 18:${s18.ok}; ${e}`);
  });
  await step('INT-13', 'interest ≤ principal', async () => {
    const e = (await admin.act('/cases', { debtor_id: String(debA), ...M({ tenure: '120' }) })).err;
    check('INT-13', '"Total interest cannot exceed the principal"', e === 'Total interest cannot exceed the principal', e);
  });
  await step('INT-14', 'over-cap legacy case: edit agent only saves; term change refused', async () => {
    const r = await admin.act(`/cases/${oldCase}`, { debtor_id: String(debA), agent_id: '2', ...M({ interest_rate: '1.6' }) });
    const r2 = await admin.act(`/cases/${oldCase}`, { debtor_id: String(debA), agent_id: '2', ...M({ interest_rate: '1.6', tenure: '11' }) });
    check('INT-14', 'Saved; changing terms → cap error', r.ok === 'Saved' && /exceeds the 18% p\.a\. limit/.test(r2.err || ''), `${r.ok} / ${r2.err}`);
  });

  // ---------------- PAY ----------------
  let rc1;
  await step('PAY-01', 'record 100 cash with ref/bank', async () => {
    const b = q1('SELECT outstanding_amount o FROM cases WHERE id=3').o;
    const r = await admin.act('/cases/3/payments', { payment_date: today(), amount: '100', method: 'cash', reference: 'REF-P01', bank: 'CIMB' });
    rc1 = (r.ok || '').match(/RCPT-\d{4}-\d{4}/)?.[0];
    const a = q1('SELECT outstanding_amount o FROM cases WHERE id=3').o;
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=3 AND event_type='payment' ORDER BY id DESC");
    const log = q1("SELECT details FROM audit_logs WHERE action='payment' AND entity_id=3 ORDER BY id DESC");
    check('PAY-01', '"Payment RCPT-YYYY-NNNN recorded"; outstanding −100; row; green timeline; audit', /^Payment RCPT-2026-\d{4} recorded$/.test(r.ok || '') && Math.abs(b - a - 100) < 0.001 && has(r.html, 'data-ref="REF-P01"') && has(r.html, rc1) && /cash/.test(tl.content) && !!log,
      `${r.ok}; ${b}→${a}; tl="${tl.content}"; audit="${log && log.details}"`);
  });
  await step('PAY-02', 'Assigned/Negotiation → Partial Paid', async () => {
    const st = q1('SELECT status FROM cases WHERE id=3').status;
    await admin.act('/cases/2/payments', { payment_date: today(), amount: '50', method: 'cash' });
    const st2 = q1('SELECT status FROM cases WHERE id=2').status;
    check('PAY-02', 'negotiation→partial_paid; assigned→partial_paid', st === 'partial_paid' && st2 === 'partial_paid', `case3=${st} case2=${st2}`);
  });
  await step('PAY-03', 'pay max (settlement today) → Fully Paid, closed_at, status event, 0.00, schedule Paid', async () => {
    const id = 20;
    const h = await show(admin, id);
    const max = (h.match(/max <\/?[^>]*>?([\d,.]+) \(settles the loan today\)/) || h.match(/max ([\d,.]+) \(settles the loan today\)/) || [])[1];
    const maxAttr = (h.match(/max="([\d.]+)" name="amount" id="pay-amount"/) || [])[1];
    const r = await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: maxAttr, method: 'bank_transfer' });
    const row = q1('SELECT status, closed_at, outstanding_amount o FROM cases WHERE id=?', id);
    const ev = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='status_change' ORDER BY id DESC", id);
    const rows = scheduleRows(r.html);
    check('PAY-03', 'Fully Paid + closed_at + event; 0.00; all Paid', /recorded/.test(r.ok || '') && row.status === 'fully_paid' && !!row.closed_at && /→ fully_paid/.test(ev.content) && ledgerAmt(r.html) === '0.00' && rows.length > 0 && rows.every(x => x.status === 'Paid'),
      `max=${max} attr=${maxAttr}; ${r.ok || r.err}; ${JSON.stringify(row)}; ev="${ev && ev.content}"; schedule=${rows.map(x => x.status).join(',')}`);
  });
  await step('PAY-04', 'over settlement → server refusal with at most', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), ...M() });
    const h = await show(admin, id);
    const settle = ledgerVal(h, 'Settlement Today');
    const r = await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '11800', method: 'cash' });
    const maxAttr = (h.match(/max="([\d.]+)" name="amount" id="pay-amount"/) || [])[1];
    check('PAY-04', `"Amount exceeds what is owed on ${today()}: at most RM <settlement>"`, r.err === `Amount exceeds what is owed on ${today()}: at most RM ${num(settle).toFixed(2)}` && num(maxAttr) === num(settle), `settle=${settle} max attr=${maxAttr}; ${r.err}`);
  });
  await step('PAY-05', '0 / negative → Invalid amount', async () => {
    const e = [];
    for (const a of ['0', '-5', 'abc', '']) e.push(await admin.act('/cases/16/payments', { payment_date: today(), amount: a, method: 'cash' }));
    check('PAY-05', 'Invalid amount', e.every(x => x.err === 'Invalid amount'), e.map(x => x.err).join(' | '));
  });
  await step('PAY-06', '2026-02-30 → Invalid payment date', async () => {
    const r = await admin.act('/cases/16/payments', { payment_date: '2026-02-30', amount: '1', method: 'cash' });
    check('PAY-06', 'Invalid payment date', r.err === 'Invalid payment date', r.err);
  });
  await step('PAY-07', 'terminal status not rewritten', async () => {
    const res = [];
    for (const [id, extra] of [[7, {}], [8, {}], [9, {}], [10, { remark: 'estate' }], [11, { remark: 'estate' }]]) {
      const b = q1('SELECT status, outstanding_amount o FROM cases WHERE id=?', id);
      const r = await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '10', method: 'cash', ...extra });
      const a = q1('SELECT status, outstanding_amount o FROM cases WHERE id=?', id);
      res.push({ id, ok: !!r.ok, st: `${b.status}→${a.status}`, d: round2(b.o - a.o) });
    }
    check('PAY-07', 'balance −10, status unchanged', res.every(x => x.ok && x.st.split('→')[0] === x.st.split('→')[1] && x.d === 10), JSON.stringify(res));
  });
  await step('PAY-08', 'PTP status kept with pending PTP', async () => {
    const r = await admin.act('/cases/4/payments', { payment_date: today(), amount: '100', method: 'cash' });
    check('PAY-08', 'status stays PTP', /recorded/.test(r.ok || '') && q1('SELECT status FROM cases WHERE id=4').status === 'ptp', q1('SELECT status FROM cases WHERE id=4').status);
  });
  await step('PAY-09', 'finance edit: cap = settlement + original; banner; timeline; audit old→new', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), ...M({ principal_amount: '5000' }) });
    await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '200', method: 'cash', reference: 'R9' });
    const pay = q1('SELECT * FROM payments WHERE case_id=? ORDER BY id DESC', id);
    const settle = num(ledgerVal(await show(fin, id), 'Settlement Today'));
    const cap = Math.round((settle + 200) * 100) / 100;
    const over = await fin.act(`/cases/${id}/payments/${pay.id}`, { amount: (cap + 0.01).toFixed(2), payment_date: today(), method: 'cash', reference: 'R9' });
    const r = await fin.act(`/cases/${id}/payments/${pay.id}`, { amount: '250', payment_date: today(), method: 'cheque', reference: 'R9b' });
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='payment' ORDER BY id DESC", id);
    const log = q1("SELECT details FROM audit_logs WHERE action='payment_edit' AND entity_id=? ORDER BY id DESC", id);
    const atCap = await fin.act(`/cases/${id}/payments/${pay.id}`, { amount: cap.toFixed(2), payment_date: today(), method: 'cash', reference: 'R9' });
    check('PAY-09', 'cap+0.01 refused; Payment updated; timeline a→b; audit old→new; cap accepted', !!over.err && r.ok === 'Payment updated' && tl.content === `Payment ${pay.receipt_no} edited: RM 200.00 → RM 250.00` && /amount 200\.00 → 250\.00/.test(log.details) && /method cash → cheque/.test(log.details) && atCap.ok === 'Payment updated',
      `over="${over.err}"; ${r.ok}; "${tl.content}"; audit="${log.details}"; atCap=${atCap.ok || atCap.err}`);
  });
  await step('PAY-10', 'void → restored; timeline; audit; Fully Paid w/o payments → Negotiation', async () => {
    const pay = q1('SELECT * FROM payments WHERE case_id=18');
    const b = q1('SELECT status, outstanding_amount o FROM cases WHERE id=18');
    const r = await fin.act(`/cases/18/payments/${pay.id}/void`);
    const a = q1('SELECT status, outstanding_amount o, closed_at FROM cases WHERE id=18');
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=18 AND event_type='payment' ORDER BY id DESC");
    const log = q1("SELECT 1 x FROM audit_logs WHERE action='payment_void' AND entity_id=18");
    check('PAY-10', 'Payment voided; balance back; →negotiation', r.ok === 'Payment voided' && a.o === b.o + pay.amount && a.status === 'negotiation' && /voided/.test(tl.content) && !!log,
      `${r.ok}; ${b.status}/${b.o} → ${a.status}/${a.o} closed_at=${a.closed_at}; "${tl.content}"`);
  });
  await step('PAY-11', 'agent cannot edit/void', async () => {
    const h = await show(a1, 5);
    const pay = q1('SELECT id FROM payments WHERE case_id=5');
    const e = await a1.post(`/cases/5/payments/${pay.id}`, { amount: '1', payment_date: today() });
    const v = await a1.post(`/cases/5/payments/${pay.id}/void`);
    check('PAY-11', 'no Actions column; 403', !/<th>Actions<\/th><\/tr><\/thead>\s*<tbody><tr><td class="mono">RCPT/.test(h) && !has(h, 'openEditPayment(this)') && e.status === 403 && v.status === 403 && !!q1('SELECT 1 x FROM payments WHERE id=?', pay.id), `edit=${e.status} void=${v.status}`);
  });
  await step('PAY-12/13', 'receipts +1; voided newest never reused', async () => {
    const r1 = await admin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash' });
    const r2 = await admin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash' });
    const n1 = r1.ok.match(/RCPT-2026-(\d{4})/)[1], n2 = r2.ok.match(/RCPT-2026-(\d{4})/)[1];
    check('PAY-12', 'consecutive +1', Number(n2) === Number(n1) + 1, `${n1}→${n2}`);
    const last = q1('SELECT id FROM payments WHERE receipt_no=?', `RCPT-2026-${n2}`);
    await admin.act(`/cases/16/payments/${last.id}/void`);
    const r3 = await admin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash' });
    const n3 = r3.ok.match(/RCPT-2026-(\d{4})/)[1];
    check('PAY-13', 'voided number not reused', Number(n3) === Number(n2) + 1, `void ${n2} → next ${n3}`);
  });
  await step('PAY-14', "Reference O'Brien round-trips through data-* (HTTP part)", async () => {
    await admin.act('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash', reference: "O'Brien", bank: `x');alert(1);//` });
    const h = await show(admin, 16);
    check('PAY-14', 'data-ref escaped, no onclick splice', has(h, 'data-ref="O&#39;Brien"') && has(h, 'data-bank="x&#39;);alert(1);//"') && !/openEditPayment\([^)]*O'Brien/.test(h), (h.match(/data-ref="[^"]*"/g) || []).slice(-1)[0], '弹窗交互见 ui.qa.py');
  });
  await step('PAY-15', 'prepay saves interest 103.94', async () => {
    // cA from INT-04/06: 11,800 → 10,696.06
    check('PAY-15', 'drop 1,103.94 (= 1,000 + 103.94 saved)', ledgerAmt(await show(admin, cA)) === '10,696.06', ledgerAmt(await show(admin, cA)));
  });
  await step('PAY-16', 'future date refused; input max=today', async () => {
    const h = await show(admin, 16);
    const r = await admin.act('/cases/16/payments', { payment_date: addDays(today(), 1), amount: '1', method: 'cash' });
    check('PAY-16', '"Payment date cannot be in the future"; max attr', r.err === 'Payment date cannot be in the future' && has(h, `name="payment_date" required max="${today()}"`), r.err);
  });
  await step('PAY-17', 'settle on 03-02 = 10,304.84; 11,800 refused', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), agent_id: '1', ...M() });
    const r1 = await admin.act(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '11800', method: 'cash' });
    const r2 = await admin.act(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '10304.84', method: 'cash' });
    const row = q1('SELECT status, outstanding_amount o FROM cases WHERE id=?', id);
    check('PAY-17', '11,800 refused (at most 10304.84); 10,304.84 → Fully Paid', r1.err === 'Amount exceeds what is owed on 2026-03-02: at most RM 10304.84' && /recorded/.test(r2.ok || '') && row.status === 'fully_paid' && row.o === 0, `${r1.err}; ${r2.ok || r2.err}; ${JSON.stringify(row)}`);
  });

  // ---------------- SCH ----------------
  await step('SCH-01', 'schedule only with start + tenure', async () => {
    const a = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '100', interest_mode: 'fixed', interest_amount: '0', tenure: '3' });
    const b = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '100', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-01' });
    const d = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '100', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-01', tenure: '3' });
    const [ha, hb, hd] = [await show(admin, a), await show(admin, b), await show(admin, d)];
    check('SCH-01', 'only both → schedule', !has(ha, '<h2>Repayment Schedule') && !has(hb, '<h2>Repayment Schedule') && has(hd, '<h2>Repayment Schedule'), `tenureOnly=${has(ha, '<h2>Repayment Schedule')} startOnly=${has(hb, '<h2>Repayment Schedule')} both=${has(hd, '<h2>Repayment Schedule')}`);
  });
  await step('SCH-02', '2026-01-31 × 3 → 02-28, 03-31, 04-30', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '300', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-31', tenure: '3' });
    const rows = scheduleRows(await show(admin, id));
    check('SCH-02', 'three month-end dates', rows.map(r => r.due).join() === '2026-02-28,2026-03-31,2026-04-30', rows.map(r => r.due).join());
  });
  await step('SCH-03', 'monthly 150 / 150 / 10,150', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), ...M({ tenure: '3' }) });
    const rows = scheduleRows(await show(admin, id));
    check('SCH-03', 'expected 150, 150, 10150; dates 02-01,03-01,04-01', rows.map(r => r.expected).join() === '150,150,10150' && rows.map(r => r.due).join() === '2026-02-01,2026-03-01,2026-04-01', rows.map(r => `${r.due}:${r.expected}`).join(' '));
  });
  await step('SCH-04', 'fixed 1000/0/3 → 333.33/333.33/333.34', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-01', tenure: '3' });
    const rows = scheduleRows(await show(admin, id));
    check('SCH-04', 'cent-exact split', rows.map(r => r.expected).join() === '333.33,333.33,333.34', rows.map(r => r.expected).join());
  });
  await step('SCH-05', 'FIFO: pay 2,000 on 933.33 plan', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '10000', interest_mode: 'fixed', interest_amount: '1200', loan_start_date: '2026-01-01', tenure: '12' });
    await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '2000', method: 'cash' });
    const rows = scheduleRows(await show(admin, id));
    check('SCH-05', 'rows 1-2 Paid; row 3 paid 133.34 / left 799.99; last 933.37', rows[0].status === 'Paid' && rows[1].status === 'Paid' && rows[2].paid === 133.34 && rows[2].outstanding === 799.99 && rows[11].expected === 933.37,
      rows.slice(0, 3).map(r => `${r.expected}/${r.paid}/${r.outstanding}/${r.status}`).join(' ') + ` last=${rows[11].expected}`);
  });
  await step('SCH-06', 'statuses Paid / Overdue / Partially Paid / Pending', async () => {
    const start = addDays(today(), -60).slice(0, 8) + '01';
    const id = await c.newCase(admin, { debtor_id: String(debB), principal_amount: '600', interest_mode: 'fixed', interest_amount: '0', loan_start_date: start, tenure: '6' });
    await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '150', method: 'cash' });
    const r1 = scheduleRows(await show(admin, id));
    await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '50', method: 'cash' });
    await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '50', method: 'cash' });
    const r2 = scheduleRows(await show(admin, id));
    const dueIdx = r2.findIndex(r => r.due >= today());
    check('SCH-06', 'Paid / Overdue (past, unpaid) / Partially Paid (future, part) / Pending', r1[0].status === 'Paid' && r1[1].status === 'Overdue' && r2[dueIdx].status === 'Partially Paid' && r2[dueIdx + 1].status === 'Pending',
      `after150=${r1.map(r => r.due + ':' + r.status).join(' ')} | after250=${r2.map(r => r.status).join(',')}`);
  });
  await step('SCH-07', 'Pay only on earliest unpaid; prefill ≤ settlement', async () => {
    const h = await show(admin, 2);
    const rows = scheduleRows(h);
    const withPay = rows.map((r, i) => (/payInstallment\(([\d.]+)\)/.test(r.action || '') ? i : -1)).filter(i => i >= 0);
    const first = rows.findIndex(r => r.outstanding > 0);
    const pre = Number((rows[first].action.match(/payInstallment\(([\d.]+)\)/) || [])[1]);
    const settle = num(ledgerVal(h, 'Settlement Today'));
    check('SCH-07', 'one Pay button on first unpaid row; amount = min(row, settlement)', withPay.length === 1 && withPay[0] === first && pre === Math.min(rows[first].outstanding, settle), `payRows=${withPay} first=${first} prefill=${pre} settle=${settle}`);
  });
  await step('SCH-08', 'auditor: no Actions column', async () => {
    const h = await show(aud, 2);
    const sec = h.slice(h.indexOf('<h2>Repayment Schedule'), h.indexOf('</table>', h.indexOf('<h2>Repayment Schedule')));
    check('SCH-08', 'no Actions/Pay', !has(sec, '<th>Actions</th>') && !has(sec, 'payInstallment'), `actions=${has(sec, '<th>Actions</th>')}`);
  });
  await step('SCH-09', 'accrual payoff → all Paid, Outstanding 0', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), ...M({ loan_start_date: addDays(today(), -45) }) });
    const h = await show(admin, id);
    const maxAttr = (h.match(/max="([\d.]+)" name="amount" id="pay-amount"/) || [])[1];
    const r = await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: maxAttr, method: 'cash' });
    const rows = scheduleRows(r.html);
    check('SCH-09', 'all Paid / 0 outstanding', rows.every(x => x.status === 'Paid' && x.outstanding === 0) && ledgerAmt(r.html) === '0.00', `max=${maxAttr} ${r.ok || r.err} rows=${rows.map(x => x.status).join(',')}`);
  });
  await step('SCH-10', 'term change re-plans immediately', async () => {
    const id = await c.newCase(admin, { debtor_id: String(debA), ...M({ tenure: '3' }) });
    await admin.act(`/cases/${id}`, { debtor_id: String(debA), ...M({ tenure: '6', interest_rate: '1' }) });
    const rows = scheduleRows(await show(admin, id));
    check('SCH-10', '6 rows at 100.00', rows.length === 6 && rows[0].expected === 100 && rows[5].expected === 10100, rows.map(r => r.expected).join(','));
  });

  finish('b-case-int-pay-sch');
  assert.ok(true);
});
function round2(n) { return Math.round(n * 100) / 100; }
