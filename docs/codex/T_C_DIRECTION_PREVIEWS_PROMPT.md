# 任务 C：每个方向出三张灵感图可选，选中那张成为封面基调

先读 `docs/codex/COMMON_RULES.md`。分支 `feat/direction-previews-3`。mock 端口 19341 / expo 19350。上限 90 分钟。

## 目标

现在每个穿搭方向只配 1 张预览图（`server/app/workflow.py` 的 `propose_directions` 节点出图任务 `purpose=preview`，`Direction.preview_url / preview_status`）。改成**每个方向 3 张**（同一方向、不同场景角度 / 构图），博主在方向卡上横滑挑一张，「就这个方向，按这张的感觉拍」——选中的那张作为封面基调：写脚本时把它的构图 / 光线描述带进第一镜，出封面时把它作为额外参考图（排在衣服之后、本人照片之前）。

## 要做到
1. 契约：`Direction` 新增 `previews: { id, url?, status, variant }[]`（variant 是这张的角度说明，如「全身街拍」「半身特写」「坐姿侧光」），保留 `preview_url / preview_status` 指向第一张以兼容旧 App。`choose_direction` 动作新增可选 `preview_id`。`docs/设计.md` 对应节追加。
2. 服务端：出预览图任务从每方向 1 条改成 3 条（同一去重键前缀 + variant），三张用同一方向描述、不同 variant 提示；预算估算与「换一组」的点数提示按 3 张算（`regenerate_estimate_*`）。选中 `preview_id` 后：写脚本节点把该预览的 variant 与画面描述写进 context；封面出图任务的 `reference_asset_ids` 追加该预览图资产，prompt 的构图 / 光线段引用它（如果任务 A 的七字段结构已合并就用它，没有就在现有 prompt 上加一句「构图与光线以灵感图为基调」）。
3. 点数：每方向 3 张意味着方向阶段多花两倍出图费；首页新建页的「一键出片预估」和方向卡的「换一组」提示都要按新数量计算。mock 服务端同步。
4. App：方向卡预览区改成横滑三张（`FlatList` horizontal 或 `ScrollView`），当前选中有描边；点大图可全屏看（复用 `InspirationWall` 的查看器样式即可）；确认按钮文案改为「按这张的感觉拍」。没选时默认第一张。生成中逐张出现，失败的那张显示重试。
5. 测试：服务端覆盖 3 张任务创建与去重、选中 preview_id 进入脚本 context 与封面参考；App 纯逻辑（选中态、默认第一张、失败重试键）加测试。
6. 文档：`docs/功能清单.md` 第 4 节「方向」两行更新。

## 验收（由验收方实测）
- 服务端 ruff + pytest 全绿；App tsc / lint / npm test 全绿。
- mock 栈截图两张放 `docs/codex/runs/t-c-shots/`：方向卡三张横滑（含选中态）、全屏看大图。
- 交付摘要写到 `docs/codex/runs/t-c-final.txt`：契约变更、点数变化、没做的部分。
