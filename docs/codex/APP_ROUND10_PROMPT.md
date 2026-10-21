# App 第十轮：账号闭环

## 目标

把 `docs/设计.md` **第 15 节**里属于 App 的部分做出来（**唯一契约，字段名照它来**）：协议 / 隐私 / 免责声明页面与入口（15.1）、注册同意勾选与首次启动隐私提示（15.2）、注册后展示恢复码与忘记密码流程（15.3）、账号与安全页：修改密码、重新生成恢复码（15.4）、注销账号（15.5）。服务端正在另一个 worktree 实现接口，你先按契约改 App 和假服务（`mock-server/`），让假服务返回这些新接口。

另一轮（第九轮：片场感 / 点数）正同时在另一个 worktree 重做 `login.tsx`、`index.tsx`、`projects/new.tsx`、`Onboarding.tsx`、`theme.ts`。为了合并不打架：**新 UI 尽量放新文件**——`src/app/legal/[kind].tsx`、`src/app/forgot.tsx`、`src/app/account.tsx`、`src/components/LegalConsent.tsx`、`src/components/RecoveryCode.tsx`、`src/components/PrivacyGate.tsx`；对 `login.tsx` 只加勾选组件、"忘记密码？"链接和底部协议链接三处；对 `settings.tsx` 只加"账号与安全"入口；对 `_layout.tsx` 只加首次启动隐私提示的挂载；不动 `theme.ts`。

## 验收标准（Claude 会亲自实测，不信自报）

1. `npm run verify` 全过（typecheck / lint / tests / iOS 与 Android 导出）；新增单测覆盖恢复码格式校验、同意状态持久化、首次启动门控。
2. `npx playwright test`（假服务）全过，并新增 `e2e/round10.spec.ts` 走通：首次启动隐私提示 → 查看协议 → 同意 → 注册未勾选被拦 → 勾选注册 → 看到恢复码并复制 → "我已保存"进入 → 设置 → 账号与安全 → 修改密码（旧密码登不上、新密码能登）→ 退出 → 忘记密码用恢复码重置并拿到新恢复码 → 注销账号 → 回到登录页。截图放 `screenshots/`，编号从 110 起（第九轮用 90–109）。
3. `e2e/live.spec.ts` 的注册步骤按新流程做最小调整（勾选同意、保存恢复码后继续），**不改其他步骤**。
4. `app/README.md` 补"第十轮"一段；交付摘要写到 `docs/codex/runs/app-round10-final.txt`（由 `-o` 指定）：做了什么、怎么验证、没做什么。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/app-account）工作，只提交本地分支，不 push，不碰 `server/`、`docs/设计.md` 和任何凭证；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不跑 `npm run test:live`，不连线上服务（会花钱）。
3. 只增不改：现有登录 / 注册 / 引导 / 编导间交互不重做；不动 `screenshots-live/`、`theme.ts`、`index.tsx`、`projects/new.tsx`、`Onboarding.tsx`。
4. 2 小时内交付；按 15.1 → 15.2 → 15.3 → 15.4 → 15.5 顺序做，时间不够就把没做的写进摘要，不要半成品提交。
5. 每做完一项跑一次 `npm run verify`，保证随时可交付。
