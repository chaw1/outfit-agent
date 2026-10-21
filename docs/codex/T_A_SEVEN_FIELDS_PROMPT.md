# 任务 A：出图提示词对齐七字段结构

先读 `docs/codex/COMMON_RULES.md`。分支 `feat/prompt-seven-fields`，只动服务端。上限 60 分钟。

## 目标

把每一镜出图的提示词改成固定七段结构：**人物 / 服装 / 场景 / 光线 / 镜头 / 构图 / 姿势**，每段一句，顺序固定，段与段之间用「；」分隔，段名用中文冒号开头（如「人物：…；服装：…；场景：…」）。这是业内服装出图提示词增强的通用结构（人物、服装、场景、光线、镜头、构图、姿势七字段），面试时要能指着代码说「我们的提示词就是这个结构」。

现状：`server/app/workflow.py` 的出图节点（搜 `小红书穿搭摄影`）把模特身份、衣服描述、场景 / 动作 / 镜头、整套搭配、`expand_photo_prompt()`（`server/app/photography.py`）拼成一长串；改图节点（`_edit_image`）和封面锚点（`server/app/worker.py` 里追加「以最后一张封面参考图为锚点」）也往同一个 prompt 字符串上追加。

要做到：

1. 新建 `server/app/prompting.py`：`build_shot_prompt(...) -> str` 按七字段组装；输入是现有信息（有没有模特照、identity 文案、衣服描述、shot 的 scene / pose / camera / styling、风格摄影参数、参考图锚点文案）。每段内容来源：
   - 人物：有本人照片 → 「保持参考图中模特身份」+ 身材/风格偏好（博主档案里有就带）；没有 → 虚构模特描述（沿用现有文案）。
   - 服装：现有 `_garment_prompt` 的内容 + styling（已确认的整套搭配）。
   - 场景：shot.scene（+ 参考图的场景锚点，如果有）。
   - 光线：`expand_photo_prompt` 里的光线部分 + 参考图光线锚点。
   - 镜头：焦段 + shot.camera。
   - 构图：构图 + 画幅（3:4 竖版）+ 人物占画面比例。
   - 姿势：shot.pose + 瞬间感描述。
   - 末尾保留现有的硬性要求（吊牌 / 包装去除、真实皮肤质感、不要文字水印等），作为「要求：」段。
2. `expand_photo_prompt` 改成返回结构化字典（focal / light / composition / moment / texture 各自独立），由 `build_shot_prompt` 使用；保留旧函数名做兼容或更新所有调用点。
3. 改图 prompt 与封面锚点追加的文案保持可读：锚点作为「人物」段的补充句，不再简单字符串尾追加。
4. 任务 payload 里新增 `prompt_fields`（七段的字典），方便管理端和过程透明以后展示；`prompt` 字符串照旧存在。
5. 测试：`server/tests/test_prompting.py` 覆盖有 / 无模特照、有 / 无 styling、有 / 无参考锚点、封面锚点追加四种组合，断言七段顺序与关键内容；现有测试里对 prompt 片段的断言要继续通过（必要时按新结构更新断言，不降低覆盖）。
6. `docs/设计.md` 的出图小节追加一段「提示词七字段结构」，`docs/调研.md` 2.4 节末尾补一句「出图提示词已按七字段组织，见 server/app/prompting.py」。

## 验收（由验收方实测）
- ruff 零错误，pytest 全绿，新测试 ≥ 4 条。
- 任选一镜的 prompt 打印出来，肉眼能看到七段按顺序出现、没有重复句子。
- 交付摘要写到 `docs/codex/runs/t-a-final.txt`：改了哪些文件、prompt 示例一则、没做的部分。
