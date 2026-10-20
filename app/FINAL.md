结论：第三轮 C1–C6 已完成本地验收，可交 Claude 复测；双指手势、原生键盘、触感与相册仍需真机验收。

- C1 完成：工作台、笔记预览及引用图点按进入全屏；左右滑图、双击/双指缩放、放大后平移；版本条沿 parent_id 家族排序并定位选中项；滑块对比、还原分、edit_check、AI生成角标齐全，关闭保留原页面。
- C2 完成：涂抹/框选、笔刷粗细、撤销/清空、移动工具、场景快捷说法及自由输入；提交严格二选一携带 mask_strokes 或 region；版本占位，完成自动对比。
- C2 验证：坐标考虑 contain 留白、缩放和平移；无头流程独立逆算首点；轮询换签名 URL 不丢缩放/选区；框选切移动后仍提交 region。
- C3 完成：查看器/长按菜单引用，输入框缩略图可移除；发送 refs，乐观消息与回读历史均显示引用，点开进查看器；笔记预览引用可返回工作台。
- C4 完成：长按菜单五项、关键操作触感；失败显示“可能没改到位：原因”和“再试一次/换个说法”；关闭重开重试保留原笔刷轨迹，同指令不同选区按对应结果恢复。
- C5 完成：mock 用本地 sharp 对选区作明显橙色处理，输出 PNG；测试验证框选/笔刷覆盖外像素不变；支持 refs、edit_check，首次用户局部改失败、后续重试通过，状态跨重启保存。
- C5 验证：无头 Chrome 390×844 完整流程 1/1 通过（约 1.7 分钟），新增 10 张截图，总计 34 张；含引用回读、菜单保存下载、预览引用往返、视频播放、401 和断网恢复；pageErrors=[]。
- C6 通过：Node v22.23.1 的 npm run verify 五项全绿，51/51 测试（含 13 项坐标/版本/重试匹配测试）、TypeScript、ESLint、iOS/Android 导出；iOS prebuild 成功。
- C6 实现：RNGH、Reanimated/worklets、SVG、expo-haptics 均按当前 Expo SDK 58 bundledNativeModules 版本；原生键盘出现时收起部分工具，深色查看器使用浅色状态栏。

复测：app/ 下使用 Node 22，npm ci；npm run verify；npm run test:e2e；npx expo prebuild --platform ios --no-install。
证据：verification/summary.json、同目录各检查日志、prebuild-ios.txt、e2e.txt；screenshots/evidence.json 含实际 mask/region/refs；verification/screenshots.json 含 34 张尺寸及 SHA256；contact-sheet.jpg 为总览。

与约定的出入：未修改 docs/设计.md 或 server/；客户端按第 8 节新增字段，无额外接口。mock 的像素着色与固定检查仅演示交互，不执行第 8.3 节的真实模型裁剪生成、羽化或语义审核。
已知问题：未连接真机或真实后端；双指并发、手势帧率、系统键盘遮挡、触感、相册授权/写入需在匹配 SDK 的 Expo Go 或本机包复测；无头鼠标手势与导出不代表真机通过。
已知问题：保存直接使用服务端文件；文件内可见水印与 AI 元数据标识未在本轮验证，mock 的 UI 角标不写入下载文件。真实媒体合规标识仍需服务端联调核验。

截图清单（screenshots/，以下均为 .png）：

- 01-register、02-projects-empty、03-new-project-uploaded、04-garments-and-directions、05-script-confirmation。
- 06-images-generating、07-images-ready、08-edit-image、09-image-new-version、10-selected-order。
- 11-note-card、12-note-preview、13-video-ready、14-video-playing、15-project-completed。
- 16-expired-session、17-network-error、18-network-recovered、19-direction-preview-generating、20-script-history。
- 21-fidelity-auto-fixed、22-script-restored、23-note-cost-and-ai-label、24-direction-preview-failed。
- 25-image-viewer、26-viewer-zoom、27-viewer-version-compare、28-viewer-brush、29-local-edit-result-compare。
- 30-reference-sent、31-image-longpress-menu、32-edit-check-failed、33-rectangle-edit-result、34-preview-reference。

提交：仅 feat/app；1f83dcb（契约/依赖/坐标/测试）、fe3a6f7（假服务），界面与验收材料见本文件所在提交；作者 chaw1 <97000945@qq.com>。
续接：先读 PROGRESS.md 和本文件，再核对代码与 verification/summary.json；无任务服务常驻。未 push、未合并、未调用真实模型、未读取钥匙串、未访问前公司环境、未开启模拟器或可见浏览器。
