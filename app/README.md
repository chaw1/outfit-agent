# 衣序 · 穿搭笔记工作台

Expo SDK 58、expo-router、strict TypeScript 的 iOS / Android / web 演示应用。唯一接口约定是 [`../docs/设计.md`](../docs/设计.md)（图片交互见第 8 节），真实联调任务见 [`../docs/codex/APP_LIVE_PROMPT.md`](../docs/codex/APP_LIVE_PROMPT.md)，实际结论见本地 `LIVE.md`。假服务可以完整演示品牌合作项目、衣服分析、方向预览、脚本历史与恢复、图片还原分、改图版本、成本、笔记和短视频，不调用真实模型。

## 第九轮：片场、点数与一键出片

本轮只按 `docs/设计.md` 第 14 节接入。首页、登录、引导和新建页使用共享 `studio` 色板；编导间、查看器、局部改图、笔记草稿与预览延续既有交互。首页灵感墙来自 `assets/inspiration/studio-01..10.jpg`，两列展示，点图放大；底部“拍一组新片”固定可达。

新建页支持“一键出片 / 沉浸编导”，默认沉浸编导以延续原流程。衣服必填，出镜照片默认使用档案，参考图选填。12 个风格词每批展示 8 个，换批保留已选，最多 6 个；创建时分别发送 `mode`、`style_tags`，不改写 `brief`。品牌留空填“自由创作”，项目名默认“品牌 · 第一个风格词”。一键出片按钮读取 `GET /api/quotes/auto`，假服务当前估计 48 点；获取失败时可重试，取得估点后才允许开拍。

用户界面只展示点数：优先使用 `*_points`，旧服务只有 `*_cny` 时按 10 倍换算，不到 0.1 点保留微量提示。确认处展示预计点数与今日剩余，点数不足时禁用并提示次日恢复。自动项目按 `state.auto` 展示六步进度及每步主动消息，隐藏所有人工确认入口；“我来接手”调用 `POST /api/projects/{id}/mode`，正在执行的任务继续，到下一确认点等待。

首页将 generating / waiting_you / ready 放入“进行中”，按进度更新时间倒序排列；存在生成项时每 5 秒刷新，回到前台与重新进入首页立即刷新。“刚刚出好”复用现有完成追踪，按服务和账号隔离。自动项目从找方向起持续被追踪，跨无任务的步骤也继续检查；原生端持久化最近五个项目的完成记录，回前台和冷启动可恢复“刚刚出好”，恢复不重发通知；原有前台横幅与本地通知交付方式保留。通知时机仍受手机后台调度与权限限制，网页测试不代表原生通知验收。

假服务增加新旧点数字段、估点、模式切换、项目进度与后台自动推进，重启后可恢复；旧客户端不带新字段仍走沉浸编导。定价为出图 5 点/张、视频 15 点，48 点估点含方向预览与自动修图预留。

本地验收（Node 22，均在 `app/` 执行）：

```sh
npm run verify
PLAYWRIGHT_BROWSERS_PATH=$PWD/.tools/browsers npx playwright test
```

新增单测覆盖点数优先/换算、风格换批、进行中排序、六步进度和自动项目离开后的完成追踪。`e2e/round9.spec.ts` 覆盖自动完成、中途接手、点数全文扫描；新增截图从 `screenshots/90-` 起。完整检查证据归档到 `verification/round9/`，交付记录为 `../docs/codex/runs/app-round9-final.txt`。

`e2e/live.spec.ts` 仅按新文案和点数改选择器；`e2e/live-auto.spec.ts` 已编写但本轮不执行。普通 Playwright 配置排除所有 live 用例；live 配置只有显式设置 `LIVE_API_BASE` 才启用，auto 用例上限 10 分钟、每步截图到 `screenshots-live/auto/`，六步证据不齐会明确失败。auto 独立断点放在 `~/Secrets/outfit-agent/`，不复用旧联调凭证，不自动重放已发出的开拍请求。

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
- 假服务的一键出片由后台计时器推进，沉浸编导会在请求时同步任务：约 0.8 秒进入 `running`，方向预览约 2.2 秒完成；三张图片约 7 / 7.5 / 8 秒完成，第 3 张会示范低分自动修一版（再约 5 秒），手动编辑约 5 秒，视频约 7 秒。完成后持久化主动消息及成本；服务重启后继续按已保存时间推进。`MOCK_PREVIEW_DELAY_MS=4500 npm run mock` 可延长预览占位供演示。
- 脚本修改会保存版本，“历史版本”通过 `restore_script` 恢复旧稿并保留已有图；重新确认后追加新批图片，每张图的 `script_version` 指明来源脚本。还原分、自动修复、成本均为固定演示数据，不是真实模型测评或账单。
- 图片和视频基图来自本仓库 `../docs/spike/` 的素材。假服务改图把所选像素调成明显橙色（整张改为整图色调变化），输出 PNG；框选外及笔刷蒙版覆盖外的解码像素保持相同，便于检查区域提交是否正确。首次用户局部改固定返回 `edit_check.passed=false`，后续重试通过；计数及区域、轨迹、引用随本地数据持久化。这些是交互演示，不执行模型生成、指令核对或真实试衣。视频使用已有 MP4，支持 Range 请求以便播放、拖动。

客户端通过集中式 `src/api/` 管理接口与类型，用纯 JS 的 XHR 增量读取 SSE，避免额外原生模块，兼顾 Expo Go 和 web。React Context 负责会话，服务端 state 负责项目恢复；同 ID 卡片由较新的对象覆盖，轮询合并任务结果。官方 Expo 模块处理照片、文件、剪贴板和视频，保留之后 prebuild / EAS 打包的路径。

续接先读 `PROGRESS.md`，再对照当前代码与 `FINAL.md`；不要把历史待办当成已经通过的验收结果。`FINAL.md` 记录当前轮次的实际结论、接口差异、限制和截图清单。

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

## 档案、发布与通知

首次打开完成三屏引导；设置里的“我的形象”可上传多张本人照片、设默认、移除和保存身高/体型/偏好，昵称一并保存。照片预览按服务和账号保存在本机；接口只有资产 ID，所以换设备会显示占位，可重新上传。旧服务没有 profile 或返回 404 时提示未开通，上传衣服、项目和对话保持可用。

项目列表支持按标题/品牌搜索、下拉或按钮刷新、长按/按钮删除并二次确认。删除后服务必须让项目、state、messages 均返回 404；本地假服务同时清理该项目任务和生成文件，保留上传原图。

笔记预览是发帖表单：标题最多 20 字并实时计数，正文可编辑，话题胶囊可增删，图片可以前后排序，AI 声明默认勾选。编辑采取本地覆盖，复制和“准备发布”都使用编辑后的标题、正文、话题与图片顺序，原始服务端笔记保留。“保存草稿”将这些字段与声明状态按服务/账号/项目存到当前设备，刷新或重开自动恢复；未保存的编辑会显示提示。

核对“发布清单”后点“准备发布”：复制文案、按顺序保存图片、保存已完成视频、打开系统文案分享。媒体先进入相册，目标平台的选图、排列和声明仍由用户操作。第一项保存失败即暂停；重试只继续未完成项。媒体 ID 断点按服务/账号/项目保存，重开页面仍生效；图片已保存后改笔记顺序会提醒按新清单在平台排列。网页不支持系统分享时显示手动发布说明。

通知使用本地通知，不接推送平台：生成任务被观察后，即使离开工作台仍在应用级检查；前台只显示应用内提示，后台获授权时静音通知，点按进入对应项目。拒绝权限不影响生成结果。系统挂起 JS 时由 expo-background-task 检查持久化的任务进度（minimumInterval=15 分钟），操作系统决定实际时间，不能承诺立即通知或被杀进程后通知。此限制见 [Expo BackgroundTask](https://docs.expo.dev/versions/latest/sdk/background-task/) 与 [Apple 后台策略](https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app)。原生通知与后台任务需要开发包/本机安装包，网页测试仅覆盖通知决策，不等于真机通过。

工作台按设计第 11 节展示可选 trace：每条助手消息下方显示能力、耗时和费用，点击可看模型与分步；Worker 主动消息同样显示。确认出图/视频旁展示服务给出的预估与今日余额，余额不足时禁用并提示；缺少预估或余额时隐藏提示。方向卡底部“换一组”发送固定文本“换一组方向，保留我刚才说的偏好”，新版方向和预览按同卡片 ID 替换。

“换个说法”遵循第 11.3 节：消息可选 can_regenerate=true，发送 action={type: "regenerate_reply", message_id}。只有最后一条助手回复且服务确认原轮没有创建生成任务才展示；仅替换该消息文本，不重新跑工具或增加出图费用。旧服务无该标记时隐藏入口。明确拒绝且未执行的消息或确认可重发；断线不明时只核对历史，避免重复生成。

本轮复测：npm run verify；npm run test:e2e；npx expo prebuild --platform ios。第 11 节新流程为 e2e/round6.spec.ts，档案/项目、发布重试及视觉回归保留原用例。本轮独立证据在 verification/fix5/，新增截图从 screenshots/53 起。假服务可用 MOCK_LEGACY_PROFILE=missing 或 old-fields 模拟旧服务；请使用独立本地数据目录复测，不对真实服务执行付费步骤。

原生验收仍需在自己的手机上检查：通知允许/拒绝、后台/前台、冷启动点按路由、不同账号隔离；照片与视频相册写入、系统分享、长按、双指手势。新增依赖是 expo-notifications、expo-background-task、expo-task-manager 和 AsyncStorage；app.json 已配置插件、静音通知频道、照片/视频读取与保存文案，iOS 生成目录不提交。

## 真实线上联调与断点

`npm run test:live` 使用独立的 `playwright.live.config.ts` 和 19310 web 端口。只有设置 `LIVE_API_BASE` 才运行；始终无头、390×844、校验 TLS，不启动假服务，不自动重试付费动作。真实模型会计费，只连接个人或明确授权的环境。

```sh
LIVE_API_BASE=https://47.97.153.127:8443 npm run test:live
```

首次通过 App 注册 `live-` 测试账号、上传 `docs/spike/inputs.jpg` 拆出的衣服和模特图并建立项目。每个步骤的截图、耗时及脱敏响应保存在 `screenshots-live/run-N/`。登录资料、已发送动作和完成步骤原子保存到被 Git 忽略的 `screenshots-live/checkpoint.json`，各轮另存 `private/run-N.json`，文件权限为 `0600`；不要提交或分享这些文件。再次执行相同命令会在同一项目上续跑；遇到已发出但结果未知的动作先读取状态，避免重复计费。

需要最终从注册开始完整复跑时，显式加 `LIVE_NEW_RUN=1`，最多允许 3 个完整项目。不要删除计数断点来绕过上限。最终实际结论、耗时、App 修复和服务端待办见 `LIVE.md`；旧 `FINAL.md` 仅证明假服务流程。真实用例不修改 `server/`，服务端问题只保留请求、响应和复现证据。

默认点击方向卡片；`LIVE_DIRECTION_MODE=text` 改为在聊天框选择第一个方向。`LIVE_INSPECT_CUFF=1` 会先保存 `08-cuff-inspect.png`，等人工查看后在本地忽略文件 `screenshots-live/cuff-selection.json` 写入当前袖口中心的原图归一化坐标 `{"x":0.3,"y":0.4}`，再由查看器真实涂抹提交；每次要求新写入的坐标文件。未启用时用 `LIVE_CUFF_X/Y` 或默认坐标，需据截图核对实际选区。

服务端明确拒绝后仍保留已发动作标记。修复服务端后，先刷新原项目核对阶段、确认项和任务，再由接续者检查 `sse-evidence.json` 与 `failure-NN.json`；仅确认未生效的动作可移走对应 `checkpoint.sent` 项并记录重试原因。不要清除整个断点或自动重放结果未知的生成请求。

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

## 第八轮：改图结果可信闭环

按设计第 13 节，每个镜头默认选最新的成功且核对通过版本；“未改到位”的新版保留可查看，点“仍然采用”会显示原因确认，选图请求携带 `accept_unverified`。服务端返回 `unverified_image` 时也会确认后重发；预览和发布清单把这些图标为“手动采用”。改图每次提交生成 UUID `attempt`，传输重试复用，明确点“再试一次”或“换个说法”才开始新尝试；`reused=true` 会提示“这次和上次一样，没有重新生成”。

笔记阶段可在查看器“采用此版本到笔记”，或从笔记卡“重新选图”，同镜头替换并保持原顺序；视频与完成阶段维持定稿。草稿记录 SHA-256 来源指纹及 dirty 状态，干净草稿跟随最新笔记，有修改且来源变化时提供“保留我的修改 / 采用新版本”，随时可恢复服务端版本；明确切换前会保留一份可恢复的本机草稿，旧图的“手动采用”标记随草稿保存。

REST 读取、写入、上传分别在 20 / 60 / 120 秒超时，写入不自动重放；创建超时先刷新项目列表再提供人工判断入口，上传显示“第 n/N 张”。方向卡按服务返回的 `regenerate_estimate_cny` 显示“约 ¥x · 含 2–3 张预览”，缺字段时兼容旧服务。首次引导第二页标题改为“正式出图和视频，由你确认”。

本轮验证使用本地假服务：`npm run verify`、`npx playwright test`；新增 `e2e/round8.spec.ts`，截图从 `screenshots/77-` 接续。单测覆盖默认选图、明确采用、新旧 attempt、草稿冲突与超时分类；假服务同时覆盖新字段和任务复用。未运行线上付费用例，`e2e/live.spec.ts` 保持原语义和文件内容。
