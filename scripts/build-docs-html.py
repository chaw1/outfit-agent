#!/usr/bin/env python3
"""把 README 与 docs/*.md 渲染成可直接打开阅读的 HTML（docs/html/）。

用法：python3 scripts/build-docs-html.py
依赖：python-markdown、pygments（本机已有；CI 不要求）。
链接规则：指向仓库内 .md 的链接改指对应 .html；图片与其他相对路径按文件位置重算。
"""

from __future__ import annotations

import html
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

import markdown
from markdown.extensions.toc import TocExtension

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "html"

# 阅读顺序：先总览，再按"调研 → 设计 → 工程 → 记录"排。
ORDER = [
    ("README.md", "README · 总览与最终验收索引"),
    ("docs/调研.md", "调研：场景、生成能力与框架"),
    ("docs/调研-Chiccify对照.md", "调研：与 Chiccify 的对照"),
    ("docs/设计.md", "设计约定：范围、分期与接口契约"),
    ("docs/UI设计稿.md", "UI 设计稿：信息架构、流程与页面"),
    ("docs/设计系统.md", "设计系统：衣序 DS"),
    ("docs/工程规范.md", "工程规范与 ADR 索引"),
    ("CONTRIBUTING.md", "贡献指南"),
    ("docs/功能清单.md", "功能清单"),
    ("docs/验收与部署.md", "验收索引与部署"),
    ("docs/评审-独立评估.md", "独立评审"),
    ("docs/开发记录.md", "开发记录"),
    ("docs/开发感受.md", "开发感受"),
    ("server/README.md", "服务端 README"),
    ("app/README.md", "App README"),
]

CSS = """
:root { --ink:#252522; --muted:#6D6963; --line:#E9E5DE; --paper:#FCFAF7; --surface:#FFFFFF; --accent:#D91B38; --code:#F4F1EC; --side: 280px; }
@media (prefers-color-scheme: dark) { :root { --ink:#F7F3EA; --muted:#B8B6B1; --line:#35373D; --paper:#1B1C1F; --surface:#232428; --accent:#FF7084; --code:#2A2B30; } }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin:0; background:var(--paper); color:var(--ink); font: 16px/1.75 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.top { position: sticky; top: 0; z-index: 2; display:flex; gap:16px; align-items:center; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--line); font-size: 14px; }
.top .brand { font-weight: 700; letter-spacing: .5px; }
.top .crumb { color: var(--muted); }
.top .nav { margin-left:auto; display:flex; gap:14px; flex-wrap: wrap; }
.wrap { display: grid; grid-template-columns: var(--side) minmax(0, 1fr); gap: 32px; max-width: 1280px; margin: 0 auto; padding: 24px 20px 80px; }
nav.toc { position: sticky; top: 56px; align-self: start; max-height: calc(100vh - 72px); overflow: auto; font-size: 13px; line-height: 1.5; padding-right: 8px; }
nav.toc ul { list-style: none; margin: 0; padding-left: 12px; } nav.toc > ul { padding-left: 0; }
nav.toc li { margin: 4px 0; } nav.toc a { color: var(--muted); } nav.toc a:hover { color: var(--accent); }
nav.toc > ul > li > a { color: var(--ink); font-weight: 600; }
main { min-width: 0; }
main h1 { font-size: 30px; line-height: 1.3; margin: 0 0 20px; }
main h2 { font-size: 22px; margin: 44px 0 14px; padding-top: 12px; border-top: 1px solid var(--line); }
main h3 { font-size: 18px; margin: 30px 0 10px; } main h4 { font-size: 16px; margin: 22px 0 8px; }
main p, main ul, main ol { margin: 0 0 14px; } main li { margin: 4px 0; }
main img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
main table { border-collapse: collapse; width: 100%; margin: 14px 0 20px; font-size: 14.5px; display: block; overflow-x: auto; }
main th, main td { border: 1px solid var(--line); padding: 8px 10px; vertical-align: top; text-align: left; }
main th { background: var(--code); white-space: nowrap; }
main code { font: 13.5px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
main pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow: auto; font-size: 13.5px; line-height: 1.55; }
main pre code { background: none; padding: 0; }
main blockquote { margin: 0 0 14px; padding: 8px 16px; border-left: 3px solid var(--accent); background: var(--surface); color: var(--muted); }
main hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
.headerlink { opacity: 0; margin-left: 6px; font-size: 14px; } h2:hover .headerlink, h3:hover .headerlink { opacity: .6; }
pre.mermaid { background: var(--surface); text-align: center; }
.meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.index-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; list-style: none; padding: 0; }
.index-list li { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; background: var(--surface); }
.index-list .n { color: var(--muted); font-size: 12px; } .index-list a { font-weight: 600; display: block; margin: 2px 0 4px; }
.index-list .d { color: var(--muted); font-size: 13px; }
@media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } nav.toc { position: static; max-height: none; border-bottom: 1px solid var(--line); padding-bottom: 12px; } }
@media print { .top, nav.toc { display: none; } .wrap { display: block; padding: 0; } }
"""

MERMAID = (
    '<script type="module">'
    'import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";'
    'mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral" });'
    "</script>"
)


def relpath(target: Path, start: Path) -> str:
    return os.path.relpath(target, start).replace(os.sep, "/")


def rewrite_links(body: str, src: Path, converted: dict[Path, Path]) -> str:
    """把 href/src 的相对路径按 docs/html/ 的位置重算；仓库内 .md 指向生成的 .html。"""

    def fix(match: re.Match[str]) -> str:
        attr, quote, url = match.group(1), match.group(2), match.group(3)
        parts = urlsplit(url)
        if parts.scheme or url.startswith(("#", "/", "mailto:", "data:")):
            return match.group(0)
        target = (src.parent / unquote(parts.path)).resolve()
        if target in converted:
            new = relpath(converted[target], OUT)
        elif target.exists():
            new = relpath(target, OUT)
        else:
            return match.group(0)
        if parts.fragment:
            new += "#" + parts.fragment
        return f"{attr}={quote}{html.escape(new, quote=True)}{quote}"

    return re.sub(r'\b(href|src)=(["\'])([^"\']+)\2', fix, body)


def render(src: Path, title: str, converted: dict[Path, Path]) -> str:
    text = src.read_text(encoding="utf-8")
    # mermaid 代码块先换成原样 HTML，交给页面里的 mermaid 渲染；其余代码块走高亮。
    text = re.sub(
        r"```mermaid\n(.*?)```", lambda m: "<pre class=\"mermaid\">\n" + html.escape(m.group(1)) + "</pre>", text, flags=re.S,
    )
    md = markdown.Markdown(extensions=[
        "tables", "fenced_code", "attr_list", "md_in_html", "sane_lists", "def_list",
        "codehilite", TocExtension(permalink="¶", toc_depth="2-3", slugify=slugify),
    ], extension_configs={"codehilite": {"guess_lang": False, "noclasses": True, "pygments_style": "friendly"}})
    body = md.convert(text)
    body = rewrite_links(body, src, converted)
    toc = md.toc  # type: ignore[attr-defined]
    uses_mermaid = 'class="mermaid"' in body
    nav = " ".join(
        f'<a href="{html.escape(relpath(converted[ROOT / p], OUT))}">{html.escape(t.split("：")[0].split(" · ")[0])}</a>'
        for p, t in ORDER if (ROOT / p) in converted and (ROOT / p) != src
    )
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · 衣序</title><style>{CSS}</style>{MERMAID if uses_mermaid else ""}</head>
<body><div class="top"><span class="brand">衣序 · 文档</span><span class="crumb">{html.escape(relpath(src, ROOT))}</span><div class="nav"><a href="index.html">目录</a> {nav}</div></div>
<div class="wrap"><nav class="toc">{toc}</nav><main>{body}</main></div></body></html>
"""


def slugify(value: str, separator: str) -> str:
    value = re.sub(r"[^\w一-鿿\- ]", "", value).strip().lower()
    return re.sub(r"[\s]+", separator, value) or "section"


def build_index(converted: dict[Path, Path], titles: dict[Path, str]) -> str:
    items = []
    for number, (p, t) in enumerate(ORDER, 1):
        src = ROOT / p
        if src not in converted:
            continue
        first = next((line.strip("# ").strip() for line in src.read_text(encoding="utf-8").splitlines() if line.startswith("# ")), "")
        items.append(f'<li><div class="n">{number:02d} · {html.escape(p)}</div><a href="{html.escape(relpath(converted[src], OUT))}">{html.escape(t)}</a><div class="d">{html.escape(first)}</div></li>')
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>衣序 · 文档目录</title><style>{CSS}</style></head>
<body><div class="top"><span class="brand">衣序 · 文档</span><span class="crumb">docs/html/index.html</span></div>
<div class="wrap" style="display:block"><main><h1>衣序 · 文档目录</h1><p class="meta">由 <code>scripts/build-docs-html.py</code> 从仓库 Markdown 生成；阅读顺序即开发顺序：调研 → 设计 → 工程底座 → 实现与回归。源文件改动后重新运行即可。</p>
<ul class="index-list">{"".join(items)}</ul></main></div></body></html>
"""


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    converted: dict[Path, Path] = {}
    titles: dict[Path, str] = {}
    for p, t in ORDER:
        src = ROOT / p
        if not src.exists():
            print(f"跳过（不存在）: {p}", file=sys.stderr)
            continue
        stem = src.stem if src.parent != ROOT and src.parent.name == "docs" else f"{src.parent.name}-{src.stem}" if src.parent != ROOT else src.stem
        converted[src] = OUT / f"{stem}.html"
        titles[src] = t
    for src, dst in converted.items():
        dst.write_text(render(src, titles[src], converted), encoding="utf-8")
        print(f"{relpath(src, ROOT)} -> {relpath(dst, ROOT)}")
    (OUT / "index.html").write_text(build_index(converted, titles), encoding="utf-8")
    print(f"index -> {relpath(OUT / 'index.html', ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
