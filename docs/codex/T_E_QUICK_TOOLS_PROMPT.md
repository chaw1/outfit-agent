# 任务 E：查看器快捷动作（换背景 / 扩图 / 高清）与衣服标签筛选

先读 `docs/codex/COMMON_RULES.md`。分支 `feat/quick-tools`。mock 端口 19381 / expo 19390。上限 90 分钟。两件事独立，先 1 后 2。

## 1. 图片查看器三个快捷动作
现状：查看器里有「局部改」（涂抹 + 一句话）和「整体改」，都走 `edit_image` 动作 → `server/app/workflow.py::_edit_image` → 改图任务。目标是加三个一键动作，复用同一条链路、同一套核对与版本管理：
- **换背景**：弹一个小面板，预置 6 个场景（街角、咖啡馆窗边、白盒子展厅、海边傍晚、地铁站、纯色影棚）+ 自定义一句话；提交为 `edit_image`，`instruction` 为「只换背景为 …，人物、服装、姿势、光线方向保持不变」，并带 `preset: 'background'`。
- **扩图**：选择方向（上 / 下 / 左右 / 四周）；服务端把原图按方向加边（白边 + 原图居中）作为 `source_asset_id` 的派生图，`instruction` 为「补全画面边缘的场景，人物与服装不变」，带 `preset: 'outpaint'`；输出尺寸仍是 3:4。
- **高清**：`preset: 'upscale'`，服务端走出图模型的图生图重绘为 2 倍尺寸（如 provider 不支持，用 Pillow Lanczos 放大 + 轻锐化做兜底，并在任务结果里标 `upscale_method`）；不进核对（还原分沿用原版）。
- 三个动作的任务 payload 带 `preset`，过程透明里的工具名显示为「换背景 / 扩图 / 高清」；点数按一次改图算，提交前有预估确认（复用现有）。
- App：查看器工具条加三个 `ToolButton`，面板样式沿用 `ImageViewer` 里的局部改面板；版本条里新版本带小字「换背景」等。mock 服务端同步（返回占位图即可）。
- 测试：服务端覆盖三种 preset 的 instruction 组装、扩图加边尺寸、高清兜底；App 纯逻辑（预置场景文案、方向到参数）加测试。

## 2. 衣服标签与筛选
现状：衣服上传后看图模型已经出分析（`assets.analysis`：品类、颜色、面料、版型等），素材库「我的衣服」只有列表。目标：
- 服务端 `GET /api/me/assets?kind=garment` 每条带 `tags: string[]`（从 analysis 的品类 / 颜色 / 季节 / 风格抽 3–6 个短词，缺字段就少几个），并支持 `&tag=` 筛选；`GET /api/me/assets/tags?kind=garment` 返回标签及数量。
- App 素材库「我的衣服」顶部一排标签 chips（`Chip` 组件），点选筛选，再点取消；新建页「从我的衣服里选」同样可筛。
- mock 服务端同步。测试：标签抽取纯函数（服务端）、筛选逻辑（App）。

## 验收（由验收方实测）
- 服务端 ruff + pytest 全绿；App tsc / lint / npm test 全绿。
- mock 栈截图三张放 `docs/codex/runs/t-e-shots/`：换背景面板、版本条里的「扩图」新版本、衣服标签筛选。
- `docs/功能清单.md` 第 6、8 节各补行；`docs/设计.md` 对应节追加 `preset` 与标签接口。
- 交付摘要写到 `docs/codex/runs/t-e-final.txt`。
