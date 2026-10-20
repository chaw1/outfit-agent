# 服务端验收交接

结论：本地 S1–S7 已通过，真实闭环成功，现已恢复 Mock。公网 Linux 未部署：未收到个人或明确授权的新服务器及域名；部署文件已备好。

- S1：Compose 一键启动成功，health.ok=true；API 18080 / Postgres 18432，媒体在持久卷 `/data/media`。README 含 Linux + Caddy 自动 HTTPS 步骤。
- S2：Mock 同一 HTTP 脚本全链路 3.714 秒，4 原图 → v2 改图 → 笔记 → 视频；可重复运行，无模型网络调用。
- S3：真实同脚本全链路 413.039 秒，5 原图 + v2 改图 + 视频全部成功。媒体均转存；视频实测 5.007 秒、830×1108、H.264/AAC（请求 720P）。
- S4：选方向后重启 API 3.275 秒；脚本阶段、确认点、历史、卡片保留，自由文字继续改稿成功。
- S5：3 个不同方向，脚本 5 镜头引用具体衣服；“换成通勤风”实际重写场景/动作/配文。最终笔记标题 12 字、6 标签、分段/表情；真实再改稿 3.981 秒，视频和图片任务不变。
- S6：最终 `REQUIRE_INTEGRATION=1 uv run pytest -q --tb=short`：64 passed / 14.73 秒，零 skip；`ruff check .` 通过。含鉴权隔离、签名过期/篡改、阶段门禁、重试、空库 Alembic、真实 SKIP LOCKED、消息/任务恢复。
- S7：13 个约定操作全部实现，SSE token/card/job/done/error 字段一致；`openapi.json` 与运行中接口逐对象比对一致。

真实闭环每步耗时（秒）：

| 步骤 | 耗时 |
|---|---:|
| 健康 / 注册 / 登录 | 0.003 / 0.354 / 0.178 |
| 上传 2 衣服 + 模特 / 建项目 | 0.044 / 0.006 |
| 看图 + 方向 | 16.662 |
| 选方向 + 脚本 / 通勤改稿 | 6.732 / 6.072 |
| 确认脚本入队 / 5 图成功 | 0.032 / 140.643 |
| 改图 v2 / 笔记 | 42.495 / 4.176 |
| 确认视频至下载 / 历史读取 | 195.610 / 0.015 |

本轮全部真实调用（含首轮失败、最终文案抽查）：

| 模型 | 次数 | 总耗时秒 | 保守估算元 |
|---|---:|---:|---:|
| qwen3-vl-plus | 2 | 26.325 | 0.005174 |
| deepseek-flash | 8 | 41.186 | 0.098905 |
| wan2.7-image-pro | 11（10 成功 + 1 失败预留） | 452.429 | 5.500000 |
| wan2.6-i2v-flash | 1（5 秒带声） | 194.289 | 1.500000 |
合计 22 次，7.104079 元；按官方价目与保守汇率估算，含失败 0.5 元预留，未查询实际账单/免费额度抵扣。低于 12 元停止线、15 元上限。

实现选择：同步 FastAPI/SQLAlchemy/psycopg 简化事务；LangGraph PostgresSaver 用项目 id 作 thread_id，interrupt/Command 控制确认；Worker 独立领任务。理由、配置和部署见 README。
恢复机制：checkpoint 保存完整消息与任务意图，补齐业务提交中断；稳定去重键防止重复确认重复入队；视频保存上游 task_id，重试仅轮询。提供 e2e 的固定账号环境变量与 `--resume PROJECT_ID` 续跑入口。
接口出入：无字段/动作改名。SSE 在结构化工具结果校验后发送文字分片，模型处理期间为 keepalive，未逐 token 透传上游。
已知问题：同步生图结果未知时停止自动重发；首轮改图 120.640 秒后通用异常，旧日志无法确认根因。参考副本从 6 MB 压至 283 KB 后新项目完整通过，原文件保留。
内容边界：已修正本次衣摆冲突和虚构试穿措辞，生成文案仍应由博主审稿；每镜头最多 3 张参考（有模特时最多 2 件衣服），超限明确报错。

证据在本机 `artifacts/`：mock-review.json、restart-review.json、real-review.json、real-first-attempt.json、note-quality-review.json、usage-total.json、real-video-info.json；示例 real-edit.png / real-video.mp4。过程日志在 `evidence/`，均不提交。
复验：`docker compose up -d --build` → `uv sync --frozen --dev` → `REQUIRE_INTEGRATION=1 uv run pytest -q` → `uv run python scripts/e2e.py --mode mock`。当前进程模型密钥已清空。
交接：仅 feat/server 本地提交，不 push / 不合并；后续只需提供确认归属的新服务器和域名，按 `deploy/compose.caddy.yaml` 部署后验证公网 HTTPS。
