结论：R1–R4 通过；真实调用估算 ¥2.569708，未超预算。实现提交 a7739d1（feat/server），未 push、合并或部署。

- **R1 参考图：通过。** ≤3 张、本人上传与 kind 校验；五维风格进入 brief、方向、脚本、预览和正式出图，references 卡可持久化并刷新签名 URL。
  证据：`tests/test_references.py`、`tests/test_anchor_reference_providers.py`；真实方向/风格分析 `evidence/anchor-real/anchor-real.json`。
  真实对比图：`evidence/anchor-real/reference-comparison.png`（左：原创霓虹参考；中：无参考的日间室内；右：参考后的霓虹街景）。R1 ¥1.024228 < ¥2。
- **R2 封面锚点：通过。** 首镜先生成；成功后其余镜头可并行领取，完整传入衣服/本人/封面，anchor_id 为实际图片 ID；封面终态失败回退，无重复付费。
  Mock 顺序/payload/双 Worker 并发/重启/失败回退/封面自动修复证据：`tests/test_anchor_worker.py`；局部编辑保持裁剪画布最后及蒙版外像素不变。
  真实三镜头：`evidence/anchor-real/anchor-three-shots.png`；目检同一人物、妆发、服装及蓝青霓虹氛围，第二镜头为近景侧面；R2 ¥1.545480 < ¥2。
- **R3 一致性分：通过。** 看图模型实际读取本人和封面，person_score 为 98/98/98，后两镜 anchor_score 为 92/92；没有对应参考时字段省略。
  主动消息已播报“人像一致性 98 分，封面一致性 92 分”；评分、任务引用、通知及 trace 见 `evidence/anchor-real/anchor-real.json`。
- **R4 回归：通过。** 全量 358 passed/42.53s，无 skip；ruff、diff 检查通过。日志：`evidence/anchor-pytest-final.log`、`evidence/anchor-ruff.log`。
  Mock 闭环 7.177s：`artifacts/anchor/mock-e2e-final.json`；E1–E4 全过（3.552/2.289/0.031/0.161s）：`artifacts/anchor/experiments-final.json`。
  旧20路径、48 schema、196旧属性均保留且 live OpenAPI 一致：`artifacts/anchor/openapi-check.json`；无参考/本人照片的缺省行为有专项测试。
  API/Worker 的35个源码文件与 checkout 一致，mock=true、管理端关闭、无模型密钥：`artifacts/anchor/source-manifest.json`。

费用：5 图 ¥2.50 + 4 文本/5 看图 ¥0.069708 = ¥2.569708；14 次全部成功，无失败/未知预留、自动修复或视频调用。明细：`artifacts/anchor/usage-summary.json`。
断点：`PROGRESS.md`、`evidence/anchor-real/{config.json,calls.sqlite,business.sqlite,anchor-real.json}`；真实结果固定同目录，started 未知结果拒绝重提，不清账本。
零新增费用复验：`uv run python scripts/verify_anchor.py --run --offline`；已禁止网络重放，账本仍14行，日志 `evidence/anchor-real-resume.log`。
限制：参考为脚本原创插画式夜街，成品相应图形化；本次三镜头顺序执行以限制保守费用预留，并行性由真实 PostgreSQL Mock 双 Worker 测试验证。
分数是模型判断，单组目检不代表总体成功率；费用为服务端估算，以供应商账单为准。证据和媒体按现有忽略规则留在本 worktree。
