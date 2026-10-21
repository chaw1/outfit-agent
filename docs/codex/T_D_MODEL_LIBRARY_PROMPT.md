# 任务 D：模特库一期，身份卡与多张参考，人像一致性低分自动重出

先读 `docs/codex/COMMON_RULES.md`，再完整读 `docs/规划-模特库与人像一致性.md` 第 1、3、4 节（一期）。分支 `feat/model-library`。mock 端口 19361 / expo 19370。上限 150 分钟。

## 目标

把「模特」做成一等资产：有模特表、有身份卡（正脸特写 / 全身 / 四分之三侧身 / 半身 + 一段文字身份描述），出图参考从「一张本人照」变成「一套身份卡」，人像一致性分低于 70 自动重出一版。预置 3 位「衣序模特」不上传照片也能出整组片。做到规划文档一期的 1–6 条，验收线也在那里。

## 要做到
1. **数据**：`models` 表（id、user_id 可空表示预置、name、kind：preset / own / generated / trained、status、identity_text、face_asset_id、sheet_asset_ids、created_at）+ Alembic 迁移；现有「我的形象」照片（`users.profile.model_asset_ids`）和「存为模特」的资产在首次读取时迁移成 kind = own / generated 的模特（一张照片一位模特，身份卡只有一张也允许，缺的角度标 missing）。`projects.model_asset_id` 保留，新增 `model_id`；两者都给时以 `model_id` 为准。
2. **预置模特**：`server/app/fixtures/models/` 放 3 位预置模特的身份卡图（用 mock provider 生成占位图即可，真实图由验收方替换；文件名固定 `preset-a-face.jpg` 等），启动时幂等写入 `models` 表，`identity_text` 写死三段中文描述。
3. **身份卡建卡**：`POST /api/me/models`（从若干本人照片建模特，name 可选）→ 任务队列里新建 `kind = identity` 任务：用看图模型写 identity_text（脸型、眉眼、鼻唇、肤色、发型发色、身高体态、年龄段），并用出图模型按参考图补缺的角度（最多 3 张，每张走现有计费）；`GET /api/me/models` 列表带状态；`DELETE /api/me/models/{id}`。花钱前要预估并由 App 确认（复用现有确认门禁模式）。
4. **出图参考改成一套**：出图任务 `reference_asset_ids` = 正脸 + 全身 +（有的话）侧身 + 这一镜衣服 +（非封面时）封面成片，顺序固定；prompt 的人物段带 identity_text。改图任务同样带正脸。
5. **低分自动重出**：`fidelity` 里 `person_score < 70` 时走 `_auto_fix` 同一条幂等路径再出一版，重出参考图加上「上一版里 person_score 最高的那张」；还原分规则不变；汇报文案把人像分写清楚。
6. **App**：新建页「出镜的人」改成模特选择器（三组：衣序模特 / 我的模特 / 本次上传），卡片显示正脸缩略图 + 名字 + 状态；设置页「我的形象」加「建身份卡」按钮（预估点数 → 确认 → 进度 → 完成）；素材库「我的模特」改读 `/api/me/models`。mock 服务端同步全部新接口。
7. **测试**：迁移幂等、预置写入幂等、建卡任务与计费、参考图顺序、低分重出幂等；App 纯逻辑（选择器分组、状态文案）加测试。
8. **文档**：`docs/设计.md` 追加「模特」一节（表、接口、任务）；`docs/功能清单.md` 第 3、8、9 节更新；`docs/规划-模特库与人像一致性.md` 一期末尾加「实现落点」小节列出文件。

## 验收（由验收方实测）
- 服务端 ruff + pytest 全绿，新测试 ≥ 8 条；App tsc / lint / npm test 全绿。
- mock 栈：不上传照片、选衣序模特 A，能从新建走到出图任务创建；设置页建身份卡流程走通。截图放 `docs/codex/runs/t-d-shots/`。
- 交付摘要写到 `docs/codex/runs/t-d-final.txt`：表结构、接口、迁移说明、没做的部分。时间不够时优先级：1 → 4 → 5 → 6 → 2 → 3。
