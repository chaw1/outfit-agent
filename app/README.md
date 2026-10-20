# 衣序 · 穿搭笔记工作台

Expo SDK 58、expo-router、strict TypeScript 的 iOS / Android / web 演示应用。唯一接口约定是 [`../docs/设计.md`](../docs/设计.md)（新增交互见第 8 节），当前任务见 [`../docs/codex/APP_FIX2_PROMPT.md`](../docs/codex/APP_FIX2_PROMPT.md)。假服务可以完整演示品牌合作项目、衣服分析、方向预览、脚本历史与恢复、图片还原分、改图版本、成本、笔记和短视频，不调用真实模型。

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

Metro 使用 `19300`。服务地址默认来自 `EXPO_PUBLIC_API_BASE`，未设置时为 `https://47.97.153.127:8443`；`.env.example` 同步使用该地址。演示本地假服务时，在 App 的“设置”中填写 `http://localhost:19301`（web），或把下面一行写入本地 `.env.local` 后重启 Metro：

```dotenv
EXPO_PUBLIC_API_BASE=http://localhost:19301
```

iPhone 连接电脑假服务时要换成电脑的局域网 IP。App 会优先保留你已在设置中保存的地址；环境变量只决定未保存地址时的初始值。`EXPO_PUBLIC_*` 会包含在客户端代码中，只用于公开配置，不能放密码或密钥。

## 用免费 Apple ID + Xcode 装到自己的 iPhone

这条路径在自己的 Mac 本地编译并签名，不需要购买 Apple Developer Program，也不经过 EAS 云构建或 TestFlight。Apple 把免费账号显示为 Personal Team；它的设备签名有效期为 7 天，到期后需要重新编译安装。限制及有效期见 [Apple 的 Personal Team 说明](https://developer.apple.com/help/account/basics/about-your-developer-account)。

1. 从 Mac App Store 安装完整的 **Xcode**，首次启动并完成许可、所需组件和 iOS 平台支持的安装。使用支持你手机 iOS 版本的 Xcode。在 Xcode → Settings → Locations 中选择该 Xcode 的 Command Line Tools。可在终端运行 `xcodebuild -version` 核对；只有 Command Line Tools 而没有完整 Xcode 不足以构建 iOS App。
2. 打开 Xcode → Settings → **Apple Accounts**（有些版本叫 Accounts），点 `+` 登录自己的 Apple ID / Apple Account，按提示完成双重认证并接受开发者协议。账号未加入付费开发者计划时会出现 **Personal Team**。
3. 在 `app/` 切到 Node 22，执行 `npm ci`。若此前给 web 假服务写过 `.env.local`，先把 `EXPO_PUBLIC_API_BASE` 改为 `https://47.97.153.127:8443`，或在设置中手动改回该地址。然后生成原生工程并安装 CocoaPods 依赖：

   ```sh
   npx expo prebuild --platform ios --no-install
   npx pod-install ios
   ```

   若提示缺少 CocoaPods，按提示安装后重跑 `npx pod-install ios`。`--no-install` 只验证原生工程生成，刻意跳过依赖安装；它本身不表示已编译或已装到手机。生成的 `ios/` 已在 `.gitignore` 中，不提交。
4. 用 USB 连接并解锁 iPhone。在手机点“**信任此电脑**”并输入解锁密码；如 Mac 询问允许连接，也选择允许。打开 Xcode → Window → Devices and Simulators，或新版本中的 Xcode → Open Developer Tool → **Device Hub**，选中手机，等待配对及准备完成。
5. iOS 16 及以上，在手机“设置 → 隐私与安全性 → **开发者模式**”中开启，按提示重启，解锁后再次确认开启。如果还没有这个选项，先完成上一步的 Xcode 配对。操作依据见 [Expo 的开发者模式说明](https://docs.expo.dev/guides/ios-developer-mode/)。
6. 用 Xcode 打开生成的 **`ios/app.xcworkspace`**（安装 Pods 后生成，不打开 `app.xcodeproj`）。在左侧选工程，再选 **app target → Signing & Capabilities**，开启 **Automatically manage signing**，Team 选择自己的 **Personal Team**。Bundle Identifier 默认是 `com.chaw1.outfitnotes`。如果被其他账号占用，在 `app.json` 的 `expo.ios.bundleIdentifier` 中换成自己的唯一标识，再重新 prebuild / 安装 Pods，并在 Xcode 重新选择 Team。顶部运行目标选择连接的真实 iPhone，让 Xcode 自动创建开发签名和描述文件。
7. 回到 `app/` 终端执行以下命令，在列表中选连接的真实 iPhone。显式保留 `19300` 端口：

   ```sh
   npx expo run:ios --device --port 19300
   ```

   Expo 会编译、安装并打开“衣序”，同时启动 Metro；第一次编译和签名会较慢。如提示没有开发签名，回到第 6 步，用 Xcode 对所选 iPhone 运行一次后重试。命令与自动开发签名说明见 [Expo CLI 文档](https://docs.expo.dev/more/expo-cli/#ios-development-signing)。
8. 若手机提示“未受信任的开发者”，在“设置 → 通用 → **VPN 与设备管理**”的开发者 App 下选择自己的 Apple ID 并信任，再打开“衣序”。开发调试时保持 Metro 运行，手机与电脑在同一网络，允许 App 访问本地网络。后续只改 JS/TS 可以运行 `npm run start`，无需每次重编原生工程。

明天演示若希望拔线后不依赖 Metro，可在同样签名完成后安装带内置 JS 的 Release 版本：

```sh
npx expo run:ios --device --configuration Release --port 19300
```

Release 仍需网络连接 API，仍受 Personal Team 的 7 天有效期限制。7 天后重新连接手机，保持同一个 Apple ID、Team 和 Bundle Identifier，再执行 `npx expo run:ios --device --port 19300`（或上面的 Release 命令）重新签名安装；通常无需先删 App。若删除 App，本地登录和设置会丢失。

默认 API 为 `https://47.97.153.127:8443`，登录页也能进入“设置”修改。若改用电脑假服务，填写 `http://192.168.1.23:19301` 之类的局域网地址。**手机中的 `localhost` 指手机本身，不能用来连接电脑。** 切换服务地址后需要重新登录。可先在手机浏览器访问电脑假服务的 `/api/health`：收到 401 说明已连通，登录后携带 Bearer token 才能返回健康状态；连接失败时检查 Wi-Fi 隔离和端口防火墙。

本次只完成原生工程生成和配置检查，没有连接 iPhone、签名、读取钥匙串或打开模拟器。实际验证结果见 `FINAL.md`。

## web、真实后端与演示路径

浏览器模式：

```sh
npm run web
```

打开 `http://localhost:19300`，先在设置把 API 改为 `http://localhost:19301`，或按前文设置 `.env.local`。手机尺寸的自动化检查使用 `390 × 844`；Playwright 配置会显式使用本地假服务地址。

接入自己的真实本地服务时，在设置中填它的电脑局域网地址与端口；接入已授权的线上服务时填 HTTPS 地址。地址可以带 `/api`，例如 `https://your-api.example/api`，也可以只写主机地址；客户端统一补齐一次 `/api`。后端需要实现设计文档的 JSON、multipart 上传、带 Bearer token 的 POST SSE 和 24 小时签名绝对媒体 URL，web 还需要允许对应来源的 CORS。HTTPS 网页应连接 HTTPS API，避免浏览器阻止混合内容。只连接个人或已明确授权的环境。

推荐按以下顺序演示：

1. 注册账号（用户名 3–32 位，密码至少 8 位），新建合作项目，填写标题、品牌、需求。
2. 上传一张或多张衣服图；“我的照片”可选。新项目进入工作台会自动启动分析和方向建议，也可以随时继续发消息。
3. 等方向预览图完成后选择方向；可以先发自由文本调整脚本，或从“历史版本”恢复旧脚本，再确认脚本。确认后才进入图片生成；恢复历史会保留已有图片。
4. 等图片完成，点图全屏看细节：左右滑切图，双指/双击缩放并拖动；版本条沿 `parent_id` 链展示，前后对比可拖滑块。点“圈选”用笔刷（调粗细、撤销、清空）或框选标记，再选快捷说法或输入指令；整张改不带区域。新版本完成自动进入对比，检查失败可再试或换个说法。长按图可局部改、整张改、引用、对比或保存；引用缩略图出现在输入框上方，随文字发送 `refs`。右上角圆点单独选图，旧图保留。
5. 按需要的顺序选图确认，进入笔记预览，查看累计成本和 AI 内容声明，复制标题、正文和话题；在手机上保存图片到相册，发布时按提示勾选平台 AI 声明。
6. 单独确认生成视频，等任务完成后在预览中播放。

衣服图在系统照片选择器中多选（最多 9 张），模特照片一次选 1 张。原生平台会申请所需照片权限；拒绝后可到系统设置重新允许。保存生成图时还需要相册写入权限；web 使用浏览器下载能力，不写手机相册。`app.json` 已声明相机用途，但当前上传入口使用相册选择器。文案复制使用系统剪贴板。视频媒体自带音轨，但播放器默认静音，需要时可通过播放控件调整。

## 假服务、数据和恢复

- 实现位于 `mock-server/index.mjs`：Node 原生 HTTP、文件存储、`Request.formData()` 上传解析；密码处理使用 `bcryptjs`，假改图用开发依赖 `sharp` 在本地处理像素。
- 账号、项目、消息、图片版本和任务保存在 `mock-server/.data/`，已排除 Git；密码用 bcrypt，token 是有效期 7 天的 JWT。签名密钥也只保存在这个本地数据目录。这些是本地演示用途，未作为可公开部署的生产服务验收。
- 不用预置账号。注册后关闭、重启服务仍保留账号、项目和生成任务；App 再次进入工作台会恢复消息并拉取最新状态。原生 token 存在 `expo-secure-store`；web token 使用当前标签页的 `sessionStorage`。401 会清除会话并返回登录。
- 工作台在前台聚焦时每 3 秒请求 `/state`（无活动任务时也检查主动消息）；`last_message_id` 未同步时自动拉 `/messages`，SSE 结束后补拉，App 进入后台暂停，回到前台立即恢复。笔记预览只在有活动任务时轮询。
- 假服务由请求推进任务：约 0.8 秒进入 `running`，方向预览约 2.2 秒完成；三张图片约 7 / 7.5 / 8 秒完成，第 3 张会示范低分自动修一版（再约 5 秒），手动编辑约 5 秒，视频约 7 秒。完成后持久化主动消息及成本；服务重启后继续按已保存时间推进。`MOCK_PREVIEW_DELAY_MS=4500 npm run mock` 可延长预览占位供演示。
- 脚本修改会保存版本，“历史版本”通过 `restore_script` 恢复旧稿并保留已有图；重新确认后追加新批图片，每张图的 `script_version` 指明来源脚本。还原分、自动修复、成本均为固定演示数据，不是真实模型测评或账单。
- 图片和视频基图来自本仓库 `../docs/spike/` 的素材。假服务改图把所选像素调成明显橙色（整张改为整图色调变化），输出 PNG；框选外及笔刷蒙版覆盖外的解码像素保持相同，便于检查区域提交是否正确。首次用户局部改固定返回 `edit_check.passed=false`，后续重试通过；计数及区域、轨迹、引用随本地数据持久化。这些是交互演示，不执行模型生成、指令核对或真实试衣。视频使用已有 MP4，支持 Range 请求以便播放、拖动。

客户端通过集中式 `src/api/` 管理接口与类型，用纯 JS 的 XHR 增量读取 SSE，避免额外原生模块，兼顾 Expo Go 和 web。React Context 负责会话，服务端 state 负责项目恢复；同 ID 卡片由较新的对象覆盖，轮询合并任务结果。官方 Expo 模块处理照片、文件、剪贴板和视频，保留之后 prebuild / EAS 打包的路径。

续接先读 `PROGRESS.md`，再对照当前代码与 `FINAL.md`；不要把历史待办当成已经通过的验收结果。`FINAL.md` 记录 C1–C6 的实际结论、接口差异、限制和截图清单。

## 验证与截图

```sh
npm run verify
```

这条命令按顺序跑类型检查、ESLint、测试、iOS 和 Android 导出，逐项保存断点结果与日志到 `verification/`；失败时立即停下，结果见 `verification/summary.json`。也可以分别执行：

```sh
npm run typecheck
npm run lint
npm test
npm run export:ios
npm run export:android
```

前两项分别等价于 `npx tsc --noEmit` 和 ESLint；单元及集成测试覆盖 API、SSE 解析、卡片合并、坐标逆变换（留白、横竖图、缩放和平移）、区域外像素、引用归属、任务推进和重启恢复。导出只生成平台 bundle，不等于完成真机安装或 App Store 签名。

运行无头手机尺寸流程（配置会自动启动假服务和 web，也可以复用已经运行的 `19301` / `19300`）：

```sh
# 没有本机 Chrome 时，先安装无头浏览器。
PLAYWRIGHT_BROWSERS_PATH=.tools/browsers npx playwright install chromium
npm run test:e2e
```

配置优先使用本机 `/Applications/Google Chrome.app`，始终以无头模式启动独立临时会话；也可以用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器路径。其他机器使用上面下载的 Chromium。自动化用 `expo start --web --no-dev --minify` 提供页面，不打开可见窗口。截图保存在 `screenshots/`，按步骤编号；`screenshots/evidence.json` 记录排序、状态请求和播放结果，实际验证结论见 `FINAL.md`。

主服务端口为 `19300` / `19301`，集成测试只在 `19410–19499` 中选择空闲端口，不停止占用端口的进程；测试临时数据也留在本 worktree 的 `mock-server/.data/tests/` 并在测试后清理。

## 以后打包与 TestFlight

`app.json` 已配置显示名“衣序”、iOS `com.chaw1.outfitnotes`、Android `com.chaw1.outfitnotes`、1024 × 1024 图标、启动页、相机、相册读取和保存权限说明；`eas.json` 提供内部预览和生产配置。iOS prebuild 的实际日志见 `verification/prebuild-ios.txt`。之后也可生成双平台原生工程：

```sh
npx expo prebuild
```

这会创建或更新 `ios/`、`android/`，需要本机对应原生工具链。App 手势与绘制使用 Expo Go 支持的 `react-native-gesture-handler`、`react-native-reanimated` / `react-native-worklets`、`react-native-svg`，触感使用 `expo-haptics`；版本由当前 Expo SDK 的 bundledNativeModules 指定。之后可转为独立安装包。

准备自己的 Expo 项目、Apple Developer 账号、App Store Connect 应用与签名凭据后，可按下面的生产流程配置并提交 TestFlight：

```sh
npx eas-cli@latest login
npx eas-cli@latest init
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios --profile production --latest
```

TestFlight 需要付费 Apple Developer Program，与前面的免费本机安装是两条独立路径。上线前确认 API、应用标识归属与权限说明，并在 TestFlight 配置测试人员。Android 可用 `npx eas-cli@latest build --platform android --profile production` 生成签名包。本次交付执行了 iOS prebuild，没有执行云构建、签名、上传或付费操作。
