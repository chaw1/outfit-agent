# 贡献指南

接口和行为以 [设计](docs/设计.md) 为准；目录、质量门禁、发布和决策索引见 [工程规范](docs/工程规范.md)。

## 开发环境

App 使用 Node 22.13 以上（`app/package.json`），服务端使用 Python 3.11–3.12 和 uv（`server/pyproject.toml`）。已有依赖可直接复用；新 checkout 分别执行 `cd app && npm ci`、`cd server && uv sync --frozen --dev`。本地服务默认 Mock，不需要模型密钥。

```bash
# 从仓库根目录启用提交门禁；每个 checkout/worktree 检查自己的配置
git config core.hooksPath .githooks
```

门禁根据暂存路径选择检查侧：`app/` 运行 ESLint 和 TypeScript，`server/` 运行 ruff；同时修改两侧则都检查。检查整侧，避免漏掉跨文件类型和导入错误；检查读取工作区，提交前仍须检查暂存差异。仅文档变更不启动应用检查。

## 分支和提交

从最新 `main` 建功能分支，每个分支只处理一个明确目标。并行 worktree 不改其他轮次负责的业务代码。提交作者固定为 `chaw1 <97000945@qq.com>`，提交说明使用一行中文标题，不加工具署名或联合署名。

提交前先 `git status -s`，只精确暂存自己的文件，再检查 `git diff --cached`。不使用 `git add -A` 收入其他人的工作；不提交 `.env`、私钥、凭证、临时数据库、测试产物或依赖目录。调研、草稿和临时 SQL 默认留本地，正式文档与 Alembic 迁移除外。

## 提交前检查

根目录 `make check` 运行 App 完整校验和服务端 ruff/强制集成测试；`make e2e` 运行假服务浏览器流程和服务端 Mock HTTP 闭环。后者要求已启动本地 Mock API/Worker。`make dev` 使用 Compose 启动本项目 Mock 服务，App 可另开终端执行 `cd app && npm run start`。已有栈占用端口时复用，勿重复启动。

```bash
cd app
npm run verify
# 另跑假服务浏览器闭环；浏览器预先安装在该目录
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/browsers" npm run test:e2e
```

```bash
cd server
uv run ruff check .
REQUIRE_INTEGRATION=1 uv run pytest -q
```

服务端集成检查依赖本项目的本地 Mock API（`127.0.0.1:18080`）、Worker 和 PostgreSQL（`localhost:18432`）。没有栈时用 `cd server && docker compose up -d --build`；不要在已占用这些端口的其他 worktree 上再起第二套。测试会校验本机地址及 Mock 状态，迁移测试只创建、删除自身随机命名的 `outfit_test_*` 数据库。详见 [服务端说明](server/README.md)。

## 评审清单

- 契约：字段、错误码、SSE 卡片和旧客户端兼容符合 `docs/设计.md`；数据库变更配 Alembic 迁移，核对序列化与 App 类型。
- 边界：API 负责鉴权和输入校验，阶段与付费放行仍由服务端代码决定，供应商调用复用 Provider，生成任务交给 Worker。
- 体验：失败可解释、可恢复；请求有超时；写请求重试不会重复创建项目或付费任务；组件使用主题 token，不新增散落色值。
- 安全：校验用户/项目/资产归属，保留限流、上传限制、媒体签名和日志脱敏；不提交或记录明文凭证、完整签名 URL。
- 证据：运行受影响侧校验、相关单测及必要闭环，记录命令、结果、未验证范围；不要用 Mock 结果宣称真实模型效果或真机效果。
- 发布：先检查迁移兼容与数据备份，再部署、验健康和关键流程；预留旧镜像及数据库恢复方案，见工程规范。

## 代码约定

TypeScript 开启 strict；组件/类型用 PascalCase、变量/函数用 camelCase，Hook 用 `use` 前缀；沿用当前单引号和分号风格。Python 模块/函数/变量用 snake_case、类用 CapWords、常量用 UPPER_SNAKE_CASE，按 ruff 导入规则组织。新增代码遵守门禁；历史例外和规则级别以工程规范中的债务清单为准。不要运行格式化工具重排整仓。

业务错误沿用 App `ApiError` 和服务端 `AppError`；不要吞掉用户操作失败或向客户端透传堆栈。网络访问必须有超时；服务端事件使用 `structured_log`，异常使用 `log_exception` 脱敏，禁止打印 token、密码、模型密钥或媒体签名。
