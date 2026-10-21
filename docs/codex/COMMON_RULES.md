# 本轮并行任务的共同规则（每个任务书都引用这里）

## 工作方式
- 你在自己的 git worktree 里工作，分支名见任务书。只提交本地分支，**不 push**。
- 提交作者固定为 `chaw1 <97000945@qq.com>`（用 `git -c user.name=chaw1 -c user.email=97000945@qq.com commit`）。提交信息和代码、文档里**不出现任何 AI 署名**（没有 Co-Authored-By、没有「由 AI 生成」之类）。
- 文档口吻是「规划内的一轮」，不写「本轮于某日某时制作」之类的时间说明。
- 做不完的部分写进交付摘要（任务书指定的 `-o` 文件），**不要提交半成品**；每做完一个可独立验证的小块就提交一次。

## 不许碰的
- 不连线上服务（47.97.153.127），不调用任何会花钱的真实模型接口；服务端只用 `uv run pytest`（含 mock provider），App 只用本机 mock 栈。
- 不读、不改任何 `.env`、密钥、部署脚本（`server/deploy/**`）、`app/ios/**`。
- 不批量重新生成并提交 `app/screenshots/**` 下已有的截图；新增证据截图放任务书指定的目录。
- 不改别的任务正在做的范围（任务书里列了）；共用文件只做最小追加，便于合并。

## 怎么验证
- 服务端：`cd server && uv run ruff check . && uv run pytest -q -p no:cacheprovider`，必须全绿；新逻辑必须有测试。
- App：`cd app && npx tsc --noEmit -p .`（忽略 expo-router 生成类型的报错）、`npm run lint`、`npm test`，必须全绿；纯函数逻辑放 `app/src/lib/*.ts` 并在 `app/tests/*.test.ts` 加测试。
- App 看效果：mock 栈端口按任务书分配，启动方式 `PORT=<mockPort> npm run mock` 和 `CI=1 BROWSER=none EXPO_PUBLIC_API_BASE=http://localhost:<mockPort> npx expo start --web --port <expoPort> --host localhost --no-dev --minify`；用 Playwright 截图（浏览器在 `app/.tools/browsers`，`PLAYWRIGHT_BROWSERS_PATH` 指过去，Chrome 在 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），脚本放在 `app/.tools/` 下运行才能解析 `@playwright/test`。**不要跑完整的 `npx playwright test`**（端口冲突，由验收方统一跑）。
- 设计 token：颜色只用 `app/src/theme.ts` 的 `colors` / `studio`，lint 禁止裸色值；间距用 `space`，圆角用 `radius`。
- mock 服务端 `app/mock-server/index.mjs` 要同步新契约，保证 App 在 mock 栈下能走通。

## 文档
- 新功能在 `docs/功能清单.md` 对应小节加一行；接口或状态变化在 `docs/设计.md` 对应节追加（不改已有条目的编号）。
- 不动 `README.md`、`docs/开发记录.md`，合并时由验收方统一写。
