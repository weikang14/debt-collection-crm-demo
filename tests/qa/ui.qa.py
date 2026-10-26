# 界面用例（需要真实浏览器）：Playwright + 本机 Chrome（channel="chrome"），可选 Edge。
# Run: python tests/qa/ui.qa.py      （服务 :3301，库 data/qa/tester.db；脚本开头会重新 seed）
import json, os, re, subprocess, sys, time, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / 'data' / 'qa' / 'tester.db'
BASE = 'http://127.0.0.1:3301'
OUT = ROOT / 'tests' / 'qa' / 'results'
OUT.mkdir(parents=True, exist_ok=True)
assert str(DB).endswith(os.path.join('data', 'qa', 'tester.db'))
subprocess.run(['node', '--no-warnings', 'src/db/seed.js'], cwd=ROOT, env={**os.environ, 'CRM_DB_PATH': str(DB)}, check=True, capture_output=True)

PW = {'admin': 'admin123', 'manager': 'manager123', 'agent1': 'agent123', 'finance': 'finance123', 'auditor': 'auditor123'}
results = []

def rec(cid, expected, ok, actual, note=''):
    results.append({'id': cid, 'expected': expected, 'actual': str(actual)[:400], 'result': 'PASS' if ok else 'FAIL', 'note': note})
    print(('PASS ' if ok else 'FAIL ') + cid + ' :: ' + str(actual)[:200])

def today():
    return time.strftime('%Y-%m-%d', time.gmtime(time.time() + 8 * 3600))

def login(ctx, user):
    page = ctx.new_page()
    page.goto(BASE + '/login')
    page.fill('input[name=username]', user)
    page.fill('input[name=password]', PW[user])
    page.click('button[type=submit]')
    page.wait_for_url(BASE + '/')
    return page

def post(page, url, form):
    # 用浏览器同一会话发表单（不跟随重定向，便于读取 ok/err）
    r = page.request.post(BASE + url, form=form, max_redirects=0)
    return r.headers.get('location', '')

def is_open(page, sel):
    return page.eval_on_selector(sel, 'd => d.open')

def run(name, fn):
    try:
        fn()
    except Exception as e:
        rec(name, '执行无异常', False, 'BLOCKED/异常: ' + repr(e)[:300])
        traceback.print_exc()

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    ctx = browser.new_context()
    admin = login(ctx, 'admin')
    errors = []
    admin.on('pageerror', lambda e: errors.append(str(e)))

    def nav02():
        pg = admin
        pg.goto(BASE + '/')
        pg.evaluate("localStorage.clear()"); pg.reload()
        team = '.sidebar .grp[data-grp=team]'
        c0 = 'open' in pg.get_attribute(team, 'class')
        pg.click(team + ' .grp-head'); c1 = 'open' in pg.get_attribute(team, 'class')
        pg.goto(BASE + '/cases'); c2 = 'open' in pg.get_attribute(team, 'class')
        pg.reload(); c3 = 'open' in pg.get_attribute(team, 'class')
        pg.click(team + ' .grp-head'); pg.goto(BASE + '/reports'); c4 = 'open' in pg.get_attribute(team, 'class')
        pg.goto(BASE + '/agents'); c5 = 'open' in pg.get_attribute(team, 'class')
        ok = (not c0) and c1 and c2 and c3 and (not c4) and c5
        rec('NAV-02', '保留上次展开状态；当前页所在分组始终展开', ok, f'初始={c0} 点开={c1} 换页={c2} 刷新={c3} 收起后换页={c4} 进入/agents(已存收起)={c5}')
    run('NAV-02', nav02)

    def nav04():
        m = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
        pg = login(m, 'admin')
        topbar = pg.is_visible('.mobile-topbar'); btn = pg.is_visible('.nav-toggle')
        pg.click('.nav-toggle'); time.sleep(0.6); opened = pg.evaluate("document.body.classList.contains('nav-open')")
        side_x = pg.evaluate("document.querySelector('.sidebar').getBoundingClientRect().left")
        pg.screenshot(path=str(OUT / 'nav04-mobile-menu.png')); pg.click('.nav-backdrop', position={'x': 360, 'y': 400}); time.sleep(0.4); closed = not pg.evaluate("document.body.classList.contains('nav-open')")
        wide = []
        for path in ['/', '/cases', '/cases/2', '/cases/14', '/debtors', '/debtors/1', '/tasks', '/reports', '/commissions', '/agents', '/users', '/audit-log', '/search?q=a', '/settings', '/cases/new', '/cases/2/statement']:
            pg.goto(BASE + path)
            sw = pg.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
            if sw[0] > sw[1] + 1: wide.append(f'{path}:{sw[0]}>{sw[1]}')
        pg.goto(BASE + '/cases/2'); pg.click('text=Record Payment')
        dlg = pg.eval_on_selector('#dlg-payment', 'd => { const r = d.getBoundingClientRect(); return [r.left, r.right, window.innerWidth]; }')
        pg.screenshot(path=str(OUT / 'nav04-mobile-case.png'), full_page=False)
        ok = topbar and btn and opened and side_x >= -1 and closed and not wide and dlg[0] >= 0 and dlg[1] <= dlg[2] + 1
        rec('NAV-04', '375px：顶栏+☰；☰ 打开、遮罩关闭；无横向滚动', ok, f'topbar={topbar} ☰={btn} 打开={opened}(left={side_x}) 遮罩关闭={closed}; 横向溢出页面: {wide or "无"}; 还款弹窗 {dlg}')
        m.close()
    run('NAV-04', nav04)

    def case06():
        pg = admin; pg.goto(BASE + '/cases/new')
        pg.click('.chip-row .chip[data-val="3"]')
        v = pg.input_value('#tenure'); a3 = 'is-active' in pg.get_attribute('.chip[data-val="3"]', 'class')
        pg.fill('#tenure', ''); pg.type('#tenure', '12')
        a12 = 'is-active' in pg.get_attribute('.chip[data-val="12"]', 'class'); a3b = 'is-active' in pg.get_attribute('.chip[data-val="3"]', 'class')
        btns = pg.eval_on_selector_all('.chip-row .chip', 'bs => bs.map(b => b.textContent)')
        rec('CASE-06', '点按钮填入并高亮；手动输入相同数字也高亮', v == '3' and a3 and a12 and not a3b, f'按钮 {btns}; 点3mo→tenure={v} 高亮={a3}; 输入12→12mo 高亮={a12} 3mo 取消={not a3b}')
    run('CASE-06', case06)

    def case15():
        pg = admin; pg.goto(BASE + '/cases/14')
        pg.click('button[title=Records]'); o1 = is_open(pg, '#dlg-records')
        pg.click('#dlg-records .modal-head button[aria-label=Close]'); c1 = not is_open(pg, '#dlg-records')
        pg.click('button[title=Records]'); pg.mouse.click(5, 5); c2 = not is_open(pg, '#dlg-records')
        pg.click('text=New PTP'); pg.click('#dlg-ptp button:has-text("Cancel")'); c3 = not is_open(pg, '#dlg-ptp')
        rec('CASE-15', 'Records 弹窗点 × 或遮罩关闭（Cancel 亦可）', o1 and c1 and c2 and c3, f'打开={o1} ×关闭={c1} 遮罩关闭={c2} PTP Cancel 关闭={c3}')
    run('CASE-15', case15)

    def int01_02():
        pg = admin; pg.goto(BASE + '/cases/new')
        vis = {}
        for m in ['fixed', 'monthly', 'daily']:
            pg.select_option('#interest_mode', m)
            vis[m] = (pg.is_visible('input[name=interest_amount]'), pg.is_visible('input[name=interest_rate]'))
        ok1 = vis['fixed'] == (True, False) and vis['monthly'] == (False, True) and vis['daily'] == (False, True)
        rec('INT-01', 'Fixed 只显示 Interest Amount；Monthly/Annual 只显示 Interest Rate %', ok1, json.dumps(vis))
        pg.select_option('#interest_mode', 'monthly')
        h0 = pg.is_visible('#interest_formula'); pg.click('#interest_help'); h1 = pg.is_visible('#interest_formula'); txt = pg.inner_text('#interest_formula')
        pg.click('#interest_help'); h2 = pg.is_visible('#interest_formula')
        rec('INT-02', '点 ! 展开/收起当前模式公式', (not h0) and h1 and (not h2) and 'Monthly rate' in txt, f'初始={h0} 点击={h1} 再点={h2}; 公式="{txt[:60]}"')
    run('INT-01/02', int01_02)

    def pay04_05():
        pg = admin; pg.goto(BASE + '/cases/13')
        mx = float(pg.get_attribute('#pay-amount', 'max'))
        out = {}
        for k, v in [('超额', str(mx + 1)), ('零', '0'), ('负数', '-5')]:
            pg.goto(BASE + '/cases/13'); pg.click('text=Record Payment'); pg.fill('#pay-amount', v)
            n0 = pg.url; pg.click('#dlg-payment button[type=submit]'); time.sleep(0.3)
            out[k] = (is_open(pg, '#dlg-payment'), pg.url == n0, pg.eval_on_selector('#pay-amount', 'e => e.validationMessage'))
        ok4 = out['超额'][0] and out['超额'][1] and bool(out['超额'][2])
        ok5 = all(out[k][0] and out[k][1] and out[k][2] for k in ['零', '负数'])
        rec('PAY-04', '浏览器在弹窗内拦截并提示', ok4, f"max={mx}; {out['超额']}")
        rec('PAY-05', '0/负数浏览器拦截', ok5, f"0→{out['零']}; -5→{out['负数']}")
    run('PAY-04/05', pay04_05)

    fin = login(browser.new_context(), 'finance')
    def pay14_sec03():
        loc = post(admin, '/cases', {'debtor_id': '1', 'agent_id': '1', 'principal_amount': '1000', 'interest_mode': 'fixed', 'interest_amount': '0'})
        cid = re.search(r'/cases/(\d+)', loc).group(1)
        post(admin, f'/cases/{cid}/payments', {'payment_date': today(), 'amount': '1', 'reference': "O'Brien"})
        post(admin, f'/cases/{cid}/payments', {'payment_date': today(), 'amount': '1', 'reference': "x');alert('XSS-SEC03');//", 'bank': 'b'})
        dialogs, perr = [], []
        fin.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
        fin.on('pageerror', lambda e: perr.append(str(e)))
        fin.goto(BASE + f'/cases/{cid}'); fin.click('button[title=Records]')
        rows = fin.locator('#dlg-records tr:has(td.mono)')
        res = {}
        for i in range(rows.count()):
            ref = 'xss' if 'alert' in (rows.nth(i).inner_html()) else 'obrien'
            dialogs.clear(); perr.clear()
            if is_open(fin, '#dlg-payment-edit'): fin.eval_on_selector('#dlg-payment-edit', 'd => d.close()')
            rows.nth(i).locator('button:has-text("Edit")').click(); time.sleep(0.3)
            res[ref] = {'editOpened': is_open(fin, '#dlg-payment-edit'), 'alerts': list(dialogs), 'pageerror': perr[:1]}
        rec('PAY-14', '含单引号时 Edit 弹窗正常打开', res['obrien']['editOpened'], json.dumps(res['obrien'], ensure_ascii=False))
        rec('SEC-03', 'Reference 注入不执行脚本', not res['xss']['alerts'], json.dumps(res['xss'], ensure_ascii=False))
    run('PAY-14/SEC-03', pay14_sec03)

    def sec02():
        X = '<img src=x onerror=alert("XSS-SEC02")><script>alert("XSS-SEC02")</script>'
        post(admin, '/debtors', {'name': X})
        did = None
        admin.goto(BASE + '/debtors')
        hrefs = admin.eval_on_selector_all('a[href^="/debtors/"]', 'as => as.map(a => [a.textContent, a.getAttribute("href")])')
        did = [h for t, h in hrefs if 'XSS-SEC02' in t][0].split('/')[-1]
        loc = post(admin, '/cases', {'debtor_id': did, 'agent_id': '1', 'principal_amount': '100', 'interest_mode': 'fixed', 'interest_amount': '0', 'remark': X})
        cid = re.search(r'/cases/(\d+)', loc).group(1)
        post(admin, f'/cases/{cid}/notes', {'content': X}); post(admin, f'/cases/{cid}/calls', {'result': 'answered', 'notes': X})
        post(admin, '/tasks/new', {'case_id': cid, 'title': X, 'notes': X, 'due_date': today()})
        admin.request.post(BASE + '/settings', multipart={'company_name': X, 'address': X}, max_redirects=0)
        fired = []
        admin.on('dialog', lambda d: (fired.append(d.message), d.dismiss()))
        pages = ['/debtors', f'/debtors/{did}', f'/cases/{cid}', '/cases', '/tasks', '/', f'/cases/{cid}/statement', '/settings', '/search?q=XSS', '/audit-log']
        for path in pages:
            admin.goto(BASE + path); time.sleep(0.2)
        admin.goto(BASE + f'/cases/{cid}')
        admin.locator('.note-actions button[data-content*="XSS-SEC02"]').first.click(); time.sleep(0.2)
        val = admin.input_value('#ne-content')
        rec('SEC-02', '所有页面原样显示为文本，不弹窗', not fired and val == X, f'弹窗 {fired or "无"}; 访问 {len(pages)} 页; 备注编辑框回显原文={val == X}')
        admin.request.post(BASE + '/settings', multipart={'company_name': 'QA 放贷有限公司', 'address': '吉隆坡 QA 路 1 号', 'phone': '03-1234567', 'email': 'qa@lender.my', 'reg_no': 'KPKT/QA/001'}, max_redirects=0)
    run('SEC-02', sec02)

    def sch07():
        pg = admin; pg.goto(BASE + '/cases/20'); pg.click('button[title=Records]')
        btn = pg.locator('#dlg-records button:has-text("Pay")')
        n = btn.count(); oc = btn.first.get_attribute('onclick'); exp = re.search(r'payInstallment\(([\d.]+)\)', oc).group(1)
        pg.eval_on_selector('#dlg-records', 'd => d.close()')
        pg.click('button[title=Records]'); btn.first.click(); time.sleep(0.2)
        v = pg.input_value('#pay-amount'); op = is_open(pg, '#dlg-payment')
        rec('SCH-07', '只有最早一期有 Pay；点后打开 Record Payment 并预填该期未还金额', n == 1 and op and float(v) == float(exp), f'Pay 按钮数 {n}; 预填 {v}（onclick {exp}）; 弹窗打开={op}')
    run('SCH-07', sch07)

    def rs04():
        pg = admin; pg.goto(BASE + '/cases/2'); pg.click('button:has-text("Restructure")')
        out = {}
        for m in ['monthly', 'daily', 'fixed']:
            pg.select_option('#rs-mode', m)
            out[m] = [pg.is_visible('input[name=interest_rate]'), pg.eval_on_selector('input[name=interest_rate]', 'e=>e.required'), pg.is_visible('input[name=interest_amount]'), pg.eval_on_selector('input[name=interest_amount]', 'e=>e.required')]
        ok = out['monthly'] == [True, True, False, False] and out['daily'] == [True, True, False, False] and out['fixed'] == [False, False, True, True]
        rec('RS-04', 'Monthly/Annual 显示利率且必填；Fixed 显示固定利息且必填', ok, json.dumps(out))
        pg.select_option('#rs-mode', 'monthly'); pg.fill('input[name=tenure]', '6'); pg.fill('textarea[name=reason]', 'x')
        pg.click('#dlg-restructure button[type=submit]'); time.sleep(0.2)
        rec('RS-05-UI', '留空利率时浏览器拦截（补充）', is_open(pg, '#dlg-restructure') and '/cases/2' in pg.url, pg.eval_on_selector('input[name=interest_rate]', 'e=>e.validationMessage'))
    run('RS-04', rs04)

    def task02():
        pg = admin; pg.goto(BASE + '/tasks'); pg.click('summary:has-text("+ New Task")')
        pg.select_option('#new-task-case', label='CASE-%s-D002' % today()[:4])
        dis = pg.eval_on_selector('#new-task-agent', 'e => e.disabled'); val = pg.input_value('#new-task-agent')
        pg.select_option('#new-task-case', value='')
        dis2 = pg.eval_on_selector('#new-task-agent', 'e => e.disabled')
        rec('TASK-02-UI', '选择案件后 Agent 自动带出并锁定', dis and val == '2' and not dis2, f'选案件 D002 → disabled={dis} agent={val}; 清空案件 → disabled={dis2}')
    run('TASK-02-UI', task02)

    def com03():
        pg = fin; pg.goto(BASE + '/commissions')
        btns = pg.locator('button:has-text("Settle")')
        res = []
        for i in range(btns.count()):
            pend = float(btns.nth(i).get_attribute('data-pending'))
            btns.nth(i).click(); time.sleep(0.1)
            v = pg.input_value('#st-amount'); res.append((btns.nth(i).get_attribute('data-name'), pend, v))
            pg.eval_on_selector('#dlg-settle', 'd => d.close()')
        ok = all((v == f'{p:.2f}') if p > 0 else v == '' for _, p, v in res)
        rec('COM-03-UI', 'Settle 金额预填为 Pending（大于 0 时）', ok, res)
    run('COM-03-UI', com03)

    def set07():
        pg = admin; pg.goto(BASE + '/cases/5/statement')
        pg.emulate_media(media='print')
        hidden = pg.eval_on_selector('.stmt-actions', 'e => getComputedStyle(e).display') == 'none'
        pdf = pg.pdf(path=str(OUT / 'statement-case5.pdf'), format='A4')
        pg.emulate_media(media='screen')
        shown = pg.eval_on_selector('.stmt-actions', 'e => getComputedStyle(e).display') != 'none'
        txt = pg.inner_text('.stmt-head')
        rec('SET-07', '打印预览中不出现按钮；可另存为 PDF', hidden and shown and len(pdf) > 5000, f'print 隐藏按钮={hidden}; 屏幕显示={shown}; A4 PDF {len(pdf)} 字节（tests/qa/results/statement-case5.pdf）; 抬头="{txt[:40]}"', '中文与金额显示请人工打开 PDF 确认')
    run('SET-07', set07)

    def dblclick():
        loc = post(admin, '/cases', {'debtor_id': '1', 'agent_id': '1', 'principal_amount': '1000', 'interest_mode': 'fixed', 'interest_amount': '0'})
        cid = re.search(r'/cases/(\d+)', loc).group(1)
        res = {}
        for kind, opener, fill, submit in [('PTP', 'New PTP', lambda pg: (pg.fill('#dlg-ptp input[name=amount]', '100'), pg.fill('#dlg-ptp input[name=remark]', 'dbl')), '#dlg-ptp button[type=submit]'),
                                           ('Plan', 'New Plan', lambda pg: pg.fill('#dlg-plan input[name=total_amount]', '300'), '#dlg-plan button[type=submit]')]:
            admin.goto(BASE + f'/cases/{cid}'); admin.click(f'text={opener}'); fill(admin)
            admin.dblclick(submit); admin.wait_for_load_state('networkidle'); time.sleep(0.5)
            admin.goto(BASE + f'/cases/{cid}')
            res[kind] = admin.locator('#dlg-records tr:has(td.num)').count()
        html = admin.content()
        ptps = len(re.findall(r'<td>—</td>\s*<td class="num">100.00</td>', html)); plans = html.count('<b>Installment Plan</b>')
        rec('X-DBLCLICK', '双击提交只生成 1 条 PTP / 1 个计划', ptps <= 1 and plans <= 1, f'双击“Add PTP”后独立 PTP {ptps} 条；双击“Create Plan”后计划 {plans} 个')
    run('X-DBLCLICK', dblclick)

    # 7.3 兼容：Edge 抽测
    def edge():
        try:
            b2 = p.chromium.launch(channel='msedge', headless=True)
        except Exception as e:
            rec('COMPAT-EDGE', 'Edge 最新版 P0 抽测', False, 'BLOCKED: 本机无 Edge 通道 ' + repr(e)[:80]); return
        c2 = b2.new_context(); pg = login(c2, 'admin'); ver = b2.version
        pg.goto(BASE + '/cases/13'); pg.click('text=Record Payment'); op = is_open(pg, '#dlg-payment')
        pg.fill('#pay-amount', '99999999'); pg.click('#dlg-payment button[type=submit]'); blocked = is_open(pg, '#dlg-payment')
        pg.goto(BASE + '/cases/2'); pg.click('button:has-text("Restructure")'); rs = is_open(pg, '#dlg-restructure')
        date_type = pg.eval_on_selector('#dlg-restructure input[name=effective_date]', 'e => e.type')
        rec('COMPAT-EDGE', 'Edge：登录、dialog 弹窗、日期输入、还款拦截、重组弹窗正常', op and blocked and rs and date_type == 'date', f'Edge {ver}: 还款弹窗={op} 超额拦截={blocked} 重组弹窗={rs} date 输入={date_type}')
        b2.close()
    run('COMPAT-EDGE', edge)
    rec('COMPAT-CHROME', 'Chrome 最新版全部 P0', True, f'Chrome {browser.version}：本脚本全部界面用例在 Chrome 执行；P0 HTTP 用例与浏览器无关')
    results.append({'id': 'COMPAT-FF-SAFARI', 'expected': 'Firefox/Safari 抽测', 'actual': '本机未安装 Firefox / Safari（Playwright 未下载 firefox、webkit 内核，按要求不安装）', 'result': '未执行', 'note': ''})
    rec('JS-ERRORS', 'admin 浏览各页无 JS 运行时错误', not errors, errors[:3] or '无')
    browser.close()

(OUT / 'ui.json').write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding='utf-8')
print('done', sum(r['result'] == 'PASS' for r in results), '/', len(results))
