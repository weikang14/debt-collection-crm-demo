# QA round 2 — browser-only checks (role 1). Run: python tests/qa/r2/ui.qa.py
# Uses the already-running tester server on 127.0.0.1:3301 (data/qa/tester-r2.db).
# 127.0.0.1 on purpose: [::1] may be login-locked by AUTH-05.
import json, os, re, datetime, pathlib
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3301"
OUT = pathlib.Path(__file__).parent / "results"
SHOTS = OUT / "ui"
SHOTS.mkdir(parents=True, exist_ok=True)
TODAY = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()
results = []

def rec(i, expected, actual, ok, note=""):
    results.append({"id": i, "expected": expected, "actual": str(actual)[:600], "result": ok if isinstance(ok, str) else ("PASS" if ok else "FAIL"), "note": note})

def login(ctx, user, pw):
    p = ctx.new_page()
    p.goto(BASE + "/login")
    p.fill("input[name=username]", user); p.fill("input[name=password]", pw)
    p.click("button[type=submit]")
    p.wait_for_url(BASE + "/")
    return p

def post(page, url, data):
    # same-origin form post through the page's own request context (cookie + no foreign Origin)
    return page.request.post(BASE + url, form=data, headers={"origin": BASE})

with sync_playwright() as pw:
    # No Chrome in the cloud session -> fall back to Playwright's bundled Chromium (2026-10-26 v1.11.0 smoke run).
    try:
        b = pw.chromium.launch(channel="chrome", headless=True)
    except Exception:
        b = pw.chromium.launch(headless=True)
    alerts = []
    ctx = b.new_context(viewport={"width": 1366, "height": 900})
    dlgmode = {"dialog": "accept"}
    def on_dialog(d):
        alerts.append(d.type + ":" + d.message)
        d.dismiss() if dlgmode["dialog"] == "dismiss" else d.accept()
    a = login(ctx, "admin", "admin123")
    a.on("dialog", on_dialog)

    # ---- NAV-02: group open state remembered; current group always open
    a.goto(BASE + "/")
    team = a.locator(".grp[data-grp=team]")
    before = "open" in (team.get_attribute("class") or "")
    a.click(".grp[data-grp=team] .grp-head")
    a.goto(BASE + "/cases"); a.reload()
    after = "open" in (team.get_attribute("class") or "")
    a.goto(BASE + "/settings")
    admin_open = "open" in (a.locator(".grp[data-grp=admin]").get_attribute("class") or "")
    rec("NAV-02", "toggle persists across pages/reload; active group open", f"team before={before} after toggle+nav+reload={after}; on /settings admin group open={admin_open}", (after != before) and admin_open)

    # ---- NAV-04: 375px layout
    m = b.new_context(viewport={"width": 375, "height": 800})
    mp = login(m, "admin", "admin123")
    res = {}
    for url in ["/", "/cases", "/cases/14", "/tasks", "/reports", "/commissions"]:
        mp.goto(BASE + url)
        res[url] = mp.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
    mp.goto(BASE + "/")
    top = mp.is_visible(".mobile-topbar .nav-toggle")
    mp.click(".nav-toggle"); opened = mp.evaluate("document.body.classList.contains('nav-open')")
    mp.click(".nav-backdrop", position={"x": 360, "y": 400}); closed = not mp.evaluate("document.body.classList.contains('nav-open')")
    mp.screenshot(path=str(SHOTS / "nav04-375.png"))
    rec("NAV-04", "topbar + ☰; opens/closes; no horizontal scroll", f"toggle={top} open={opened} closeByBackdrop={closed} noHScroll={res}", top and opened and closed and all(res.values()))
    # 7.3 mobile dialogs usable
    mp.goto(BASE + "/cases/14"); mp.click("button[aria-label=Records]")
    rw = mp.evaluate("(() => { const d = document.getElementById('dlg-records'); const r = d.getBoundingClientRect(); return [r.left >= -1, r.right <= window.innerWidth + 1, document.documentElement.scrollWidth <= window.innerWidth + 1]; })()")
    mp.screenshot(path=str(SHOTS / "records-375.png"))
    rec("7.3-375", "Records dialog fits 375px", rw, all(rw))
    m.close()

    # ---- DEB-02 / CASE-03 / TASK-04 / USR-08: browser blocks required / minlength
    a.goto(BASE + "/debtors/new")
    deb_block = a.evaluate("!document.querySelector('form.form').checkValidity()")
    a.goto(BASE + "/cases/new")
    a.fill("input[name=principal_amount]", "100")
    case_block = a.evaluate("!document.querySelector('form.form').checkValidity()")
    a.goto(BASE + "/tasks")
    a.click("summary:has-text('+ New Task')")
    task_block = a.evaluate("!document.querySelector('form[action=\"/tasks/new\"]').checkValidity()")
    a.goto(BASE + "/users/new")
    a.fill("input[name=username]", "x"); a.fill("input[name=full_name]", "x"); a.fill("input[name=password]", "1234567")
    pw_block = a.evaluate("!document.querySelector('form.form').checkValidity()")
    a.select_option("#role-select", "agent"); agent_field = a.is_visible("#agent-field")
    rec("DEB-02", "blank name blocked by browser", deb_block, deb_block)
    rec("CASE-03", "no debtor blocked by browser", case_block, case_block)
    rec("TASK-04", "blank title blocked by browser", task_block, task_block)
    rec("USR-08", "7-char password blocked by browser (minlength)", pw_block, pw_block)
    rec("USR-04", "role agent shows Linked Agent", agent_field, agent_field)

    # ---- CASE-06 tenure chips; INT-01 fields per mode; INT-02 formula
    a.goto(BASE + "/cases/new")
    a.click(".chip[data-val='24']")
    v = a.input_value("#tenure"); act = a.get_attribute(".chip[data-val='24']", "class")
    a.fill("#tenure", "12"); a.dispatch_event("#tenure", "input")
    act12 = a.get_attribute(".chip[data-val='12']", "class"); act24 = a.get_attribute(".chip[data-val='24']", "class")
    rec("CASE-06", "chip fills + highlights; typed 12 highlights 12mo", f"value={v} 24={act} | typed 12 → 12={act12} 24={act24}", v == "24" and "is-active" in act and "is-active" in act12 and "is-active" not in act24)
    vis = {}
    for mode in ["fixed", "monthly", "daily"]:
        a.select_option("#interest_mode", mode)
        vis[mode] = (a.is_visible("input[name=interest_amount]"), a.is_visible("input[name=interest_rate]"))
    rec("INT-01", "fixed: amount only; monthly/daily: rate only", vis, vis["fixed"] == (True, False) and vis["monthly"] == (False, True) and vis["daily"] == (False, True))
    a.select_option("#interest_mode", "monthly")
    a.click("#interest_help"); shown = a.is_visible("#interest_formula"); txt = a.inner_text("#interest_formula")
    a.click("#interest_help"); hidden = not a.is_visible("#interest_formula")
    a.click("#interest_help"); a.screenshot(path=str(SHOTS / "int02-formula.png"))
    stale = "÷ 30" in txt
    rec("INT-02", "! toggles the formula for the current mode (and the formula must match D-01 whole-month rule)", f"toggle shown={shown} hidden={hidden}; monthly text: {txt!r}", shown and hidden and not stale, "公式文字仍为“daily rate = monthly% ÷ 100 ÷ 30”，与 v1.10.0 整月计息不符（src/views/cases/form.ejs:54）")

    # ---- Record Payment dialog: PAY-04 / PAY-05 / PAY-16 browser blocks
    a.goto(BASE + "/cases/20")
    a.click("button:has-text('Record Payment')")
    mx = float(a.get_attribute("#pay-amount", "max"))
    a.fill("#pay-amount", f"{mx + 0.01:.2f}")
    over = a.evaluate("document.getElementById('pay-amount').validity.rangeOverflow")
    a.click("#dlg-payment button[type=submit]"); still_open = a.evaluate("document.getElementById('dlg-payment').open")
    msg = a.evaluate("document.getElementById('pay-amount').validationMessage")
    a.fill("#pay-amount", "0"); under = a.evaluate("document.getElementById('pay-amount').validity.rangeUnderflow")
    dmax = a.get_attribute("#dlg-payment input[name=payment_date]", "max")
    a.fill("#dlg-payment input[name=payment_date]", (TODAY + datetime.timedelta(days=1)).isoformat())
    fut = a.evaluate("document.querySelector('#dlg-payment input[name=payment_date]').validity.rangeOverflow")
    a.screenshot(path=str(SHOTS / "pay04-dialog.png"))
    rec("PAY-04", "browser blocks > max inside the dialog", f"max={mx} overflow={over} dialogOpen={still_open} msg={msg!r}", over and still_open)
    rec("PAY-05", "0 blocked (min 0.01)", under, under)
    rec("PAY-16", "date picker max = today; tomorrow invalid", f"max={dmax} tomorrowInvalid={fut}", dmax == TODAY.isoformat() and fut)
    a.keyboard.press("Escape")

    # ---- CASE-15 Records dialog open/close (× and backdrop)
    a.goto(BASE + "/cases/14")
    a.click("button[aria-label=Records]"); o1 = a.evaluate("document.getElementById('dlg-records').open")
    a.click("#dlg-records button[aria-label=Close]"); c1 = not a.evaluate("document.getElementById('dlg-records').open")
    a.click("button[aria-label=Records]")
    a.mouse.click(5, 5); c2 = not a.evaluate("document.getElementById('dlg-records').open")
    rec("CASE-15", "Records opens; × and backdrop close", f"open={o1} closeX={c1} closeBackdrop={c2}", o1 and c1 and c2)

    # ---- SCH-07 Pay prefill
    a.click("button[aria-label=Records]")
    btn = a.locator("#dlg-records button:has-text('Pay')").first
    oc = btn.get_attribute("onclick"); amt = re.search(r"payInstallment\(([\d.]+)\)", oc).group(1)
    btn.click()
    pre = a.input_value("#pay-amount"); popen = a.evaluate("document.getElementById('dlg-payment').open")
    rec("SCH-07", "Pay opens Record Payment prefilled with the row's unpaid amount", f"button={amt} prefill={pre} open={popen}", popen and float(pre) == float(amt))
    a.keyboard.press("Escape"); a.keyboard.press("Escape")

    # ---- RS-04 restructure dialog mode switch + RS-13 date min
    a.goto(BASE + "/cases/2")
    a.click("button:has-text('Restructure')")
    st = {}
    for mode in ["monthly", "daily", "fixed"]:
        a.select_option("#rs-mode", mode)
        st[mode] = (a.is_visible("#dlg-restructure input[name=interest_rate]"), a.evaluate("document.querySelector('#dlg-restructure input[name=interest_rate]').required"),
                    a.is_visible("#dlg-restructure input[name=interest_amount]"), a.evaluate("document.querySelector('#dlg-restructure input[name=interest_amount]').required"))
    rec("RS-04", "monthly/daily: rate shown+required; fixed: amount shown+required", st, st["monthly"] == (True, True, False, False) and st["daily"] == (True, True, False, False) and st["fixed"] == (False, False, True, True))
    a.keyboard.press("Escape")
    a.goto(BASE + "/cases/14")
    lock_min = a.get_attribute("#dlg-payment input[name=payment_date]", "min")
    rec("RS-13", "payment date min = effective date + 1 (case 14)", lock_min, lock_min == (TODAY - datetime.timedelta(days=9)).isoformat())

    # ---- PTP-03 Fulfill prefill; PTP-02/07 browser blocks
    a.click("button[aria-label=Records]")
    fb = a.locator("#dlg-records button:has-text('Fulfill')").first
    famt = re.search(r"openFulfill\(\d+, ([\d.]+)\)", fb.get_attribute("onclick")).group(1)
    fb.click(); fpre = a.input_value("#fulfill-amount")
    rec("PTP-03", "Fulfill dialog amount defaults to the PTP amount (editable)", f"ptp={famt} prefill={fpre}", float(fpre) == float(famt))
    a.keyboard.press("Escape"); a.keyboard.press("Escape")
    a.click("button:has-text('New PTP')")
    pmax = float(a.get_attribute("#dlg-ptp input[name=amount]", "max"))
    a.fill("#dlg-ptp input[name=amount]", f"{pmax + 1:.2f}")
    povr = a.evaluate("document.querySelector('#dlg-ptp input[name=amount]').validity.rangeOverflow")
    a.keyboard.press("Escape")
    a.click("button:has-text('New Plan')")
    a.fill("#dlg-plan input[name=num_installments]", "1"); n1 = a.evaluate("document.querySelector('#dlg-plan input[name=num_installments]').validity.rangeUnderflow")
    a.fill("#dlg-plan input[name=num_installments]", "61"); n61 = a.evaluate("document.querySelector('#dlg-plan input[name=num_installments]').validity.rangeOverflow")
    a.keyboard.press("Escape")
    rec("PTP-02", "browser blocks PTP amount > max", f"max={pmax} overflow={povr}", povr)
    rec("PTP-07", "browser blocks 1 and 61 installments", f"1→{n1} 61→{n61}", n1 and n61)

    # ---- TASK-02 agent locks to the case's agent
    a.goto(BASE + "/tasks"); a.click("summary:has-text('+ New Task')")
    a.select_option("#new-task-case", label="CASE-2026-D002")
    dis = a.evaluate("document.getElementById('new-task-agent').disabled"); val = a.input_value("#new-task-agent")
    types = a.eval_on_selector_all("form[action='/tasks/new'] select[name=type] option", "els => els.map(e => e.value)")
    rec("TASK-02", "picking a case locks Agent to its agent; no visit type", f"disabled={dis} agent={val} types={types}", dis and val == "2" and "visit" not in types)

    # ---- PAY-14 / SEC-03: quotes and script in Reference/Bank
    post(a, "/cases/16/payments", {"payment_date": TODAY.isoformat(), "amount": "1", "method": "cash", "reference": "O'Brien", "bank": "x');alert(1);//"})
    n_alerts = len(alerts)
    a.goto(BASE + "/cases/16"); a.click("button[aria-label=Records]")
    eb = a.locator("#dlg-records tr:has-text('cash') button:has-text('Edit')").first
    eb.click()
    ref = a.input_value("#pe-ref"); bank = a.input_value("#pe-bank"); eopen = a.evaluate("document.getElementById('dlg-payment-edit').open")
    a.screenshot(path=str(SHOTS / "pay14-edit.png"))
    rec("PAY-14", "Edit opens; Reference O'Brien shown verbatim", f"open={eopen} ref={ref!r}", eopen and ref == "O'Brien")
    rec("SEC-03", "x');alert(1);// shown as text, no script runs", f"bank={bank!r} alerts={alerts[n_alerts:]}", bank == "x');alert(1);//" and len(alerts) == n_alerts)
    a.keyboard.press("Escape")

    # ---- SEC-02: stored XSS payloads must not execute anywhere
    X = "<img src=x onerror=alert('xss')><script>alert(1)</script>"
    post(a, "/debtors", {"name": X, "risk_level": "medium"})
    r = post(a, "/cases/16/notes", {"content": X})
    post(a, "/tasks/new", {"case_id": "16", "type": "follow_up", "title": X, "due_date": TODAY.isoformat(), "notes": X})
    post(a, "/cases/16/calls", {"result": "answered", "duration_seconds": "1", "notes": X})
    post(a, "/agents", {"name": X, "department": X})
    n0 = len(alerts)
    for url in ["/", "/cases/16", "/debtors", "/tasks", "/agents", "/audit-log", "/search?q=img", "/cases/16/statement"]:
        a.goto(BASE + url); a.wait_for_timeout(150)
        if url == "/cases/16":
            a.click("button[aria-label=Records]"); a.wait_for_timeout(100); a.keyboard.press("Escape")
            # open the note edit dialog too (data-content)
            ne = a.locator("button:has-text('Edit')[data-content]").first
            if ne.count(): ne.click(); a.wait_for_timeout(100); a.keyboard.press("Escape")
        if url == "/tasks":
            te = a.locator("button[onclick='editTask(this)']").last
            te.click(); a.wait_for_timeout(100); a.keyboard.press("Escape")
    rec("SEC-02", "no alert() in any page or dialog", f"alerts during sweep={alerts[n0:]}", len(alerts) == n0)

    # ---- COM-03 settle dialog prefill
    a.goto(BASE + "/commissions")
    sb = a.locator("button:has-text('Settle')").first
    pend = sb.get_attribute("data-pending"); sb.click(); spre = a.input_value("#st-amount")
    rec("COM-03", "Settle prefilled with Pending (>0)", f"pending={pend} prefill={spre!r}", (float(pend) > 0 and abs(float(spre) - float(pend)) < 0.001) or (float(pend) <= 0 and spre == ""))
    a.keyboard.press("Escape")

    # ---- PTP-04 / PTP-10 / RS-15 / PAY-10 confirm dialogs exist (accept handler above records them)
    a.goto(BASE + "/cases/14"); a.click("button[aria-label=Records]")
    k = len(alerts); dlgmode["dialog"] = "dismiss"
    a.locator("#dlg-records form[action$='/break'] button").first.click()
    a.wait_for_timeout(300); dlgmode["dialog"] = "accept"
    asked = [m for m in alerts[k:] if m.startswith("confirm:")]
    rec("PTP-04-confirm", "Break asks for confirmation; dismiss keeps the PTP", f"confirm={asked} url={a.url}", bool(asked) and a.url.endswith("/cases/14"))
    alerts[:] = [m for m in alerts if not m.startswith("confirm:")]

    # ---- SET-07 print: buttons hidden; PDF renders
    a.goto(BASE + "/cases/14/statement")
    a.emulate_media(media="print")
    hidden = not a.is_visible(".stmt-actions")
    pdf = SHOTS / "statement-case14.pdf"
    a.pdf(path=str(pdf), format="A4")
    a.emulate_media(media="screen")
    rec("SET-07", "print media hides buttons; A4 PDF produced", f"buttonsHidden={hidden} pdfBytes={pdf.stat().st_size}", hidden and pdf.stat().st_size > 5000, "PDF 存于 tests/qa/r2/results/ui/")

    # ---- 7.3 dialog interactions: Cancel closes
    a.goto(BASE + "/cases/20"); a.click("button:has-text('Record Payment')")
    a.click("#dlg-payment button:has-text('Cancel')"); cc = not a.evaluate("document.getElementById('dlg-payment').open")
    rec("7.3-dialog", "Cancel closes dialog", cc, cc)

    # ---- agent UI: status dropdown on a Legal case (X-STATUS evidence)
    g = b.new_context(viewport={"width": 1366, "height": 900})
    ag = login(g, "agent1", "agent123")
    ag.goto(BASE + "/cases/17")
    opts = ag.eval_on_selector_all("select[name=status] option", "els => els.map(e => (e.disabled ? '(disabled) ' : '') + e.value)")
    ag.screenshot(path=str(SHOTS / "agent-legal-status.png"))
    rec("X-STATUS-UI", "agent on a Legal case: dropdown offers working statuses (selecting one lifts Legal)", opts, "FAIL" if any(o == "negotiation" for o in opts) else "PASS", "与 X-STATUS 同一问题：页面上一选即生效")
    g.close()

    b.close()

OUT.mkdir(exist_ok=True)
(OUT / "ui.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
from collections import Counter
print("ui", dict(Counter(r["result"] for r in results)))
for r in results:
    if r["result"] != "PASS":
        print(" ", r["result"], r["id"], r["actual"][:200])
