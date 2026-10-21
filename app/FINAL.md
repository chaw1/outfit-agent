结论：W1–W3 均通过本地验收，可交复测；只用本地假服务，未联线上或验收真机。

- W1 通过：新建支持0/1/2/3张参考图，kind=reference上传；超额截断、满3禁用、删除补选；reference_asset_ids随创建发送；工作台全阶段保留风格标签卡，无参考时隐藏。E2E前3项及完整流程、截图65–68。
- W2 通过：卡片/查看器显示“人像 92”（0分同样显示），有anchor_id显示“以封面为锚点”；切图与缺字段隐藏；主动一致性播报原样显示，刷新可恢复。截图69–76及round7-evidence.json。
- W3 通过：Node v22.23.1；npm run verify五项全绿（110/110单测、类型、lint、iOS/Android导出）；完整E2E 10/10（251.9秒，0失败/跳过/不稳定），第七轮定向4/4；npx expo prebuild --platform ios含CocoaPods成功；无新增依赖。

证据目录：verification/fix6/，含summary.json、verify.txt、各项日志、e2e.txt/json、e2e-round7.txt/json、round7-evidence.json、prebuild-ios.txt及final-audit.json。
新增截图12张：65–75均390×844，76为320×844；全部目视通过，尺寸/SHA256见screenshots.json，总览contact-sheet.jpg（均在证据目录）。
截图清单（screenshots/，均.png）：
- 65-new-project-optional-references、66-references-three-limit、67-references-remove-and-replace、68-references-style-card。
- 69-person-fidelity-badge、70-viewer-person-and-cover-anchor、71-proactive-consistency-summary、72-consistency-history-restored。
- 73-legacy-reference-and-person-fields-hidden、74-legacy-viewer-consistency-hidden、75-zero-person-score-is-visible、76-narrow-screen-badges-and-selection。

假服务口径：有本人照或参考图时先封面后其余镜头，失败回退；编辑/自动修复继承锚点；无两者沿用旧并行。归属、上限、重启恢复与无字段旧行为均有契约测试。
已知限制：示例图、风格标签与92/94分是固定演示值，不代表模型质量；相同参考素材的替换由asset ID及请求断言证明。真实服务、原生相册/权限/手势仍需个人环境复测。
范围：仅feat/app本worktree；未改server/、设计或依赖，ios/忽略未提交，未访问线上/前公司/钥匙串，未push/合并；本地服务均已退出。
保留：原148份截图/证据文件和6份验证文件按字节恢复，既有联调run-1/run-2未动；本轮日志/JSON/总览留本地。
续接：先读PROGRESS.md；Node22执行npm run verify、npm run test:e2e、CI=1 BROWSER=none npx expo prebuild --platform ios；禁止test:live。
提交：d8d81f2（契约）、277fe78（界面）；回归/截图/本文在最终提交，作者chaw1 <97000945@qq.com>，中文一行。
