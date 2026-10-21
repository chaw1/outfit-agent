# 服务端第九轮：点数、一键出片、摄影感出片、进度字段

## 目标

把 `docs/设计.md` **第 14 节**里属于服务端的部分做出来（**唯一契约，字段名照它来**）：

1. **14.1 点数**：`costs.py` 的 `POINTS_PER_CNY = 10` 与 `points()`；所有现有 `*_cny` 字段旁增加同义 `*_points`（budget、pending_action、trace、directions.regenerate_estimate、卡片 cost、`/api/me`）；管理端页头注明"用户端以点数显示，10 点 = 1 元"。
2. **14.2 一键出片**：`POST /api/projects` 的 `mode` / `style_tags`（迁移 0010）；`GET /api/quotes/auto`；auto 自动走完三个人在回路点直到 `done`，失败就停下转回 guided 并发主动消息；`state.auto`；`POST /api/projects/{id}/mode`；`propose_directions` 输出 `recommended`。
3. **14.3 摄影感出片**：入队出图前把镜头扩写成摄影脚本（焦段 / 光线 / 构图 / 瞬间 / 质感 + 否定项），`style_tags` 映射摄影语言，参考图作构图锚点；写进 payload 的 `photo_prompt`。衣服还原相关描述不动。
4. **14.4 进度字段**：`GET /api/projects` 每项的 `progress`。

这是给面试官看的最后一轮，他们自己的产品就有「一键出片 / 沉浸编导」，会追问："自动模式里人在回路点怎么被跳过的、失败时怎么收口、用户怎么接手、点数怎么算、为什么图不像 AI 了。"你的实现要能让这些问题一句话答出来。

## 验收标准（Claude 会亲自实测，不信自报）

1. `ruff check` 干净；`REQUIRE_INTEGRATION=1 python -m pytest -q` 全过。新增用例至少覆盖：`*_points` 与 `*_cny` 换算一致；不带 `mode` 的老请求行为不变；auto 项目在 mock 下从创建走到 `done`，期间 `pending_action` 一直为 `null`，`state.auto.step` 依次推进；auto 中任务失败 → 停在当前阶段、`mode` 变 `guided`、有主动消息；`POST /mode` 切 guided 后下一个人在回路点停下；`GET /api/quotes/auto` 为正数且与 `costs.py` 一致；`progress.label` 在出图中 / 等待确认 / 完成三种状态正确；`photo_prompt` 含焦段、光线、构图、质感四类词且不含"棚拍白底"。
2. `scripts/e2e.py --mode mock` 通过；老接口字段对第八轮 App 完全兼容。
3. `server/README.md` 补"第九轮"一段（点数口径、auto 的状态机一张小表、摄影感扩写的例子一条）；`openapi.json` 更新。
4. 交付摘要写到 `docs/codex/runs/server-round9-final.txt`（由 `-o` 指定）：做了什么、怎么验证、没做什么、auto 状态机图。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/server）工作，只提交本地分支，不 push，不碰 `app/`、`docs/设计.md` 和任何 `.env` / 凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不调用线上服务，不调用任何会花钱的真实模型接口（测试用 mock）。
3. 只增不改：不重构现有工作流 / 队列语义，不改旧迁移，不动 `local_edit.py` 像素逻辑，不删 `*_cny` 字段。
4. 2.5 小时内交付；按 14.1 → 14.4 → 14.2 → 14.3 的顺序做（先易后难），时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项跑一次测试，保证随时可交付。
