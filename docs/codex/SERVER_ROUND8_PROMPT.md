# 服务端第八轮：改图结果可信闭环

## 目标

把独立评审（`docs/评审-独立评估.md` 问题 1、2、9）指出的"任务成功 ≠ 内容可交付"补上：质检失败的改图版本不能悄悄进入笔记和视频、文案不能把没改成功的指令写成事实、用户"再试一次"要真的产生一次新尝试而不是被去重吞掉、"换一组"要带估价。**唯一契约是 `docs/设计.md` 第 13 节（13.1、13.2、13.6 是服务端的活）**，字段名照它来，不要另起名字。

这是最后一轮，面试官会拿着评审报告追问：
- "系统已经知道没改成功，为什么默认把它送去发布？"→ `approve_images` 的 `unverified_image` 错误 + `accept_unverified` + `note.accepted_unverified_ids`。
- "图没塞腰，文案却写塞腰，谁为品牌负责？"→ 写笔记上下文分开 requested_change 与可确认画面事实。
- "网络重放和用户明确购买一次新尝试，为什么用同一种幂等语义？"→ `edit_image.attempt` + 回包 `reused`。
- "用户连续换五组，钱从哪里扣？"→ `directions.regenerate_estimate_cny`。

## 验收标准（Claude 会亲自实测，不信自报）

1. `ruff check` 干净；`REQUIRE_INTEGRATION=1 python -m pytest -q` 全过（新增用例覆盖：未通过版本不带 accept 被拒、带 accept 通过且 `accepted_unverified_ids` 持久化；同一 `attempt` 重放返回同一任务且 `reused=true`、新 `attempt` 新任务；写笔记上下文里失败指令不出现在"画面事实"里；`regenerate_estimate_cny` 存在且为正数）。
2. `scripts/e2e.py --mode mock` 通过；现有 `GET /api/projects/{id}/state` 等接口对老客户端完全兼容（不带新字段时行为不变）。
3. `server/README.md` 补一段"第八轮"说明；Alembic 如需新列就加迁移（0010），不要改旧迁移。
4. 交付摘要写到 `docs/codex/runs/server-round8-final.txt`（输出文件由 `-o` 指定）：做了什么、怎么验证、没做什么。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/server）工作，只提交本地分支，不 push，不碰 `app/`、`docs/设计.md` 和任何 `.env`/凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不调用线上服务，不调用任何会花钱的真实模型接口（测试用 mock）。
3. 只增不改：不重构现有工作流/队列语义，不把质检失败改成任务 failed，不动 `local_edit.py` 的像素逻辑。
4. 2 小时内交付；先做 13.1 → 13.2 → 13.6，时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项就跑一次测试，保证随时可交付。
