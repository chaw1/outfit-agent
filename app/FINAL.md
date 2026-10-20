结论：第二轮 B1–B4 已完成本地验收，可交 Claude 复测；真机安装、签名和真实后端联调尚未执行。

- B1 通过：方向预览有排队/生成占位、成图和失败提示；图片显示还原分、自动修复说明及来源脚本；改图提供 4 个快捷说法。
- B1 通过：脚本卡及后续阶段可打开历史，发送 `restore_script` 恢复草稿并重新确认，已有图片保留；笔记预览显示成本和 `ai_label`。
- B1 通过：前台工作台每 3 秒拉 state，`last_message_id` 未同步时自动拉 messages；覆盖流中发现、最后任务完成、消息稍晚可见与前后台恢复。
- B2 通过：mock 补齐全部新字段、方向预览、54 分自动修到 92 分、主动播报去重、历史恢复/重新确认及固定成本；note/done 改图保留笔记、视频和待确认动作。
- B2 通过：无头 Chrome、390×844 完整流程通过，含恢复后保留旧图、快捷改图、选图排序、笔记复制/下载、视频实际播放、401 和断网恢复；24 张截图，页面异常为 0。
- B3 通过：默认 `https://47.97.153.127:8443`，设置仍可修改；衣序显示名、bundle、图标、启动页及相机/相册权限齐全；iOS prebuild 成功，生成目录未提交。
- B3 通过：README 包含免费 Apple ID、Personal Team、手机配对/信任、开发者模式、`run:ios --device --port 19300`、Release 演示和 7 天重装步骤。
- B4 通过：Node v22.23.1 执行 `npm run verify`，TypeScript、ESLint、35/35 测试、iOS/Android 导出全部通过；新增字段合并、消息标记刷新、脚本恢复均有单测/集成证据。

复测：在 app/ 使用 Node 22，执行 `npm ci`、`npm run verify`、`npm run test:e2e`；原生生成执行 `npx expo prebuild --platform ios --no-install`。
证据：`verification/summary.json` 及同目录日志、`verification/prebuild-ios.txt`、`verification/e2e.txt`、`screenshots/evidence.json`；总览 `verification/contact-sheet.jpg`。

与约定的出入：未修改设计及 server/；新增字段和 restore_script 均按第 7 节，预览任务复用 kind:image；客户端新增字段可选以兼容旧响应。mock checkpoint 为本地脚本快照，模拟 LangGraph 历史语义。
已知限制：mock 图片/视频复用 docs/spike 固定素材，还原分和成本是演示数据，不执行真实生成、评分或修复；任务由轮询请求推进并持久化主动消息。
已知限制：第 7.3 节真实媒体文件的水印/元数据由服务端提供，mock 素材未添加文件内标识；App 展示声明并直接保存服务端媒体，真实文件标识待联调核验。
已知限制：未访问真实 API、未连接 iPhone、未签名或验证原生相册/键盘/播放；prebuild 和导出不代表真机安装通过。

截图清单（均在 screenshots/，后缀 .png）：

- 01-register、02-projects-empty、03-new-project-uploaded、04-garments-and-directions、05-script-confirmation。
- 06-images-generating、07-images-ready、08-edit-image、09-image-new-version、10-selected-order。
- 11-note-card、12-note-preview、13-video-ready、14-video-playing、15-project-completed。
- 16-expired-session、17-network-error、18-network-recovered。
- 19-direction-preview-generating、20-script-history、21-fidelity-auto-fixed、22-script-restored、23-note-cost-and-ai-label、24-direction-preview-failed。

提交：feat/app；1d8963d（类型/同步）、ea373f2（假服务）、f7c2542（界面/端到端），配置与验收材料见最后一条提交；作者 chaw1 <97000945@qq.com>。
续接：先读 PROGRESS.md 和本文件，再核对代码；未 push、未合并 main、未调用真实模型、未读取钥匙串、未访问前公司环境、未开启模拟器或可见浏览器。
