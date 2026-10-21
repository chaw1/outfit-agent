# 第十三轮：管理端丰富与视觉升级

## 目标

把 `/admin`（`server/app/admin_static/index.html` 单文件前端 + `server/app/admin.py`）做成一个面试官打开就会多看两眼的运营后台：信息密度高、视觉和 App 同一套语言、手机浏览器也好看。现状是功能齐（总览 / 用量 / 模型与配额 / 任务队列 / 创作者）但样式朴素、没有图表、没有时间趋势。契约是 `docs/设计.md` 第 9 节；新增的面板和接口只能"追加"到第 9 节，不改已有条目。

要做到的事（按价值排序，时间不够就从后面砍）：

1. **视觉**：用 `docs/设计系统.md` 的 token（`app/design/tokens.json` 里的 paper 主题：色板、字号阶梯、间距、圆角）重写样式；左侧或顶部导航、卡片式统计、表格有斑马纹和 sticky 表头、状态用 Badge 色；深浅两套跟随系统；390 宽手机布局不横向滚动；无外部网络依赖（字体、图表库都不能走 CDN，图表用内联 SVG 或 `<canvas>` 自己画）。
2. **总览加趋势**：最近 7 天每天的调用次数与估算费用折线/柱状图；按模型的费用占比；最近 24 小时错误数与请求量（`request_events` 表已有数据，`设计.md` 9.x 已提到）；任务成功率。
3. **用量统计**：按天图表 + 表格联动；按模型 / 按用户切换；导出 CSV 按钮保留。
4. **任务队列**：状态筛选、按项目 / 用户搜索、耗时列、失败原因展开；重试 / 取消按钮带二次确认；自动 10 秒刷新可开关。
5. **创作者**：列表加项目数、累计花费、最近活跃；点开一个用户看其项目与花费明细（新接口 `GET /api/admin/users/{id}`，追加到第 9 节）。
6. **模型与配额**：现有表单保留，改成分组卡片；改动保存后有成功 Toast。

## 验收标准（Claude 会亲自实测，不信自报）

1. `uv run ruff check .` 零错误；`REQUIRE_INTEGRATION=1 uv run pytest -q` 全过（本机 Mock 栈在 18080；管理端接口新增必须有测试）。
2. 本机 Mock 栈 `ADMIN_TOKEN` 登录后，六个页面在 1280 宽与 390 宽各截一张图放 `docs/admin-shots/`（用 Playwright，浏览器在 `app/.tools/browsers`，`PLAYWRIGHT_BROWSERS_PATH` 指过去），控制台无报错、无外部请求。
3. 页面在数据为空时有空状态文案，不出现 `undefined` / `NaN`。
4. `docs/设计.md` 第 9 节追加新增面板与接口；`README.md` 文档表与 `docs/演示脚本.md` 的"管理端"段更新；交付摘要写到 `docs/codex/runs/server-admin2-final.txt`（由 `-o` 指定）。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/admin-polish）工作，只提交本地分支，不 push；只允许改 `server/app/admin.py`、`server/app/admin_static/**`、`server/tests/test_admin*.py`、`docs/设计.md` 第 9 节追加、`docs/admin-shots/**`、`README.md` 与 `docs/演示脚本.md` 的管理端段落；不碰 App、其他服务端模块和任何凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不连线上服务，不调用会花钱的接口；只用本机 Mock 栈。
3. 对 App 已有接口零改动；已有管理接口的响应结构只增不改。
4. 90 分钟内交付；顺序：视觉重写 → 总览趋势 → 用量图表 → 队列 → 创作者详情 → 配额卡片；每做完一项跑一次 ruff 与管理端测试；时间不够就把没做的写进摘要，不要半成品提交。
5. 不写"本轮于某日某时制作"之类的时间说明，文档口吻是"规划内的一轮"。
