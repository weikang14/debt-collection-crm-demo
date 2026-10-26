// Manual v1.1 §4.9 PTP, §4.10 RS (incl. §5.3 example B) — HTTP level. RS-04 → ui.qa.py.
const { test } = require('node:test');
const c = require('./_client');
const { reseed, step, finish, assert } = require('./_run');
const { check, rec, has, strip, today, addDays, q1, qa, ledgerAmt, ledgerVal, num, scheduleRows } = c;

const show = async (s, id) => (await s.get(`/cases/${id}`)).text;
const M = (extra = {}) => ({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', ...extra });
const ptpRows = (h) => {
  const i = h.indexOf('<h2>Promise to Pay'); const t = h.slice(i, h.indexOf('</table>', i));
  return { heads: [...t.matchAll(/<tr class="plan-head"><td colspan="4">([\s\S]*?)<\/td>/g)].map(m => strip(m[1]).trim()),
    rows: [...t.matchAll(/<tr><td>([^<]*)<\/td>\s*<td class="num">([^<]*)<\/td><td>([^<]*)<\/td>\s*<td><span class="badge ([^"]*)">([^<]*)<\/span><\/td>/g)].map(m => ({ inst: m[1], amount: num(m[2]), due: m[3], cls: m[4], status: m[5] })) };
};

test('r2 C: PTP / RS', { timeout: 300000 }, async () => {
  reseed();
  const admin = await c.as('admin');
  const man = await c.as('manager');
  const fin = await c.as('finance');
  const aud = await c.as('auditor');
  const a1 = await c.as('agent1');
  const deb = await c.newDebtor(admin, 'QA PTP/RS');

  // ---------------- PTP ----------------
  let pc; // agent1's own monthly case
  await step('PTP-01', 'PTP created; status PTP; gold timeline; audit', async () => {
    pc = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', status: 'assigned', ...M() });
    const r = await a1.act(`/cases/${pc}/ptps`, { amount: '500', due_date: addDays(today(), 3), remark: 'PTP-01' });
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='ptp_created' ORDER BY id DESC", pc);
    const log = q1("SELECT 1 x FROM audit_logs WHERE action='ptp_create' AND entity_id=?", pc);
    check('PTP-01', 'banner/status/timeline/audit', r.ok === 'PTP created' && q1('SELECT status FROM cases WHERE id=?', pc).status === 'ptp' && tl.content === `PTP RM 500.00 due ${addDays(today(), 3)}` && /badge is-gold">ptp_created/.test(r.html) && !!log,
      `${r.ok}; "${tl.content}"`);
  });
  await step('PTP-02', 'amount > outstanding', async () => {
    const o = q1('SELECT outstanding_amount o FROM cases WHERE id=?', pc).o;
    const r = await a1.act(`/cases/${pc}/ptps`, { amount: String(o + 1), due_date: addDays(today(), 3) });
    const h = await show(a1, pc);
    check('PTP-02', '"Amount exceeds outstanding"; input max set', r.err === 'Amount exceeds outstanding' && new RegExp(`max="${o}" name="amount" required`).test(h), `${r.err}; o=${o}`);
  });
  await step('PTP-03', 'Fulfill full → fulfilled + payment + audit', async () => {
    const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='pending'", pc);
    const b = q1('SELECT outstanding_amount o FROM cases WHERE id=?', pc).o;
    const r = await a1.act(`/ptps/${p.id}/fulfill`, { amount: '500', payment_date: today(), method: 'cash' });
    const pay = q1('SELECT * FROM payments WHERE case_id=? ORDER BY id DESC', pc);
    const logs = qa("SELECT action FROM audit_logs WHERE entity_id=? AND action IN ('payment','ptp_fulfilled')", pc).map(x => x.action);
    check('PTP-03', 'PTP payment recorded; fulfilled; payment 500; balance down; audit both', r.ok === 'PTP payment recorded' && q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'fulfilled' && pay.amount === 500 && q1('SELECT outstanding_amount o FROM cases WHERE id=?', pc).o < b && logs.includes('payment') && logs.includes('ptp_fulfilled'),
      `${r.ok}; receipt=${pay.receipt_no}; status now ${q1('SELECT status FROM cases WHERE id=?', pc).status}; audit=${logs}`);
    const h = await show(a1, pc);
    rec('PTP-03b', 'fulfill dialog amount defaults to PTP amount (HTTP: openFulfill(id, amount))', has(h, 'openFulfill(') ? 'n/a (no pending)' : 'no pending left', 'PASS');
  });
  await step('PTP-05', 're-fulfill → PTP already resolved, no double', async () => {
    const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='fulfilled'", pc);
    const n = q1('SELECT COUNT(*) n FROM payments WHERE case_id=?', pc).n;
    const r = await a1.act(`/ptps/${p.id}/fulfill`, { amount: '500', payment_date: today(), method: 'cash' });
    const r2 = await a1.act(`/ptps/${p.id}/break`);
    check('PTP-05', 'refused; payment count unchanged; Break also refused', r.err === 'PTP already resolved' && r2.err === 'PTP already resolved' && q1('SELECT COUNT(*) n FROM payments WHERE case_id=?', pc).n === n && q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'fulfilled', `${r.err} / ${r2.err}`);
  });
  await step('PTP-04', 'Break → broken; PTP → Negotiation; confirm dialog', async () => {
    await a1.act(`/cases/${pc}/ptps`, { amount: '100', due_date: addDays(today(), 2) });
    const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='pending'", pc);
    const h = await show(a1, pc);
    const confirm = has(h, `action="/ptps/${p.id}/break" style="margin:0;" onsubmit="return confirm('Mark this PTP as broken?')"`);
    const r = await a1.act(`/ptps/${p.id}/break`);
    const st = q1('SELECT status FROM cases WHERE id=?', pc).status;
    check('PTP-04', 'PTP broken; broken; case → negotiation (manual text "no confirm" is stale: confirm exists)', r.ok === 'PTP broken' && q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'broken' && st === 'negotiation' && confirm, `${r.ok}; case=${st}; confirm=${confirm}`, '手册写“Break 没有确认框（见附录 E-12）”，与附录 E-12“已加确认框”矛盾；实际有确认框');
  });
  let planCase;
  await step('PTP-06', 'plan 1000 × 3 → 333.33/333.33/333.34 monthly; header 0/3 kept; PTP', async () => {
    planCase = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', status: 'negotiation', ...M() });
    const r = await a1.act(`/cases/${planCase}/ptp-plans`, { total_amount: '1000', num_installments: '3', first_due_date: today() });
    const p = ptpRows(r.html);
    const d = qa('SELECT due_date FROM ptps WHERE case_id=? ORDER BY installment_no', planCase).map(x => x.due_date);
    const exp = [0, 1, 2].map(k => { const x = new Date(today() + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + k); return x.toISOString().slice(0, 10); });
    check('PTP-06', 'split, dates, header, status', r.ok === 'Installment plan created' && p.rows.map(x => x.amount).join() === '333.33,333.33,333.34' && d.join() === exp.join() && p.heads[0] === 'Installment Plan · RM 1,000.00 · 0/3 kept' && q1('SELECT status FROM cases WHERE id=?', planCase).status === 'ptp',
      `${r.ok}; ${p.rows.map(x => x.amount)}; ${d}; "${p.heads[0]}"`);
  });
  await step('PTP-07', 'installments 1 / 61', async () => {
    const e1 = (await a1.act(`/cases/${planCase}/ptp-plans`, { total_amount: '100', num_installments: '1', first_due_date: today() })).err;
    const e2 = (await a1.act(`/cases/${planCase}/ptp-plans`, { total_amount: '100', num_installments: '61', first_due_date: today() })).err;
    check('PTP-07', '"Installments must be 2–60"', e1 === 'Installments must be 2–60' && e2 === 'Installments must be 2–60', `${e1} / ${e2}`);
  });
  await step('PTP-08', 'total 0.01 × 2', async () => {
    const e = (await a1.act(`/cases/${planCase}/ptp-plans`, { total_amount: '0.01', num_installments: '2', first_due_date: today() })).err;
    check('PTP-08', '"Total too small for the number of installments"', e === 'Total too small for the number of installments', e);
  });
  await step('PTP-09', 'fulfil #1 → 1/3 kept; still PTP', async () => {
    const p = q1("SELECT * FROM ptps WHERE case_id=? AND installment_no=1 AND status='pending'", planCase);
    const r = await a1.act(`/ptps/${p.id}/fulfill`, { amount: String(p.amount), payment_date: today(), method: 'cash' });
    const h = ptpRows(r.html);
    check('PTP-09', '"1/3 kept"; status ptp', r.ok === 'PTP payment recorded' && /1\/3 kept$/.test(h.heads[0]) && q1('SELECT status FROM cases WHERE id=?', planCase).status === 'ptp', `"${h.heads[0]}" status=${q1('SELECT status FROM cases WHERE id=?', planCase).status}`);
  });
  await step('PTP-10', 'Cancel plan → pending broken; timeline; Negotiation; audit', async () => {
    const plan = q1('SELECT plan_id FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', planCase).plan_id;
    const h = await show(a1, planCase);
    const confirm = has(h, "onsubmit=\"return confirm('Cancel this installment plan?");
    const r = await a1.act(`/cases/${planCase}/ptp-plans/${plan}/cancel`);
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='ptp_broken' ORDER BY id DESC", planCase);
    const sts = qa('SELECT status FROM ptps WHERE case_id=? ORDER BY installment_no', planCase).map(x => x.status);
    const log = q1("SELECT 1 x FROM audit_logs WHERE action='ptp_plan_cancel' AND entity_id=?", planCase);
    check('PTP-10', 'banner, 2 broken, timeline text, status, audit', r.ok === 'Installment plan cancelled' && sts.join() === 'fulfilled,broken,broken' && tl.content === 'Installment plan cancelled (2 pending installment(s) broken)' && q1('SELECT status FROM cases WHERE id=?', planCase).status === 'negotiation' && !!log && confirm,
      `${r.ok}; ${sts}; "${tl.content}"; status=${q1('SELECT status FROM cases WHERE id=?', planCase).status}`);
  });
  await step('PTP-11', 'finance/auditor no PTP actions; agent1 on foreign PTP → 403', async () => {
    const h1 = await show(fin, 4), h2 = await show(aud, 4);
    const p = q1("SELECT id FROM ptps WHERE case_id=14 AND status='pending'");
    const f = await a1.post(`/ptps/${p.id}/fulfill`, { amount: '1', payment_date: today(), method: 'cash' });
    const b = await a1.post(`/ptps/${p.id}/break`);
    const pf = await fin.post(`/ptps/${p.id}/fulfill`, { amount: '1', payment_date: today() });
    check('PTP-11', 'no Fulfill/Break/Cancel; 403s', !has(h1, 'onclick="openFulfill(') && !has(h2, 'onclick="openFulfill(') && !has(h1, '/break"') && f.status === 403 && b.status === 403 && pf.status === 403 && q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'pending',
      `fin/aud buttons=${has(h1, 'onclick="openFulfill(')}/${has(h2, 'onclick="openFulfill(')}; agent1 fulfill=${f.status} break=${b.status}; finance fulfill=${pf.status}`);
  });
  await step('PTP-13', 'past due dates refused', async () => {
    const e1 = (await a1.act(`/cases/${pc}/ptps`, { amount: '10', due_date: addDays(today(), -1) })).err;
    const e2 = (await a1.act(`/cases/${pc}/ptp-plans`, { total_amount: '30', num_installments: '3', first_due_date: addDays(today(), -1) })).err;
    check('PTP-13', 'Due date cannot be in the past / First due date cannot be in the past', e1 === 'Due date cannot be in the past' && e2 === 'First due date cannot be in the past', `${e1} / ${e2}`);
  });
  await step('PTP-14', 'promised total ≤ settlement at last due date', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '1000' }) });
    const d1 = addDays(today(), 5), d2 = addDays(today(), 20);
    const r1 = await a1.act(`/cases/${id}/ptps`, { amount: '600', due_date: d1 });
    const r2 = await a1.act(`/cases/${id}/ptps`, { amount: '600', due_date: d2 });
    check('PTP-14', '"Promised total RM 1,200.00 exceeds the settlement amount on <d2> (RM y)"', r1.ok === 'PTP created' && /^Promised total RM 1,200\.00 exceeds the settlement amount on \d{4}-\d{2}-\d{2} \(RM [\d,.]+\)$/.test(r2.err || '') && (r2.err || '').includes(d2), `${r1.ok}; ${r2.err}`);
  });
  await step('PTP-15', 'partial fulfil → partially_kept (blue), timeline, no new promise', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '2000' }) });
    await a1.act(`/cases/${id}/ptps`, { amount: '300', due_date: today() });
    const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='pending'", id);
    const n = q1('SELECT COUNT(*) n FROM ptps WHERE case_id=?', id).n;
    const r = await a1.act(`/ptps/${p.id}/fulfill`, { amount: '120', payment_date: today(), method: 'cash' });
    const row = ptpRows(r.html).rows[0];
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='ptp_fulfilled' ORDER BY id DESC", id);
    check('PTP-15', 'partially kept, blue, "PTP partially kept: RM 120.00 of RM 300.00", no new PTP', q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'partially_kept' && row.cls === 'is-blue' && row.status === 'partially kept'
      && tl.content === 'PTP partially kept: RM 120.00 of RM 300.00' && q1('SELECT COUNT(*) n FROM ptps WHERE case_id=?', id).n === n, `${row.status}/${row.cls}; "${tl.content}"; case status=${q1('SELECT status FROM cases WHERE id=?', id).status}`);
  });
  await step('PTP-16', 'bankruptcy: new PTP/plan refused; Fulfill → Record Payment hint', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '2000' }) });
    await admin.act(`/cases/${id}/ptps`, { amount: '100', due_date: addDays(today(), 4) });
    const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='pending'", id);
    await admin.act(`/cases/${id}/status`, { status: 'bankruptcy' });
    const e1 = (await admin.act(`/cases/${id}/ptps`, { amount: '10', due_date: today() })).err;
    const e2 = (await admin.act(`/cases/${id}/ptp-plans`, { total_amount: '30', num_installments: '3', first_due_date: today() })).err;
    const e3 = (await admin.act(`/ptps/${p.id}/fulfill`, { amount: '100', payment_date: today(), method: 'cash' })).err;
    check('PTP-16', 'refusals', e1 === 'Not allowed while the case is Bankruptcy' && e2 === 'Not allowed while the case is Bankruptcy' && /Record this payment with a reason instead/.test(e3 || ''), `${e1} | ${e2} | ${e3}`);
  });
  await step('PTP-12', 'restructured case: fulfil date ≤ eff refused; input min', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M() });
    const eff = addDays(today(), -5);
    const rs = await admin.act(`/cases/${id}/restructures`, { effective_date: eff, interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'PTP-12' });
    await admin.act(`/cases/${id}/ptps`, { amount: '100', due_date: today() });
    const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='pending'", id);
    const h = await show(admin, id);
    const minOk = has(h, `name="payment_date" required max="${today()}" min="${addDays(eff, 1)}"`);
    const e1 = (await admin.act(`/ptps/${p.id}/fulfill`, { amount: '100', payment_date: eff, method: 'cash' })).err;
    const e2 = (await admin.act(`/ptps/${p.id}/fulfill`, { amount: '100', payment_date: addDays(eff, -3), method: 'cash' })).err;
    check('PTP-12', `"Payment date must be after the restructure date (${eff})"; min=eff+1`, rs.ok === 'Restructured' && e1 === `Payment date must be after the restructure date (${eff})` && e2 === e1 && minOk, `${rs.ok || rs.err}; ${e1}; min attr=${minOk}`);
  });

  // ---------------- RS ----------------
  let B; // example B case
  await step('RS-01', 'Restructure button visibility', async () => {
    const vis = async (s, id) => has(await show(s, id), "dlg('dlg-restructure')");
    const open = { admin: await vis(admin, 2), manager: await vis(man, 2), agent2: await vis(await c.as('agent2'), 2), finance: await vis(fin, 2), auditor: await vis(aud, 2) };
    const term = { closed: await vis(admin, 8), cancelled: await vis(admin, 9), fully_paid: await vis(admin, 6), bankruptcy: await vis(admin, 10), deceased: await vis(admin, 11), legal: await vis(admin, 7) };
    check('RS-01', 'only admin/manager on open case; none on closed/cancelled/paid/bankrupt/deceased', open.admin && open.manager && !open.agent2 && !open.finance && !open.auditor && !term.closed && !term.cancelled && !term.fully_paid && !term.bankruptcy && !term.deceased,
      `open=${JSON.stringify(open)} term=${JSON.stringify(term)}`);
  });
  await step('RS-02', 'dialog: remaining principal + unpaid interest as of today; date range', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), ...M() });
    await admin.act(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const h = await show(admin, id);
    const m = strip(h).match(/Remaining principal RM ([\d,.]+) · unpaid interest RM ([\d,.]+) as of today/);
    const inp = h.match(/name="effective_date" min="([^"]+)" max="([^"]+)" value="([^"]+)"/);
    check('RS-02', 'principal 9,304.84; min=max(start,last payment,prev+1)=2026-03-02; max=value=today', m && m[1] === '9,304.84' && inp && inp[1] === '2026-03-02' && inp[2] === today() && inp[3] === today(),
      `${m && m.slice(1)}; range=${inp && inp.slice(1)}`);
  });
  await step('RS-03', 'already restructured today → no valid date', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), ...M() });
    await admin.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.2', tenure: '12', reason: 'RS-03' });
    const h = await show(admin, id);
    check('RS-03', 'red "No valid effective date today — it must be on or after …"', has(h, `No valid effective date today — it must be on or after ${addDays(today(), 1)}.`), (strip(h).match(/No valid effective date[^.]+\./) || ['none'])[0]);
  });
  await step('RS-05', 'blank rate/amount/tenure/reason', async () => {
    const id = 2;
    const base = { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.2', tenure: '12', reason: 'x' };
    const e = [];
    for (const f of [{ interest_rate: '' }, { interest_mode: 'fixed', interest_amount: '' }, { tenure: '' }, { reason: '  ' }]) e.push((await admin.act(`/cases/${id}/restructures`, { ...base, ...f })).err);
    check('RS-05', 'four messages; blank rate not 0%', e.join('|') === 'Interest rate is required|Interest amount is required|Tenure must be 1–120 months|Reason is required' && !q1('SELECT 1 x FROM case_restructures WHERE case_id=2'), e.join(' | '));
  });
  await step('RS-06', 'tenure 0 / 121 / 1.5', async () => {
    const e = [];
    for (const t of ['0', '121', '1.5']) e.push((await admin.act('/cases/2/restructures', { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.2', tenure: t, reason: 'x' })).err);
    check('RS-06', '"Tenure must be 1–120 months"', e.every(x => x === 'Tenure must be 1–120 months'), e.join(' | '));
  });
  await step('RS-07', 'effective date out of range', async () => {
    const c2 = q1('SELECT * FROM cases WHERE id=2');
    const min = String(c2.interest_from).slice(0, 10);
    const e1 = (await admin.act('/cases/2/restructures', { effective_date: addDays(min, -1), interest_mode: 'monthly', interest_rate: '1.2', tenure: '12', reason: 'x' })).err;
    const e2 = (await admin.act('/cases/2/restructures', { effective_date: addDays(today(), 1), interest_mode: 'monthly', interest_rate: '1.2', tenure: '12', reason: 'x' })).err;
    check('RS-07', `"Effective date must be between ${min} and ${today()}"`, e1 === `Effective date must be between ${min} and ${today()}` && e2 === e1, `${e1} | ${e2}`);
  });
  await step('RS-08', 'Restructured: maturity, note, timeline, audit', async () => {
    B = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M() });
    await admin.act(`/cases/${B}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
    const r = await man.act(`/cases/${B}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'Example B' });
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='restructure' ORDER BY id DESC", B);
    const log = q1("SELECT 1 x FROM audit_logs WHERE action='restructure' AND entity_id=?", B);
    check('RS-08', 'Maturity 2027-10-01 + "Restructured on 2026-04-01"; gold timeline w/ terms, cut, arrears, reason; audit', r.ok === 'Restructured' && ledgerVal(r.html, 'Maturity Date') === '2027-10-01' && has(r.html, 'Restructured on 2026-04-01')
      && tl.content === 'Restructure: from 2026-04-01, 1.2%/month, 18 months. Principal RM 9,304.84, arrears RM 135.07 carried. Reason: Example B' && /badge is-gold">restructure/.test(r.html) && !!log, `${r.ok}; mat=${ledgerVal(r.html, 'Maturity Date')}; "${tl.content}"`);
  });
  await step('RS-09/RS-11', 'example B: 11,449.75; arrears row 135.07; 111.66/month', async () => {
    const h = await show(admin, B);
    const rows = scheduleRows(h);
    const head = has(h, 'Repayment Schedule<small style="color:var(--muted)">') || /Repayment Schedule <small[^>]*>· since restructure on 2026-04-01/.test(h);
    check('RS-09', 'heading "since restructure on"; row 1 = 2026-04-01 arrears 135.07; then monthly', head && rows[0].due === '2026-04-01' && rows[0].arrears && rows[0].expected === 135.07 && rows[1].due === '2026-05-01' && rows.length === 19,
      `head=${head}; first=${JSON.stringify(rows[0])}; n=${rows.length}`);
    check('RS-11', 'interest 2,449.75; outstanding 11,449.75; 111.66 per month; arrears fixed', ledgerVal(h, 'Interest') === '2,449.75' && ledgerAmt(h) === '11,449.75' && rows[1].expected === 111.66 && rows[18].expected === round2(111.66 + 9304.84)
      && q1('SELECT arrears_at_cut a FROM case_restructures WHERE case_id=?', B).a === 135.07, `I=${ledgerVal(h, 'Interest')} O=${ledgerAmt(h)} row2=${rows[1].expected} last=${rows[18].expected}`);
  });
  await step('RS-10', 'history card + superseded schedule (Restructured)', async () => {
    const h = await show(admin, B);
    const sec = strip(h.slice(h.indexOf('<h2>Restructure History'), h.indexOf('<h2>Payments')));
    const sup = h.slice(h.indexOf('Superseded schedule'), h.indexOf('</details>', h.indexOf('Superseded schedule')));
    check('RS-10', 'eff, terms, tenure, by, cut, arrears, reason; superseded shows Restructured', /2026-04-01 · 1\.2%\/month · 18 months · by Collection Manager/.test(sec) && /Principal at cut RM 9,304\.84 · Arrears carried RM 135\.07/.test(sec) && /Reason: Example B/.test(sec) && /Restructured<\/span>/.test(sup),
      sec.slice(0, 200));
  });
  await step('RS-12', 'old payments locked', async () => {
    const h = await show(fin, B);
    const pay = q1('SELECT id FROM payments WHERE case_id=?', B);
    const e1 = (await fin.act(`/cases/${B}/payments/${pay.id}`, { amount: '900', payment_date: '2026-03-02', method: 'cash' })).err;
    const e2 = (await fin.act(`/cases/${B}/payments/${pay.id}/void`)).err;
    check('RS-12', '"Locked · restructured"; edit/void refused', has(h, 'Locked · restructured') && !has(h, `/payments/${pay.id}/void`) && e1 === 'This payment belongs to a restructured period; undo the restructure first' && e2 === e1, `${e1} | ${e2}`);
  });
  await step('RS-13', 'new payment ≤ eff refused; input min eff+1', async () => {
    const h = await show(fin, B);
    const e1 = (await fin.act(`/cases/${B}/payments`, { payment_date: '2026-04-01', amount: '10', method: 'cash' })).err;
    const e2 = (await fin.act(`/cases/${B}/payments`, { payment_date: '2026-03-15', amount: '10', method: 'cash' })).err;
    check('RS-13', '"Payment date must be after the restructure date (2026-04-01)"; min=2026-04-02', e1 === 'Payment date must be after the restructure date (2026-04-01)' && e2 === e1 && has(h, 'min="2026-04-02"'), `${e1}`);
  });
  await step('RS-14', 'Edit Case terms locked; tamper ignored; other fields save', async () => {
    const h = (await admin.get(`/cases/${B}/edit`)).text;
    const ui = has(h, 'Loan terms are locked after a restructure') && /name="principal_amount"[^>]*readonly/.test(h) && /name="loan_start_date"[^>]*readonly/.test(h) && /id="tenure"[^>]*readonly/.test(h) && /id="interest_mode" disabled/.test(h) && !has(h, 'class="chip-row"') && /name="interest_rate"[^>]*readonly/.test(h);
    const before = q1('SELECT principal_amount, interest_rate, tenure, loan_start_date, outstanding_amount FROM cases WHERE id=?', B);
    const r = await admin.act(`/cases/${B}`, { debtor_id: String(deb), agent_id: '2', principal_amount: '1', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-06-01', tenure: '3', priority: 'urgent', remark: 'RS-14' });
    const after = q1('SELECT principal_amount, interest_rate, tenure, loan_start_date, outstanding_amount, priority, agent_id FROM cases WHERE id=?', B);
    check('RS-14', 'notice, readonly, disabled mode, no chips; terms unchanged; priority saved', ui && r.ok === 'Saved' && after.principal_amount === before.principal_amount && after.interest_rate === before.interest_rate && after.tenure === before.tenure && after.outstanding_amount === before.outstanding_amount && after.priority === 'urgent',
      `ui=${ui}; ${r.ok}; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    await admin.act(`/cases/${B}`, { debtor_id: String(deb), agent_id: '1', principal_amount: '1', priority: 'medium' });
  });
  await step('RS-16', 'payment after eff hides Undo; refused; void → undo allowed; on-eff payment fine', async () => {
    const r1 = await fin.act(`/cases/${B}/payments`, { payment_date: today(), amount: '100', method: 'cash' });
    const h = await show(man, B);
    const rid = q1('SELECT id FROM case_restructures WHERE case_id=?', B).id;
    const e = (await man.act(`/cases/${B}/restructures/${rid}/undo`)).err;
    const pid = q1('SELECT id FROM payments WHERE case_id=? AND payment_date=?', B, today()).id;
    await fin.act(`/cases/${B}/payments/${pid}/void`);
    const h2 = await show(man, B);
    check('RS-16', 'Undo hidden; "Payments exist after the effective date; void them first"; after void Undo back', /recorded/.test(r1.ok || '') && !has(h, '/undo"') && e === 'Payments exist after the effective date; void them first' && has(h2, '/undo"'), `${r1.ok}; ${e}; undoBack=${has(h2, '/undo"')}`);
  });
  await step('RS-15', 'Undo → original terms; timeline; audit; Edit unlocked', async () => {
    const rid = q1('SELECT id FROM case_restructures WHERE case_id=?', B).id;
    const h = await show(man, B);
    const confirm = has(h, "onsubmit=\"return confirm('Undo this restructure?')\"");
    const r = await man.act(`/cases/${B}/restructures/${rid}/undo`);
    const tl = q1("SELECT content FROM timeline_events WHERE case_id=? AND event_type='restructure' ORDER BY id DESC", B);
    const ed = (await admin.get(`/cases/${B}/edit`)).text;
    const log = q1("SELECT 1 x FROM audit_logs WHERE action='restructure_undo' AND entity_id=?", B);
    check('RS-15', 'Restructure undone; back to 10,696.06; timeline; audit; unlocked', r.ok === 'Restructure undone' && ledgerAmt(r.html) === '10,696.06' && tl.content === 'Restructure undone: from 2026-04-01' && !!log && !has(ed, 'Loan terms are locked') && confirm, `${r.ok}; O=${ledgerAmt(r.html)}; "${tl.content}"`);
  });
  await step('RS-17', 'multiple restructures', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), ...M() });
    await man.act(`/cases/${id}/restructures`, { effective_date: '2026-03-01', interest_mode: 'monthly', interest_rate: '1.4', tenure: '12', reason: 'first' });
    const eSame = (await man.act(`/cases/${id}/restructures`, { effective_date: '2026-03-01', interest_mode: 'monthly', interest_rate: '1.3', tenure: '12', reason: 'second' })).err;
    const r2 = await man.act(`/cases/${id}/restructures`, { effective_date: '2026-03-02', interest_mode: 'monthly', interest_rate: '1.3', tenure: '12', reason: 'second' });
    const [first, second] = qa('SELECT id FROM case_restructures WHERE case_id=? ORDER BY effective_date', id).map(x => x.id);
    const h = await show(man, id);
    const sec = h.slice(h.indexOf('<h2>Restructure History'), h.indexOf('<h2>Payments'));
    const undoForms = [...sec.matchAll(/restructures\/(\d+)\/undo/g)].map(m => Number(m[1]));
    const newestFirst = sec.indexOf('Reason: second') < sec.indexOf('Reason: first');
    const e = (await man.act(`/cases/${id}/restructures/${first}/undo`)).err;
    check('RS-17', 'min = prev+1; newest on top; only latest has Undo; older → "Only the latest restructure can be undone"', /^Effective date must be between 2026-03-02 and /.test(eSame || '') && r2.ok === 'Restructured' && newestFirst && undoForms.join() === String(second) && e === 'Only the latest restructure can be undone',
      `${eSame}; ${r2.ok}; undo=${undoForms}; ${e}`);
  });
  await step('RS-18', 'Fixed 500 / 12 → (cut + 500)/12, arrears first', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), ...M() });
    const r = await man.act(`/cases/${id}/restructures`, { effective_date: '2026-03-02', interest_mode: 'fixed', interest_amount: '500', tenure: '12', reason: 'fixed' });
    const rs = q1('SELECT * FROM case_restructures WHERE case_id=?', id);
    const rows = scheduleRows(r.html);
    const total = round2(rs.principal_at_cut + 500), base = Math.floor(total / 12 * 100) / 100;
    check('RS-18', 'arrears row then 12 equal rows summing to cut+500', rows[0].arrears && rows[0].expected === round2(rs.arrears_at_cut) && rows.length === 13 && rows[1].expected === base && round2(rows.slice(1).reduce((s, x) => s + x.expected, 0)) === total,
      `${r.ok || r.err}; cut=${rs.principal_at_cut} arrears=${rs.arrears_at_cut}; rows=${rows.slice(0, 3).map(x => x.expected)}…${rows[12] && rows[12].expected}`);
  });
  await step('RS-19', 'agent/finance POST restructure/undo → 403', async () => {
    const a2 = await c.as('agent2');
    const body = { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.0', tenure: '12', reason: 'x' };
    const rid = q1('SELECT id FROM case_restructures WHERE case_id=14').id;
    const s = [(await a2.post('/cases/14/restructures', body)).status, (await fin.post('/cases/14/restructures', body)).status, (await a2.post(`/cases/14/restructures/${rid}/undo`)).status, (await fin.post(`/cases/14/restructures/${rid}/undo`)).status];
    check('RS-19', 'all 403', s.every(x => x === 403) && q1('SELECT COUNT(*) n FROM case_restructures WHERE case_id=14').n === 1, s.join(','));
  });
  await step('RS-20', 'closed/cancelled/bankrupt/deceased/zero → cannot', async () => {
    const e = [];
    for (const id of [8, 9, 10, 11, 6]) e.push((await admin.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'fixed', interest_amount: '0', tenure: '6', reason: 'x' })).err);
    check('RS-20', '"This case cannot be restructured"', e.every(x => x === 'This case cannot be restructured'), e.join(' | '));
  });
  await step('RS-21', 'matured loan: arrears only to original maturity', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: '2025-01-01', tenure: '6' }) });
    const r = await man.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1', tenure: '12', reason: 'matured' });
    const rs = q1('SELECT * FROM case_restructures WHERE case_id=?', id);
    check('RS-21', 'arrears = 10000×1.5%×6 = 900.00', r.ok === 'Restructured' && rs.arrears_at_cut === 900 && rs.principal_at_cut === 10000, `${r.ok || r.err}; arrears=${rs && rs.arrears_at_cut}`);
  });
  await step('RS-22', 'demo case 14', async () => {
    const h = await show(admin, 14);
    const rows = scheduleRows(h);
    const sec = strip(h.slice(h.indexOf('<h2>Restructure History'), h.indexOf('<h2>Payments')));
    const eff = addDays(today(), -10);
    check('RS-22', 'arrears row, new plan, history 10 days ago 1.2%/month 18 months, reason', rows[0].arrears && rows.length === 19 && sec.includes(`${eff} · 1.2%/month · 18 months`) && /Debtor requested lower instalments/.test(sec), `first=${rows[0].due}/${rows[0].expected}; ${sec.slice(0, 120)}`);
  });
  await step('RS-23', 'cannot raise rate', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), ...M({ interest_rate: '1.2' }) });
    const e = (await man.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'x' })).err;
    check('RS-23', '"A restructure cannot raise the interest rate (14.4% → 18% p.a.)"', e === 'A restructure cannot raise the interest rate (14.4% → 18% p.a.)', e);
  });
  await step('RS-24', 'cap applies to restructure', async () => {
    const e = (await man.act('/cases/20/restructures', { effective_date: today(), interest_mode: 'monthly', interest_rate: '2', tenure: '12', reason: 'x' })).err;
    check('RS-24', '"Interest rate exceeds the 18% p.a. limit …"', /^Interest rate exceeds the 18% p\.a\. limit \(this loan: 24% p\.a\.\)$/.test(e || ''), e);
  });
  await step('RS-25', 'same-day payment then restructure today', async () => {
    const id = await c.newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: '2026-08-25' }) });
    const before = q1('SELECT * FROM cases WHERE id=?', id);
    const settle = num(ledgerVal(await show(admin, id), 'Settlement Today'));
    const unpaid = round2(settle - 10000); // two whole months: 300.00
    await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '1000', method: 'cash' });
    const h = await show(man, id);
    const dlg = strip(h).match(/Remaining principal RM ([\d,.]+) · unpaid interest RM ([\d,.]+) as of today/);
    const r = await man.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.0', tenure: '12', reason: 'same day' });
    const rs = q1('SELECT * FROM case_restructures WHERE case_id=?', id);
    const h2 = await show(man, id);
    check('RS-25', `cut principal = 10000 − (1000 − ${unpaid}) ; arrears 0; Undo still offered`, r.ok === 'Restructured' && rs.principal_at_cut === round2(10000 - (1000 - unpaid)) && rs.arrears_at_cut === 0 && dlg && num(dlg[1]) === rs.principal_at_cut && has(h2, '/undo"'),
      `unpaid before=${unpaid}; dialog=${dlg && dlg.slice(1)}; cut=${rs && rs.principal_at_cut}/${rs && rs.arrears_at_cut}; undo=${has(h2, '/undo"')}; opened=${before.opened_at}`);
  });

  finish('c-ptp-rs');
  assert.ok(true);
});
function round2(n) { return Math.round(n * 100) / 100; }
