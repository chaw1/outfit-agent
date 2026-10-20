# /goal：App 第二轮——接上新字段，准备上真机

第一轮 App（`app/`）已验收通过。服务端这一轮在补：方向预览图、还原分和自动修图、主动播报、脚本历史（时间旅行）、成本、AI 生成声明。新增字段和动作见 `docs/设计.md` 第 7 节（只增不改），评审意见在 `docs/review/fable-design-review.md` 第 6 节。今晚会部署到 `https://47.97.153.127:8443`，明天 Gary 用免费 Apple ID + Xcode 把 App 装到自己的 iPhone 上演示。

## 成功标准（Claude 会自己复测）

- **B1 新字段都用上**：
  - 方向卡显示预览图（生成中有占位和进度感，失败有提示）；
  - 图片显示"还原 92"角标，自动修过的版本标"已自动修一版"并能看到修了什么；
  - 改图弹窗加 3–4 个快捷说法（衬衫塞进裤腰 / 背景亮一点 / 换个角度 / 换个姿势），点一下填入；
  - 脚本卡有"历史版本"入口，列出 `script_versions`，可以恢复到某一版（发 `restore_script`）；
  - 笔记预览显示"这篇成本约 ¥x.x"和 `ai_label` 提示；
  - `state.last_message_id` 变化时自动重新拉 `/messages`，智能体主动发的消息能及时出现。
- **B2 假服务同步**：`mock-server` 补齐新字段、主动播报、脚本历史和恢复，走一遍完整链路；截图更新到 `app/screenshots/`（新增预览图、还原角标、历史版本、成本这几步）。
- **B3 真机准备**：默认服务器地址改为 `https://47.97.153.127:8443`（仍可在设置里改）；`app.json` 的 iOS bundleIdentifier、显示名"衣序"、图标、启动页、相册和相机权限说明齐全；`npx expo prebuild --platform ios --no-install` 能成功（生成的 `ios/` 不提交）。README 补一节"用免费 Apple ID + Xcode 装到自己的 iPhone"：从装 Xcode、登录 Apple ID、选 Personal Team、连手机信任开发者，到 `npx expo run:ios --device` 的完整步骤，以及 7 天后重装的说明。
- **B4 不退步**：类型检查、ESLint、单元测试（新增：卡片合并新字段、`last_message_id` 触发刷新、历史恢复）、iOS/Android 导出全部通过（`npm run verify`，Node 22）。

## 硬护栏

1. **提交**：只在本 worktree 的 `feat/app` 分支提交；中文一行 commit，作者 `chaw1 <97000945@qq.com>`；不加任何 AI 署名或 Co-Authored-By；不 push，不合并 main。
2. **不花钱**：不调用任何真实模型 API，不读取钥匙串。可以只读访问 `https://47.97.153.127:8443/api/health` 确认连通，不注册账号、不写数据。
3. **范围**：只改 `/Users/jiawei/Projects/jiawei-personal/outfit-agent-wt-app`；不进其他 worktree，不碰其他项目；端口用 19xxx。
4. **不弹窗、不出声**：Playwright 无头；不打开模拟器。
5. **墙钟上限 2 小时**；到点前收尾写 FINAL。

## 交付

`app/FINAL.md` 覆盖重写（≤ 50 行，先写结论）：B1–B4 逐条结论、和约定的出入、已知问题、截图清单。
