# 管理端验收交接

结论：A1–A6 已通过本机 Mock 验证；本轮真实模型调用 0 次、费用 0 元。仅 feat/server，不部署、不 push、不合并。功能提交：`a8fdf6a`。

- **A1 登录与隔离通过**：独立 8 小时 Bearer 会话，App JWT 双向隔离、口令旋转失效、空 ADMIN_TOKEN（含非法 JSON）统一 404。证据：`tests/test_admin_api.py`、`artifacts/admin/acceptance.json`、`artifacts/admin/review-browser.json`。
- **A2 五页通过**：总览、三维用量/用户筛选/CSV、模型配额、队列重试取消、用户禁启用/层级。HTTP 验证重试后 Worker 成功、取消后 attempts=0；390px 全页 DOM 无溢出，页面无非预期报错。证据：`artifacts/admin/acceptance.json`、`artifacts/admin/browser.json`。
- **A3 运行配置通过**：数据库无缓存读取；不重启将出图切为 wan2.6-image，Worker 新产物 model 同步改变。free 预算归零拒绝确认出图且无新任务，对话仍正常；升 pro 后立即恢复。用户/全局配额、四类生成入口与恢复守门见 `tests/test_admin_runtime.py`、`artifacts/admin/acceptance.json`。
- **A4 数据与迁移通过**：`alembic/versions/0004_admin.py` 新增 app_settings、用户 tier/disabled、账本 user_id 并按 project 回填；空库、含旧用户/项目/账本的 0003 库升级均通过，孤立账本保留 NULL。证据：`tests/test_migrations.py`、`tests/test_admin_migrations.py`、`artifacts/admin/pytest.log`。未操作线上库。
- **A5 无退步**：220 passed（30.04s），ruff 通过，Mock e2e 与 E1–E4 全通过；原 10 个接口与 25 个 schema 完全一致，新增 10 个管理路径，静态/运行中 OpenAPI 一致。证据目录 `artifacts/admin/`：`pytest.log`、`ruff.log`、`e2e.json`、`experiments.json`、`contract.json`、`source-manifest.json`；定义：`openapi.json`。
- **A6 文档通过**：`README.md` 管理端章节含启用、登录、环境变量、预算和边界；`.env.example` ADMIN_TOKEN 留空，Compose 显式传入。`docs/设计.md` 第 9 节约定未改。

页面截图（均 390×844，另附完整配额页）：

- [总览](artifacts/admin/overview-390.png) · [用量统计](artifacts/admin/usage-390.png) · [模型与配额](artifacts/admin/settings-390.png)
- [任务队列](artifacts/admin/jobs-390.png) · [用户管理](artifacts/admin/users-390.png) · [完整配额页](artifacts/admin/settings-full-390.png)

技术选型：FastAPI 同容器提供无外部依赖的单文件 HTML/CSS/JS，复用认证错误格式和数据库，不增加进程或前端构建步骤。

复测：在 `server/` 执行 `uv run python scripts/admin_review.py`，自动产生进程内临时口令并依次构建、测试、联测、实验、截图；退出时恢复空口令 Mock。仅改截图脚本可用 `--browser-only` 续验；证据保存在 `artifacts/admin/`。
断点：本地 `PROGRESS.md`；首次截图的旧 favicon 404、第二次浏览器探针回调错误及最终通过记录均保留，最终页面证据以 `browser.json` 和 `review-browser.json` 为准。

已知边界：每日按北京时间重算，默认 free/pro/全局为 12/120/1200 元，层级默认允许所有候选。预算未到时可先入队整批，Worker 逐次预留，到限后剩余任务失败；不是整批预扣。取消沿用 App 的 failed 状态并加管理标记。
原真实模式 `MODEL_BUDGET_CNY` 全历史硬上限仍独立保留；候选模型仅验证 Mock 切换，未付费复测真实兼容。截图累计费用含历史调用，与本轮 0 元分开。
本机最终状态：API/Worker 均 Mock、无模型 key，ADMIN_TOKEN 空、管理端 404；真实服务器与线上服务均未访问。
