# 服务端第十轮：账号闭环

## 目标

把 `docs/设计.md` **第 15 节**里属于服务端的部分做出来（**唯一契约，字段名照它来**）：法律文本与接口（15.1）、注册同意字段（15.2）、恢复码找回密码（15.3）、修改密码与 token 作废（15.4）、注销账号（15.5）。三份法律正文要认真写，面向"衣序（演示版）"，内容真实、可读、不空话，每份 400–900 字。

另一轮（第九轮：点数 / 一键出片）正同时在另一个 worktree 改 `main.py`、`schemas.py`、`workflow.py`、`views.py` 和迁移 0010。为了合并不打架：**新接口全部放在新模块 `server/app/account.py`（APIRouter）**，`main.py` 只加一行 `include_router`；新 schema 放 `account.py` 或新文件；迁移文件 `0011_account_closure.py`，`down_revision = "0009"`。

## 验收标准（Claude 会亲自实测，不信自报）

1. `ruff check` 干净；`REQUIRE_INTEGRATION=1 python -m pytest -q` 全过。新增用例至少覆盖：`GET /api/legal/{kind}` 三种都返回且版本一致；注册返回一次性 `recovery_code`，再查任何接口都拿不到明文；`recover` 正确 → 密码变更、旧 token 401、返回新恢复码；错误恢复码 → `RECOVERY_FAILED` 且连续失败被限流；`POST /api/me/password` 后旧 token 401、新 token 可用；`DELETE /api/me` 后用户名可重新注册、原项目与媒体被清理、旧 token 401；老客户端不带 `agreed_legal_version` 仍能注册。
2. `scripts/e2e.py --mode mock` 通过；现有接口完全兼容。
3. 管理端用户列表显示"已注销"状态（只加字段与一个标签，不重排页面）。
4. `server/README.md` 补"第十轮"一段（接口表 + 恢复码口径 + 未做的短信通道如何接）；`openapi.json` 更新；交付摘要写到 `docs/codex/runs/server-round10-final.txt`（由 `-o` 指定）：做了什么、怎么验证、没做什么。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/server-account）工作，只提交本地分支，不 push，不碰 `app/`、`docs/设计.md` 和任何 `.env` / 凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不调用线上服务，不调用任何会花钱的模型接口。
3. 只增不改：不改现有登录 / 注册的语义，不改旧迁移，不动 `workflow.py` / `worker.py` / `views.py`；对 `main.py`、`schemas.py`、`models.py`、`security.py` 的改动最小化（能放新模块就放新模块）。
4. 2 小时内交付；按 15.1 → 15.2 → 15.3 → 15.4 → 15.5 顺序做，时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项跑一次测试，保证随时可交付。
