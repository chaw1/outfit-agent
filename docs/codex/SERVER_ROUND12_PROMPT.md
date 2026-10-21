# 第十二轮 A：素材库（服务端）

## 目标

把 `docs/设计.md` **第 18.1 节**做出来（**唯一契约**），目的是让博主拍过的模特、上传过的衣服、挑中的成片沉淀成本人可复用的数据——特别是"把成片里的人存为我的模特，下次拍片还选她"。底子已有：生成时第一张参考就是 `model_asset_id`（§6），档案 `profile.model_asset_ids`（§10.1，`app/profile.py`），注销清理（§15，`app/account.py`）。新接口放独立模块 `app/assets_library.py`，`main.py` 只做挂载。

## 验收标准（Claude 会亲自实测，不信自报）

1. `POST /api/me/models/from-image` 在 Mock 栈上：对本人项目成片返回新资产（`kind=model, source=generated, parent_id=成片`）且档案 `model_asset_ids` 多一项；重复调用返回同一资产 id；别人的成片 404；超过 20 张 422 中文说明。
2. `GET /api/me/assets` 三种 `kind` 都能列出、分页正确、`in_profile`/`project_title`/`name` 字段正确；`DELETE` 的三种情况（模特副本删文件、被引用衣服 409、未引用衣服删除）各有测试。
3. 用存下来的模特创建新项目，生成任务的 `reference_asset_ids` 第一项是它（现有逻辑，补一条测试固定）。
4. 跨项目复用衣服资产创建项目成功（补测试）。注销后本人的模特副本文件也被删除（补测试）。
5. `uv run ruff check . && REQUIRE_INTEGRATION=1 uv run pytest -q` 全过；`server/README.md` 接口表加本节；交付摘要写到 `docs/codex/runs/server-round12-final.txt`（由 `-o` 指定）：做了什么、怎么验证、没做什么。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/server）工作，只提交本地分支，不 push，不碰 `app/`、`docs/设计.md` 和任何凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不连线上服务，不调用会花钱的接口；集成测试用本地 Mock 栈（`MOCK_PROVIDERS=1`）。
3. 只增不改：旧接口、旧字段语义不变，不改现有迁移；需要迁移就新建 `0012`。
4. 1 小时内交付；顺序：from-image → 列表 → 删除 → 测试 → README；时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项跑一次 ruff + pytest。
