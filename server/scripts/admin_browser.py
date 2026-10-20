#!/usr/bin/env python3
"""Capture all five admin pages and verify a 390 px layout on a local Mock stack.

Run with a temporary ADMIN_TOKEN in the environment:
  uv run --with playwright python scripts/admin_browser.py
No credentials or browser storage are written to the evidence.
"""

import argparse
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_MESSAGE = "此操作暂不可用，请检查用户状态。"
PAGES = {
    "overview": "总览",
    "usage": "用量统计",
    "settings": "模型与配额",
    "jobs": "任务队列",
    "users": "用户管理",
}


def chromium_path() -> str | None:
    """Reuse an installed Chromium rather than downloading a browser."""
    if os.environ.get("ADMIN_BROWSER_EXECUTABLE"):
        return os.environ["ADMIN_BROWSER_EXECUTABLE"]
    cache = Path.home() / "Library/Caches/ms-playwright"
    candidates = list(cache.glob("chromium-*/*/*.app/Contents/MacOS/Google Chrome for Testing"))
    if not candidates:
        return None
    return str(max(candidates, key=lambda p: int(p.parts[-6].split("-")[-1])))


def run(base_url: str, output: Path) -> None:
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.port != 18080
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Browser verification only allows this worktree's local HTTP stack")
    token = os.environ.get("ADMIN_TOKEN")
    if not token:
        raise ValueError("Supply a temporary ADMIN_TOKEN through the process environment")
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "mode": "mock",
        "base_url": base_url,
        "viewport": {"width": 390, "height": 844},
        "created_at": datetime.now(UTC).isoformat(),
        "pages": {},
        "console_errors": [],
        "expected_console_errors": [],
        "page_errors": [],
        "http_errors": [],
        "expected_http_errors": [],
        "success": False,
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=chromium_path())
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=1,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            reduced_motion="reduce",
            accept_downloads=True,
        )
        page = context.new_page()
        forbidden_probe = {"active": False}

        def console_message(message):
            if message.type != "error":
                return
            expected = forbidden_probe["active"] and "403" in message.text
            key = "expected_console_errors" if expected else "console_errors"
            report[key].append(message.text)

        def response_received(response):
            if response.status < 400:
                return
            url = urlsplit(response.url)
            expected = response.status == 403 and url.query == "q=fixture_forbidden"
            key = "expected_http_errors" if expected else "http_errors"
            report[key].append({"path": url.path, "status": response.status})

        page.on("console", console_message)
        page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
        page.on("response", response_received)
        try:
            health = context.request.get(base_url + "/api/health").json()
            assert health["providers"]["mock"] is True, "Real model providers are forbidden"
            page.goto(base_url + "/admin", wait_until="networkidle")
            expect(page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            page.get_by_label("管理口令", exact=True).fill(token)
            page.get_by_role("button", name="进入管理台").click()
            expect(page.get_by_role("heading", name="总览", exact=True)).to_be_visible()
            assert page.locator("#admin-token").input_value() == ""
            report["login"] = "independent login succeeded; password field cleared"
            for route, title in PAGES.items():
                page.locator(f'nav [data-page="{route}"]').click()
                expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
                page.wait_for_load_state("networkidle")
                if route == "usage":
                    for group in ("day", "user", "model"):
                        page.locator(f'[data-group="{group}"]').click()
                        expect(page.locator(f'[data-group="{group}"]')).to_have_class("active")
                        page.wait_for_load_state("networkidle")
                    with page.expect_download() as download_info:
                        page.get_by_role("button", name="导出 CSV").click()
                    download = download_info.value
                    csv = Path(download.path()).read_bytes()
                    assert len(csv) > 0
                    report["usage_csv"] = {"bytes": len(csv), "downloaded": True}
                    page.locator("#toast").wait_for(state="hidden", timeout=6000)
                if route == "settings":
                    report["model_candidates"] = {
                        ability: page.locator(f"#model-{ability} option").count()
                        for ability in ("text", "vision", "image", "video")
                    }
                    assert all(count > 0 for count in report["model_candidates"].values())
                    expect(page.get_by_role("button", name="保存设置")).to_be_visible()
                    read_settings = """async () => {
                        const response = await fetch('/api/admin/settings', {headers: {
                            Authorization: 'Bearer ' +
                                sessionStorage.getItem('outfit_admin_session')
                        }});
                        const {models, tiers, global_daily_budget_cny} = await response.json();
                        return {models, tiers, global_daily_budget_cny};
                    }"""
                    original_settings = page.evaluate(read_settings)
                    with page.expect_response(lambda response: (
                        urlsplit(response.url).path == "/api/admin/settings"
                        and response.request.method == "PUT"
                    )) as saved:
                        page.get_by_role("button", name="保存设置").click()
                    assert saved.value.status == 200
                    expect(page.locator("#toast")).to_have_text("设置已保存")
                    expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
                    assert page.evaluate(read_settings) == original_settings
                    page.locator("#toast").wait_for(state="hidden", timeout=6000)
                    report["settings_save"] = {"status": 200, "original_values_preserved": True}
                if route == "jobs":
                    page.locator("#job-status").select_option("queued")
                    page.get_by_role("button", name="查询", exact=True).click()
                    expect(page.locator("#job-status")).to_have_value("queued")
                    page.wait_for_load_state("networkidle")
                    page.locator("#job-status").select_option("")
                    page.get_by_role("button", name="查询", exact=True).click()
                    expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
                    expect(page.locator("#job-status")).to_have_value("")
                    page.wait_for_load_state("networkidle")
                    report["job_controls"] = {
                        "retry": page.locator('[data-job-action="retry"]').count(),
                        "cancel": page.locator('[data-job-action="cancel"]').count(),
                    }
                if route == "users":
                    message = FORBIDDEN_MESSAGE
                    page.route(
                        "**/api/admin/users?q=fixture_forbidden",
                        lambda route: route.fulfill(
                            status=403, content_type="application/json",
                            body=json.dumps({"error": {
                                "code": "fixture_forbidden", "message": FORBIDDEN_MESSAGE,
                            }}, ensure_ascii=False),
                        ),
                        times=1,
                    )
                    forbidden_probe["active"] = True
                    page.locator("#user-search").fill("fixture_forbidden")
                    page.get_by_role("button", name="搜索", exact=True).click()
                    expect(page.get_by_text(message, exact=True)).to_be_visible()
                    expect(page.locator("#app")).to_be_visible()
                    expect(page.locator("#login")).to_be_hidden()
                    assert page.evaluate(
                        "Boolean(sessionStorage.getItem('outfit_admin_session'))"
                    )
                    page.wait_for_load_state("networkidle")
                    forbidden_probe["active"] = False
                    report["business_403"] = {
                        "session_preserved": True, "chinese_error_visible": True,
                    }
                    page.get_by_role("button", name="刷新", exact=True).click()
                    expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
                    page.locator("#user-search").fill("no_such_local_fixture_user")
                    page.get_by_role("button", name="搜索", exact=True).click()
                    expect(page.get_by_text("没有找到用户", exact=True)).to_be_visible()
                    page.locator("#user-search").fill("")
                    page.get_by_role("button", name="搜索", exact=True).click()
                    expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
                    expect(page.locator("#user-search")).to_have_value("")
                    page.wait_for_load_state("networkidle")
                    report["user_controls"] = {
                        "tier": page.locator("[data-user-tier]").count(),
                        "enable_disable": page.locator("[data-user-toggle]").count(),
                    }
                expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
                expect(page.locator("#main .loading")).to_have_count(0)
                layout = page.evaluate("""() => ({
                    viewport: window.innerWidth,
                    document: document.documentElement.scrollWidth,
                    body: document.body.scrollWidth,
                    content: document.querySelector('main').scrollWidth,
                    content_width: document.querySelector('main').clientWidth,
                    overflowing: [...document.querySelectorAll('body *')].filter(el => {
                        const r = el.getBoundingClientRect();
                        return r.width && r.right > window.innerWidth + 1;
                    }).map(el => el.tagName + (el.id ? '#' + el.id : ''))
                })""")
                assert layout["viewport"] == 390
                assert layout["document"] <= 390 and layout["body"] <= 390, layout
                assert layout["content"] <= layout["content_width"], layout
                assert not layout["overflowing"], layout
                screenshot = output / f"{route}-390.png"
                page.screenshot(path=str(screenshot), full_page=False, animations="disabled")
                if route == "settings":
                    page.screenshot(
                        path=str(output / "settings-full-390.png"),
                        full_page=True, animations="disabled",
                    )
                report["pages"][route] = {"title": title, "screenshot": screenshot.name, **layout}
            fresh_page = context.new_page()
            fresh_page.goto(base_url + "/admin", wait_until="networkidle")
            expect(fresh_page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            fresh_page.close()
            report["tab_isolation"] = True
            page.get_by_role("button", name="退出", exact=True).click()
            expect(page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            report["logout"] = True
            assert not report["console_errors"], report["console_errors"]
            assert not report["page_errors"], report["page_errors"]
            assert not report["http_errors"], report["http_errors"]
            report["success"] = True
        except Exception as error:
            report["failure"] = str(error).replace(token, "[REDACTED]")
            raise
        finally:
            (output / "browser.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n"
            )
            context.close()
            browser.close()
    print(f"Admin browser verification passed: {output / 'browser.json'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/admin")
    arguments = parser.parse_args()
    run(arguments.base_url.rstrip("/"), arguments.output)
