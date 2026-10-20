# /goal：服务端第六轮——智能体过程透明、花钱前预估、换一组、重新回复

面试官要一眼看到"这是个智能体在工作"：每条回复能展开看它选了什么工具、耗时、花费；花钱前有预估；方向能换一组；回复能重写。**约定是 `docs/设计.md` 第 11 节（11.1–11.3、11.5）**，字段名严格按它来（App 侧已经按 `can_regenerate` / `regenerate_reply` 实现了，别改名）。

## 成功标准（Claude 会自己复测，不信自报）

- **T1 trace**：真实路径和 Mock 路径的每条 assistant 消息都有 `trace`（工具、模型、耗时、费用、refs、分步），SSE 在 `done` 前发 `trace` 事件，`GET /messages` 读回一致；Worker 主动消息也带 trace（n 张图、耗时、费用）。费用口径与账本一致。
- **T2 预估**：`pending_action.estimated_cost_cny` 在 confirm_script / confirm_video 时有值且与第 5 节单价一致；`state.budget` 四个字段正确，和管理端层级/今日花费同源。
- **T3 换一组**：方向阶段自由文本"换一组方向，保留我刚才说的偏好"→ 模型选 `propose_directions`，新方向带新预览图（Mock 和真实各验一次，真实 ≤ 1.5 元）；用户之前说过的偏好（如"要通勤"）在新方向里体现。
- **T4 重新回复**：`regenerate_reply` 只重写文字、同 id 覆盖、不创建任务、不产生出图费用；带付费任务的轮次返回中文拒绝；`can_regenerate` 标记正确；E1–E4 不受影响。
- **T5 不退步**：全部测试、ruff、Mock 端到端、E1–E4 全过；OpenAPI 同步；旧字段零改动。

## 硬护栏

1. **提交**：只在本 worktree 的 `feat/server` 分支提交；中文一行 commit，作者 `chaw1 <97000945@qq.com>`；不加任何 AI 署名或 Co-Authored-By；不 push，不合并 main。
2. **凭证**：key 只从钥匙串取后注入进程环境变量（方法见 `docs/codex/SERVER_PROMPT.md`）；不写进任何文件、日志、快照、git。
3. **花费**：真实模型调用上限 2 元。
4. **范围**：只改 `/Users/jiawei/Projects/jiawei-personal/outfit-agent-wt-server`；不 ssh 服务器、不部署；不进其他 worktree；不停本机其他 Docker 容器；不弹窗、不出声。
5. **墙钟上限 1 小时**；到点前收尾。保持断点可续（形式自选）。

## 交付

`server/TRACE.md`（≤ 30 行，先写结论）：T1–T5 逐条结论与证据路径、本轮花费、已知限制。
