# v1.11.0 冒烟测试（05-v1.11.0-修复报告与线上冒烟测试.pdf 第 7、8 章：A-1…A-15、B-1…B-17）。
# 只走 HTTP 与浏览器界面，不读数据库，所以同一脚本也能对线上跑（先核对版本号）。
# 本地（模拟 Render：RENDER=true 显示演示提示条）：
#   CRM_DB_PATH=data/qa/smoke-r3.db node --no-warnings src/db/seed.js
#   RENDER=true NODE_ENV=production SESSION_SECRET=local-smoke CRM_DB_PATH=data/qa/smoke-r3.db PORT=3311 node --no-warnings src/app.js
#   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers python tests/qa/r3/smoke.qa.py
# 线上：QA_BASE=https://debt-collection-crm-demo.onrender.com QA_ALLOW_ONLINE=1 python tests/qa/r3/smoke.qa.py
#   只用公开演示账号；B-6 会作废一笔本脚本自己录入的还款，B-9 会撤销本脚本自己做的重组，不动其它数据。
# 浏览器：云端没有 Chrome，用 Playwright 自带的 Chromium（有 Chrome 时也可 QA_CHANNEL=chrome）。
# 结果：tests/qa/r3/results/smoke.json，截图与对账单 PDF 在 tests/qa/r3/results/smoke/。
import datetime, json, os, re, sys, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get('QA_BASE', 'http://127.0.0.1:3311').rstrip('/')
if not re.match(r'^http://(127\.0\.0\.1|localhost)(:\d+)?$', BASE) and os.environ.get('QA_ALLOW_ONLINE') != '1':
    sys.exit('refusing: non-local QA_BASE needs QA_ALLOW_ONLINE=1')
OUT = Path(__file__).resolve().parent / 'results'
SHOTS = OUT / 'smoke'
SHOTS.mkdir(parents=True, exist_ok=True)
PW = {'admin': 'admin123', 'manager': 'manager123', 'agent1': 'agent123', 'agent2': 'agent123', 'agent3': 'agent123', 'finance': 'finance123', 'auditor': 'auditor123'}
NOW = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)
TODAY = NOW.date()
iso = lambda d: d.isoformat()
def add_days(n): return iso(TODAY + datetime.timedelta(days=n))
def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year; m += 1
    last = [31, 29 if (y % 4 == 0 and (y % 100 or y % 400 == 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return datetime.date(y, m, min(d.day, last))
money = lambda x: f'{x:,.2f}'
num = lambda s: None if s is None else float(str(s).replace(',', '').replace('RM', '').strip() or 'nan')

results = []
def rec(i, expected, ok, actual, note=''):
    r = ok if isinstance(ok, str) else ('PASS' if ok else 'FAIL')
    results.append({'id': i, 'expected': expected, 'actual': str(actual)[:900], 'result': r, 'note': note, 'at_myt': datetime.datetime.now(datetime.timezone.utc).astimezone(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')})
    print(f'{r:5} {i} :: {str(actual)[:240]}', flush=True)

def run(i, expected, fn):
    try:
        fn()
    except Exception as e:
        rec(i, expected, 'BLOCKED', 'script error: ' + repr(e)[:400])
        traceback.print_exc()

def flash(html):
    # page flash = the .alert that is not the demo banner
    for cls, txt in re.findall(r'<div class="alert is-(green|red)">([^<]*)</div>', html):
        if not txt.startswith('Demo environment'):
            return ('ok' if cls == 'green' else 'err', unescape(txt))
    return (None, None)
def unescape(s): return s.replace('&#39;', "'").replace('&quot;', '"').replace('&#34;', '"').replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
def strip(html): return re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]+>', ' ', re.sub(r'<script[\s\S]*?</script>', '', html))))
def lead(html):
    m = re.search(r'ledger-amt"><span class="ledger-cur">RM</span>([\d,.-]+)', html); return num(m.group(1)) if m else None
def lval(html, lbl):
    m = re.search(r'ledger-lbl">' + re.escape(lbl) + r'</div><div class="ledger-val[^"]*">([^<]+)<', html); return m.group(1).strip() if m else None
def lsmall(html, lbl):
    m = re.search(r'ledger-lbl">' + re.escape(lbl) + r'</div><div class="ledger-val[^"]*">[^<]+</div>\s*<small[^>]*>([^<]+)<', html); return m.group(1).strip() if m else None
def sched(html):
    i = html.find('<h2>Repayment Schedule')
    if i < 0: return []
    t = html[i:html.find('</table>', i)]
    return [{'due': m[0].strip(), 'arrears': bool(m[1]), 'expected': num(m[2]), 'paid': num(m[3]), 'out': num(m[4]), 'status': m[5], 'action': m[6]}
            for m in re.findall(r'<tr>\s*<td>([^<]*)(<small[^>]*>[^<]*</small>)?</td>\s*<td class="num">([^<]*)</td>\s*<td class="num">([^<]*)</td>\s*<td class="num">([^<]*)</td>\s*<td><span class="badge [^"]*">([^<]*)</span></td>(?:\s*<td>([\s\S]*?)</td>)?', t)]
def section(html, h2):
    i = html.find('<h2>' + h2)
    if i < 0: return ''
    j = html.find('</section>', i)
    return html[i:j if j > 0 else None]
def payment_rows(html):
    return re.findall(r'<tr><td class="mono">(RCPT-[\d-]+)</td><td>([^<]*)</td>\s*<td class="num">([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td>', section(html, 'Payments'))
def ptp_rows(html):
    return [(a.strip(), num(b), c, d) for a, b, c, d in re.findall(r'<tr><td>([^<]*)</td>\s*<td class="num">([^<]*)</td><td>([^<]*)</td>\s*<td><span class="badge [^"]*">([^<]*)</span>', section(html, 'Promise to Pay'))]
def timeline(html):
    i = html.find('<ul class="timeline">')
    return [(t, strip(c).strip()) for t, c in re.findall(r'<li><span class="badge [^"]*">([a-z_]+)</span>([\s\S]*?)<span class="meta">', html[i:html.find('</ul>', i)])] if i >= 0 else []

with sync_playwright() as pw:
    ch = os.environ.get('QA_CHANNEL')
    browser = pw.chromium.launch(channel=ch, headless=True) if ch else pw.chromium.launch(headless=True)
    BROWSER = f'{"Chrome" if ch else "Chromium (Playwright 自带)"} {browser.version}'
    page_errors = []
    sessions = {}
    def login(user, viewport=None):
        ctx = browser.new_context(viewport=viewport or {'width': 1366, 'height': 900})
        p = ctx.new_page()
        p.on('pageerror', lambda e: page_errors.append(f'{user}: {e}'))
        p.on('dialog', lambda d: d.accept())
        p.goto(BASE + '/login')
        p.fill('input[name=username]', user); p.fill('input[name=password]', PW[user])
        p.click('button[type=submit]'); p.wait_for_url(BASE + '/')
        return p
    def S(user):
        if user not in sessions: sessions[user] = login(user)
        return sessions[user]
    def get(user, url):
        r = S(user).request.get(BASE + url); return r.status, r.text()
    def post(user, url, form, multipart=False):
        p = S(user)
        r = (p.request.post(BASE + url, multipart=form, headers={'origin': BASE}) if multipart
             else p.request.post(BASE + url, form=form, headers={'origin': BASE}))
        html = r.text()
        k, t = flash(html)
        return {'status': r.status, 'url': r.url, 'ok': t if k == 'ok' else None, 'err': t if k == 'err' else None, 'html': html}
    def show(user, cid): return get(user, f'/cases/{cid}')[1]
    def case_ids(user):
        return sorted(set(int(x) for x in re.findall(r'<a class="mono" href="/cases/(\d+)">', get(user, '/cases')[1])))

    # ---------------- 版本门槛（线上测试前必须是 v1.11.0） ----------------
    anon = pw.request.new_context(); _r = anon.get(BASE + '/login'); st, lg = _r.status, _r.text()
    ver = (re.search(r'v(\d+\.\d+\.\d+) · <a href="/version">', lg) or [None, None])[1]
    rec('VERSION', '登录页版本号 v1.11.0（线上测试的前提）', ver == '1.11.0', f'HTTP {st}; 登录页 v{ver}; {BASE}; 浏览器 {BROWSER}')
    if ver != '1.11.0':
        json.dump(results, open(OUT / 'smoke.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1); sys.exit('version gate failed')

    # ================= A 部分 =================
    def a1():
        p = browser.new_context().new_page(); p.goto(BASE + '/login'); html = p.content()
        login_ok = 'v1.11.0' in html and 'Demo environment — use made-up data only.' in html
        p.screenshot(path=str(SHOTS / 'A-1-login.png'))
        pages = ['/', '/cases', '/cases/2', '/debtors', '/tasks', '/reports', '/commissions', '/settings', '/audit-log']
        miss = [u for u in pages if 'Demo environment — use made-up data only.' not in get('admin', u)[1]]
        rec('A-1', '登录页显示 v1.11.0 和红色提示；登录后每个页面顶部也有这条提示', login_ok and not miss and 'class="alert is-red">Demo environment' in lg,
            f'登录页 v1.11.0 + 提示={login_ok}（红色 alert is-red）；登录后 {len(pages)} 页缺提示: {miss or "无"}')
    run('A-1', '版本 + 演示提示', a1)

    def a2():
        p = S('agent2'); p.goto(BASE + '/cases/14'); html = p.content()
        p.click('button[aria-label=Records]'); p.wait_for_timeout(200)
        p.screenshot(path=str(SHOTS / 'A-2-case14-records.png'), full_page=True)
        rows = sched(html)
        arr = [r for r in rows if r['arrears']]; reg = [r for r in rows if not r['arrears']]
        rs = strip(section(html, 'Restructure History'))
        eff = add_days(-10)
        hist = re.search(r'(\d{4}-\d{2}-\d{2}) · ([\d.]+%/month) · (\d+) months', rs)
        small = lsmall(html, 'Overdue')
        ok = (small == 'up to date' and 'Overdue' not in [r['status'] for r in rows] and len(arr) == 1 and 'Arrears (carried)' in html
              and reg and arr[0]['due'] == reg[0]['due'] and hist and hist.group(1) == eff and hist.group(2) == '1.2%/month' and hist.group(3) == '18')
        rec('A-2', 'up to date；挂账行“Arrears (carried)”与新计划第一期同日到期；重组 10 天前、1.2%/月、18 个月', ok,
            f'Overdue 小字="{small}"；挂账行 {arr[0]["due"] if arr else None} RM {arr[0]["expected"] if arr else None} vs 第一期 {reg[0]["due"] if reg else None}；'
            f'计划状态 {sorted(set(r["status"] for r in rows))}；重组历史 {hist.group(0) if hist else rs[:120]}（期望生效日 {eff}）')
    run('A-2', '案件 14 up to date', a2)

    def a3():
        p = S('agent2'); p.goto(BASE + '/cases/2'); html = p.content()
        p.screenshot(path=str(SHOTS / 'A-3-case2-ledger.png'))
        big = re.search(r'ledger-lead">\s*<div class="ledger-lbl">([^<]+)', html)
        settle = lead(html); cb = lval(html, 'Contract Balance'); od = lval(html, 'Overdue'); sm = lsmall(html, 'Overdue')
        ok = big and big.group(1).strip() == 'Settlement Today' and cb and 'incl. interest not yet due' in html and od is not None and sm and (sm == 'up to date' or re.match(r'\d+ days? past due', sm)) and num(od) <= settle
        rec('A-3', '最大的数字是 Settlement Today；旁边 Contract Balance（含未到期利息）与逾期情况；逾期 ≤ 今日结清额', bool(ok),
            f'主数字标签="{big.group(1).strip() if big else None}" RM {money(settle) if settle else None}；Contract Balance {cb}；Overdue {od}（{sm}）')
    run('A-3', '案件 2 主数字', a3)

    def a4():
        h5 = show('agent1', 5)
        sel = re.search(r'<select name="status"[^>]*>([\s\S]*?)</select>', h5)
        opts = re.findall(r'<option value="(\w+)"', sel.group(1)) if sel else []
        h17 = show('agent1', 17); h10 = show('agent2', 10)
        lock = lambda h: 'name="status"' not in h and 'only a manager can change it' in h
        S('agent1').goto(BASE + '/cases/17'); S('agent1').screenshot(path=str(SHOTS / 'A-4-agent1-case17.png'))
        ok = opts == ['new', 'assigned', 'negotiation', 'ptp', 'partial_paid'] and lock(h17) and lock(h10)
        rec('A-4', '案件 5 下拉只有 New/Assigned/Negotiation/PTP/Partial Paid；案件 17、10 无下拉，显示“only a manager can change it”', ok,
            f'案件5 选项={opts}；案件17 锁定={lock(h17)}；案件10(agent2) 锁定={lock(h10)}')
    run('A-4', 'agent 状态权限', a4)

    def a5():
        p = S('admin'); p.goto(BASE + '/settings')
        p.fill('input[name=max_annual_rate]', '24')
        blocked = not p.evaluate("document.querySelector('input[name=max_annual_rate]').checkValidity()")
        vmsg = p.evaluate("document.querySelector('input[name=max_annual_rate]').validationMessage")
        p.click('form[action="/settings"] button[type=submit]'); p.wait_for_timeout(300)
        stayed = p.url.endswith('/settings') and p.input_value('input[name=max_annual_rate]') == '24'
        srv24 = post('admin', '/settings', {'company_name': '', 'max_annual_rate': '24'}, multipart=True)
        p.goto(BASE + '/settings'); p.fill('input[name=max_annual_rate]', '12')
        with p.expect_navigation(): p.click('form[action="/settings"] button[type=submit]')
        k12, t12 = flash(p.content()); p.goto(BASE + '/settings'); h12 = p.content()
        p.screenshot(path=str(SHOTS / 'A-5-settings-cap12.png'), full_page=True)
        box = re.search(r'Open loans above the 12% p\.a\. cap:[^<]*', strip(h12))
        aud = strip(get('admin', '/audit-log')[1])
        a = re.search(r'max_annual_rate: 18 → 12', aud)
        p.fill('input[name=max_annual_rate]', '18')
        with p.expect_navigation(): p.click('form[action="/settings"] button[type=submit]')
        p.goto(BASE + '/settings'); h18 = p.content()
        gone = 'Open loans above' not in h18 and p.input_value('input[name=max_annual_rate]') == '18'
        ok = blocked and stayed and srv24['err'] and k12 == 'ok' and box and a and gone
        rec('A-5', '24 被拒（浏览器先拦截）；12 保存成功并出现红框“Open loans above the 12% p.a. cap: …”；审计“max_annual_rate: 18 → 12”；改回 18 后红框消失', bool(ok),
            f'浏览器拦截 24={blocked}（"{vmsg}"），提交后停留={stayed}；服务端直接提交 24 → {srv24["err"]}；12 → {t12}；红框="{box.group(0)[:160] if box else None}"；'
            f'审计={a.group(0) if a else None}；改回 18 后红框消失={gone}')
    run('A-5', '利率上限设置', a5)

    debtor_any = None
    def a6():
        global debtor_any
        f = get('manager', '/cases/new')[1]
        debtor_any = re.findall(r'<option value="(\d+)"', f[f.find('name="debtor_id"'):f.find('</select>', f.find('name="debtor_id"'))])[0]
        before = len(case_ids('manager'))
        base = {'debtor_id': debtor_any, 'agent_id': '', 'principal_amount': '10000', 'loan_start_date': add_days(-1), 'priority': 'medium', 'status': 'new', 'remark': 'A-6 冒烟（虚构）'}
        r1 = post('manager', '/cases', {**base, 'interest_mode': 'fixed', 'interest_amount': '200', 'tenure': ''})
        r2 = post('manager', '/cases', {**base, 'interest_mode': 'monthly', 'interest_rate': '1.5', 'tenure': ''})
        r3 = post('manager', '/cases', {**base, 'interest_mode': 'monthly', 'interest_rate': '1.5004', 'tenure': '12'})
        after = len(case_ids('manager'))
        need = 'Tenure is required for a loan that charges interest'
        ok = r1['err'] == need and r2['err'] == need and r3['err'] and 'exceeds the 18% p.a. limit' in r3['err'] and after == before
        rec('A-6', '①② 提示“Tenure is required for a loan that charges interest”；③ 因超过 18% p.a. 被拒；三次都没有建成案件', ok,
            f'① {r1["err"]}；② {r2["err"]}；③ {r3["err"]}；案件数 {before} → {after}',
            '③ 的提示写“this loan: 18% p.a.”（实际 18.0048%），数字被四舍五入，读者可能看不懂为何 18% 超过 18%' if r3['err'] and 'this loan: 18% p.a.' in r3['err'] else '')
    run('A-6', '新建案件：期限必填与利率上限', a6)

    def a7():
        p = S('manager'); p.goto(BASE + '/cases/19')
        n0 = len(payment_rows(p.content()))
        p.click('button:has-text("Record Payment")')
        p.fill('#dlg-payment input[name=payment_date]', iso(TODAY)); p.fill('#pay-amount', '10.00')
        p.fill('#dlg-payment input[name=reference]', 'A-7 smoke')
        disabled = p.evaluate("""() => new Promise(res => { const b = document.querySelector('#dlg-payment button[type=submit]');
            b.click(); setTimeout(() => { const d = b.disabled; b.click(); res(d); }, 5); })""")
        p.wait_for_load_state('load'); p.wait_for_timeout(800)
        p.goto(BASE + '/cases/19'); rows = payment_rows(p.content())
        mine = [r for r in rows if r[2] == '10.00' and r[1] == iso(TODAY)]
        p.click('button[aria-label=Records]'); p.screenshot(path=str(SHOTS / 'A-7-case19-payments.png'))
        rec('A-7', '提交后按钮变灰；快速双击只生成一笔还款、一个收据号', disabled and len(rows) == n0 + 1 and len(mine) == 1,
            f'第一次点击后按钮 disabled={disabled}；还款行 {n0} → {len(rows)}；今日 10.00 的还款 {[(r[0], r[2]) for r in mine]}')
        # 服务端兜底：10 秒内同金额、同日期、同 Reference 再提交一次
        r = post('manager', '/cases/19/payments', {'payment_date': iso(TODAY), 'amount': '10.00', 'method': 'bank_transfer', 'reference': 'A-7 smoke', 'bank': ''})
        rows2 = payment_rows(show('manager', 19))
        rec('A-7b', '（服务端）10 秒内同金额同日期同 Reference 再提交只记一笔', len(rows2) == len(rows), f'再提交 → {r["ok"] or r["err"]}；还款行 {len(rows)} → {len(rows2)}')
    run('A-7', '防重复提交', a7)

    def a8():
        e = get('manager', '/cases/19/edit')[1]
        start = (re.search(r'name="loan_start_date" value="([\d-]+)"', e) or [None, None])[1]
        h = show('manager', 19)
        on_detail = 'Loan Start Date' in h
        day = iso(datetime.date.fromisoformat(start) - datetime.timedelta(days=1))
        n0 = len(payment_rows(h))
        r = post('manager', '/cases/19/payments', {'payment_date': day, 'amount': '5.00', 'method': 'cash', 'reference': 'A-8'})
        n1 = len(payment_rows(show('manager', 19)))
        want = f'Payment date cannot be before the loan start date ({start})'
        rec('A-8', '提示“Payment date cannot be before the loan start date (日期)”，没有入账', r['err'] == want and n1 == n0,
            f'起始日 {start}，填 {day} → {r["err"]}；还款行 {n0} → {n1}',
            '' if on_detail else '案件 19 是 Fixed 贷款，详情页不显示 Loan Start Date（只在 Monthly/Annual 显示），清单写“日期填在详情页 Loan Start Date 之前”无法照做；起始日取自 Edit Case 页')
    run('A-8', '起息日前的还款', a8)

    def a9():
        h0 = show('admin', 4)
        pend0 = [r for r in ptp_rows(h0) if r[3] == 'pending']
        p = S('admin'); p.goto(BASE + '/cases/4')
        with p.expect_navigation(): p.select_option('select[name=status]', 'bankruptcy')
        h = p.content(); k, t = flash(h)
        p.screenshot(path=str(SHOTS / 'A-9-case4-bankruptcy.png'))
        tl = [c for typ, c in timeline(h)]
        msg = next((c for c in tl if 'pending promise(s) closed' in c), None)
        st = [r[3] for r in ptp_rows(h)]
        head = h[h.find('head-actions'):h.find('</div>', h.find('head-actions'))]
        gone = {b: (b not in head) for b in ['New PTP', 'New Plan', 'Restructure', 'Log Call']}
        gone['Fulfill'] = 'onclick="openFulfill(' not in h
        ok = k == 'ok' and len(pend0) == 1 and 'pending' not in st and 'broken' in st and msg and msg.startswith('1 pending promise(s) closed: case marked Bankruptcy') and all(gone.values())
        rec('A-9', '原 pending PTP 自动变为 broken；时间线“1 pending promise(s) closed: case marked Bankruptcy”；不再有 New PTP/New Plan/Restructure/Log Call/Fulfill', bool(ok),
            f'{t}；改前 pending {len(pend0)} 条，改后 PTP 状态 {st}；时间线="{msg}"；按钮已隐藏 {gone}')
    run('A-9', '案件 4 改为 Bankruptcy', a9)

    def a10():
        r1 = post('admin', '/tasks/new', {'case_id': '4', 'agent_id': '', 'type': 'follow_up', 'title': 'A-10 follow up (smoke)', 'due_date': add_days(2), 'notes': ''})
        r2 = post('admin', '/tasks/new', {'case_id': '4', 'agent_id': '', 'type': 'legal', 'title': 'A-10 legal (smoke)', 'due_date': add_days(2), 'notes': ''})
        h = show('admin', 4)
        ok = r1['err'] == 'Only legal tasks can be added to a bankrupt or deceased case' and r2['ok'] and 'A-10 legal (smoke)' in h and 'A-10 follow up (smoke)' not in h
        rec('A-10', 'follow_up 被拒（“Only legal tasks can be added to a bankrupt or deceased case”）；legal 任务可以建', ok, f'follow_up → {r1["err"]}；legal → {r2["ok"] or r2["err"]}')
    run('A-10', '冻结案件只能建 legal 任务', a10)

    def a11():
        p = S('admin'); p.goto(BASE + '/cases/4')
        p.click('button:has-text("Record Payment")')
        p.fill('#dlg-payment input[name=payment_date]', iso(TODAY)); p.fill('#pay-amount', '20.00')
        req = p.evaluate("document.querySelector('#dlg-payment input[name=remark]') && document.querySelector('#dlg-payment input[name=remark]').required")
        blocked = not p.evaluate("document.querySelector('#dlg-payment form').checkValidity()")
        p.click('#dlg-payment button[type=submit]'); p.wait_for_timeout(200)
        still_open = p.evaluate("document.getElementById('dlg-payment').open")
        p.fill('#dlg-payment input[name=remark]', 'Trustee distribution')
        with p.expect_navigation(): p.click('#dlg-payment button[type=submit]')
        h = p.content(); k, t = flash(h)
        rows = payment_rows(h); in_remark = any(r[4] == 'Trustee distribution' for r in rows)
        in_tl = any('Trustee distribution' in c for _, c in timeline(h))
        aud = strip(get('admin', '/audit-log')[1]); in_aud = 'Trustee distribution' in aud
        p.click('button[aria-label=Records]'); p.screenshot(path=str(SHOTS / 'A-11-case4-payment-remark.png'))
        rec('A-11', '弹窗 Reason 必填（不填时浏览器拦截）；提交后原因显示在 Payments 的 Remark 列、时间线和 Audit Log', bool(req and blocked and still_open and k == 'ok' and in_remark and in_tl and in_aud),
            f'Reason required={req}，空 Reason 浏览器拦截={blocked}（弹窗仍开={still_open}）；提交 → {t}；Remark 列={in_remark}；时间线={in_tl}；审计={in_aud}')
    run('A-11', '破产案件收款原因', a11)

    def a12():
        p = S('admin'); p.goto(BASE + '/cases/4')
        p.select_option('select[name=status]', 'negotiation')
        with p.expect_navigation(): p.click('form.status-inline button[type=submit]')
        k1, t1 = flash(p.content())
        p.select_option('select[name=status]', 'negotiation'); p.fill('form.status-inline input[name=reason]', 'Bankruptcy order annulled (smoke test)')
        with p.expect_navigation(): p.click('form.status-inline button[type=submit]')
        h = p.content(); k2, t2 = flash(h)
        badge = re.search(r'<h1>[^<]*<span class="badge[^"]*"><span class="dot"></span>([^<]+)</span>', h)
        aud = strip(get('admin', '/audit-log')[1]); in_aud = 'Bankruptcy order annulled (smoke test)' in aud
        ok = t1 == 'A reason is required to lift Bankruptcy' and k2 == 'ok' and badge and badge.group(1) == 'Negotiation' and in_aud
        rec('A-12', '不填原因提示“A reason is required to lift Bankruptcy”；填了可以改，审计记下原因', bool(ok),
            f'不填 → {t1}；填了 → {t2}，状态 {badge.group(1) if badge else None}；审计含原因={in_aud}')
    run('A-12', '解除 Bankruptcy 须填原因', a12)

    def a13():
        p = S('manager'); p.goto(BASE + '/cases/20')
        p.click('button:has-text("Restructure")')
        p.select_option('#rs-mode', 'fixed'); p.fill('#dlg-restructure input[name=interest_amount]', '500')
        p.fill('#dlg-restructure input[name=tenure]', '12'); p.fill('#dlg-restructure textarea[name=reason]', 'A-13 smoke')
        with p.expect_navigation(): p.click('#dlg-restructure button[type=submit]')
        k, t = flash(p.content())
        want = 'A rate-based loan cannot be restructured to a fixed amount (pending legal review)'
        rec('A-13', '提示“A rate-based loan cannot be restructured to a fixed amount (pending legal review)”', t == want, f'{k}: {t}')
    run('A-13', 'Monthly 重组为 Fixed 被拒', a13)

    def a14():
        n0 = len(page_errors)
        p = S('manager'); p.goto(BASE + '/cases/new')
        p.select_option('#interest_mode', 'monthly'); p.click('#interest_help')
        shown = p.is_visible('#interest_formula'); txt = {}
        for m in ['fixed', 'monthly', 'daily']:
            p.select_option('#interest_mode', m); p.wait_for_timeout(100); txt[m] = p.inner_text('#interest_formula') if p.is_visible('#interest_formula') else '(hidden)'
        p.select_option('#interest_mode', 'monthly')
        p.screenshot(path=str(SHOTS / 'A-14-formula.png'))
        mo = txt['monthly']
        ok = shown and 'remaining principal × monthly% for each full month' in mo and 'pro-rated by the actual days in that month' in mo and '÷ 30' not in mo and len(page_errors) == n0
        rec('A-14', 'Monthly 说明为“remaining principal × monthly% for each full month … pro-rated by the actual days in that month”；切换正常，没有脚本错误', ok,
            f'点“!”显示={shown}；monthly="{mo[:260]}"；fixed="{txt["fixed"][:80]}"；daily="{txt["daily"][:80]}"；脚本错误 {page_errors[n0:] or "无"}')
    run('A-14', '公式说明', a14)

    def a15():
        p = login('admin', {'width': 375, 'height': 800})
        res = {}
        for u in ['/', '/cases', '/cases/2', '/cases/14', '/tasks', '/reports']:
            p.goto(BASE + u); res[u] = p.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        p.goto(BASE + '/')
        box = p.evaluate("""() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('Upcoming Follow-ups'));
            if (!h) return null; let t = h.nextElementSibling; while (t && !t.querySelector('table') && t.tagName !== 'TABLE') t = t.nextElementSibling;
            if (!t) return 'no table'; const tb = t.tagName === 'TABLE' ? t : t.querySelector('table'); const w = tb.parentElement; const cs = getComputedStyle(w);
            return {overflowX: cs.overflowX, scroll: w.scrollWidth, client: w.clientWidth, tableWidth: tb.scrollWidth}; }""")
        p.screenshot(path=str(SHOTS / 'A-15-dashboard-375.png'), full_page=True)
        p.click('.nav-toggle'); opened = p.evaluate("document.body.classList.contains('nav-open')")
        p.screenshot(path=str(SHOTS / 'A-15-menu-375.png'))
        p.click('.nav-backdrop', position={'x': 360, 'y': 400}); closed = not p.evaluate("document.body.classList.contains('nav-open')")
        p.goto(BASE + '/cases/2'); p.screenshot(path=str(SHOTS / 'A-15-case2-375.png'), full_page=True)
        inbox = isinstance(box, dict) and box['overflowX'] in ('auto', 'scroll')
        rec('A-15', '375px：没有横向滚动；Upcoming Follow-ups 表格在框内滚动；☰ 能打开和关闭侧栏', all(res.values()) and inbox and opened and closed,
            f'无横向滚动={res}；Upcoming 表格容器={box}；☰ 打开={opened} 关闭={closed}')
        p.context.close()
    run('A-15', '375px 窄屏', a15)

    # ================= B 部分 =================
    def b1():
        menus = {}
        expect = {
            'admin': ['Dashboard', 'Debtors', 'Cases', 'Tasks', 'Agents', 'Users', 'Reports', 'Commissions', 'Settings', 'Demo Data', 'Audit Log', 'Search'],
            'manager': ['Dashboard', 'Debtors', 'Cases', 'Tasks', 'Agents', 'Reports', 'Commissions', 'Search'],
            'agent1': ['Dashboard', 'Debtors', 'Cases', 'Tasks', 'Reports', 'Commissions', 'Search'],
            'agent2': ['Dashboard', 'Debtors', 'Cases', 'Tasks', 'Reports', 'Commissions', 'Search'],
            'agent3': ['Dashboard', 'Debtors', 'Cases', 'Tasks', 'Reports', 'Commissions', 'Search'],
            'finance': ['Dashboard', 'Debtors', 'Cases', 'Tasks', 'Reports', 'Commissions', 'Search'],
            'auditor': ['Dashboard', 'Debtors', 'Cases', 'Tasks', 'Agents', 'Reports', 'Commissions', 'Audit Log', 'Search'],
        }
        hrefs = {'Dashboard': '/', 'Debtors': '/debtors', 'Cases': '/cases', 'Tasks': '/tasks', 'Agents': '/agents', 'Users': '/users', 'Reports': '/reports',
                 'Commissions': '/commissions', 'Settings': '/settings', 'Demo Data': '/demo-tools', 'Audit Log': '/audit-log', 'Search': '/search'}
        bad = []
        for u in expect:
            html = get(u, '/')[1]
            side = html[html.find('<aside class="sidebar">'):html.find('</aside>')]
            got = re.findall(r'<a href="[^"]+" class="[^"]*">(?:<svg[\s\S]*?</svg>)?<span class="lbl">([^<]+)</span>', side)
            menus[u] = got
            if got != expect[u]: bad.append(f'{u} 菜单 {got}')
            for name, href in hrefs.items():
                s = get(u, href)[0]
                if (name in expect[u]) != (s == 200): bad.append(f'{u} {href}→{s}')
        rec('B-1', '7 个账号都能登录，菜单与权限一致（菜单里的页面 200，菜单外的 403/404）', not bad,
            f'全部登录成功；菜单: ' + '; '.join(f'{u}={len(m)}项' for u, m in menus.items()) + f'；不一致: {bad or "无"}',
            '手册 v1.2 的权限矩阵不在仓库里；期望值取自《使用手册》第三章角色表 + 侧栏代码')
    run('B-1', '登录与菜单权限', b1)

    def b2():
        out = {}
        for u in ['admin', 'manager', 'agent1', 'finance', 'auditor']:
            s, h = get(u, '/'); t = strip(h)
            out[u] = s == 200 and 'Collected Today' in t and 'Total Outstanding' in t and 'Error' not in re.sub(r'<title>[\s\S]*?</title>', '', h)[:2000] and not re.search(r'NaN|undefined', t)
        S('admin').goto(BASE + '/'); S('admin').screenshot(path=str(SHOTS / 'B-2-dashboard.png'), full_page=True)
        rec('B-2', 'Dashboard 各项数字正常显示，没有报错页', all(out.values()), out)
    run('B-2', 'Dashboard', b2)

    B = {}
    def b3():
        r = post('manager', '/debtors', {'name': 'QA 冒烟 虚构债务人 R3', 'ic_passport': '000000-00-0000', 'company': '', 'phone': '000-0000000', 'email': '', 'address': '', 'employer': '', 'salary': '', 'risk_level': 'medium', 'guarantor_name': '', 'guarantor_phone': '', 'remark': '虚构资料'})
        did = (re.search(r'/debtors/(\d+)', r['url']) or [None, None])[1]
        if not did:
            lst = get('manager', '/debtors?q=' + 'QA%20%E5%86%92%E7%83%9F')[1]; did = re.findall(r'href="/debtors/(\d+)"', lst)[0]
        start = add_months(TODAY, -2)
        rc = post('manager', '/cases', {'debtor_id': did, 'agent_id': '', 'principal_amount': '12000', 'interest_mode': 'monthly', 'interest_rate': '1.5', 'interest_amount': '',
                                         'loan_start_date': iso(start), 'tenure': '12', 'priority': 'medium', 'status': 'assigned', 'remark': 'B-3 冒烟（虚构）'})
        cid = int(re.search(r'/cases/(\d+)$', rc['url']).group(1)); B.update(cid=cid, did=did, start=start)
        h = show('manager', cid); rows = sched(h)
        dues = [r['due'] for r in rows]; want_dues = [iso(add_months(start, i)) for i in range(1, 13)]
        total = round(sum(r['expected'] for r in rows), 2)
        mat = lval(h, 'Maturity Date')
        # 独立预期：合同利息 12000 × 1.5% × 12 = 2160；等额本金 1000/期 + 利息按剩余本金逐月递减（利息优先口径见 INT-02 说明）
        ok = r['ok'] and rc['ok'] == 'Case created' and len(rows) == 12 and dues == want_dues and lval(h, 'Interest') == '2,160.00' and lval(h, 'Contract Balance') == '14,160.00' and abs(total - 14160) < 0.005 and mat == iso(add_months(start, 12))
        rec('B-3', '新建债务人和案件（Monthly 1.5%，12 个月）；还款计划 12 期、到期日逐月、合计 = 本金 + 利息', bool(ok),
            f'债务人 {r["ok"]} #{did}；案件 #{cid} {rc["ok"]}；起始 {iso(start)}；计划 {len(rows)} 期 {dues[0] if dues else None}…{dues[-1] if dues else None}（期望 {want_dues[0]}…{want_dues[-1]}）；'
            f'每期 {[r["expected"] for r in rows[:3]]}…；合计 {total}；Interest {lval(h, "Interest")}；Contract Balance {lval(h, "Contract Balance")}；到期 {mat}')
    run('B-3', '新建债务人与案件', b3)

    def b4():
        cid = B['cid']; h0 = show('manager', cid); cb0 = num(lval(h0, 'Contract Balance'))
        r = post('manager', f'/cases/{cid}/payments', {'payment_date': iso(TODAY), 'amount': '500.00', 'method': 'cash', 'reference': 'B-4', 'bank': ''})
        h = show('manager', cid); st = re.search(r'<h1>[^<]*<span class="badge[^"]*"><span class="dot"></span>([^<]+)</span>', h).group(1)
        cb = num(lval(h, 'Contract Balance')); B['rcpt'] = (re.search(r'RCPT-\d{4}-\d{4}', r['ok'] or '') or [None])[0]
        # 独立预期（利息优先）：今天已计 2 个整月利息 12000×1.5%×2 = 360；500 先冲 360，余 140 冲本金，
        # 剩余 10 期的合同利息少 140×1.5%×10 = 21 → 合同余额降 521
        drop = 500 + (500 - 360) * 0.015 * 10
        ok = r['ok'] and st == 'Partial Paid' and abs(cb0 - cb - drop) < 0.005 and lval(h, 'Paid') == '500.00' and lval(h, 'Interest') == money(2160 - 21)
        rec('B-4', '部分还款后状态 Partial Paid，欠款正确（还 500 → 合同余额降 500 + 提前还本省下的未到期利息 21 = 521）', bool(ok),
            f'{r["ok"] or r["err"]}；状态 {st}；Contract Balance {money(cb0)} → {money(cb)}（降 {money(cb0 - cb)}，独立计算 {money(drop)}）；Interest {lval(h, "Interest")}；Paid {lval(h, "Paid")}')
    run('B-4', '部分还款', b4)

    def b5():
        p = S('manager'); p.goto(BASE + f'/cases/{B["cid"]}')
        settle = lead(p.content())
        p.click('button:has-text("Record Payment")'); p.fill('#dlg-payment input[name=payment_date]', iso(TODAY)); p.fill('#pay-amount', f'{settle + 100:.2f}')
        blocked = not p.evaluate("document.getElementById('pay-amount').checkValidity()"); vm = p.evaluate("document.getElementById('pay-amount').validationMessage")
        p.screenshot(path=str(SHOTS / 'B-5-overpay-dialog.png'))
        p.keyboard.press('Escape')
        srv = post('manager', f'/cases/{B["cid"]}/payments', {'payment_date': iso(TODAY), 'amount': f'{settle + 0.01:.2f}', 'method': 'cash', 'reference': 'B-5 over'})
        # 提前结清：新案件，起始日 = 两个月前同一天 → 已计利息正好 2 个整月 = 10000 × 1.5% × 2 = 300
        start = add_months(TODAY, -2)
        rc = post('manager', '/cases', {'debtor_id': B['did'], 'agent_id': '', 'principal_amount': '10000', 'interest_mode': 'monthly', 'interest_rate': '1.5', 'loan_start_date': iso(start), 'tenure': '12', 'priority': 'medium', 'status': 'assigned', 'remark': 'B-5 提前结清（虚构）'})
        c2 = int(re.search(r'/cases/(\d+)$', rc['url']).group(1)); h = show('manager', c2); s2 = lead(h)
        pay = post('manager', f'/cases/{c2}/payments', {'payment_date': iso(TODAY), 'amount': f'{s2:.2f}', 'method': 'bank_transfer', 'reference': 'B-5 settle'})
        h2 = show('manager', c2); st = re.search(r'<h1>[^<]*<span class="badge[^"]*"><span class="dot"></span>([^<]+)</span>', h2).group(1)
        ok = blocked and srv['err'] == f'Amount exceeds what is owed on {iso(TODAY)}: at most RM {settle:.2f}' and abs(s2 - 10300) < 0.005 and pay['ok'] and st == 'Fully Paid'
        rec('B-5', '超额还款在弹窗内被拦截；提前结清只收到今天为止的利息', bool(ok),
            f'弹窗填 {settle + 100:.2f} 被拦截={blocked}（"{vm}"）；服务端 {settle + 0.01:.2f} → {srv["err"]}；新案件 #{c2}（{iso(start)} 起 10,000 × 1.5%）今日结清额 {money(s2)}（独立计算 10,300.00，合同 11,800.00）→ {pay["ok"] or pay["err"]}，状态 {st}')
    run('B-5', '超额拦截与提前结清', b5)

    def b6():
        cid = B['cid']; h = show('manager', cid)
        pid = re.search(r'data-id="(\d+)" data-amount="500"', h).group(1)
        cb_before = num(lval(h, 'Contract Balance'))
        e = post('manager', f'/cases/{cid}/payments/{pid}', {'payment_date': iso(TODAY), 'amount': '600.00', 'method': 'cheque', 'reference': 'B-6 edited', 'bank': ''})
        h1 = show('manager', cid); cb1 = num(lval(h1, 'Contract Balance'))
        v = post('manager', f'/cases/{cid}/payments/{pid}/void', {})
        h2 = show('manager', cid); cb2 = num(lval(h2, 'Contract Balance'))
        st = re.search(r'<h1>[^<]*<span class="badge[^"]*"><span class="dot"></span>([^<]+)</span>', h2).group(1)
        # 500→600：多出的 100 全冲本金，剩余 10 期利息再少 100×1.5%×10 = 15 → 合同余额再降 115
        ok = e['ok'] and abs(cb_before - cb1 - 115) < 0.005 and v['ok'] and abs(cb2 - 14160) < 0.005 and not payment_rows(h2)
        rec('B-6', '编辑并作废一笔还款，欠款恢复', bool(ok), f'编辑 500→600：{e["ok"] or e["err"]}，Contract Balance {money(cb_before)} → {money(cb1)}（降 {money(cb_before - cb1)}，独立计算 115.00）；作废：{v["ok"] or v["err"]}，→ {money(cb2)}（原 14,160.00），状态 {st}',
            '作废唯一一笔还款后状态仍是 Partial Paid（没有退回 Assigned）' if st == 'Partial Paid' else '')
    run('B-6', '编辑与作废还款', b6)

    def b7():
        p = S('manager'); p.goto(BASE + f'/cases/{B["cid"]}')
        rows = sched(p.content()); settle = lead(p.content())
        pays = [i for i, r in enumerate(rows) if r['action'] and 'payInstallment(' in r['action']]
        first = next(i for i, r in enumerate(rows) if r['out'] > 0)
        want = min(rows[first]['out'], settle)
        p.click('button[aria-label=Records]'); p.click('#dlg-records button:has-text("Pay")')
        opened = p.evaluate("document.getElementById('dlg-payment').open"); val = p.input_value('#pay-amount')
        p.screenshot(path=str(SHOTS / 'B-7-pay-prefill.png'))
        p.keyboard.press('Escape')
        rec('B-7', '还款计划第一期的 Pay 按钮能预填金额', pays == [first] and opened and abs(float(val) - want) < 0.005,
            f'Pay 按钮所在行 {pays}（第一笔未还 {first}）；预填 {val}（期望 min(本期 {rows[first]["out"]}, 结清额 {settle}) = {want}）；弹窗打开={opened}')
    run('B-7', 'Pay 预填', b7)

    def b8():
        cid = B['cid']
        r1 = post('manager', f'/cases/{cid}/ptps', {'amount': '100.00', 'due_date': add_days(3), 'remark': 'B-8'})
        h = show('manager', cid); pid = re.search(r'openFulfill\((\d+), 100\)', h).group(1)
        r2 = post('manager', f'/ptps/{pid}/fulfill', {'amount': '100.00', 'payment_date': iso(TODAY), 'method': 'cash'})
        h = show('manager', cid); st1 = [r[3] for r in ptp_rows(h)]
        r3 = post('manager', f'/cases/{cid}/ptp-plans', {'total_amount': '300.00', 'num_installments': '3', 'first_due_date': add_days(7)})
        h = show('manager', cid); plan = re.search(r'/ptp-plans/([\w-]+)/cancel', h).group(1)
        r4 = post('manager', f'/cases/{cid}/ptp-plans/{plan}/cancel', {})
        h = show('manager', cid); rows = ptp_rows(h)
        inst = [r[3] for r in rows if '/' in r[0]]
        ok = r1['ok'] and r2['ok'] and 'fulfilled' in st1 and r3['ok'] and r4['ok'] and inst == ['broken'] * 3 and len(payment_rows(h)) == 1
        rec('B-8', '新建 PTP → 履行（自动记一笔还款）→ 新建分期计划 → 取消计划（各期变 broken）', bool(ok),
            f'PTP {r1["ok"] or r1["err"]}；履行 {r2["ok"] or r2["err"]}；计划 {r3["ok"] or r3["err"]}；取消 {r4["ok"] or r4["err"]}；分期状态 {inst}；还款行 {len(payment_rows(h))}')
    run('B-8', 'PTP 与分期计划', b8)

    def b9():
        start = add_months(TODAY, -3)
        rc = post('manager', '/cases', {'debtor_id': B['did'], 'agent_id': '', 'principal_amount': '10000', 'interest_mode': 'monthly', 'interest_rate': '1.5', 'loan_start_date': iso(start), 'tenure': '12', 'priority': 'medium', 'status': 'assigned', 'remark': 'B-9 重组（虚构）'})
        cid = int(re.search(r'/cases/(\d+)$', rc['url']).group(1))
        pay_day = iso(add_months(TODAY, -1))
        post('manager', f'/cases/{cid}/payments', {'payment_date': pay_day, 'amount': '300.00', 'method': 'cash', 'reference': 'B-9'})
        h0 = show('manager', cid); cb0 = lval(h0, 'Contract Balance')
        dlg = h0[h0.find('id="dlg-restructure"'):h0.find('</dialog>', h0.find('id="dlg-restructure"'))]
        eff = re.search(r'name="effective_date" min="([\d-]+)" max="([\d-]+)" value="([\d-]+)"', dlg)
        r = post('manager', f'/cases/{cid}/restructures', {'effective_date': eff.group(3), 'interest_mode': 'monthly', 'interest_rate': '1.2', 'interest_amount': '', 'tenure': '12', 'reason': 'B-9 smoke'})
        h = show('manager', cid)
        locked = 'Locked · restructured' in section(h, 'Payments')
        pid = re.search(r'/cases/\d+/payments/(\d+)/void', h0).group(1)
        e = post('manager', f'/cases/{cid}/payments/{pid}', {'payment_date': pay_day, 'amount': '200.00', 'method': 'cash', 'reference': 'B-9 edit'})
        v = post('manager', f'/cases/{cid}/payments/{pid}/void', {})
        rid = re.search(r'/restructures/(\d+)/undo', h).group(1)
        u = post('manager', f'/cases/{cid}/restructures/{rid}/undo', {})
        h2 = show('manager', cid)
        ok = r['ok'] == 'Restructured' and locked and e['err'] and v['err'] and u['ok'] == 'Restructure undone' and lval(h2, 'Contract Balance') == cb0 and 'Restructure History' not in h2
        rec('B-9', '重组 → 生效日前的还款被锁定（不能编辑/作废）→ 撤销后恢复原条款', bool(ok),
            f'案件 #{cid}；生效日 {eff.group(3)}（可选 {eff.group(1)}…{eff.group(2)}）→ {r["ok"] or r["err"]}；Payments 显示 Locked={locked}；改锁定还款 → {e["err"]}；作废 → {v["err"]}；'
            f'撤销 → {u["ok"] or u["err"]}；Contract Balance {cb0} → {lval(h2, "Contract Balance")}')
    run('B-9', '重组、锁定、撤销', b9)

    def b10():
        cid = B['cid']
        c = post('manager', f'/cases/{cid}/calls', {'result': 'answered', 'duration_seconds': '45', 'notes': 'B-10 call'})
        n = post('manager', f'/cases/{cid}/notes', {'content': 'B-10 note'})
        s = post('manager', f'/cases/{cid}/status', {'status': 'negotiation'})
        tl = timeline(show('manager', cid))
        top = [t for t, _ in tl[:3]]
        ok = c['ok'] and n['ok'] and s['ok'] and top == ['status_change', 'note', 'call'] and 'B-10 note' in tl[1][1] and 'negotiation' in tl[0][1]
        rec('B-10', '记一次通话、加一条备注、修改状态，时间线正确（最新在上）', bool(ok), f'通话 {c["ok"] or c["err"]}；备注 {n["ok"] or n["err"]}；状态 {s["ok"] or s["err"]}；时间线前 3 条 {[(t, x[:60]) for t, x in tl[:3]]}')
    run('B-10', '通话、备注、状态', b10)

    def b11():
        cid = B['cid']
        r = post('manager', '/tasks/new', {'case_id': str(cid), 'agent_id': '', 'type': 'follow_up', 'title': 'B-11 smoke task', 'due_date': add_days(2), 'notes': ''})
        h = get('manager', '/tasks?status=pending')[1]
        tid = re.search(r'data-id="(\d+)"[^>]*data-title="B-11 smoke task"', h) or re.search(r'B-11 smoke task[\s\S]*?/tasks/(\d+)/complete', h)
        c = post('manager', f'/tasks/{tid.group(1)}/complete', {})
        rows = re.findall(r'<tr><td>B-11 smoke task</td><td>[^<]*</td>\s*<td><span class="badge [^"]*">([^<]+)</span>', show('manager', cid))
        rec('B-11', '新建并完成一个任务', bool(r['ok'] and c['ok'] and rows == ['done']), f'新建 {r["ok"] or r["err"]}；完成 {c["ok"] or c["err"]}；案件 Records 里任务状态 {rows}')
    run('B-11', '任务', b11)

    def b12():
        s, h = get('admin', '/reports')
        out = {}
        for k, fn in [('cases', 'cases-detailed.csv'), ('outstanding', 'outstanding-by-status.csv'), ('performance', 'agent-performance.csv')]:
            r = S('admin').request.get(BASE + '/reports?export=' + k)
            body = r.text(); cd = r.headers.get('content-disposition', '')
            out[k] = (r.status, fn in cd, 'csv' in r.headers.get('content-type', ''), body.splitlines()[0][:80] if body else '', len(body.splitlines()))
        ok = s == 200 and 'Error' not in strip(h)[:300] and all(v[0] == 200 and v[1] and v[2] and v[4] > 1 for v in out.values())
        rec('B-12', '报表页正常显示，三个 CSV 都能下载', ok, f'/reports {s}；' + '；'.join(f'{k}: HTTP {v[0]} 文件名={v[1]} csv={v[2]} 表头="{v[3]}" {v[4]} 行' for k, v in out.items()))
    run('B-12', '报表与 CSV', b12)

    def b13():
        month = iso(TODAY)[:7]
        h = get('finance', f'/commissions?month={month}')[1]
        btn = re.findall(r'data-agent-id="(\d+)" data-name="([^"]+)" data-pending="([\d.]+)"', h)
        cand = [b for b in btn if float(b[2]) >= 1]
        if not cand: rec('B-13', '佣金结算与作废', 'BLOCKED', f'本月没有待结算佣金的催收员：{btn}'); return
        aid, name, pend = cand[0]
        r = post('finance', '/commissions/settle', {'agent_id': aid, 'period': month, 'amount': '1.00', 'note': 'B-13 smoke'})
        h2 = get('finance', f'/commissions?month={month}')[1]
        # 只作废本脚本这笔（按 Note 定位），不碰其它结算
        sid = re.search(r'<td>B-13 smoke</td>[\s\S]*?/commissions/(\d+)/void', h2)
        v = post('finance', f'/commissions/{sid.group(1)}/void', {}) if sid else {'ok': None, 'err': 'no void button for B-13 smoke'}
        h3 = get('finance', f'/commissions?month={month}')[1]
        pend3 = dict(re.findall(r'data-agent-id="(\d+)" data-name="[^"]+" data-pending="([\d.]+)"', h3))
        ok = r['ok'] and v['ok'] and abs(float(pend3.get(aid, -1)) - float(pend)) < 0.005
        rec('B-13', '佣金结算与作废（作废后待结算金额恢复）', bool(ok), f'{name} 待结算 {pend}；结算 1.00 → {r["ok"] or r["err"]}；作废 → {v["ok"] or v["err"]}；作废后待结算 {pend3.get(aid)}')
    run('B-13', '佣金', b13)

    def b14():
        out = {}
        for cid in [2, 5, 14]:
            p = S('admin'); p.goto(BASE + f'/cases/{cid}/statement')
            hidden = p.evaluate("""() => { const e = document.querySelector('.stmt-actions'); if (!e) return null; const before = getComputedStyle(e).display; return before; }""")
            p.emulate_media(media='print')
            hid_print = p.evaluate("(() => { const e = document.querySelector('.stmt-actions'); return e ? getComputedStyle(e).display : null; })()")
            path = SHOTS / f'statement-case{cid}.pdf'
            p.pdf(path=str(path), format='A4', print_background=True)
            p.emulate_media(media='screen')
            out[cid] = (hidden, hid_print, path.stat().st_size, 'window.print()' in p.content())
        ok = all(v[0] not in (None, 'none') and v[1] == 'none' and v[2] > 10000 and v[3] for v in out.values())
        rec('B-14', '对账单可以打印（打印时隐藏按钮，生成 A4 PDF）', ok, '；'.join(f'案件 {k}: 屏幕按钮 display={v[0]}，打印 display={v[1]}，PDF {v[2]} 字节' for k, v in out.items()))
    run('B-14', '对账单打印', b14)

    def b15():
        s, h = get('agent1', '/cases/2')
        listed = 2 in case_ids('agent1')
        rec('B-15', 'agent1 直接访问 /cases/2 被拒绝', s in (403, 404) and not listed, f'HTTP {s}；agent1 的案件列表含 2={listed}；agent1 列表 {case_ids("agent1")}')
    run('B-15', '行级权限', b15)

    def b16():
        h = show('auditor', 2)
        head = h[h.find('head-actions'):h.find('</div>', h.find('head-actions'))]
        ui = {b: (b in head) for b in ['Record Payment', 'Restructure', 'New PTP', 'New Plan', 'Log Call', 'Edit Case']}
        ui['status select'] = 'name="status"' in h; ui['add note'] = 'class="add-note"' in h
        srv = [S('auditor').request.post(BASE + u, form=f, headers={'origin': BASE}, max_redirects=0).status for u, f in
               [('/cases/2/payments', {'payment_date': iso(TODAY), 'amount': '1', 'method': 'cash'}), ('/cases/2/notes', {'content': 'x'}), ('/cases/2/status', {'status': 'negotiation'}), ('/cases/2/ptps', {'amount': '1', 'due_date': add_days(1)})]]
        rec('B-16', 'auditor 的案件页只读', not any(ui.values()) and all(x == 403 for x in srv), f'界面元素出现 {ui}；直接 POST 状态码 {srv}；Print statement 可见={"Print statement" in head}')
    run('B-16', 'auditor 只读', b16)

    def b17():
        t = strip(get('admin', '/audit-log')[1])
        want = {'利率上限': 'max_annual_rate: 18 → 12', '冻结原因收款': 'Trustee distribution', '解除破产原因': 'Bankruptcy order annulled (smoke test)', 'B-3 案件': 'Created case', '还款': 'Recorded payment', '作废': 'Voided', '重组撤销': 'ndo'}
        got = {k: (v in t) for k, v in want.items()}
        rec('B-17', 'Audit Log 有本次测试操作的记录', all(got.values()), got)
    run('B-17', '审计', b17)

    rec('JS-ERRORS', '全程没有页面脚本错误', not page_errors, page_errors[:5] or '无')
    browser.close()

json.dump(results, open(OUT / 'smoke.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
c = {}
for r in results: c[r['result']] = c.get(r['result'], 0) + 1
print('smoke', c)
