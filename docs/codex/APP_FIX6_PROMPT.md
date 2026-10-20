# /goal：App 第七轮——参考图槽位、封面锚点与一致性角标

服务端第七轮按 `docs/设计.md` 第 12 节实现：建项目可带 ≤ 3 张参考图（`reference_asset_ids`）、`references` 卡片、`image.anchor_id`、`fidelity.person_score / anchor_score`、主动播报带一致性摘要。App 侧照 **第 12 节** 做：新建项目加"参考图（选填）"槽位（最多 3 张，`kind=reference` 上传）；工作台显示参考图卡（风格标签）；图片角标加"人像 92"（有 `person_score` 时）；查看器信息区显示"以封面为锚点"（有 `anchor_id` 时）；主动播报原样显示。先在本地假服务实现同样字段；真实服务没有这些字段时相应 UI 隐藏，旧功能不能坏。视觉沿用现有 token 和组件。

## 成功标准（Claude 会自己复测，不信自报）

- **W1** 新建项目能选 0–3 张参考图并随项目创建发出；工作台有参考图卡；没有参考图时不出现。
- **W2** 角标与锚点信息在假服务全流程可见；字段缺失时隐藏。
- **W3** `npm run verify` 全绿，E2E 通过并补截图（继续编号），`npx expo prebuild --platform ios` 通过；不新增原生依赖。

## 硬护栏

1. 只在本 worktree 的 `feat/app` 分支提交；中文一行 commit，作者 `chaw1 <97000945@qq.com>`；不加任何 AI 署名；不 push，不合并 main。
2. 不调用线上服务；全程本地假服务。不读钥匙串。
3. 只改 `/Users/jiawei/Projects/jiawei-personal/outfit-agent-wt-app`；不改 `server/`、`docs/设计.md`；`app/ios/` 不提交。
4. 不弹窗、不出声。
5. 墙钟上限 1 小时；保持断点可续。

## 交付

`app/FINAL.md` 覆盖重写（≤ 25 行，先写结论）：W1–W3 逐条结论与证据、截图清单、已知限制。
