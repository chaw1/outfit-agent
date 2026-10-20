结论：T1–T5 已通过；292 项测试、ruff、Mock 闭环与 E1–E4 全过；真实累计保守计费 1.159020 元。仅本地实现与验证，未推送、合并或部署。

- T1：对话与 Worker 主动消息带 trace；SSE 在 done 前发 trace，GET 读回一致；checkpoint 恢复保留 trace 和重写内容。调用按本轮 ledger_ids / 任务 job_id 隔离，含失败预留、质检与自动修复。
  证据：[HTTP](tests/test_trace_http.py)、[Worker 与恢复](tests/test_worker_trace.py)、[真实对话 trace 对账](evidence/trace-real-diagnostic/trace-real.json)。
- T2：脚本预估 = 镜头数 × 0.50 × 1.20；5 秒视频 = 1.50 元；与图片/视频账本共用 costs.py。budget 四字段与 /me、管理层级及上海自然日账本同源。
  证据：[预算与日界测试](tests/test_trace_budget.py)、[共享单价](app/costs.py)、[HTTP 回读](tests/test_trace_http.py)。
- T3：Mock 与真实均由模型选 propose_directions；新方向新 id、新预览。真实保留“要通勤”和平底鞋，给出地铁入口与办公室两个新场景，实际生成两张不同预览。
  证据：[方向测试](tests/test_direction_refresh.py)、[真实回复/预览路径/人工目检](evidence/trace-real-diagnostic/trace-real.json)；刷新含首次失败预留共 1.158010 元，≤1.50 元。
- T4：regenerate_reply 只调用文字模型，同 id 覆盖，无新增消息/任务，卡片和领域状态保留；付费轮次中文拒绝，跨项目拒绝；重写后可正常继续确认/改脚本。
  证据：[独立审查](tests/test_trace_review.py)、[无工具请求与文字账本](tests/test_regenerate_provider.py)、[HTTP](tests/test_trace_http.py)。真实文字重写 0.001010 元，新增图片费用为 0。
- T5：292 passed / 39.85s，无 skip；ruff、Mock e2e、E1–E4 全过；0008 空库/旧数据迁移通过。旧 20 路径、44 schema 及全部旧属性保留，OpenAPI 与运行服务一致。
  证据：[pytest](evidence/trace-pytest-final.log)、[ruff](evidence/trace-ruff.log)、[闭环](artifacts/trace/mock-e2e.json)、[E1–E4](artifacts/trace/experiments.json)、[OpenAPI](artifacts/trace/openapi-check.json)。
  API/Worker 源码匹配本 checkout，保持 Mock、无模型 key、管理端关闭：[源清单](artifacts/trace/source-manifest.json)。

本轮账本：2 张图 1.000000 + 成功方向文字 0.008010 + 重写文字 0.001010 + 首次文字 JSON 解析失败保留 0.150000 = 1.159020 元（上限 2 元）；共 5 次调用，无真实看图/视频。
[费用汇总](artifacts/trace/usage-summary.json)；[首次失败断点](evidence/trace-real/trace-real.json)未改动或重提；诊断实验另存，所有失败费用均保留计入。
[验收脚本](scripts/verify_trace.py)用 business.sqlite + calls.sqlite 保存结果与账本，成功结果复用、未知 started 禁止重提；[禁用 HTTP 后续跑](evidence/trace-real-resume.log)确认 0 新调用。
限制：旧历史消息 trace=null / can_regenerate=false；报价不含另计的文字/看图费用；真实预览第 2 张偏衣服静物，未充分呈现上身搭配；首次无效 JSON 未自动重试。
Worker trace 是发布时账本快照；极端租约过期后，已发出的上游调用无法撤回，迟到调用可能晚于失败通知入账。常规完成与失败重试已按任务准确归集。
断点与完整执行记录保留于 [PROGRESS](PROGRESS.md)；证据目录和原始图片留本地供复测，不提交凭证。按本文件与设计第 11 节验收，无需启动新付费实验。
实现提交：`08ad3ab`，`feat/server`，作者 `chaw1 <97000945@qq.com>`；交接文件单独提交。
