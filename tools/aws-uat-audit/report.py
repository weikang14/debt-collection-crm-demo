#!/usr/bin/env python3
"""把 audit.py 产生的 findings.json 排成 PDF 报告（版式照《ECS Task 连不上 ECR 排查手册》）。

用法：
  python3 report.py out/findings.json -o AWS-UAT-检查报告.pdf
需要 Playwright + Chromium；中文字体用 Noto Sans CJK（apt install fonts-noto-cjk）。
"""
import argparse
import html
import json
import os
from collections import Counter, defaultdict

SEV = ["高", "中", "低", "提示"]
SEV_DESC = {
    "高": "可能直接造成数据外泄、PROD 被影响或服务中断，尽快处理",
    "中": "有明确风险或会造成问题，排进近期计划",
    "低": "基线 / 最佳实践没做到，有空时处理",
    "提示": "不一定是问题，确认一下即可",
}
PARTS = [
    ("UAT 环境配置问题", lambda f: f["area"] == "配置" and f["env"] in ("UAT", "共用/未标", "账号")),
    ("UAT 对照 PROD：哪些不一致", lambda f: f["area"] == "UAT vs PROD"),
    ("UAT 和 PROD 的权限区分", lambda f: f["area"] in ("权限区分", "权限")),
    ("整个环境的安全隐患", lambda f: f["area"] == "安全"),
    ("顺带发现：PROD 的配置问题", lambda f: f["area"] == "配置" and f["env"] == "PROD"),
]

CSS = """
@page { size: A4; margin: 16mm 14mm 16mm 14mm; }
:root { --blue:#1f5f8b; --dark:#2b3a4a; --line:#e6ebf0; --soft:#f3f6f9; --ink:#1d2733; --muted:#5b6b7b;
        --red:#b42318; --redbg:#fbeeee; --org:#b54708; --orgbg:#fcf1ec; --grn:#2f7d4f; --grnbg:#ecf6f0; --gry:#667085; --grybg:#f2f4f7; }
* { box-sizing: border-box; }
body { font-family: "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Zen Hei", sans-serif; color: var(--ink);
       font-size: 9.4pt; line-height: 1.6; margin: 0; background: #fff; }
code, .mono { font-family: "DejaVu Sans Mono", monospace; font-size: 8.3pt; }
code { background: var(--soft); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; word-break: break-all; }
h1 { font-size: 22pt; margin: 0 0 2px; letter-spacing: .5px; }
.sub { color: var(--muted); font-size: 9pt; padding-bottom: 6px; border-bottom: 2px solid var(--blue); margin-bottom: 12px; }
.sub span + span:before { content: "·"; margin: 0 8px; color: #aab4be; }
.box { background: var(--soft); border-radius: 4px; padding: 10px 14px; margin: 0 0 12px; }
.box .note { color: var(--muted); font-size: 8.7pt; }
h2 { color: var(--blue); font-size: 13pt; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; border: 1px solid var(--line); page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { background: var(--soft); text-align: left; font-weight: 700; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 8.9pt; }
td { padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 8.9pt; }
td.k { color: var(--muted); width: 17%; white-space: nowrap; }
td.num { text-align: center; color: var(--blue); font-weight: 700; width: 6%; }
.chip { display: inline-block; border-radius: 10px; padding: 0 8px; font-size: 8pt; font-weight: 700; white-space: nowrap; border: 1px solid transparent; }
.s-高 { color: var(--red); background: var(--redbg); border-color: #f3c6c2; }
.s-中 { color: var(--org); background: var(--orgbg); border-color: #f5d0b5; }
.s-低 { color: var(--blue); background: #e3edf6; border-color: #c4d7e8; }
.s-提示 { color: var(--gry); background: var(--grybg); border-color: #d9dee5; }
.ok { color: var(--grn); background: var(--grnbg); border-color: #bfe0cb; }
.env { display: inline-block; font-size: 7.8pt; color: var(--dark); background: #eef3f8; border-radius: 3px; padding: 0 5px; margin-right: 4px; }
.bar { background: var(--blue); color: #fff; border-radius: 4px; padding: 9px 14px; margin: 20px 0 10px; display: flex; justify-content: space-between; align-items: baseline; page-break-after: avoid; }
.bar b { font-size: 13pt; } .bar span { font-size: 8.7pt; opacity: .9; }
.card { border: 1px solid var(--line); border-radius: 4px; margin: 10px 0 12px; page-break-inside: avoid; }
.card .hd { background: var(--dark); color: #fff; padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; border-radius: 4px 4px 0 0; }
.card .hd b { font-size: 9.6pt; } .card .hd .id { background: #e3edf6; color: var(--blue); border-radius: 3px; padding: 0 6px; margin-right: 8px; font-size: 8.5pt; font-weight: 700; }
.card table { margin: 0; border: 0; }
.card td.k { width: 14%; }
.why { }
.fix { color: var(--ink); font-weight: 500; }
.path { line-height: 2; }
.path .c { display: inline-block; border: 1px solid #c9d3dd; background: #f6f8fa; border-radius: 10px; padding: 0 8px; font-size: 8pt; margin-right: 2px; }
.path .c:last-child { background: var(--blue); color: #fff; border-color: var(--blue); font-weight: 700; }
.path .sep { color: #9aa6b2; margin: 0 3px; font-size: 7pt; }
.ev { font-family: "DejaVu Sans Mono", monospace; font-size: 7.8pt; color: #344454; white-space: pre-wrap; word-break: break-all; }
.small { font-size: 8.4pt; color: var(--muted); }
.diff td { font-size: 8.3pt; }
.diff td.u { color: var(--org); } .diff td.p { color: var(--grn); }
ul.dots { padding-left: 0; list-style: none; margin: 4px 0 8px; } ul.dots li:before { content: "·"; color: var(--blue); font-weight: 700; margin-right: 6px; }
.pb { page-break-before: always; }
"""


def e(s):
    return html.escape(str(s if s is not None else ""))


def chip(sev):
    return f'<span class="chip s-{e(sev)}">{e(sev)}</span>'


def path_html(path):
    if not path:
        return ""
    parts = [f'<span class="c">{e(p)}</span>' for p in path]
    return '<div class="path">' + '<span class="sep">›</span>'.join(parts) + "</div>"


def evidence_html(ev):
    if not ev:
        return ""
    out = []
    for k, v in ev.items():
        if k == "diffs":
            rows = "".join(f'<tr><td class="k">{e(a)}</td><td class="u">{e(u)}</td><td class="p">{e(p)}</td></tr>' for a, u, p in v)
            out.append(f'<table class="diff"><tr><th>设定</th><th>UAT</th><th>PROD</th></tr>{rows}</table>')
        elif isinstance(v, list):
            out.append(f'<div class="ev"><b>{e(k)}</b>：' + e("\n  ".join([""] + [str(x) for x in v])) + "</div>")
        else:
            out.append(f'<div class="ev"><b>{e(k)}</b>：{e(v)}</div>')
    return "".join(out)


def card(fid, f):
    rows = [
        ("哪里", f'<span class="env">{e(f["env"])}</span>{e(f["resource"])}'),
        ("为什么", f'<div class="why">{e(f["why"])}</div>'),
        ("建议", f'<div class="fix">{e(f["fix"])}</div>'),
    ]
    if f.get("path"):
        rows.append(("点击路径", path_html(f["path"])))
    if f.get("evidence"):
        rows.append(("读到的值", evidence_html(f["evidence"])))
    body = "".join(f'<tr><td class="k">{k}</td><td>{v}</td></tr>' for k, v in rows)
    return (f'<div class="card"><div class="hd"><div><span class="id">{fid}</span><b>{e(f["title"])}</b></div>{chip(f["severity"])}</div>'
            f"<table>{body}</table></div>")


def compact(fs, start_ids):
    rows = "".join(
        f'<tr><td class="num">{start_ids[id(f)]}</td><td><span class="env">{e(f["env"])}</span>{e(f["resource"])}<br><b>{e(f["title"])}</b>'
        f'<div class="small">{e(f["why"])}</div>{evidence_html(f.get("evidence"))}</td><td>{e(f["fix"])}{path_html(f.get("path"))}</td><td>{chip(f["severity"])}</td></tr>'
        for f in fs)
    return f'<table><tr><th>#</th><th>哪里有问题 · 为什么</th><th>建议</th><th>严重度</th></tr>{rows}</table>'


def build(d, title):
    fs = d["findings"]
    cnt = Counter(f["severity"] for f in fs)
    date = d["generated_at"][:10]
    acct = d["account_id"] + (f'（{", ".join(d["aliases"])}）' if d.get("aliases") else "")
    uat_vpcs = [v for v in d.get("vpcs", []) if v["env"] == "UAT"]
    prod_vpcs = [v for v in d.get("vpcs", []) if v["env"] == "PROD"]

    # 分配到各部分，编号 = 部分-序号
    assigned, ids = defaultdict(list), {}
    for f in fs:
        for i, (_, pred) in enumerate(PARTS, 1):
            if pred(f):
                assigned[i].append(f)
                break
        else:
            assigned[4].append(f)
    for i in assigned:
        assigned[i].sort(key=lambda f: (SEV.index(f["severity"]), 0 if f["env"] == "UAT" else 1))
        for n, f in enumerate(assigned[i], 1):
            ids[id(f)] = f"{i}-{n}"

    h = [f"<!doctype html><html><head><meta charset='utf-8'><title>{e(title)}</title><style>{CSS}</style></head><body>"]
    h.append(f"<h1>{e(title)}</h1>")
    h.append('<div class="sub">' + "".join(f"<span>{e(x)}</span>" for x in
             ["只读检查", f"账号 {d['account_id']}", " / ".join(d["regions"]), date]) + "</div>")

    high = [f for f in fs if f["severity"] == "高"]
    sep = [f for f in fs if f["area"] == "权限区分"]
    drift = [f for f in fs if f["area"] == "UAT vs PROD" and f["severity"] != "提示"]
    h.append('<div class="box"><b>结论：</b>'
             f'这次一共找到 <b>{len(fs)}</b> 项，其中 <b>高 {cnt["高"]}</b>、中 {cnt["中"]}、低 {cnt["低"]}、提示 {cnt["提示"]}。'
             + (f'最需要先处理的是：<b>{e("；".join(dict.fromkeys(f["title"] for f in high[:4])))}</b>。' if high else "没有高风险项。")
             + f'UAT/PROD 权限区分方面有 <b>{len(sep)}</b> 项问题；UAT 和 PROD 配置不一致的有 <b>{len(drift)}</b> 组。'
             '<div class="note">全程只读：脚本只调用 Describe / List / Get 类 API，并在程序里拦截所有写操作和读取 secret 内容的操作，'
             '没有改动任何资源。结果代表检查当下的状态。</div></div>')

    h.append('<table><tr><th style="width:12%">严重度</th><th style="width:10%">数量</th><th>代表什么</th></tr>' +
             "".join(f"<tr><td>{chip(s)}</td><td><b>{cnt[s]}</b></td><td>{SEV_DESC[s]}</td></tr>" for s in SEV) + "</table>")

    h.append("<h2>问题总览（高、中）</h2>")
    top = [f for f in fs if f["severity"] in ("高", "中")]
    top.sort(key=lambda f: (SEV.index(f["severity"]), ids[id(f)]))
    h.append('<table><tr><th style="width:8%">编号</th><th>哪里有问题</th><th style="width:11%">环境</th><th style="width:9%">严重度</th></tr>' +
             "".join(f'<tr><td class="num">{ids[id(f)]}</td><td>{e(f["title"])}<div class="small">{e(f["resource"])}</div></td>'
                     f'<td>{e(f["env"])}</td><td>{chip(f["severity"])}</td></tr>' for f in top) + "</table>")

    h.append('<h2 class="pb">检查范围</h2><ul class="dots">'
             "<li>按 AWS console 的栏位和名称写，方便直接去页面核对；名称有小差异以实际页面为准。</li>"
             "<li>环境靠资源名字或 Environment tag 里的 <code>uat</code> / <code>prod</code> 判断；名字里没有环境词的资源归在「共用/未标」。</li>"
             "<li>「UAT 对照 PROD」是把名字里的 uat / prod 换掉后配对比较；名字不对称的资源配不上，会列在「只有一边有」。</li>"
             "<li>编号 <b>1-x</b> 到 <b>5-x</b> 对应下面五个部分；建议都是「先看，确认后再改」，本报告不代表已经改过。</li></ul>")
    rows = [("AWS 账号", f"<code>{e(acct)}</code>"), ("检查用的身份", f"<code>{e(d['identity'])}</code>"),
            ("Region", " ".join(f"<code>{e(r)}</code>" for r in d["regions"])), ("检查时间", e(d["generated_at"][:19].replace("T", " ") + " UTC")),
            ("UAT 的 VPC", "<br>".join(f"<code>{e(v['name'])}</code> <code>{e(v['id'])}</code> {e(v['cidr'])}" for v in uat_vpcs) or "没找到名字含 uat 的 VPC"),
            ("PROD 的 VPC", "<br>".join(f"<code>{e(v['name'])}</code> <code>{e(v['id'])}</code> {e(v['cidr'])}" for v in prod_vpcs) or "没找到名字含 prod 的 VPC"),
            ("未能检查", f'<span class="chip {"ok" if not d["errors"] else "s-中"}">{len(d["errors"])} 项</span> 见第 5 部分末尾' )]
    h.append('<table><tr><th style="width:20%">项目</th><th>内容</th></tr>' + "".join(f'<tr><td class="k">{k}</td><td>{v}</td></tr>' for k, v in rows) + "</table>")

    for i, (name, _) in enumerate(PARTS, 1):
        part = assigned.get(i, [])
        c = Counter(f["severity"] for f in part)
        h.append(f'<div class="bar"><b>第 {i} 部分　{e(name)}</b><span>{len(part)} 项' +
                 ("".join(f" · {s} {c[s]}" for s in SEV if c[s])) + "</span></div>")
        if not part:
            h.append('<p><span class="chip ok">没有发现问题</span></p>')
        big = [f for f in part if f["severity"] in ("高", "中")]
        small = [f for f in part if f["severity"] in ("低", "提示")]
        for f in big:
            h.append(card(ids[id(f)], f))
        if small:
            h.append(f'<p class="small">以下 {len(small)} 项风险较低，列表说明：</p>' + compact(small, ids))
        if i == 2:
            pairs = [x for x in d.get("drift", []) if x["diffs"]]
            same = [x for x in d.get("drift", []) if not x["diffs"]]
            h.append(f'<p class="small">共配对 {len(d.get("drift", []))} 组资源，{len(same)} 组关键设定完全一致，{len(pairs)} 组有差异（上面已按严重度列出）。</p>')

    h.append('<h2>建议处理顺序</h2><table><tr><th style="width:8%">顺序</th><th>做什么</th><th style="width:22%">对应编号</th></tr>')
    order = [
        ("先止血", lambda f: f["severity"] == "高" and f["area"] in ("安全",)),
        ("切断 UAT ↔ PROD 的越权", lambda f: f["severity"] == "高" and f["area"] in ("权限区分", "权限")),
        ("修 UAT 跑不起来 / 和 PROD 不一致的地方", lambda f: f["severity"] in ("高", "中") and f["area"] in ("配置", "UAT vs PROD")),
        ("补监控与审计（CloudTrail、GuardDuty、Flow logs）", lambda f: f["severity"] == "中" and f["area"] == "安全"),
        ("中风险权限收窄", lambda f: f["severity"] == "中" and f["area"] in ("权限区分", "权限")),
        ("低风险 / 提示，排进日常维护", lambda f: f["severity"] in ("低", "提示")),
    ]
    for n, (what, pred) in enumerate(order, 1):
        sel = [ids[id(f)] for f in fs if pred(f)]
        if sel:
            h.append(f'<tr><td class="num">{n}</td><td>{e(what)}</td><td class="mono">{e(", ".join(sorted(sel, key=lambda x: tuple(map(int, x.split("-"))))[:18]))}{" …" if len(sel) > 18 else ""}</td></tr>')
    h.append("</table>")

    if d["errors"]:
        h.append('<h2>未能检查的项目</h2><p class="small">下面这些 API 调用失败，相关项目没有被检查到（多半是检查用的身份缺少权限，或该服务在这个 region 没开通）。'
                 '补上 <code>SecurityAudit</code> + <code>ViewOnlyAccess</code> 两个 AWS managed policy 后重跑即可。</p>')
        agg = Counter((x["what"], x["code"]) for x in d["errors"])
        h.append('<table><tr><th>API</th><th style="width:30%">错误</th><th style="width:10%">次数</th></tr>' +
                 "".join(f'<tr><td class="mono">{e(w)}</td><td class="mono">{e(c)}</td><td>{n}</td></tr>' for (w, c), n in agg.most_common()) + "</table>")
    h.append("</body></html>")
    return "".join(h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("findings")
    ap.add_argument("-o", "--output", default="AWS-UAT-检查报告.pdf")
    ap.add_argument("--title", default="AWS UAT 环境检查报告")
    ap.add_argument("--html", help="同时输出 HTML，方便调版面")
    a = ap.parse_args()
    d = json.load(open(a.findings))
    doc = build(d, a.title)
    if a.html:
        open(a.html, "w").write(doc)
    foot = '<div style="width:100%;text-align:center;font-size:7pt;color:#9aa6b2;font-family:Noto Sans CJK SC"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    head = f'<div style="width:100%;text-align:right;font-size:7pt;color:#9aa6b2;padding-right:14mm;font-family:Noto Sans CJK SC">{e(a.title)}</div>'
    opts = {"path": os.path.abspath(a.output), "format": "A4", "printBackground": True, "displayHeaderFooter": True,
            "headerTemplate": head, "footerTemplate": foot,
            "margin": {"top": "16mm", "bottom": "16mm", "left": "14mm", "right": "14mm"}}
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        _pdf_with_node(doc, opts)
    else:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page()
            pg.set_content(doc, wait_until="load")
            pg.pdf(path=opts["path"], format="A4", print_background=True, display_header_footer=True,
                   header_template=head, footer_template=foot, margin=opts["margin"])
            b.close()
    print(f"已输出 {opts['path']}")


def _pdf_with_node(doc, opts):
    """没有 Python 版 Playwright 时，改用 Node 版（npm i playwright）。"""
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        src = os.path.join(t, "r.html")
        open(src, "w").write(doc)
        js = ("const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();"
              "await p.goto('file://'+process.argv[1],{waitUntil:'load'});await p.pdf(JSON.parse(process.argv[2]));await b.close();})()"
              ".catch(e=>{console.error(e);process.exit(1)})")
        subprocess.run(["node", "-e", js, src, json.dumps(opts)], check=True)


if __name__ == "__main__":
    main()
