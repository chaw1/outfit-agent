# 任务 B：封面「主图」角标、片场重命名与置顶、过程透明的参考图缩略图

先读 `docs/codex/COMMON_RULES.md`。分支 `feat/app-polish-3`。mock 端口 19321 / expo 19330。上限 75 分钟。三件事独立，按顺序做，每件一个提交。

## 1. 封面标「主图」并锁定顺序（App）
- 出图卡与图片查看器里，封面那张（`anchor_id` 指向它，或 shot 为脚本第一镜且 version 最新被采用）显示「主图」角标（`Badge`，tone brand），其余不显示。
- 笔记预览的图片顺序里，主图固定在第一位，不能被拖到后面（可以换成同一镜的新版本）。
- 纯函数 `isCoverImage(image, images, script)` 放 `app/src/lib/images.ts`（或已有的图片工具文件），加测试。

## 2. 片场长按菜单加「重命名」「置顶」（服务端 + App）
- 服务端：`PATCH /api/projects/{id}` 接受 `{ title?: string, pinned?: boolean }`，title 1–40 字，只能改自己的项目；`Project` 加 `pinned` 列（Alembic 迁移），`GET /api/projects` 返回 `pinned` 并把置顶的排在最前（其余顺序不变）。测试覆盖越权、长度、排序。
- mock 服务端同步。
- App：首页项目卡长按现在只有删除确认；改成一个小菜单：重命名（弹输入框，预填当前名）、置顶 / 取消置顶、删除（保留二次确认）。置顶的卡右上角一个图钉图标。`api/client.ts` 加 `patchProject`。
- 列表排序逻辑（置顶优先 + 现有规则）放 `app/src/lib/projectProgress.ts`，加测试。

## 3. 过程透明栏显示用了哪几张参考图（服务端 + App）
- 服务端 `MessageTrace` 加 `reference_images?: { id, url, role }[]`（role：模特 / 衣服 / 参考图 / 封面锚点），出图与改图回复的 trace 里填上，用现有签名链接。`docs/设计.md` 对应节追加字段说明。
- App `MessageTrace.tsx` 展开时在分步列表上方横排这些缩略图（56 宽，`previewUrl(url, 360)`），带角色小字；没有就不显示。
- mock 服务端同步。

## 验收（由验收方实测）
- 服务端 ruff + pytest 全绿；App tsc / lint / npm test 全绿。
- mock 栈截图三张放 `docs/codex/runs/t-b-shots/`：主图角标、长按菜单（含置顶后的列表）、展开的过程透明栏。
- `docs/功能清单.md` 第 2、4、6 节各补一行。
- 交付摘要写到 `docs/codex/runs/t-b-final.txt`。
