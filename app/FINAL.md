结论：本轮功能已实现，规定的本地检查通过，可交复测；原生通知、相册和系统分享仍待真机验收。

- P1 完成：多张本人照片、设默认/移除、昵称/身高/体型/偏好保存，新建项目默认带档案照片并可换；旧字段、GET/PATCH 404 优雅降级。证据：product.spec.ts、profile-projects.test.ts、mock-server.test.ts，截图 39、40、43。
- P2 完成：标题/品牌搜索、下拉/按钮刷新、阶段/封面、长按/按钮删除及二次确认；取消后可正常打开，删除后列表消失且 project/state/messages 均 404。证据：product-evidence.json，截图 41、42；mock 级联清理任务/生成文件，保留上传原图。
- P3 完成：准备发布依次复制文案、按清单保存全图、保存视频、打开系统分享；逐项清单与声明确认；首个失败暂停，仅继续未完成项，重开/刷新保留媒体断点。证据：publish.test.ts、workflow.spec.ts、evidence.json，截图 48–51。
- P4 实现并通过逻辑验证：图片批次/自动修复/改图/视频分组完成、持久化去重、账号/服务器隔离、后台静音通知、点按项目路由、前台提示、拒绝权限静默；6 项通知引擎测试及截图 52。没有冒充真机通知验收。
- P5 完成：查看器/缩略图/预览去掉重复角标；差异点两行折叠/展开；长按复制；明确失败消息可重发且先核对历史；最后安全回复可换说法；三屏首次引导与关于/版本/隐私。证据：conversation.test.ts、两份 E2E，截图 36–38、43–47；连续两次拒绝仍只有一个重发项。
- P6 通过：Node v22.23.1，npm run verify 五项全绿（93/93 测试、类型、lint、iOS/Android 导出）；npm run test:e2e 2/2 通过（约 1.9 分钟，pageErrors=[]）；npx expo prebuild --platform ios 含 CocoaPods 安装成功。

证据：verification/summary.json 与同目录检查日志；e2e.txt；prebuild-ios.txt、prebuild-ios-full.txt；screenshots/evidence.json、product-evidence.json。
截图：55 张均 390×844，尺寸/SHA256 见 verification/screenshots.json；全部与新增总览为 contact-sheet.jpg、contact-sheet-new.jpg，新增 20 张已目视。
新增截图（screenshots/，均 .png，沿用已有 35 之后编号）：
- 36-onboarding-1、37-onboarding-2、38-onboarding-3、39-profile-photos-default、40-new-project-default-profile、41-project-search-brand。
- 42-project-delete-confirmation、42-project-delete-completed、43-about-privacy、43-profile-patch-404、43-profile-old-fields。
- 44-safe-rephrase、45-message-copy-menu、46-failed-message-retry、47-fidelity-diffs-expanded、48-publish-partial-retry、49-publish-checklist-ready。
- 50-publish-video-saved、51-publish-resumed-no-duplicates、52-foreground-generation-notice。

原生依赖：expo-notifications ~58.1.5、expo-background-task ~58.0.11、expo-task-manager ~58.0.12、AsyncStorage 2.2.0，按 SDK 58 版本安装；分享复用 React Native Share。
权限：app.json 配置通知/后台任务插件、Android POST_NOTIFICATIONS 与照片/视频读取、相册读取/保存中文文案；iOS 后台标识与 processing 模式已由插件生成；ios/ 未提交。
未定部分的实现理由：档案只约定资产 ID，因此本机缓存预览，换设备暂无预览时仍能选 ID/重新上传；PATCH height_cm:null 清空选填身高。
未定部分的实现理由：增加可选 can_regenerate 与 regenerate_reply，仅服务明确认定原轮未建生成任务才显示，旧服务无标记隐藏；同 ID 只改文字，不重跑工具、不增费用。
发布边界：系统分享发送文案，素材已入相册；用户在目标平台按清单选媒体、勾声明。已保存后改顺序会提醒在平台重排，不重复下载。
原生边界：后台检查使用 15 分钟调度提示，实际由系统决定，无法保证挂起后立即通知或被杀后通知；通知授权/点按、相册顺序/视频写入和原生分享需在本机安装包复测。
其他限制：未连接真实后端；mock 用固定素材/像素修改模拟，不验证真实媒体烧录标识；发送结果不明时只核对历史，不自动重放可能付费的请求。

续接：先读 PROGRESS.md、本文件与 README；全部本地服务已退出。代码提交 2871318、0dc92b0、02d8fc2；验收材料在本文件所在提交，仅 feat/app，未 push/合并；未改 server/、设计约定或其他 worktree，未读钥匙串、未调用真实付费接口、未访问前公司环境。
