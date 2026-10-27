# v1.11.0 冒烟测试 A 部分（A-1…A-15，见 docs/qa-reports/2026-10-25/05-v1.11.0-修复报告与线上冒烟测试.pdf 第 7 节）
# 在本地模拟 Render 的新部署执行（线上地址不可达时的替代）：
#   CRM_DB_PATH=data/qa/smoke-v111.db node --no-warnings src/db/seed.js
#   RENDER=true NODE_ENV=production SESSION_SECRET=x CRM_DB_PATH=data/qa/smoke-v111.db PORT=3305 node --no-warnings src/app.js
#   （RENDER=true 打开演示提示条，与 Render 一致）
#   python tests/qa/smoke-v1.11.0.qa.py      （SMOKE_BASE 可改地址；结果写 docs/qa-reports/2026-10-25/06-artifacts/）
# 有 Chrome 用 Chrome，没有就用 Playwright 自带的 Chromium。只读写本地库，不碰 data/crm.db。
import json, os, re, sys, time, traceback, datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get('SMOKE_BASE', 'http://127.0.0.1:3305')
OUT = ROOT / 'docs' / 'qa-reports' / '2026-10-25' / '06-artifacts'
OUT.mkdir(parents=True, exist_ok=True)
PW = {'admin': 'admin123', 'manager': 'manager123', 'agent1': 'agent123', 'agent2': 'agent123', 'agent3': 'agent123', 'finance': 'finance123', 'auditor': 'auditor123'}
TODAY = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).date()
results = []

def rec(cid, expected, ok, actual):
    results.append({'id': cid, 'expected': expected, 'actual': str(actual)[:800], 'result': 'PASS' if ok else 'FAIL'})
    print(('PASS ' if ok else 'FAIL ') + cid + ' :: ' + str(actual)[:300])

def run(cid, fn):
    try:
        fn()
    except Exception as e:
        rec(cid, '执行无异常', False, 'BLOCKED/异常: ' + repr(e)[:400])
        traceback.print_exc()

def text(pg):
    return re.sub(r'\s+', ' ', pg.inner_text('body'))

def alert(pg):
    # the Render demo banner is also an .alert.is-red — skip it
    for el in pg.query_selector_all('.alert.is-green, .alert.is-red'):
        t = el.inner_text().strip()
        if not t.startswith('Demo environment'): return t
    return None

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel='chrome', headless=True); BROWSER = 'Chrome'
    except Exception:
        browser = p.chromium.launch(headless=True); BROWSER = 'Playwright Chromium'
    print('browser:', BROWSER, browser.version)
    js_errors = []
    sessions = {}

    def as_user(u, viewport=None):
        key = (u, str(viewport))
        if key in sessions: return sessions[key]
        ctx = browser.new_context(viewport=viewport or {'width': 1366, 'height': 900})
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: js_errors.append(f'{u}: {e}'))
        pg.goto(BASE + '/login')
        pg.fill('input[name=username]', u); pg.fill('input[name=password]', PW[u])
        pg.click('button[type=submit]'); pg.wait_for_url(BASE + '/')
        sessions[key] = pg
        return pg

    # A-1 version + demo banner on login and every page
    def a1():
        ctx = browser.new_context(); pg = ctx.new_page(); pg.goto(BASE + '/login')
        t = text(pg); ver = re.search(r'v(\d+\.\d+\.\d+)', t)
        banner_login = 'Demo environment — use made-up data only.' in t
        red = pg.eval_on_selector(":text('Demo environment')", "e => getComputedStyle(e.closest('div,p,header,section')||e).color + ' / ' + getComputedStyle(e.closest('div,p,header,section')||e).backgroundColor")
        pg.screenshot(path=str(OUT / 'a01-login.png'))
        a = as_user('admin'); missing = []
        for path in ['/', '/cases', '/cases/2', '/debtors', '/tasks', '/reports', '/commissions', '/settings', '/audit-log']:
            a.goto(BASE + path)
            if 'Demo environment — use made-up data only.' not in text(a): missing.append(path)
        rec('A-1', '登录页显示 v1.11.0 和红色提示；登录后每个页面顶部也有', ver and ver.group(1) == '1.11.0' and banner_login and not missing,
            f'login version=v{ver.group(1) if ver else None}; login banner={banner_login} ({red}); pages missing banner={missing or "none"}')
    run('A-1', a1)

    # A-2 case 14 up to date, arrears row same day as first installment, history 10 days ago 1.2%/18m
    def a2():
        pg = as_user('agent2'); pg.goto(BASE + '/cases/14')
        t = text(pg)
        od = pg.eval_on_selector("xpath=//div[@class='ledger-lbl' and text()='Overdue']/..", 'e => e.innerText') if pg.query_selector("xpath=//div[@class='ledger-lbl' and text()='Overdue']") else ''
        pg.click('button[aria-label=Records]'); time.sleep(0.3)
        rt = pg.inner_text('#dlg-records')
        rows = re.findall(r'^(\d{4}-\d{2}-\d{2})( · Arrears \(carried\))?\t', rt, re.M)
        hist = re.findall(r'^(\d{4}-\d{2}-\d{2}) · ([^\n]*)$', rt[rt.find('Restructure History'):], re.M)
        pg.screenshot(path=str(OUT / 'a02-case14-records.png'), full_page=True)
        arrears = [d for d, a in rows if a]; plain = [d for d, a in rows if not a]
        same_day = bool(arrears) and bool(plain) and arrears[0] == plain[0]
        eff = str(TODAY - datetime.timedelta(days=10))
        hist_ok = bool(hist) and hist[0][0] == eff and '1.2%/month' in hist[0][1] and '18 months' in hist[0][1]
        rec('A-2', 'up to date；Arrears (carried) 与第一期同日；重组历史 10 天前 1.2%/月 18 个月',
            'up to date' in od and same_day and hist_ok,
            f'overdue cell="{od.strip()}"; arrears due={arrears[:1]} first instalment={plain[:1]}; history={hist}; expected effective={eff}')
    run('A-2', a2)

    # A-3 case 2 main number = Settlement Today; Contract Balance; overdue ≤ settlement
    def a3():
        pg = as_user('agent2'); pg.goto(BASE + '/cases/2')
        lbl = pg.text_content('.ledger-lead .ledger-lbl').strip(); big = pg.inner_text('.ledger-amt')
        cells = dict(pg.eval_on_selector_all('.ledger-break > div', "ds => ds.map(d => [d.querySelector('.ledger-lbl').textContent.trim(), d.textContent.replace(/\\s+/g,' ').trim()])"))
        num = lambda s: float(re.sub(r'[^\d.]', '', s.split()[0] if s else '0') or 'nan')
        settle = num(big.replace('RM', '')); cb = cells.get('Contract Balance', ''); od = cells.get('Overdue', '')
        odv = num(od.replace('Overdue', '').strip())
        pg.screenshot(path=str(OUT / 'a03-case2-ledger.png'))
        rec('A-3', '主数字 Settlement Today；旁边 Contract Balance（含未到期利息）与逾期；逾期 ≤ 结清额',
            lbl.startswith('Settlement Today') and 'incl. interest not yet due' in cb and ('up to date' in od or 'past due' in od) and odv <= settle,
            f'lead="{lbl}" {big}; Contract Balance="{cb}"; Overdue="{od}"')
    run('A-3', a3)

    # A-4 agent status rights
    def a4():
        pg = as_user('agent1'); pg.goto(BASE + '/cases/5')
        opts = pg.eval_on_selector_all('form[action="/cases/5/status"] select[name=status] option', 'os => os.map(o => o.innerText.trim())')
        pg.goto(BASE + '/cases/17'); t17 = text(pg); sel17 = pg.query_selector('select[name=status]')
        p2 = as_user('agent2'); p2.goto(BASE + '/cases/10'); t10 = text(p2); sel10 = p2.query_selector('select[name=status]')
        p2.screenshot(path=str(OUT / 'a04-agent2-case10.png'))
        want = ['New', 'Assigned', 'Negotiation', 'PTP', 'Partial Paid']
        rec('A-4', '案件 5 下拉只有 New/Assigned/Negotiation/PTP/Partial Paid；17、10 无下拉，显示“only a manager can change it”',
            opts == want and sel17 is None and sel10 is None and 'only a manager can change it' in t17 and 'only a manager can change it' in t10,
            f'case5 options={opts}; case17 select={sel17 is not None}, note={"only a manager can change it" in t17}; case10 select={sel10 is not None}, note={"only a manager can change it" in t10}')
    run('A-4', a4)

    # A-5 rate cap settings
    def a5():
        pg = as_user('admin'); pg.goto(BASE + '/settings')
        inp = 'input[name=max_annual_rate]'
        pg.fill(inp, '24'); pg.click(f'form:has({inp}) button[type=submit]'); time.sleep(0.3)
        valid = pg.eval_on_selector(inp, 'e => e.validity.valid'); msg = pg.eval_on_selector(inp, 'e => e.validationMessage')
        browser_block = not valid and pg.url.endswith('/settings')
        # server side (bypass the browser): same session, same form field
        r = pg.request.post(BASE + '/settings', form={'max_annual_rate': '24', 'company_name': pg.eval_on_selector('input[name=company_name]', 'e => e.value')}, max_redirects=0)
        pg.goto(BASE + '/settings'); srv = alert(pg); cap_after24 = pg.eval_on_selector(inp, 'e => e.value')
        pg.fill(inp, '12'); pg.click(f'form:has({inp}) button[type=submit]'); pg.wait_for_load_state()
        ok12 = alert(pg); t = text(pg); red = re.search(r'Open loans above the 12% p\.a\. cap:[^.]*', t)
        pg.screenshot(path=str(OUT / 'a05-settings-cap12.png'), full_page=True)
        pg.goto(BASE + '/audit-log'); at = text(pg); aud = re.search(r'max_annual_rate: 18 → 12', at)
        pg.goto(BASE + '/settings'); pg.fill(inp, '18'); pg.click(f'form:has({inp}) button[type=submit]'); pg.wait_for_load_state()
        gone = 'Open loans above' not in text(pg); final = pg.eval_on_selector(inp, 'e => e.value')
        rec('A-5', '24 被拒（浏览器先拦截）；12 保存成功并出现红框；审计 “max_annual_rate: 18 → 12”；改回 18 后红框消失',
            browser_block and cap_after24 == '18' and ok12 and red and aud and gone and final == '18',
            f'browser: valid={valid} msg="{msg}"; server POST 24 → "{srv}" (cap still {cap_after24}); 12 → "{ok12}"; red box="{red.group(0)[:200] if red else None}"; audit match={bool(aud)}; back to 18 → box gone={gone}, value={final}')
    run('A-5', a5)

    # A-6 tenure required / exact cap on new case (manager)
    def a6():
        pg = as_user('manager'); out = []
        before = None
        for label, mode, extra in [('① Fixed 200 无期限', 'fixed', {'interest_amount': '200'}), ('② Monthly 1.5 无期限', 'monthly', {'interest_rate': '1.5'}), ('③ Monthly 1.5004 12 月', 'monthly', {'interest_rate': '1.5004', 'tenure': '12'})]:
            pg.goto(BASE + '/cases'); n0 = len(pg.query_selector_all('table tbody tr'))
            pg.goto(BASE + '/cases/new')
            pg.select_option('select[name=debtor_id]', index=1)
            pg.fill('input[name=principal_amount]', '5000')
            pg.fill('input[name=loan_start_date]', str(TODAY))
            pg.select_option('#interest_mode', mode)
            for k, v in extra.items(): pg.fill(f'input[name={k}]', v)
            pg.click('form.form button[type=submit]'); pg.wait_for_load_state()
            msg = alert(pg); created = re.search(r'/cases/\d+$', pg.url) is not None
            if msg is None and pg.url.endswith('/cases/new'):
                bad = pg.eval_on_selector_all('form.form :invalid', "es => es.map(e => e.name + ': ' + e.validationMessage)")
                form = {'debtor_id': pg.eval_on_selector('select[name=debtor_id]', 'e => e.value'), 'principal_amount': '5000', 'loan_start_date': str(TODAY), 'interest_mode': mode, 'priority': 'medium', 'status': 'new', **extra}
                r = pg.request.post(BASE + '/cases', form=form, max_redirects=0); loc = r.headers.get('location', '')
                created = re.search(r'/cases/\d+$', loc) is not None
                pg.goto(BASE + (loc or '/cases/new')); msg = f'浏览器拦截 {bad}；绕过浏览器直接提交 → {alert(pg)}'
            out.append((label, msg, created))
        pg.screenshot(path=str(OUT / 'a06-newcase-cap.png'))
        need = 'Tenure is required for a loan that charges interest'
        ok = out[0][1] == need and out[1][1] == need and out[2][1] and '18%' in out[2][1] and not any(c for _, _, c in out)
        rec('A-6', '①② “Tenure is required for a loan that charges interest”；③ 超过 18% p.a. 被拒；都没建成', ok, '; '.join(f'{l}: "{m}" created={c}' for l, m, c in out))
    run('A-6', a6)

    # A-7 double click Add Payment on case 19
    def a7():
        pg = as_user('manager'); pg.goto(BASE + '/cases/19')
        n0 = len(re.findall(r'RCPT-\d{4}-\d{4}', pg.content()))
        pg.click('text=Record Payment'); pg.fill('#dlg-payment input[name=payment_date]', str(TODAY)); pg.fill('#pay-amount', '10.00')
        btn = pg.locator('#dlg-payment button[type=submit]')
        pg.evaluate("() => { const b = document.querySelector('#dlg-payment button[type=submit]'); b.click(); window.__dis = b.disabled; setTimeout(()=>{window.__dis2 = b.disabled}, 5); b.click(); }")
        pg.wait_for_load_state(); time.sleep(0.5); pg.goto(BASE + '/cases/19')
        rc = sorted(set(re.findall(r'RCPT-\d{4}-\d{4}', pg.content())))
        pay_rows = lambda amt: pg.eval_on_selector_all('#dlg-records h2:text-is("Payments") + * tr, #dlg-records h2:text-is("Payments") ~ table tr', f"rs => rs.filter(r => /RCPT-/.test(r.innerText) && r.innerText.includes('{amt}')).length")
        rows10 = pay_rows('10.00')
        # also: the real double click through Playwright
        pg.click('text=Record Payment'); pg.fill('#dlg-payment input[name=payment_date]', str(TODAY)); pg.fill('#pay-amount', '11.00'); pg.fill('#dlg-payment input[name=reference]', 'A7-dbl')
        btn.dblclick(); pg.wait_for_load_state(); time.sleep(0.5); pg.goto(BASE + '/cases/19')
        rows11 = pay_rows('11.00')
        rec('A-7', '提交后按钮变灰；只生成一笔还款、一个收据号', rows10 == 1 and rows11 == 1, f'two clicks 10.00 → {rows10} row(s); dblclick 11.00 → {rows11} row(s); receipts on page={rc}')
    run('A-7', a7)

    # A-8 payment before loan start
    def a8():
        pg = as_user('manager'); pg.goto(BASE + '/cases/19')
        shown = re.search(r'Loan Start Date\s*(\d{4}-\d{2}-\d{2})', re.sub(r'\s+', ' ', pg.text_content('body')))
        # case 19 is a Fixed loan: the detail page only shows Loan Start Date for rate-based loans, so read it from Edit
        pg.goto(BASE + '/cases/19/edit'); start = pg.eval_on_selector('input[name=loan_start_date]', 'e => e.value'); pg.goto(BASE + '/cases/19')
        d = (datetime.date.fromisoformat(start) - datetime.timedelta(days=1)).isoformat()
        n0 = pg.content().count('RCPT-')
        pg.click('text=Record Payment'); pg.fill('#dlg-payment input[name=payment_date]', d); pg.fill('#pay-amount', '5.00')
        pg.click('#dlg-payment button[type=submit]'); pg.wait_for_load_state(); msg = alert(pg)
        n1 = pg.content().count('RCPT-')
        rec('A-8', f'提示 “Payment date cannot be before the loan start date ({start})”，未入账', msg == f'Payment date cannot be before the loan start date ({start})' and n1 == n0, f'date {d} → "{msg}"; receipts {n0}→{n1}; Loan Start Date on detail page={shown.group(1) if shown else "not shown (Fixed loan)"}, from Edit={start}')
    run('A-8', a8)

    # A-9 case 4 → Bankruptcy closes the pending PTP
    def a9():
        pg = as_user('admin'); pg.goto(BASE + '/cases/4')
        pg.select_option('select[name=status]', 'bankruptcy'); pg.wait_for_load_state(); time.sleep(0.3)
        t = text(pg); msg = alert(pg)
        btns = [b for b in ['New PTP', 'New Plan', 'Restructure', 'Log Call'] if pg.locator(f'button:text-is("{b}"):visible').count()]
        fulfill = pg.locator('button:text-is("Fulfill")').count() > 0
        tl = '1 pending promise(s) closed: case marked Bankruptcy' in t
        pg.click('button[aria-label=Records]'); time.sleep(0.3); rt = pg.inner_text('#dlg-records') if pg.query_selector('#dlg-records') else ''
        broken = 'broken' in rt.lower(); pending = 'pending' in rt.lower()
        pg.screenshot(path=str(OUT / 'a09-case4-bankruptcy.png'), full_page=True)
        rec('A-9', 'PTP 自动 broken；时间线 “1 pending promise(s) closed: case marked Bankruptcy”；无 New PTP/New Plan/Restructure/Log Call/Fulfill',
            tl and broken and not btns and not fulfill, f'banner="{msg}"; timeline match={tl}; PTP broken={broken} pending={pending}; buttons shown={btns}; Fulfill={fulfill}')
    run('A-9', a9)

    # A-10 tasks on a bankrupt case
    def a10():
        pg = as_user('admin')
        r1 = pg.request.post(BASE + '/tasks/new', form={'case_id': '4', 'type': 'follow_up', 'title': 'A-10 follow up', 'due_date': str(TODAY + datetime.timedelta(days=2))}, max_redirects=0)
        pg.goto(BASE + r1.headers.get('location', '/tasks')); m1 = alert(pg)
        r2 = pg.request.post(BASE + '/tasks/new', form={'case_id': '4', 'type': 'legal', 'title': 'A-10 legal', 'due_date': str(TODAY + datetime.timedelta(days=2))}, max_redirects=0)
        pg.goto(BASE + r2.headers.get('location', '/tasks')); m2 = alert(pg)
        pg.goto(BASE + '/tasks'); t = text(pg)
        rec('A-10', 'follow_up 被拒 “Only legal tasks can be added to a bankrupt or deceased case”；legal 可以建',
            m1 == 'Only legal tasks can be added to a bankrupt or deceased case' and 'A-10 legal' in t and 'A-10 follow up' not in t, f'follow_up → "{m1}"; legal → "{m2}"; on task list: legal={"A-10 legal" in t}, follow_up={"A-10 follow up" in t}')
    run('A-10', a10)

    # A-11 payment on a bankrupt case needs a reason
    def a11():
        pg = as_user('admin'); pg.goto(BASE + '/cases/4')
        pg.click('text=Record Payment'); pg.fill('#dlg-payment input[name=payment_date]', str(TODAY)); pg.fill('#pay-amount', '12.34')
        pg.click('#dlg-payment button[type=submit]'); time.sleep(0.3)
        blocked = pg.eval_on_selector('#dlg-payment', 'd => d.open') and not pg.eval_on_selector('#dlg-payment input[name=remark]', 'e => e.validity.valid')
        pg.fill('#dlg-payment input[name=remark]', 'Trustee distribution'); pg.click('#dlg-payment button[type=submit]'); pg.wait_for_load_state()
        msg = alert(pg); t = text(pg)
        pg.click('button[aria-label=Records]'); time.sleep(0.3); rt = pg.inner_text('#dlg-records')
        in_payments = bool(re.search(r'12\.34.*Trustee distribution', rt.replace('\n', ' ')))
        in_tl = 'Trustee distribution' in t
        pg.goto(BASE + '/audit-log'); in_audit = 'Trustee distribution' in text(pg)
        rec('A-11', 'Reason 必填（浏览器拦截）；原因显示在 Payments 的 Remark、时间线和 Audit Log', blocked and in_payments and in_tl and in_audit,
            f'empty reason blocked={blocked}; banner="{msg}"; Payments remark={in_payments}; timeline={in_tl}; audit={in_audit}')
    run('A-11', a11)

    # A-12 lifting bankruptcy needs a reason
    def a12():
        pg = as_user('admin'); pg.goto(BASE + '/cases/4')
        pg.select_option('select[name=status]', 'negotiation'); pg.click('form[action="/cases/4/status"] button[type=submit]'); pg.wait_for_load_state()
        m1 = alert(pg)
        pg.select_option('select[name=status]', 'negotiation'); pg.fill('form[action="/cases/4/status"] input[name=reason]', 'A-12 trustee discharged'); pg.click('form[action="/cases/4/status"] button[type=submit]'); pg.wait_for_load_state()
        m2 = alert(pg); st = pg.eval_on_selector('select[name=status]', 'e => e.value') if pg.query_selector('select[name=status]') else None
        pg.goto(BASE + '/audit-log'); aud = 'A-12 trustee discharged' in text(pg)
        rec('A-12', '不填原因提示 “A reason is required to lift Bankruptcy”；填了可以改，审计记下原因',
            m1 == 'A reason is required to lift Bankruptcy' and st == 'negotiation' and aud, f'no reason → "{m1}"; with reason → "{m2}", status now={st}; audit has reason={aud}')
    run('A-12', a12)

    # A-13 restructure Monthly → Fixed refused
    def a13():
        pg = as_user('manager'); pg.goto(BASE + '/cases/20')
        pg.click('button:text-is("Restructure")'); pg.select_option('#rs-mode', 'fixed')
        pg.fill('#dlg-restructure input[name=interest_amount]', '100'); pg.fill('#dlg-restructure input[name=tenure]', '12'); pg.fill('#dlg-restructure textarea[name=reason]', 'A-13')
        pg.click('#dlg-restructure button[type=submit]'); pg.wait_for_load_state(); msg = alert(pg)
        want = 'A rate-based loan cannot be restructured to a fixed amount (pending legal review)'
        rec('A-13', f'提示 “{want}”', msg == want, f'"{msg}"')
    run('A-13', a13)

    # A-14 formula help on New Case
    def a14():
        pg = as_user('manager'); n0 = len(js_errors); pg.goto(BASE + '/cases/new')
        texts = {}
        for mode in ['monthly', 'daily', 'fixed']:
            pg.select_option('#interest_mode', mode)
            if not pg.is_visible('#interest_formula'): pg.click('#interest_help')
            texts[mode] = pg.inner_text('#interest_formula').replace('\n', ' ')
        pg.select_option('#interest_mode', 'monthly'); pg.screenshot(path=str(OUT / 'a14-formula.png'))
        m = texts['monthly']
        ok = 'remaining principal × monthly% for each full month' in m and 'pro-rated by the actual days in that month' in m and len(js_errors) == n0 and all(texts.values()) and len(set(texts.values())) == 3
        rec('A-14', 'Monthly 说明为整月计息 + 不足月按当月实际天数；三种模式切换正常，无脚本错误', ok, f'{texts}; js errors={js_errors[n0:]}')
    run('A-14', a14)

    # A-15 375px: no horizontal scroll, follow-ups scroll in box, ☰ toggles
    def a15():
        pg = as_user('admin', {'width': 375, 'height': 812}); res = {}
        for path in ['/', '/cases', '/cases/2']:
            pg.goto(BASE + path)
            res[path] = pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        pg.goto(BASE + '/'); pg.screenshot(path=str(OUT / 'a15-dashboard-375.png'), full_page=True)
        box = pg.evaluate("""() => { const h = [...document.querySelectorAll('h2,h3,.card-title')].find(e => /Upcoming Follow-ups/.test(e.innerText));
            if (!h) return 'no heading'; const card = h.closest('.card') || h.parentElement; const t = card.querySelector('table');
            const w = t && (t.parentElement); if (!t) return 'no table';
            const cs = getComputedStyle(w); return {overflowX: cs.overflowX, tableW: t.scrollWidth, boxW: w.clientWidth}; }""")
        tog = pg.query_selector('button.nav-toggle')
        opened = closed = covered = None
        if tog:
            tog.click(); time.sleep(0.6); opened = pg.evaluate("document.body.classList.contains('nav-open')")
            pg.screenshot(path=str(OUT / 'a15-menu-open-375.png'))
            covered = pg.eval_on_selector('button.nav-toggle', 'e => { const r = e.getBoundingClientRect(); return !e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }')
            pg.mouse.click(360, 400); time.sleep(0.4)   # tap the dimmed area outside the sidebar
            closed = pg.evaluate("document.body.classList.contains('nav-open')")
        ok_box = isinstance(box, dict) and box['overflowX'] in ('auto', 'scroll')
        rec('A-15', '375px 无横向滚动；Upcoming Follow-ups 表格在框内滚动；☰ 能开关侧栏',
            all(res.values()) and ok_box and tog is not None and opened is True and closed is False, f'no h-scroll={res}; follow-ups box={box}; ☰ opens={opened}; closed by tapping outside={closed is False}; ☰ covered by the open sidebar={covered}')
    run('A-15', a15)

    # B-14 statement → PDF (Chromium print), kept for comparison with the earlier statement PDFs
    def b14():
        pg = as_user('admin')
        for cid in (14, 5):
            pg.goto(BASE + f'/cases/{cid}/statement'); pg.emulate_media(media='print')
            hidden = pg.eval_on_selector_all('button, .no-print', 'es => es.length > 0 && es.every(e => e.getClientRects().length === 0)')
            pg.pdf(path=str(OUT / f'statement-case{cid}.pdf'), format='A4', print_background=True); pg.emulate_media(media='screen')
        rec('B-14-PDF', '对账单可以打印（打印样式隐藏按钮，生成 PDF）', hidden and (OUT / 'statement-case14.pdf').stat().st_size > 10000, f'buttons hidden in print={hidden}; statement-case14.pdf {(OUT / "statement-case14.pdf").stat().st_size} B, statement-case5.pdf {(OUT / "statement-case5.pdf").stat().st_size} B')
    run('B-14-PDF', b14)

    # extra: the real Edit form on a seeded rate-based case once the cap is lowered (S-INT-14b in the HTTP run)
    def int14b():
        pg = as_user('admin'); pg.goto(BASE + '/settings'); pg.fill('input[name=max_annual_rate]', '12'); pg.click('form:has(input[name=max_annual_rate]) button[type=submit]'); pg.wait_for_load_state()
        pg.goto(BASE + '/cases/2/edit'); pg.select_option('select[name=agent_id]', index=1); pg.fill('textarea[name=remark]', 'X-INT-14b reassign only')
        pg.click('form.form button[type=submit]'); pg.wait_for_load_state(); msg = alert(pg)
        pg.screenshot(path=str(OUT / 'x-int14b-edit-case2-cap12.png'))
        pg.goto(BASE + '/settings'); pg.fill('input[name=max_annual_rate]', '18'); pg.click('form:has(input[name=max_annual_rate]) button[type=submit]'); pg.wait_for_load_state()
        rec('X-INT-14b', '利率上限调到 12 后，演示案件 2 只改催收员/备注应能保存（条款没动）', msg == 'Saved', f'Edit 页只改 Agent 和 Remark → "{msg}"（上限已改回 18）')
    run('X-INT-14b', int14b)

    rec('JS-ERRORS', '全程无页面脚本错误', not js_errors, js_errors or 'none')
    browser.close()

(OUT / 'smoke-A-local.json').write_text(json.dumps({'base': BASE, 'browser': f'{BROWSER} {browser.version}', 'run_at_myt': str(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)), 'results': results}, ensure_ascii=False, indent=1))
print('A', {k: sum(1 for r in results if r['result'] == k) for k in ('PASS', 'FAIL')})
