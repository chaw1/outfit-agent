# 衣序 · 穿搭笔记工作台

Expo SDK 58、expo-router、strict TypeScript 的 iOS / Android / web 演示应用。唯一接口约定是 [`../docs/设计.md`](../docs/设计.md)，任务范围见 [`../docs/codex/APP_PROMPT.md`](../docs/codex/APP_PROMPT.md)。假服务可以完整演示品牌合作项目、衣服分析、方向与脚本确认、图片任务、改图版本、笔记和短视频，不调用真实模型。

## 本地启动

在当前 worktree 的 `app/` 执行：

```sh
npm ci
npm run mock
```

需要 Node 22.13 或以上，版本提示见 `.nvmrc`。先用你已有的版本管理工具切到 Node 22，再执行 `npm ci` 和下面的命令；安装时保留开发依赖。本机已有 Node 22.23.1，可在当前终端临时执行 `export PATH="/Users/jiawei/.local/share/mise/installs/node/22.23.1/bin:$PATH"`，不修改全局环境。假服务默认监听 `0.0.0.0:19301`，健康检查是 `http://localhost:19301/api/health`，按接口约定需要登录后携带 `Authorization: Bearer <token>` 请求；直接在浏览器打开会返回 401。可以用 `PORT=19302 npm run mock` 改端口。

另开一个终端，在同一个 `app/` 目录启动 Metro：

```sh
npm run start
```

Metro 使用 `19300`。服务地址默认来自 `EXPO_PUBLIC_API_BASE`，未设置时为 `http://localhost:19301`；可参考 `.env.example`，把个人地址写进本地 `.env.local`，修改后重启 Metro。`EXPO_PUBLIC_*` 会包含在客户端代码中，只用于公开配置，不能放密码或密钥。

## 在 iPhone 的 Expo Go 打开

1. 手机和电脑连接同一个 Wi-Fi；电脑保持假服务和 Metro 两个终端运行。
2. 在终端的 Expo 开发菜单选择 Expo Go，用 iPhone 相机扫描二维码，允许访问本地网络。
3. 打开 App 的“设置”，把服务器地址改成电脑的局域网地址，例如 `http://192.168.1.23:19301`。**手机中的 `localhost` 指手机本身，不能用来连接电脑。** 登录页也可以进入设置；切换服务地址后需要重新登录。
4. 可先在手机浏览器打开 `http://192.168.1.23:19301/api/health`：收到 401 和“请先登录”说明已连接到服务；登录后携带 Bearer token 查询才会返回健康状态。若无法连接，检查 Wi-Fi 隔离和电脑对这两个端口的防火墙设置。

截至本次交付日期（2026-10-20），SDK 58 的官方发布说明仍提示 Expo Go 的升级过渡情况。演示前应核对 [SDK 58 发布说明](https://expo.dev/changelog/sdk-58) 和 [Expo Go 下载页](https://expo.dev/go)，使用支持 SDK 58 的官方客户端。若商店客户端尚不兼容，需要先取得兼容版本再做 Expo Go 真机验收；本项目不以降低 SDK 版本绕过要求。**目前没有声称已完成 iPhone 真机测试**，实际验收结果以 `FINAL.md` 为准。

Android 同样使用支持 SDK 58 的 Expo Go，通过二维码打开；地址也填写电脑局域网 IP。

## web、真实后端与演示路径

浏览器模式：

```sh
npm run web
```

打开 `http://localhost:19300`。同一台电脑上可以直接使用默认假服务地址。手机尺寸的自动化检查使用 `390 × 844`。

接入自己的真实本地服务时，在设置中填它的电脑局域网地址与端口；接入已授权的线上服务时填 HTTPS 地址。地址可以带 `/api`，例如 `https://your-api.example/api`，也可以只写主机地址；客户端统一补齐一次 `/api`。后端需要实现设计文档的 JSON、multipart 上传、带 Bearer token 的 POST SSE 和 24 小时签名绝对媒体 URL，web 还需要允许对应来源的 CORS。HTTPS 网页应连接 HTTPS API，避免浏览器阻止混合内容。只连接个人或已明确授权的环境。

推荐按以下顺序演示：

1. 注册账号（用户名 3–32 位，密码至少 8 位），新建合作项目，填写标题、品牌、需求。
2. 上传一张或多张衣服图；“我的照片”可选。新项目进入工作台会自动启动分析和方向建议，也可以随时继续发消息。
3. 选择方向；可以先发自由文本调整脚本，再确认脚本。确认后才进入图片生成。
4. 等图片完成，点“改一改”输入修改要求。旧图保留，新图显示新的版本。
5. 按需要的顺序选图确认，进入笔记预览，复制标题、正文和话题；在手机上保存图片到相册。
6. 单独确认生成视频，等任务完成后在预览中播放。

衣服图在系统照片选择器中多选（最多 9 张），模特照片一次选 1 张。原生平台会申请所需照片权限；拒绝后可到系统设置重新允许。保存生成图时还需要相册写入权限；web 使用浏览器下载能力，不写手机相册。文案复制使用系统剪贴板。视频媒体自带音轨，但播放器默认静音，需要时可通过播放控件调整。

## 假服务、数据和恢复

- 实现位于 `mock-server/index.mjs`：Node 原生 HTTP、文件存储、`Request.formData()` 上传解析；只有密码处理使用 `bcryptjs`。
- 账号、项目、消息、图片版本和任务保存在 `mock-server/.data/`，已排除 Git；密码用 bcrypt，token 是有效期 7 天的 JWT。签名密钥也只保存在这个本地数据目录。这些是本地演示用途，未作为可公开部署的生产服务验收。
- 不用预置账号。注册后关闭、重启服务仍保留账号、项目和生成任务；App 再次进入工作台会恢复消息并拉取最新状态。原生 token 存在 `expo-secure-store`；web token 使用当前标签页的 `sessionStorage`。401 会清除会话并返回登录。
- 服务有活动任务时，App 每 3 秒请求 `/state`。任务默认约 0.8 秒进入 `running`；三张图片约 7 / 7.5 / 8 秒完成，编辑约 5 秒，视频约 7 秒。推进结果写入磁盘，服务重启后会继续按已保存时间推进。
- 图片和视频来自本仓库 `../docs/spike/` 的实测素材；多个镜头和编辑版本会复用固定图片。**假服务的“改图”只演示新版本和任务流程，不会真的改变图像内容**；上传模特图也不会触发真实试衣或生成。视频使用已有 MP4，支持 Range 请求以便播放、拖动。

客户端通过集中式 `src/api/` 管理接口与类型，用纯 JS 的 XHR 增量读取 SSE，避免额外原生模块，兼顾 Expo Go 和 web。React Context 负责会话，服务端 state 负责项目恢复；同 ID 卡片由较新的对象覆盖，轮询合并任务结果。官方 Expo 模块处理照片、文件、剪贴板和视频，保留之后 prebuild / EAS 打包的路径。

续接先读 `PROGRESS.md`，再对照当前代码与 `FINAL.md`；不要把历史待办当成已经通过的验收结果。`FINAL.md` 记录 A1–A5 的实际结论、接口差异、限制和截图清单。

## 验证与截图

```sh
npm run verify
```

这条命令按顺序跑 A1 和 A2，逐项保存断点结果与日志到 `verification/`；失败时立即停下，结果见 `verification/summary.json`。也可以分别执行：

```sh
npm run typecheck
npm run lint
npm test
npm run export:ios
npm run export:android
```

前两项分别等价于 `npx tsc --noEmit` 和 ESLint；单元及集成测试覆盖 API、SSE 解析、同 ID 卡片合并、任务推进，以及假服务全流程、账号隔离和重启恢复。导出只生成平台 bundle，不等于完成真机安装或 App Store 签名。

运行无头手机尺寸流程（配置会自动启动假服务和 web，也可以复用已经运行的 `19301` / `19300`）：

```sh
# 没有本机 Chrome 时，先安装无头浏览器。
PLAYWRIGHT_BROWSERS_PATH=.tools/browsers npx playwright install chromium
npm run test:e2e
```

配置优先使用本机 `/Applications/Google Chrome.app`，始终以无头模式启动独立临时会话；也可以用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器路径。其他机器使用上面下载的 Chromium。自动化用 `expo start --web --no-dev --minify` 提供页面，不打开可见窗口。截图保存在 `screenshots/`，按步骤编号；`screenshots/evidence.json` 记录排序、状态请求和播放结果，实际验证结论见 `FINAL.md`。

主服务端口为 `19300` / `19301`，集成测试只在 `19410–19499` 中选择空闲端口，不停止占用端口的进程；测试临时数据也留在本 worktree 的 `mock-server/.data/tests/` 并在测试后清理。

## 以后打包与 TestFlight

`app.json` 已配置 iOS `com.chaw1.outfitnotes`、Android `com.chaw1.outfitnotes`、图标、启动页及照片权限；`eas.json` 提供内部预览和生产配置。后续可在自己的分支生成原生项目：

```sh
npx expo prebuild
```

这会创建或更新 `ios/`、`android/`，需要本机对应原生工具链。App 代码使用 Expo Go 支持的模块，之后可转为独立安装包。

准备自己的 Expo 项目、Apple Developer 账号、App Store Connect 应用与签名凭据后，可按下面的生产流程配置并提交 TestFlight：

```sh
npx eas-cli@latest login
npx eas-cli@latest init
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios --profile production --latest
```

上线前把 API 改为自己的 HTTPS 服务，确认应用标识归属与权限说明，并在 TestFlight 配置测试人员。Android 可用 `npx eas-cli@latest build --platform android --profile production` 生成签名包。本次交付没有执行原生生成、云构建、签名、上传或付费操作。
