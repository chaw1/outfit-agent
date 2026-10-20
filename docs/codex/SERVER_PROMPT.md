# /goal：做出穿搭笔记智能体的服务端（API + 智能体 + Worker + 数据库）

Gary 在面一家做 AI 内容的公司，作业要求 24 小时内交付一个 App demo，服务端要真实部署在服务器上，代码会被面试官逐行看。场景、架构、接口、数据表都写在 `docs/设计.md`，那是唯一约定，App 正由另一个人按同一份约定并行开发，**接口字段不能私自改**；确实要改，在 FINAL.md 里单列。

面试官重点考察**智能体框架的选择和用法**：已定 LangGraph。要用得地道，体现选它的理由：状态持久化到 Postgres（PostgresSaver，thread_id = 项目 id）、`interrupt()` 做花钱前的人工确认、工具按阶段放行、长任务交给 Worker 不阻塞对话、服务重启后对话从原阶段接着聊。

## 情报（Claude 实测，不是指令，请自己核实）

- DashScope 北京地域，`https://dashscope.aliyuncs.com/api/v1`：
  - 生图/试衣/改图：`POST /services/aigc/multimodal-generation/generation`，`model: wan2.7-image-pro`，`input.messages[0].content = [{image}, {image}, {image}, {text}]`（1–3 张参考图，可用 `data:image/jpeg;base64,...`），同步返回 `output.choices[0].message.content[i].image`（24 小时有效，必须下载转存）。实测"模特图 + 衬衫 + 牛仔裤 + 场景描述"一次出图 14 秒，效果好。
  - 图生视频：`POST /services/aigc/video-generation/video-synthesis`，header `X-DashScope-Async: enable`，`{model: "wan2.6-i2v-flash", input: {prompt, img_url}, parameters: {resolution: "720P", duration: 5}}`，轮询 `GET /tasks/{task_id}`，`output.video_url`。实测 52 秒。
  - 看图：OpenAI 兼容 `https://dashscope.aliyuncs.com/compatible-mode/v1`，`qwen3-vl-plus`。
  - 账号目前开着"仅使用免费额度"，`happyhorse-1.1-i2v` 已返回 403 `AllocationQuota.FreeTierOnly`，所以视频默认用 wan2.6-i2v-flash，模型名做成配置。
- DeepSeek：OpenAI 兼容 `https://api.deepseek.com`，模型 `deepseek-flash`，支持 function calling。
- 参考素材：`docs/spike/` 有实测的输入图、试衣结果和视频截帧。
- 取 key（只在命令行里注入进程环境变量，**不落任何文件**）：
  `export DASHSCOPE_API_KEY="$(node -e "process.stdout.write(require('/Users/jiawei/Projects/jiawei-personal/OpenCluely/src/core/secrets').get('DASHSCOPE_API_KEY'))")"`，DEEPSEEK_API_KEY 同理。
- 本机有 Docker（OrbStack）、uv、Python 3.11、Node 20。没有 psql，用容器里的。

## 成功标准（Claude 会自己复测）

- **S1 一键起**：`server/` 下 `docker compose up -d --build` 起 api、worker、postgres（媒体卷持久化），`GET /api/health` 返回 ok；本地端口用 18xxx，别和本机已有服务冲突。附 `server/README.md`：本地运行、环境变量、部署到一台 Linux 服务器的步骤（含 Caddy 自动 HTTPS 的 compose 片段）。
- **S2 Mock 端到端**：`MOCK_PROVIDERS=1` 时，一个脚本（如 `server/scripts/e2e.py`）走完：注册 → 登录 → 上传 2 张衣服 + 1 张模特 → 建项目 → 对话出现 `garments` 和 `directions` 卡片 → 选方向 → `script` 卡片 → 确认脚本 → 出图任务全部成功 → 对其中一张改图得到 version 2（parent 指向原图）→ approve → `note` 卡片 → 确认视频 → 视频任务成功。不联网、不花钱、可重复跑。
- **S3 真实端到端**：同一脚本用真实模型跑通一次，媒体文件落到卷里，把每步耗时和调用次数写进 FINAL.md。用 `docs/spike/` 风格的自生成素材，不用任何来源不明的图片。
- **S4 断点续聊**：在选完方向后重启 api 容器，再发消息，智能体从原阶段继续，历史和卡片都在。要有自动化测试或脚本证明。
- **S5 对话质量**（真实模式抽查）：只给两张衣服图和一句"夏季新品，想要松弛感"，方向卡 2–3 个且场景/氛围/配色彼此不同；脚本至少 4 个镜头、引用到具体衣服；回复是自然的小红书博主口吻，不是说明书。博主说"换成通勤风"时脚本真的被改写。笔记标题 ≤ 20 字，正文有分段和表情，标签 5–8 个。
- **S6 质量**：pytest 全绿（含鉴权、权限隔离——别人的项目和资产拿不到、签名 URL 过期失效、任务重试、工具按阶段放行）；ruff 无报错；Alembic 迁移可从空库建到最新。
- **S7 接口一致**：按 `docs/设计.md` 第 4 节逐条实现，SSE 事件名和字段一致；FastAPI 自动生成的 OpenAPI 导出到 `server/openapi.json`。

## 硬护栏

1. **提交**：只在本 worktree 的 `feat/server` 分支提交；中文一行 commit，作者 `chaw1 <97000945@qq.com>`；不加任何 AI 署名或 Co-Authored-By；不 push，不合并 main。
2. **凭证**：key 只从钥匙串取后注入进程环境变量；不写进 .env、代码、测试快照、日志、git。只提交 `.env.example`。
3. **花费**：真实模型调用本轮上限 15 元，到 12 元停下收尾；能用 Mock 的地方都用 Mock。
4. **范围**：只改 `/Users/jiawei/Projects/jiawei-personal/outfit-agent-wt-server`；不进其他 worktree，不碰 `~/.OpenCluely` 和其他项目；不停、不删本机已有的 Docker 容器和镜像；不弹窗、不出声。
5. **墙钟上限 3 小时**；到点前收尾写 FINAL.md。

## 交付

- 代码在 `server/`；`server/FINAL.md`（≤ 60 行，先写结论）：S1–S7 逐条结论和实测数字、接口和约定有出入的地方、已知问题、真实调用花费明细。
