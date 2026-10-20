# App 第八轮：改图结果可信闭环（手机端）

## 目标

把独立评审（`docs/评审-独立评估.md` 问题 1、2、3、4、7、9）指出的几处"用户花了钱却说不清最后用的是哪张图/哪版文案"补上。**唯一契约是 `docs/设计.md` 第 13 节**（13.1–13.6 全部涉及 App），字段名照它来。服务端正在另一个 worktree 同步实现 13.1/13.2/13.6 的字段；你先按契约改 App 和假服务（`mock-server/`），让假服务也返回这些新字段，便于端到端测试。

要做的事，按优先级：

1. **13.1 质检失败不默认入稿**：默认选择规则、"未改到位"角标、"仍然采用"确认（显示 `edit_check.reason`）、`approve_images` 带 `accept_unverified`、收到 `unverified_image` 错误时弹确认再重发、预览/发布清单标"手动采用"。
2. **13.2 再试一次 = 新尝试**：`edit_image.attempt`（UUID）、传输重试复用、"再试一次 / 换个说法"才换新 `attempt`、`reused=true` 时不再空等并提示。
3. **13.3 笔记阶段采用新版**：note 阶段查看器版本条/笔记卡的"采用此版本到笔记 / 重新选图"，替换同镜头、保持顺序，发 `approve_images`，预览随 `note.image_ids` 刷新；video/done 维持定稿。
4. **13.4 草稿冲突**：来源指纹 + dirty；"保留我的修改 / 采用新版本"、"恢复服务端版本"。
5. **13.5 REST 分类超时**：读 20 s / 写 60 s / 上传 120 s，写入不自动重放，上传"第 n/N 张"。
6. **13.6 换一组估价 + 引导页标题**。

UI 要和现在的视觉体系一致（`src/theme.ts` 的 token，已有的角标/提示组件），不要新造一套样式；文案中文、口语、短。

## 验收标准（Claude 会亲自实测，不信自报）

1. `npm run verify` 全过（typecheck / lint / tests / iOS 与 Android 导出）；新增单测覆盖默认选择规则、attempt 复用与更换、草稿指纹与冲突分支、超时分类。
2. `npx playwright test`（假服务）全过，并新增一个 `e2e/round8.spec.ts` 走通：改图未通过 → 默认仍选旧版 → 仍然采用（确认）→ 选图带 `accept_unverified` → note 阶段改图后"采用此版本" → 草稿冲突两个分支 → "再试一次"产生新 `attempt`、`reused` 提示。截图放 `screenshots/`，编号接着现有的往下排。
3. `e2e/live.spec.ts` 不要改语义（Claude 之后会在线上跑它）；只允许为兼容新 UI 做最小调整。
4. `app/README.md` 补"第八轮"一段；交付摘要写到 `docs/codex/runs/app-round8-final.txt`（输出文件由 `-o` 指定）：做了什么、怎么验证、没做什么。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/app）工作，只提交本地分支，不 push，不碰 `server/`、`docs/设计.md` 和任何凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不跑 `npm run test:live`，不连线上服务（会花钱）。
3. 只增不改：不重做查看器/预览的现有交互，不动 `screenshots-live/`。
4. 2.5 小时内交付；按上面的优先级做，时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项就跑一次 `npm run verify`，保证随时可交付。
