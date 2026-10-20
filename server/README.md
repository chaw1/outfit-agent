# 穿搭笔记智能体服务端

接口只遵循 [`docs/设计.md`](../docs/设计.md)。API、智能体、Worker 共用 PostgreSQL，媒体写入命名卷，支持同一项目中断后继续。默认 Mock，不需要模型凭证。实际验证结果见 [`FINAL.md`](FINAL.md)，本文的 Linux 部署步骤不是已部署声明。

## 选择与边界

- **FastAPI + SQLAlchemy 2 + psycopg**：同步数据库/模型客户端便于审阅事务边界，FastAPI 在线程池执行阻塞路径；SSE 单独返回契约事件。鉴权采用 bcrypt + 7 天 JWT。
- **LangGraph + PostgresSaver**：`thread_id = project.id`，业务阶段、脚本和方向保存在 checkpoint；`interrupt()` 等博主确认，`Command(resume=...)` 继续。阶段决定可用工具，DeepSeek function calling 返回对应结构化对象。固定业务阶段便于控制付费边界；阶段内自由文本可以实际改写脚本，明确指定图片也可改图；视频生成中和完成后仍可修订笔记，保持原视频与图片顺序。
- **PostgreSQL 任务队列**：API 只入队，独立 Worker 使用 `FOR UPDATE SKIP LOCKED` 领取任务，记录重试次数和租约。图片与视频的动态结果从任务表投射到 state，Worker 不并发修改对话 checkpoint。对话不等待生图/视频；App 在 `active_jobs` 非空时每 3 秒读取 state。
- **本地媒体卷**：及时下载供应商临时 URL，转存为项目资产并保留版本链；对外使用 24 小时 HMAC 签名地址。持有签名 URL 即可读取媒体，App `<Image>` 无需 bearer token；业务项目、素材引用和任务仍按账号隔离。
- **Alembic** 管理业务表，API 启动时执行迁移；PostgresSaver 在 lifespan 初始化 checkpoint 表。两者共用数据库，任务意图、完整展示消息和稳定去重键用于修复 checkpoint 与业务事务提交之间的空隙。

## 本地启动

需要 Docker Compose v2；本机脚本需要 Python 3.11 和 [uv](https://docs.astral.sh/uv/)。在当前 `server/` 目录执行：

```bash
docker compose up -d --build
curl -fsS http://localhost:18080/api/health
uv sync --frozen --dev
uv run python scripts/e2e.py --mode mock
uv run python scripts/restart_e2e.py --mode mock
REQUIRE_INTEGRATION=1 uv run pytest -q
uv run ruff check .
```

固定 compose 项目名 `outfit-agent-server`。API 默认 `18080`，PostgreSQL 仅在本机 `18432` 可访问。不要对其他项目的容器做操作。重启脚本只执行本目录的 `docker compose restart api`，验证选方向后的脚本、历史、卡片、待确认动作均保留，随后自由文本继续修改。停止本项目用 `docker compose stop`；不需要删除媒体卷。

OpenAPI 静态导出位于 [`openapi.json`](openapi.json)，运行中还可查看 `http://localhost:18080/docs` 和 `/openapi.json`。SSE 事件为 `token/card/job/done/error`；消息与卡片先持久化再返回。当前结构化工具结果完整校验后才发送文本分片，模型处理期间发送 keepalive；没有逐 token 透传上游推理。客户端重连后可读取 `/messages` 和 `/state` 恢复工作台。

### 验证脚本与证据

`scripts/e2e.py` 只通过 HTTP 运行完整链路：注册、登录、上传两件衣服和模特、方向/脚本、自由文本“换成通勤风”、确认生成至少 4 张图、改图 v2、选图与笔记、单独确认 5 秒视频、下载媒体。Mock/real 用同一脚本，只切换服务器配置与 `--mode`。模式与 `/health` 不一致会拒绝执行。

素材来自 [`fixtures/README.md`](fixtures/README.md) 所述仓库自生成参考图裁片，无外部图片依赖。Mock provider 只产生本地固定媒体及结构化文本，不进行模型网络调用。每步耗时、项目 ID、任务和卡片摘要实时写到 `artifacts/*.json`，不保存 bearer token、密码或媒体签名。失败证据保留已完成步骤，便于定位后续接续点；重新运行会创建独立账号/项目，不覆盖此前结果。

```bash
uv run python scripts/e2e.py --mode mock --output artifacts/mock-review.json
uv run python scripts/restart_e2e.py --mode mock --output artifacts/restart-review.json
```

需要复用真实验证进度时，先在当前进程环境设置 `E2E_USERNAME`、`E2E_PASSWORD`（不要把密码写入命令历史）。脚本会用该固定账号注册，已存在则登录；证据只记录用户名和项目 ID。失败后读取证据中的 `project_id`，在同一凭证环境中执行：

```bash
uv run python scripts/e2e.py --mode real --resume PROJECT_ID --output artifacts/real-review.json
```

续跑按当前阶段复用已确认脚本、已有出图/改图任务、笔记及视频，不重复确认已入队的付费步骤；有活跃任务时等待，已成功的 v2 和视频直接复用。同一路径已有证据保存在 `previous_runs`。终态失败任务会明确停止，脚本不会绕过重试上限自动重复付费。未设置固定账号环境变量时，默认仍每次创建随机账号。

pytest 的 HTTP 集成用例要求本机 Mock 栈；默认无栈时标记跳过，`REQUIRE_INTEGRATION=1` 强制要求可用，防止把跳过当通过。测试只允许 `localhost/127.0.0.1:18080`。迁移测试仅在 `localhost:18432` 新建随机 `outfit_test_*` 空库，运行 Alembic 并核对六张业务表，最后删除该测试自己创建的库；业务数据库不做清理。自定义数据库口令时应为测试进程设置相同 `TEST_DATABASE_URL` 和 `JWT_SECRET`，凭证只注入环境变量。

## 配置

配置仅从进程环境读取，应用不会自动加载 `.env`。Compose 可用 `.env.example` 查看无密钥示例；实际密钥、数据库密码和 JWT secret 只注入启动进程环境，不写入文件或提交。

| 变量 | 默认值 / 用途 |
|---|---|
| `MOCK_PROVIDERS` | `1`；全部模型调用改为本地实现 |
| `DATABASE_URL` | 本机开发 `postgresql+psycopg://…@localhost:18432/outfit`；Compose 内部为 `postgres:5432` |
| `POSTGRES_PASSWORD` | 本地默认 `outfit`；公开部署必须替换 |
| `JWT_SECRET` | 本地开发固定值；生产必须随机值，API/Worker/测试签名须一致 |
| `PUBLIC_BASE_URL` | `http://localhost:18080`；App 可访问的绝对媒体根地址 |
| `MEDIA_DIR` | 开发 `data/media`；Compose `/data/media` 命名卷 |
| `API_PORT` / `POSTGRES_PORT` | `18080` / `18432` |
| `API_BIND` | 本地默认 `0.0.0.0`；Caddy 部署设 `127.0.0.1` |
| `DASHSCOPE_API_KEY` / `DEEPSEEK_API_KEY` | 真实模式必须通过进程环境设置 |
| `TEXT_MODEL` / `VISION_MODEL` | `deepseek-flash` / `qwen3-vl-plus` |
| `IMAGE_MODEL` / `VIDEO_MODEL` | `wan2.7-image-pro` / `wan2.6-i2v-flash` |
| `MODEL_BUDGET_CNY` | `12`；真实调用的本项目预算保护阈值，以代码配置为准 |
| `ENVIRONMENT` | `development`；公开部署设 `production` |
| `CORS_ORIGINS` | `*`；可设逗号分隔的网页来源，原生 App 不受浏览器 CORS 约束 |

启动真实模式前，在当前终端安全注入两家模型密钥，设置 `MOCK_PROVIDERS=0` 后重新创建 API 和 Worker。不要把密钥打印到终端或运行日志。脚本真实链路会生成至少 5 张图和 1 条视频：

```bash
export MOCK_PROVIDERS=0
docker compose up -d --force-recreate api worker
uv run python scripts/e2e.py --mode real --output artifacts/real-review.json
```

预算账本在 `usage_ledger` 记录模型、计时、单位和估算金额，最终账单以供应商为准。默认按[通义万相图片](https://help.aliyun.com/zh/model-studio/wan2-7-image-pro) 0.5 元/张、[万相视频](https://help.aliyun.com/zh/model-studio/wan2-6-i2v-flash) 720P 带声 0.3 元/秒，以及 [DeepSeek 官方 token 价格](https://api-docs.deepseek.com/quick_start/pricing/)的峰值价保守估算。账本覆盖本库全部真实调用，重启不会重置预算；未知结果的已发出图片请求不会自动重提。`uv run python scripts/report_usage.py --output artifacts/usage.json` 可导出脱敏用量汇总。真实完成项目可用固定验收账号环境变量运行 `uv run python scripts/review_note.py --mode real --project-id PROJECT_ID`，抽查文案改写且不新增媒体任务（会调用一次文本模型）。真实验证完成后恢复 `MOCK_PROVIDERS=1` 并重新创建 API、Worker，避免日常测试触发费用。

## 单台 Linux + Caddy 自动 HTTPS

1. 在**个人或明确授权的新服务器**安装 Docker Engine 和 Compose v2，把本仓库 `server/` 复制到部署目录。以下命令均在该目录运行，不能用于前公司服务器。
2. 将自有域名 A/AAAA 记录指向服务器，仅开放 80/443（以及自己的管理入口）。数据库保持 loopback 绑定，API 宿主端口也绑定 loopback；Caddy 走内部 `api:8000`。
3. 通过管理员的进程环境注入高强度 `JWT_SECRET`、`POSTGRES_PASSWORD` 和需要的模型密钥。不要用开发默认值。配置公开地址：

```bash
export DOMAIN=outfit.example.com
export PUBLIC_BASE_URL="https://$DOMAIN"
export ENVIRONMENT=production API_BIND=127.0.0.1
export MOCK_PROVIDERS=1
docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d --build
curl -fsS "https://$DOMAIN/api/health"
```

`deploy/compose.caddy.yaml` 增加 Caddy、80/443 端口和证书持久卷；`deploy/Caddyfile` 按域名自动申请/续期证书。`flush_interval -1` 及时转发 SSE，上传限制 16 MB。域名未解析、80/443 未放通时，先处理 DNS/防火墙再申请证书。

部署后以公网 HTTPS 地址运行同一 HTTP 验证脚本，例如 `--base-url https://outfit.example.com --mode mock`。原生 App 的 API 根地址用 `https://outfit.example.com/api`，媒体使用响应中的绝对签名 URL。检查模型下载后的文件在媒体卷、API/Worker 重启后仍可读；备份数据库及媒体卷时要同步保留版本链，不要仅备份 checkpoint 表。此仓库未内置用户界面、账号找回、对象存储和多机部署。
