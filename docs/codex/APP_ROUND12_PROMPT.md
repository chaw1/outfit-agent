# 第十二轮 B：素材库（App）

## 目标

把 `docs/设计.md` **第 18.2 节**做出来（**唯一契约**）：「存为我的模特」、素材库页（我的模特 / 我的衣服 / 我的成片）、新建页"从我的衣服里选"与出镜来源标签。服务端接口（18.1）同时由另一路实现，App 先按契约在 `src/mock-server`（假服务）里实现同样的接口和行为，用假服务端到端验证；真服务 404 时隐藏入口（`supportsProfile` 同款探测方式）。

另一路正在拆 `src/components/ui.tsx` 为 `components/ds/`（`ui.tsx` 保留为再导出层）。为了合并不打架：**新 UI 全放新文件**（`src/app/assets.tsx`、`src/components/AssetLibrary.tsx`、`src/components/SaveAsModel.tsx`、`src/lib/assets.ts`），对现有页面只做最小改动（加入口、加一段选择器、加一个动作按钮），继续从 `./ui` 引入组件，不改 `ui.tsx`，不改任何现有组件的样式。颜色与间距只用 `src/theme.ts` 的 token，不写裸色值。

## 验收标准（Claude 会亲自实测，不信自报）

1. `npm run verify` 全过；`npx playwright test` 全过，新增 `e2e/round12.spec.ts` 覆盖：成片上「存为我的模特」→ 素材库里出现、设为默认 → 新建页出镜默认变成她；从我的衣服里选 → 不上传也能开拍；删除二次确认；旧服务（404）下入口隐藏。截图进 `screenshots/`。
2. 页面用词只出现「素材库 / 我的模特 / 我的衣服 / 我的成片」，不出现"资产 / asset"、"¥ / 元"；深色片场主题与首页一致（`Page tone="studio"`），网格 3:4，触控 ≥ 44，有空态与加载态。
3. `src/mock-server` 的新接口与 18.1 字段一致（Claude 会拿真服务端对照）。
4. `app/README.md` 页面表加素材库；交付摘要写到 `docs/codex/runs/app-round12-final.txt`（由 `-o` 指定）：做了什么、怎么验证、没做什么、改了哪些现有文件（逐个列出）。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/app-account）工作，只提交本地分支，不 push，不碰 `server/`、`docs/设计.md`、`screenshots-live/` 和任何凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不跑 `npm run test:live`，不连线上服务。
3. 只增不改：不改现有页面的交互与文案，不改 `ui.tsx` 与任何现有组件；现有用例全部保持通过。
4. 1 小时内交付；顺序：假服务接口 → 存为我的模特 → 素材库页 → 新建页选择 → 用例与截图 → README；时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项跑一次 `npm run verify` 与 `npx playwright test`。
