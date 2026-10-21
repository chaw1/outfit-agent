# 第十一轮 A：设计系统「衣序 DS」

## 目标

把 `docs/设计.md` **第 16 节**做出来（**唯一契约**）：token 单一来源（`app/design/tokens.json` → 生成 `theme.ts`）、组件库拆分与规格化（`components/ds/`）、仅开发态的组件画廊 `/__design`（`__DEV__` 门控，App 内无入口）、视觉回归快照、裸色值 lint、`docs/设计系统.md`。目标是让面试官看这份文档和画廊截图，一眼看出这是一个有 token、有变体状态、有快照回归、能和设计师协作的设计系统，而不是一堆样式。

基线已包含第九轮（studio 深色片场色板、Chip / Segmented 等新 UI）与第十轮（账号页面）。拆分 `ui.tsx` 时现有引用一律不改（`ui.tsx` 变成再导出层），所有页面渲染结果必须和拆分前一致（用现有 mock e2e 截图做对照）。

## 验收标准（Claude 会亲自实测，不信自报）

1. `npm run tokens` 生成的 `src/theme.ts` 与仓库现有文件 diff 为空；`npm run tokens:check` 在手改 theme.ts 后能报错。
2. `npm run verify` 全过；`npx playwright test` 全过（含现有全部 spec，证明拆分没改渲染）；新增 `e2e/design-system.spec.ts` 四种组合快照通过，基线进仓库，截图进 `screenshots/ds/`。
3. ESLint 裸色值 / 魔法间距规则为 error 且 `npm run lint` 零违规（违规先修，修的只能是样式写法，不改行为）。
4. `/__design` 画廊只在开发构建可通过 URL 打开，正式导出（`expo export`）的包里不含该页面（用 grep 产物证明），App 内无入口；画廊能切 paper / studio、320 / 390、字号 1.0 / 1.3。
5. `docs/设计系统.md` 按 16.4 写全，token 表由脚本从 tokens.json 生成；README 文档表加一行；演示脚本加"设计系统 30 秒"（不在 App 里演示）；交付摘要写到 `docs/codex/runs/app-design-system-final.txt`（由 `-o` 指定）。

## 硬护栏（≤5 条）

1. 只在本 worktree 工作，只提交本地分支，不 push，不碰 `server/`、`docs/设计.md` 和任何凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不跑 `npm run test:live`，不连线上服务。
3. 只增不改：不改任何页面的交互与文案，不动 `screenshots-live/`。
4. 2.5 小时内交付；顺序：tokens.json 反推与生成 → 拆分组件 → 画廊 → 快照 → lint → 文档；时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项跑一次 `npm run verify` 与 `npx playwright test`。
