# 真实线上联调续接（已完成）

- 任务：完整执行 `docs/codex/APP_LIVE_PROMPT.md`；唯一约定 `docs/设计.md`；交付 `app/LIVE.md`（≤40 行，结论优先）。
- 开始：2026-10-21 00:19:46（Asia/Shanghai）；墙钟截止 01:49:46。只改当前 worktree 的 App，只在 `feat/app` 提交，不 push、不改 server、不 SSH、不读钥匙串。
- 用户明确授权的个人线上服务：`https://47.97.153.127:8443`。正常 TLS、浏览器 CORS 均通过；health mock=false。未访问前公司环境、服务器或钥匙串。
- 已新增 `npm run test:live`、独立19310 config、LIVE_API_BASE门控（未设置时1 skipped）、13阶段截图/耗时、最多3个完整项目、防付费动作自动重放、即时SSE脱敏证据。
- Run1 项目 `23329be6-51b0-4a29-b253-a9ec9312c4d7`：分析及预览通过，选方向两次SSE PROVIDER_ERROR（圈选轨迹不能为空）且状态不变；自由文本尝试结果未明，已保留发送标记。测试的SSE正文/finished无界等待已修正，未重发未决请求。
- Run2 项目 `04a5aea6-f5e3-4940-98f4-56bb5c1a59e6`：完整真实链路1 passed（8.9min），包括自由改脚本、3镜头及58→92自动修复、主动播报、实际袖口涂抹、refs、笔记成本/声明、视频播放；pageErrors=[]。
- 服务端质量风险：run2局部改edit_check=false（袖口未放平），自动修复版也有标签残留检查失败；App如实展示。离线1773×2364像素比对：28,949像素变化，报告框外0变化；仅证明框外，不等于精确笔刷蒙版保证。见run-2/local-edit-pixels.json。
- 确认并修复App问题：错误Notice在长卡片上方、自动滚动后视口外（y=-433）；现固定输入区上方。API拒绝/显式重试单测和手机视口回归已补，本地完整mock E2E通过1.6min，证据screenshots/35-provider-error-visible.png。
- `npm run verify`五项通过，59 tests；包含私密归档0600、旧断点升级、三遍上限、同项目续跑、请求发送前后失败保护、凭证脱敏。初始四份verification旧WIP已用本轮真实验证结果刷新。
- Run3 最终复跑完成（修复后新Metro），项目 `22aca728-fdf5-4f32-842e-d4b0e4f1b15e`：13/13步骤通过、无SSE错误/pageErrors，7.5min；视频830×1108、5.007s，实际静音播放到1.927s。局部改仍被模型判未放平，见LIVE的S2，不等于效果达标。完整项目计数3/3，禁止再设置LIVE_NEW_RUN=1；只可原项目续跑。
- 登录/动作断点：screenshots-live/checkpoint.json与private/run-N.json（0600，目录0700，Git忽略）；HTTP/SSE/状态/失败/截图在run-N。报告与截图按全局规则留本地，代码及已跟踪文档提交。
- 提交：`9b20848` 修复工作台错误提示被长卡片遮挡；联调框架与最终证据索引随本文件提交，见git log。不push、不合并。
- 所有任务已结束：三项目均active_jobs=[]，累计state成本估算¥13.814804。原自启Metro19310已停，最终Playwright管理的新Metro已随测试停止；本地mock也由测试自动起停。
- 证据审计：final-audit.json确认run2/3全部13步骤、每个脚本镜头有成功图片、还原分、主动消息回读、归一化mask、refs与图序、成本声明和静音实播；manifest.json含58张390×844 UI截图与3张离线质检原图的尺寸/SHA256。最终关键截图已目视复核。
- 收尾：LIVE.md≤40行、结论优先；敏感文件忽略且0600。报告/截图保留本地，代码与已跟踪正式文档提交；整个任务约40分钟，低于90分钟。未执行真机签名、安装或读取钥匙串。

# 第三轮续接（已完成）

- 任务：完整执行 `docs/codex/APP_FIX2_PROMPT.md`；唯一契约 `docs/设计.md`，重点第 8 节。
- 开始：2026-10-20 23:32（Asia/Shanghai），墙钟截止 2026-10-21 01:32。
- 分支 `feat/app`；初始四份 verification 日志有未提交重跑改动；本轮完成后刷新验证证据。不 push、不合并。
- 仅当前 worktree，本地 19xxx、无头浏览器；不访问真实模型/钥匙串/前公司环境，不开模拟器。
- 并行分工：viewer 负责 ImageViewer / imageGeometry / 坐标测试；mock_contract 负责假服务 / types / 集成测试；e2e 负责无头流程与截图；主线负责入口、长按菜单、引用、验证及交付。
- 已安装 SDK58 bundledNativeModules 指定的 RNGH/Reanimated/worklets/SVG/haptics；sharp 仅用于本地假服务生成明显局部效果。
- 已接入：根手势容器、ImageInteractions 菜单/保存、点图查看与独立选图、workspace 引用展示/发送/删除、note preview 图片入口与引用返回工作台。
- 已完成组件集成；修复签名URL轮询导致选区/缩放丢失、移动工具误切selection类型、短拖重复圆点、双指接管误涂、同指令不同mask重试匹配；键盘可见时收起部分工具保证提交，SVG高亮裁到图片内。
- 最终 Node22 verify 五项通过，51/51 测试；iOS prebuild 成功。标签遮挡修复后的最终无头全链 1/1 通过（约1.7分钟），pageErrors=[]。已通过zoom/pan坐标逆算、跨轮询保留、failed重开精确retry、框选→移动→region、refs持久化、菜单保存下载、preview引用往返和原视频/断网流程。
- 截图34张均390×844，新增25–34；已逐项目视新增图及总览，修复compare label被还原分覆盖，深色状态栏改浅色。尺寸/哈希在verification/screenshots.json，总览contact-sheet.jpg。
- 提交断点：1f83dcb（契约/依赖/坐标/测试）、fe3a6f7（假服务）；界面/端到端/最终证据与覆盖后的FINAL在最终提交，见git log。FINAL共31行。
- 完成：2026-10-20 23:51（Asia/Shanghai，约19分钟），未超过2小时；未做真实后端、签名安装或真机验收。下一步按README在自己的iPhone复测双指、键盘、触感、相册及真实媒体水印/元数据。
- Node22：`PATH=/Users/jiawei/.local/share/mise/installs/node/22.23.1/bin:$PATH`；无头流程已自动退出19300/19301，无任务服务常驻。复测会自动起停，请勿同时启动第二套。

## 第二轮续接

- 任务：完整执行 `../docs/codex/APP_FIX1_PROMPT.md`，唯一契约 `../docs/设计.md`（重点第 7 节）。
- 开始：2026-10-20 22:53（Asia/Shanghai），最晚 2026-10-21 00:53 收尾。
- 范围：当前 worktree 的 `feat/app`；不 push、不合并、不调用真实模型、不读钥匙串；仅本地 19xxx 端口，无头浏览器，不开模拟器。
- 工作区初始已有 verification/{android,ios,summary,tests} 四份日志改动，仅为第一轮重跑结果；本轮已运行 verify 并刷新证据。
- 并行分工：主线界面/端到端/最终验收；假服务契约与集成测试；状态同步/类型/合并测试；iOS 配置/prebuild/安装文档。
- 已实现：方向预览加载/失败、还原分与自动修复说明、4 个改图快捷说法、脚本历史恢复、成本与声明；script_version 和项目成本可见。
- 同步：前台工作台每 3 秒拉 state，last_message_id 未同步自动拉 messages；流中保留待刷新标记，后台暂停，返回前台补拉；修复 forced history 被并发轮询抢占的边界。
- 假服务：本地预览任务、主动播报、54 分→自动修复 92 分、历史/恢复/保留旧图/重新确认追加图片、固定成本和声明；note/done 阶段改图保留笔记、视频和待确认。
- B3：默认地址与相机权限已更新，Node 22.23.1 prebuild 成功；ios/ 已忽略。README 含免费 Apple ID / Personal Team / 手机信任与开发者模式 / Debug 和 Release / 7 天重装。
- B4：最终实现的 Node 22.23.1 verify 五项通过，35/35 测试；日志和 bundle 元数据校验见 verification/summary.json。最终无头 390×844 全链 1/1 通过（约 1.1 分钟），24 张截图尺寸逐张核对，新增截图及总览已目视核对。
- 完成：2026-10-20 23:04（Asia/Shanghai，用时约 11 分钟），B1–B4 本地验收通过；没有执行真实 API、真机签名/安装或原生相册验收。
- 提交：1d8963d（类型与同步）、ea373f2（假服务与集成测试）、f7c2542（界面与端到端）；配置及验收文档在最后一条提交。仅 feat/app，不 push、不合并。
- 当前验证服务已由 Playwright 自动退出；生成 ios/ 保留本地且已忽略，便于接续配置签名。下一步按 README 装到用户自己的 iPhone，并用同契约真实后端核验文件标识、权限和原生体验。
- 已覆盖 `FINAL.md`（≤50行）。以下为第一轮历史，不能视为本轮验收证据。

## 第一轮历史

- 任务：完整执行 `../docs/codex/APP_PROMPT.md`；接口唯一来源 `../docs/设计.md`。
- 开始：2026-10-20 22:13（Asia/Shanghai）；墙钟截止：2026-10-21 01:13。
- 分支：`feat/app`；只在当前 worktree；不 push、不调用模型、不访问前公司环境。
- 架构：SDK 58 + expo-router + strict TypeScript；REST + 纯 JS XHR SSE；React Context 管理会话，项目状态由服务端恢复；Node 原生 HTTP 假服务。
- 原因：保持 Expo Go / web 共用一套代码，原生文件与相册交给 Expo 官方模块；不引入重状态框架；XHR 在 RN 下可接收增量，不依赖原生 EventSource。
- 并行范围：接口/解析/合并与测试、卡片 UI、假服务；主线负责脚手架、页面、会话、集成与验收。
- 环境：默认 Node 20 不满足 SDK 58；已找到本机现有 Node 22.23.1，运行前临时设置 `PATH=/Users/jiawei/.local/share/mise/installs/node/22.23.1/bin:$PATH`，不修改全局环境；新机器按 `.nvmrc` 使用 Node 22。
- 已核对：SDK 58 npm 包已发布；官方 2026-10-15 公告仍提示商店 Expo Go 处于升级过渡期，需匹配 SDK 58 的客户端，不能声称真机已验收。
- 已完成：接口/SSE/状态合并、假服务及重启恢复、全部页面/六卡片/轮播/复制/按格式保存/静音视频；A1 共 26 项测试、TS 和 ESLint 绿；iOS / Android Hermes bundle 导出成功。
- 已实拍：无头 Chrome，390×844，完整注册到视频播放；多图和模特图上传、自由文本、编辑 v2、选图排序、复制、下载、刷新恢复、401 回登录、断网重试；18 张截图，见 `screenshots/`。
- 卡点与修复：浏览器 fetch 丢失原生接收者，改为绑定 globalThis 并回归测试；预览返回 replace 重复堆叠工作台，改为优先 back；SDK 58 相册使用 Asset.create；会话/工作台代际守卫防迟到请求覆盖；SSE 断流只重拉 GET，不自动重发确认动作。
- 最近契约校正：健康检查也需要 token；类型兼容设计未细化的 palette 字符串/数组；未修改 `docs/设计.md`。
- 验证入口：`npm run verify` 将每项结果写到 `verification/summary.json`，日志同目录；`npm run test:e2e` 自动起本任务的两项服务，优先本机 Chrome 无头模式，无需下载大体积 Chromium。
- 完成：2026-10-20 22:40（用时约 27 分钟）；最终 `verify` 五项通过；E2E 1/1 通过（31.6 秒），18 张截图尺寸全部为 390×844，已逐张总览核对。
- 提交：`4ac3ee7` 接口与状态合并；`e4f5baa` 假服务；`f692390` 移动端；交接文档与验收材料位于最后一条提交。作者均为 `chaw1 <97000945@qq.com>`，未 push。
- 当前没有本任务服务常驻。复测时 `npm run test:e2e` 自动起停服务；手动演示按 README 的两个终端启动。数据/凭证、node_modules、dist、浏览器缓存均未提交。
- 后续验收：匹配 SDK 58 的 Expo Go 真机验证权限/相册/播放，再接同契约的真实后端；不扩大到前公司或其他 worktree。最终结论以 `FINAL.md` 为准。
