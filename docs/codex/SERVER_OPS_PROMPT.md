# /goal：服务端第五轮——博主档案、级联删除、线上防护与 CI

管理端已经做完。这一轮把服务端补成"线上系统该有的样子"：博主档案与偏好记忆、项目删除级联清理、限流与上传校验、请求 id 与结构化日志、CI。**约定是 `docs/设计.md` 第 10 节（10.1、10.2、10.5、10.6）**，照它做；它没写的自己定并在交付里写明理由。App 侧正在按同一节并行开发，**接口字段名严格按设计，不要自己发明**。

## 成功标准（Claude 会自己复测，不信自报）

- **O1 博主档案**：`GET /api/me` 返回 `tier / daily_budget_cny / today_cost_cny / profile`；`PATCH /api/me` 能改昵称和档案，非本人的 `model` 资产被拒绝（中文说明）。新建项目不传 `model_asset_id` 时取档案默认照片；`style_notes` 进入智能体上下文，Mock 和真实路径都带上（用 1–2 次真实 DeepSeek 调用证明方向 / 脚本回复体现了偏好，≤ 0.1 元）。
- **O2 级联删除**：删项目后消息、任务、checkpoint、生成媒体文件都清掉，上传的衣服原图保留；运行中的任务被取消不再回写。
- **O3 防护**：注册 / 登录按 IP 限流，上传 / 对话按用户限流，超限 429 中文说明；上传类型 / 大小 / 尺寸校验，413/415 中文说明；限流阈值可配置，测试里用小阈值验证。
- **O4 可观测**：每个请求有 `X-Request-Id`（客户端带了就沿用），JSON 结构化日志含请求 id、用户、项目、耗时、状态码；模型调用日志含模型、耗时、费用；管理端总览加"最近 24 小时错误数"和请求量。
- **O5 CI**：`.github/workflows/ci.yml`：服务端 ruff + pytest（Mock，services 起 postgres）、App typecheck + lint + 单测；本地用 `act` 或等价方式证明工作流语法正确、步骤能跑（不要求真跑通 GitHub）。
- **O6 不退步**：全部测试、ruff、Mock 端到端、E1–E4 全过；OpenAPI 同步；Alembic 新迁移空库和有数据的库都能跑；`server/README.md` 补相应章节。

## 硬护栏

1. **提交**：只在本 worktree 的 `feat/server` 分支提交；中文一行 commit，作者 `chaw1 <97000945@qq.com>`；不加任何 AI 署名或 Co-Authored-By；不 push，不合并 main。
2. **凭证**：key 只从钥匙串取后注入进程环境变量（方法见 `docs/codex/SERVER_PROMPT.md`）；不写进任何文件、日志、快照、git。
3. **花费**：真实模型调用上限 0.5 元。
4. **范围**：只改 `/Users/jiawei/Projects/jiawei-personal/outfit-agent-wt-server`；不 ssh 服务器、不部署；不进其他 worktree；不停本机其他 Docker 容器；不弹窗、不出声。旧接口、旧字段一个都不改。
5. **墙钟上限 1.5 小时**；到点前收尾。保持断点可续（形式自选）。

## 交付

`server/OPS.md`（≤ 40 行，先写结论）：O1–O6 逐条结论与证据路径、本轮花费、已知限制。
