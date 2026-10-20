结论：Q1–Q5 均通过本地验收，可交复测；全程只用假服务，真机原生体验尚未验收。

- Q1 通过：全流程 9 条智能体消息显示能力/耗时/费用，可展开模型与分步；缺 trace 隐藏。SSE 重写在 GET 503 下仍同 ID 更新，断流后同 ID 历史恢复，无重复消息；截图 53、56、64。
- Q2 通过：出图估价 ¥4.32、视频 ¥1.50 与 state 一致；余额 ¥0.10 时两类确认均禁用并中文提示；缺字段隐藏且保留旧确认。假服务余额扣排队预留，成功费用与账本一致；截图 55、57–60。
- Q3 通过：“换一组”发送“换一组方向，保留我刚才说的偏好”，同 card.id 单实例覆盖，保留偏好并显示新方向预览；截图 54。
- Q4 通过：标题 20 字计数、正文编辑、话题增删、声明默认勾选、图片调序；草稿保存后刷新恢复全部编辑与声明状态；复制/分享及图片保存顺序使用编辑值；截图 61–63。
- Q5 通过：Node v22.23.1，npm run verify 五项全绿（105/105 测试、类型、lint、iOS/Android 导出）；全套 E2E 6/6（3.3 分钟），最终边界复跑 3/3（44.9 秒，pageErrors=[]）；npx expo prebuild --platform ios 含 CocoaPods 成功。

证据：verification/fix5/summary.json、verify.txt、各项检查日志、e2e.txt/json、e2e-round6.txt/json、round6-evidence.json、prebuild-ios.txt、final-audit.json。
截图共新增 12 张，均 390×844，已目视复核；尺寸/SHA256 见 verification/fix5/screenshots.json，总览 contact-sheet.jpg。
截图清单（screenshots/，均 .png）：
- 53-agent-trace-expanded、54-regenerated-directions-preview、55-script-estimate-and-budget。
- 56-same-id-rewrite-stream-trace、57-video-estimate-and-budget、58-script-insufficient-budget。
- 59-legacy-fields-hidden、60-video-insufficient-budget、61-note-form-draft-saved。
- 62-note-draft-restored、63-edited-note-publish-ready、64-same-id-disconnect-recovered。

实现口径：编辑只在本地覆盖发布内容，不回写服务端；草稿需点保存，按服务/账号/项目隔离，不跨设备同步。声明勾选不会代替目标平台设置。
已知限制：未接真实后端；假服务 trace 耗时与费用用于演示，不验证真实模型计费。手机键盘、相册、系统分享、通知与原生手势仍需个人真机复测。
范围：未新增依赖，未改 server/ 或设计约定；ios/ 未提交。原有四份验证日志与全部旧截图按字节保留，已有 screenshots-live/run-1、run-2 未动。
续接：先读 PROGRESS.md；本轮日志/JSON/总览留本地，源码、正式文档和新增截图提交。Playwright、Metro、假服务均已退出。
提交：d9f8373、8371b5b、dc01c3f、f332cb8；验收资料在最终提交。仅 feat/app，中文一行，作者 chaw1 <97000945@qq.com>，未 push/合并。
