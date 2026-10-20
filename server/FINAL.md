# 服务端第三轮验收交接

结论：T1–T5 已实现并完成验证；170 项测试通过，真实塞腰成功、吊牌去除成功。袖口展开重试后仍未到位，已如实标注并主动播报。本轮 21 次真实调用估算 ¥3.078382；未连接服务器、未部署、未 push。

- T1：支持 region / mask_strokes，二选一；蒙版→扩边裁剪→裁剪块+原衣服参考→蒙版内羽化贴回。越界、空轨迹、NaN/布尔值、极小选区均中文拒绝，选区参与去重。
- T1 像素证据：真实袖口区域内改变 66,089 像素；蒙版外 4,125,252 像素中改变 **0**。框选、笔刷、多段轨迹、贴边、落盘均有逐像素测试；原角标区域受保护。
- T1 实图：`artifacts/real-fix2-original.png` → `artifacts/real-fix2-cuff.png`；全图对比 `artifacts/real-fix2-cuff-comparison.png`，细节对比 `artifacts/real-fix2-cuff-detail.png`。
- T2：整图、局部图都以 Qwen 对比前后图检查原指令，返回 image.edit_check；不通过加强指令纠正一次。队列重试与质量纠正共享最多 2 次图片请求，调用前加锁持久化计数，无递归修复。
- T2 真实塞腰：53.396s、2 次图片请求，最终 passed=true、还原分 92；目检裤腰线可见且下摆全部塞入。对比 `artifacts/real-fix2-tuck-comparison.png`。
- T2 真实袖口：59.359s、2 次图片请求，最终 passed=false；原因是卷边仍未展开。主动消息明确说明未完成，原图/新版均保留；核对不可用或重试失败也保留已付费图并诚实说明。
- T3：生成/编辑提示与还原质检明确排除吊牌、纸片、织标贴纸、价签、衣架和包装，不能转成徽章/布贴或要求补齐标签文字。
- T3 实测：首张暴露标签被当 logo 的问题，保留 `artifacts/real-fix2-initial-original.png`；加强规则后重新生成，目检胸前/裤腰无吊牌，还原分 98，质检明确“标签正确去除”。旧失败图复检 57 分，正确要求去除标签（`artifacts/tag-regression-fix2.json`）。
- T4：POST /messages.refs 校验当前项目成功正式图片；引用具体镜头、版本、还原分进入模型上下文；“这张袖口卷起来了，放下来”解析到引用图，精确引用旧版不会跳到最新版；GET /messages.refs 可读回，checkpoint 恢复保留。
- T5：最终全量 **170 passed / 26.92s**；ruff、diff 检查及 OpenAPI 比对通过。旧测试各文件断言数无减少，既有文件总断言 380→439；Alembic 空库与 refs 默认值迁移通过。
- T5 Mock e2e：**6.966s**，增加涂抹局部改和引用改图两步，4 原图+3 改图+笔记+视频成功；按真实指令/返回任务 ID 匹配，避免把自动还原版本当用户改图。
- T5 E1–E4：重启续聊 2.980s、重复确认去重 3.220s、越阶段拒绝 0.022s、脚本恢复 0.134s，全部 PASS；补充 HTTP 续跑 8 passed / 17.41s。

选型：采用设计 8.3 的本地裁剪与受限羽化，可直接证明外部像素一致；裁剪短边不足 240px 时上采样，原衣服在前、裁剪画布在最后，极端长宽比补上下文。
[万相官方文档](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)提供原生框选，未提供任意轨迹/外部像素一致承诺；本轮没有付费比较原生框选。
契约出入：无字段改名或删除；新增 Alembic 0003 的 messages.refs（历史默认 []）。羽化完全限于蒙版内，比“羽化带外一致”更严格；声明角标框内不允许改写。核对服务不可用时不盲目重生成，以 false+中文原因说明未确认。
已知问题：真实袖口展开仍未到位；看图评分有随机性，塞腰终图仍出现一条疑似标签痕迹的矛盾描述，目检未见可拆标签。结果检查不构成逐细节保证；失败会如实展示。

| 本轮真实模型 | 调用 | 累计秒 | 估算元 |
|---|---:|---:|---:|
| wan2.7-image-pro | 6 | 81.536 | 3.000000 |
| qwen3-vl-plus | 13 | 114.748 | 0.062667 |
| deepseek-flash | 2 | 2.886 | 0.015715 |
| 合计 | 21 | 199.170 | **3.078382** |
费用包含最初失败图、重生成、两项编辑各自的一次纠正和旧图复检；无视频调用。专属本机数据库 `outfit_fix2_20261020` 从零计费，累计预算闸 ¥8，低于本轮 ¥8 停止线/¥10 上限；最终扣费以供应商账单为准。

续接：真实证据 `artifacts/real-fix2-final.json`、`usage-fix2-final.json`；失败基线 `real-fix2-initial.json`。真实程序 `scripts/verify_edits.py` 只运行专属本机库，逐步存任务 ID，未知请求停止重提；三步续跑已验证新增模型调用为 0（`resume-real-fix2.json`），凭证仅钥匙串取出注入子进程环境。
复验：`docker compose up -d --build` → `REQUIRE_INTEGRATION=1 uv run pytest -q` → `uv run python scripts/e2e.py --mode mock` → `uv run python scripts/experiments.py`；按顺序运行，重启实验不能与 HTTP 测试并行。
证据日志：`evidence/fix2-tests-final.log`、`fix2-e2e-resume-tests-final.log`；Mock `artifacts/mock-fix2-final.json`、`experiments-fix2-final.json`、`assertions-fix2.json`；断点 `PROGRESS.md`（本地不提交）。一次补测误与重启实验重叠而断连，实验结束后顺序重跑 8 项全绿，未改断言掩盖。
当前 API/Worker 均验证 Mock 且模型凭证为空；媒体、证据与专属数据库保留供本机验收，仅 feat/server 本地中文单行提交，无 push/合并/部署。
