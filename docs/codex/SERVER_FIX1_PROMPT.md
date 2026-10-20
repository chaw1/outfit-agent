# /goal：服务端第二轮——让智能体名副其实，并补上"高还原"和几处体验

第一轮代码（`server/`）流程完整、队列扎实，但评审（`docs/review/fable-design-review.md`，务必读完）指出一个致命问题：**阶段内的意图识别是关键词表**（`workflow.py` 的 `_question / _revision_requested / _image_edit_from_text`，连"通勤风"都写死了），**回复是模板句**，模型每次被 `tool_choice` 强制只能调一个指定工具。面试官的考察重点就是智能体和框架用法，这一眼就会被看穿。

这一轮的目标：**阶段之间是状态机（代码管钱、可审计），阶段之内是 ReAct（模型从允许的工具里自己选、自己解析参数、自己写回复）**，并把评审里的【现在改】和【集成时补】落地。新增字段和动作见 `docs/设计.md` 第 7 节（只增不改），App 正在按它并行改。

## 成功标准（Claude 会用自己的私有问句集复测，不会告诉你）

- **R1 阶段内 ReAct**：真实模式下，自由文本由模型在 `ALLOWED_TOOLS[stage]`（加一个只回复不动作的 `chat`）里选工具，参数由模型从上下文解析（"第二张""咖啡馆那张""把衬衫那张修一下"→ 对应 `image_id`）。真实路径里**不得有关键词路由或针对特定说法的特判**；关键词逻辑只允许留在 Mock 的假模型里。自建一套 ≥ 20 句、覆盖各阶段的问句集（含模糊说法、反问、跑题、要求越阶段），用真实 DeepSeek 跑，选对工具 ≥ 90%，越阶段的请求被代码拒绝并给出中文解释。结果写进 FINAL。
- **R2 回复由模型写**：每个工具 schema 带 `reply`，博主搭子口吻，同一阶段两个不同项目的回复不能一样；模板句只做失败兜底。
- **R3 修 bug**：在 `note` 阶段改图不退回 `images`、不丢视频确认；签名 URL 的 `exp` 按 6 小时窗口取整，轮询时 URL 不变；`/state`、`/messages` 不被对话锁挂住（对话进行中轮询 1 秒内返回，要有测试）；异常记完整堆栈（不得含 key）；看图结果缓存在资产上，重跑不重复付费；`revise_script` 在 `images/note` 阶段也允许，回到 `script` 阶段等确认，旧图保留。
- **R4 高还原**：生成 prompt 写入看图结果（品类/颜色/面料），明确要求严格保持版型、颜色、纽扣、口袋、logo；改图参考图带上原衣服图（≤ 3 张）。每张图生成后用 `qwen3-vl-plus` 对比原衣服打 `fidelity`；低于 60 自动用差异点修一版（每张最多一次）。用一组故意让衣服走样的 Mock 用例测通自动修复路径。
- **R5 方向预览图**：出方向后为每个方向入队一张预览图，`direction.preview_url/preview_status` 随 `/state` 更新。
- **R6 主动播报**：同一批图全部完成、视频完成、自动修复完成时，Worker 插入一条 assistant 消息（不必调模型，可用模板，但要带上具体数字和还原分摘要），`state.last_message_id` 随之变化。
- **R7 脚本历史（LangGraph 时间旅行）**：`state.script_versions` 来自 `get_state_history`；`restore_script` 动作能回到任意历史版本。做成实验 E4：先改成通勤风，再恢复到之前一版并确认，测试覆盖。
- **R8 卡片早到**：用 LangGraph 的流式（`stream_mode` custom/updates）让 `garments` 卡片在看图完成时就推给 App，不必等方向生成完。
- **R9 成本与合规**：`state.cost_cny`、`note.cost_cny` 来自调用账本；生成图片保存时加可见的"AI生成"小角标和元数据标识；视频请求带水印参数；`note.ai_label` 有值。
- **R10 实验与部署**：`scripts/experiments.py` 用 Mock 模式依次跑 E1 重启续聊、E2 重复确认不重复入队、E3 越阶段被拒、E4 脚本时间旅行，输出一张结果表。compose 生产配置：worker 2 个副本、日志轮转、API 只绑 `127.0.0.1:18080`（前面是宿主机 nginx 的 https://47.97.153.127:8443，`PUBLIC_BASE_URL` 用这个）。**不要连服务器部署**，Claude 负责部署。
- **R11 不退步**：全部测试通过（第一轮的 64 个只改适配、不删断言），ruff 干净，Mock e2e 通过，真实 e2e 再跑通一次并给出每步耗时。

## 硬护栏

1. **提交**：只在本 worktree 的 `feat/server` 分支提交；中文一行 commit，作者 `chaw1 <97000945@qq.com>`；不加任何 AI 署名或 Co-Authored-By；不 push，不合并 main。
2. **凭证**：key 只从钥匙串取后注入进程环境变量（方法见 `docs/codex/SERVER_PROMPT.md`）；不写进任何文件、日志、快照、git。
3. **花费**：本轮真实模型调用上限 15 元，到 12 元停下收尾；能用 Mock 的都用 Mock。
4. **范围**：只改 `/Users/jiawei/Projects/jiawei-personal/outfit-agent-wt-server`；不进其他 worktree，不碰其他项目；不 ssh 任何服务器；不停、不删本机其他 Docker 容器；不弹窗、不出声。
5. **墙钟上限 2.5 小时**；到点前收尾写 FINAL。

## 交付

`server/FINAL.md` 覆盖重写（≤ 60 行，先写结论）：R1–R11 逐条结论和数字（含问句集准确率、实验表）、和 `docs/设计.md` 的出入、已知问题、本轮花费。
