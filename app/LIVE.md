> **历史记录**（2026-10-21 00:19–01:01 的三轮联调）。最终验收以仓库 README「最终验收索引」为准：最新一次为 07:41–07:46 的 `screenshots-live/run-1/`，13/13 通过。

结论：最终 run-3 真实联调 13/13 通过（约7.5分钟，视频已实播）；run-2亦通过。局部改图质检未通过，不能视为效果达标，服务端待处理。
- 范围：390×844无头web → https://47.97.153.127:8443；正常TLS/CORS，health mock=false；未做iPhone实机安装/签名。
- 运行：2026-10-21 00:19–01:01（Asia/Shanghai，约41分钟，低于90分钟）；完整项目3/3，run-1失败后优先原项目续跑；不再新建第四轮。
- 验证：npm run verify五项通过，59/59测试；本地完整mock E2E通过1.6分钟；最终run-3无SSE错误、pageErrors=[]。
- App修复：长卡片使服务端错误提示滚出视口（旧版y=-433）；已固定在输入框上方。新增拒绝/显式重试单测及390×844视口回归；截图screenshots/35-provider-error-visible.png。

| 最终run-3步骤 | 耗时(s) | 结果 |
|---|---:|---|
| 注册新账号 | 2.60 | 通过 |
| 上传衬衫/牛仔裤/模特并建项目 | 4.18 | 通过 |
| 衣服分析、方向与全部预览解码 | 67.00 | 通过 |
| 选方向、生成脚本 | 5.37 | 通过 |
| 自由文本修改脚本 | 5.18 | 通过 |
| 确认脚本 | 2.14 | 通过 |
| 全部镜头、还原分、主动播报 | 87.31 | 通过 |
| 查看器袖口涂抹局部改（含定位/下载） | 124.92 | 任务完成，质检失败已显示 |
| 引用新图、自由文本点评 | 3.20 | 通过 |
| 选图并生成笔记 | 4.08 | 通过 |
| 预览成本与 AI 声明 | 0.99 | 通过 |
| 单独确认视频 | 3.07 | 通过 |
| 等待视频并静音实播 | 134.32 | 通过 |

- 实播证据：5.007秒视频，830×1108，currentTime=1.927秒，muted=true；笔记预览当时约¥4.15并显示AI声明。
- S1（服务端）：run-1 POST /api/projects/23329be6-51b0-4a29-b253-a9ec9312c4d7/messages，{"action":{"type":"choose_direction","direction_id":"direction-1"}}，两次HTTP200但SSE PROVIDER_ERROR“对话模型返回列表长度有误，圈选轨迹不能为空。”；state仍direction、chosen=null、script=null。原项目点第一个方向复现，新项目run-2/3成功。原文见run-1/sse-evidence.json、failure-02.json。
- S2（服务端）：run-2/3真实袖口涂抹edit任务均succeeded、还原分98，但edit_check.passed=false（袖口仍卷、未放平）；run-2自动58→92修复版亦报标签残留。见run-2/3的08-brush-cuff-result.png及evidence.json；按brushRequest原请求在原图局部改复现。未改server/、未SSH。
- 局部像素核验：run-2修改28,949/4,191,372像素，报告框外变化0；仅证明外接框外保持不变，未证明精确笔刷蒙版。见run-2/local-edit-pixels.json。
- 截图清单：最终run-3/共25张390×844，覆盖01–13及上传/衣服分析/历史/生成/主动播报/涂抹/引用/声明/视频补图；全部58张UI截图（含run-1失败、run-2完整流程）的准确路径、尺寸、SHA256见screenshots-live/manifest.json。
- 证据根目录：screenshots-live/；各run有http-evidence.json、sse-evidence.json、evidence.json、final-state.json；final-audit.json复核13步、镜头覆盖、引用顺序、成本声明、静音实播与截图尺寸。
- 续接：checkpoint.json与private/run-N.json为0600且Git忽略；run-1未决自由文本请求保留标记未重发。仅可不带LIVE_NEW_RUN续跑，已发动作先核状态/消息，不能自动重放；测试账号均live-前缀。
- 费用：三个项目state累计估算约¥13.81，最终均无活动任务；框架修复SSE finished/body无界等待，现按状态/持久消息等候并即时脱敏留证。
- 提交：9b20848修复错误提示；3da4d1a增加真实联调与断点保护。仅feat/app，作者chaw1 <97000945@qq.com>，不push、不合并；本报告与截图按全局规则留本地。
