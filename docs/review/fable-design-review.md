# 穿搭笔记智能体 · 技术方案评审（Fable，2026-10-20）

> 评审对象：`docs/设计.md` + 服务端 worktree 实际代码（graph.py / workflow.py / worker.py / main.py / providers.py / compose）+ App 截图。标签：【现在改】趁 Codex 还在写就改；【集成时补】集成阶段 1 小时内能补；【写进文档】作为演进方向写进调研文档。

## 最重要的 5 条结论

1. **智能体"含金量"不足，面试官一眼能看出**：`providers.text()` 对每次调用强制 `tool_choice` 指定一个工具，用户意图靠 `_question / _revision_requested / _image_edit_from_text` 的关键词表路由（里面甚至写死了"通勤风"）。这是"状态机 + 关键词 + 结构化输出"，不是 Agent。改法很小：阶段内把 `ALLOWED_TOOLS[stage]` 整组交给模型、`tool_choice="required"`，让模型选工具、代码管钱。【现在改】
2. **一个真实流程 bug**：`_edit_image` 无条件 `stage="images", pending_action=None`。在 `note` 阶段改一张图，项目会退回 images，笔记状态还在但视频确认丢了，要重新 approve（再花一次 write_note）。改成保持当前阶段。【现在改】
3. **签名 URL 每次响应都换 `exp`**，App 每 3 秒轮询一次就换一遍所有图片 URL，RN `<Image>` 按 URL 缓存，演示时缩略图会反复重载闪烁。把 `exp` 量化到固定时间窗即可。【现在改】
4. **"高还原"目前只有一句 prompt**。用 qwen3-vl-plus 做生成后的一致性判分（分钱级），低分自动走已有的 edit 管线出 v2，这是对创始人"高还原是生死线"最直接的回应，也是 Worker 里最便宜的加法。【集成时补】
5. **方向卡没有图**。MuseGate 的流程是"多组风格灵感图挑选"，我们的方向卡是纯文字（截图 04）。每个方向出一张小预览图（约 0.5 元/张，14 秒，并行），是最值得补的产品点。【集成时补】

## 1. 智能体设计

- **图的形状**：现在是 `understand_brief → await_<stage>（6 个同样的等待节点）→ execute_stage_tool → await_<stage>` 的星形，`draw_mermaid()` 画出来看不出业务流。阶段状态机放在 `stage` 字符串和 `ALLOWED_TOOLS` 里是对的（花钱门禁必须确定性、可审计），但要把边界说清楚：**阶段之间是状态机（代码定），阶段之内是 ReAct（模型选工具），工具副作用由代码校验**。现状缺的正是中间那层。【现在改】`providers.text(tools=[...])` 返回 `(name, args)`；`Workflow.handle` 对自由文本改为：`tools = ALLOWED_TOOLS[stage]`，模型选中 `revise_script / edit_image(image_id, instruction) / propose_directions / write_note / chat`，再过 `validate` 和 `_allow`。关键词函数只留给 `MOCK_PROVIDERS=1`。`edit_image` 的 `image_id` 让模型从 context 里的图片列表自己解析"第二张"。成本不变（仍是每轮一次调用）。
- **interrupt 用法**：等待节点无副作用、每轮 `Command(resume=event)`、校验放在 interrupt 之外、失败时 `update_state(as_node=await_x)` 兜底——这几点是对的，面试时值得主动讲。两处会被追问：(a) `graph._outfit_workflow = workflow` 猴子补丁 + 每个请求重新 `build_graph`，LangGraph 1.x 的做法是 `StateGraph(State, context_schema=Ctx)`，节点签名 `def node(state, runtime: Runtime[Ctx])`，`graph.invoke(..., context=Ctx(workflow=...))`，图在 lifespan 里只编译一次；【集成时补】(b) `turn_text / turn_cards / turn_jobs / incoming` 这类单轮临时字段混在持久化 State 里，至少在文档里说明"这是本轮输出通道，不是领域状态"。【写进文档】
- **长任务与图的衔接**：Worker 不回图，图在每轮入口重新从 DB 读 `image_items` 和 job 状态——这是对的选择（interrupt 只能被 resume 一次，生成中用户还在说话，不能让 Worker 和用户抢同一个 resume）。但要补两件事：(1) 图片全部完成时没人告诉用户。Worker 在同一 `script_hash` 的最后一张图落库时直接插一条 assistant `Message`（不调模型，文案模板 + `images` 卡片），App 轮询到 `active_jobs` 清空时刷新消息列表；【集成时补】(2) 文档里明确两种方案的取舍：现在的"DB 是任务事实、图只做决策"vs 演进方向"`await_images` 节点 interrupt 等 Worker `Command(resume)`"，以及为什么 24 小时版选前者。【写进文档】
- **stage 有两处真相**：graph state 的 `stage` 可能停在 `video`，`GET /state` 又按 job 结果算出 `done` 回写 `project.stage`。能接受，但要说明"project.stage 是投影"。【写进文档】
- **断点续聊**：S4 设计正确。补一个最便宜的演示：在选完方向后 `docker compose restart api`，手机上继续发"换成通勤风"。【集成时补】
- **改脚本/改图的版本**：图片版本链（job 即 image、`parent_id`、按 shot 算 `version`、dedupe_key 含 `script_hash`）设计好；脚本没有版本，而且 `images/note` 阶段不允许 `revise_script`，演示时面试官说"方向不对，重来"只能走 `chat`。短期：把 `revise_script` 加进 `images/note` 的允许集，回到 `script` 阶段等确认，老图保留（dedupe_key 已含 script_hash，不会撞）；`image` 对象加可选 `script_hash` 字段供 App 分组。【集成时补】长期：用 `get_state_history()` 做"回到上一版脚本"的时间旅行，这是 LangGraph 独有卖点，写进文档并做 E4 实验（见第 2 节）。【写进文档】
- **其他小坑**：`start()` 里 qwen 看图和 DeepSeek 出方向在同一节点，DeepSeek 失败重跑会再付一次看图钱，把看图结果缓存到 `Asset`（已有 `prompt/model` 列，加 `analysis` JSON）；【集成时补】`internal_error_handler` 和 `process_turn` 只记异常类名不记堆栈，集成排错会很痛苦，改 `log.exception`（key 不在堆栈里）。【现在改】

## 2. 框架选型论证（面试重点）

- **抓 6 条硬需求**，每条都能对应到代码里的一处：H1 多轮状态跨进程、跨重启（thread_id=项目，PostgresSaver）；H2 花钱前的原生人工确认，且重放不重复花钱（interrupt/resume + uuid5 dedupe）；H3 阶段门禁可审计（`ALLOWED_TOOLS` 一张表看完）；H4 中间事件流式到 App（卡片）；H5 模型无关 + Python + 自托管（DeepSeek 与 Qwen 混用，不绑任何云）；H6 版本回溯（checkpoint 历史）。
- **逐个对手一句话**（文档里做成表）：OpenAI Agents SDK——有 Session 和工具审批/RunState 序列化，但没有图、没有阶段门禁，Postgres 持久化要自己写，模型层 OpenAI 优先；Google ADK——Sequential/Loop 工作流和 DatabaseSessionService 不错，人工确认靠 LongRunningFunctionTool 绕，Gemini 中心，国产模型走 LiteLLM；CrewAI——多角色协作叙事，Flows 的 `@persist` 是 SQLite，人工确认是命令行 `human_input`，不适合单用户长会话；Microsoft Agent Framework——工作流 + checkpoint + RequestInfo 人工确认，技术上最接近 LangGraph，但 2025-10 还是 preview、API 在变、Azure 倾向；AgentScope——百炼原生、ReActAgent 实时打断做得好，是**诚实的第二名**（团队全在百炼上时值得选），但阶段图和 Postgres checkpoint 不是一等公民；Dify/Coze——是平台不是框架，作业要交"真实部署的 Server + 逐行看的代码"，而且流程本身是公司的护城河，不该放在别人平台上；手写循环——最强对手，见下。
- **LangGraph 最大的反方意见（要在文档里自己先说出来）**：这个项目目前把 LangGraph 用成了"存在 checkpoint 表里的 `pending_action` 字段"——两节点循环、强制 tool_choice、关键词路由；而重放语义反而带来了复杂度（uuid5 job id、`restore_jobs`、`restore_messages`、`update_state` 修复分支、消息两套真相）。一个手写 `while` + `project_state JSONB` + `events` 表大概 200 行，更短更透明。**回应**：让图挣到它的位置——模型在阶段内选工具（第 1 条）、`stream_mode="custom"` 让卡片随节点进度推送、`get_state_history` 做脚本回溯、图的 mermaid 放进文档；并承认"如果流程永远只有这 7 个阶段，手写也够"。
- **最有说服力的小实验**（全部 Mock 模式零成本，各写成一个 pytest + 一段演示脚本）：E1 拔电源——选方向后重启 api，继续聊；E2 重复确认——`confirm_script` 发两次 / 同一指令改图两次，jobs 表行数不变；E3 越阶段——`script` 阶段请求 `confirm_video`，被 `_allow` 拒绝并给出中文提示；E4 时间旅行——"换成通勤风"前后两个 checkpoint 用 `get_state_history` 列出来，回滚到前一版再确认。E1 + E4 当场在手机上演示最有冲击力，E4 是别的框架做不出来的。【集成时补】可选 E5：同一个"选方向 → 确认 → 重启 → 继续"用手写循环写一版对照，列行数和缺的能力。【写进文档】

## 3. "高还原"怎么体现

- **生成后判分**（Worker 后置步骤，不进智能体决策）：每张图落库后调一次 qwen3-vl-plus，输入 [各件衣服原图, 生成图]，要 JSON `{garments:[{asset_id, score 0-100, diffs:[...]}], overall}`，存 `job.result.fidelity`，`image` 对象加可选 `fidelity: {score, diffs}`，App 显示"还原 92"角标。成本：每张图一次 VL 调用，分钱级。【集成时补】
- **低分自动修**：`overall < 60` 且未修过时，用 diffs 拼指令（"恢复衬衫胸前口袋，纽扣保持米白"）直接走现有 edit 管线出 v2，parent 指向 v1，用户看到"自动修了一版"。每个项目上限 1–2 次，预算可控（≈0.5 元/次）。【集成时补】
- **prompt 先改**：`_generate_images` 的 prompt 现在只有场景/动作/镜头，没把 qwen 看图结果喂进去。改成"参考图 1 为模特本人；参考图 2 为{颜色}{面料}{品类}，严格保持版型、颜色、纽扣与口袋；参考图 3 …"，并把 `garments` 的 category/color/material 写进去。`_edit_image` 只用父图做参考，再带上原衣服图（≤3 张）防改图漂移。【现在改】
- 视频：首帧即选中图（已做），prompt 加"人物面部和服装不变"；实测脸有轻微变化，文档里如实写，演进方向是 ID 保持类模型。【写进文档】

## 4. 接口与数据

- **SSE 不是真流式**：`process_turn` 跑完整轮后把文本切 24 字假装增量，助手文案是模板字符串（"衣服我看过啦…"），每个项目一模一样，S5 的"博主口吻"实际没由模型产生。最小改法：每个工具 schema 加 `reply` 字段让模型顺手写一两句，零额外成本；【现在改】再用 `graph.stream(stream_mode=["custom","updates"])` + `get_stream_writer()` 在节点内推卡片，`garments` 卡片 3 秒就能出现、不用等 DeepSeek。【集成时补】真 token 流式要在 tool-call 参数流上做增量 JSON 解析，写进演进方向。【写进文档】
- **轮询会被对话锁住**：`GET /state` 和 `GET /messages` 都拿 `pg_advisory_xact_lock(project)` 并做写修复 + commit，而 `process_turn` 在同一把锁里跑 5–10 秒的模型调用——对话进行中，3 秒一次的轮询会挂住。读接口改 `pg_try_advisory_xact_lock`，拿不到就跳过修复只读。【集成时补】
- **签名 URL 稳定化**：`exp = ((now // 6h) + 2) * 6h`，同一时间窗内 URL 不变，App 缓存才有效。【现在改】
- **卡片覆盖更新**：`card.id = {project}:{type}` 一类一张，历史消息里同一张卡会出现多个版本——这其实是天然的版本日志，App 工作台取最新即可，文档里说明。【写进文档】
- **任务队列表**：`dedupe_key` 唯一、`available_at`、租约心跳、attempts 做 fencing、"外部已发起但无 task_id 的失联任务判失败不重放"——这段是整个代码里最扎实的，面试时主动展示。可加一列 `cost_cny` 从 ledger 汇总到项目，在笔记页显示"这篇笔记成本 ¥x.x"——直接回答"能不能帮我做增量生意"。【集成时补】
- `GET /state` 是带写入的读接口（restore + commit），文档说明这是"自愈投影"。【写进文档】

## 5. 部署与可靠性（够用即可）

- **上线前检查单**：`MOCK_PROVIDERS=0`、`ENVIRONMENT=production`、`JWT_SECRET` 随机、`PUBLIC_BASE_URL=https://域名`（否则签名 URL 全指向 localhost，手机一张图都看不到）、`API_BIND=127.0.0.1`（Caddy 在前面时别暴露 18080）、`MODEL_BUDGET_CNY` 从 12 提到 60（别在演示中途被预算闸停住）、百炼控制台关掉"仅使用免费额度"。【集成时补】
- **没有域名也能 HTTPS**：`DOMAIN=<公网IP>.sslip.io`，Let's Encrypt 对 sslip.io 正常签发，Caddy 自动搞定；iPhone 不需要装证书。【集成时补】
- **Worker 开两个副本**：`docker compose up -d --scale worker=2`，SKIP LOCKED 已支持，4 张图从 60 秒变 30 秒，零代码；DashScope 并发限额低，不要超过 2–3。【集成时补】
- **日志**：compose 加 `logging: {driver: json-file, options: {max-size: "20m", max-file: "3"}}`；排错靠 `docker compose logs -f api worker`，配合第 1 节的 `log.exception`。【集成时补】
- 媒体卷、Postgres 卷、Caddy `flush_interval -1`、16MB 上传、Alembic 在 api 启动时跑——都已到位，不要再加对象存储和反向代理层。

## 6. 产品体验（对照 MuseGate / Chiccify）

- **方向卡附灵感图**（最值得补）：`start()` 出方向后为每个方向入队一张 `preview` 图（1 件主衣 + 模特，dedupe_key 按 direction id），`direction` 对象加可选 `preview_url`，App 轮询到后显示。和"花钱前确认"原则的关系要在文档说清：预览是明码标价的低成本层（≈1.5 元/项目），批量出图仍然门禁在脚本确认后。【集成时补】
- **生成完成的主动播报 + 还原度角标**（第 1、3 节已述）：博主不用盯着转圈，智能体说"4 张都好了，第 3 张衬衫口袋跑了我已经补了一版"，这句话就是"高还原 + Agent"的现场证明。【集成时补】
- 改图输入框给 3 个快捷 chip（塞进裤腰 / 背景亮一点 / 换个角度），演示时少打字。【集成时补】
