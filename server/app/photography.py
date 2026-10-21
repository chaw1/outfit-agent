"""Deterministic photography direction; no extra model calls or garment edits."""

# Focal length, light, composition, candid moment and texture for the shared tags.
STYLE_PHOTOGRAPHY = {
    "松弛通勤": ("35mm", "树荫下自然散射光", "不居中的街景三分构图",
               "走动中整理衣角，不看镜头", "轻微动态模糊、清淡胶片颗粒"),
    "老钱极简": ("50mm", "窗边柔和侧光", "留白的半身裁切、偏心构图",
               "低头整理袖口的瞬间", "低饱和细颗粒、哑光层次"),
    "法式慵懒": ("50mm", "午后窗光与柔和逆光", "门框前景遮挡、不对称留白",
               "倚窗拨开头发，视线离开镜头", "温暖胶片颗粒、柔和高光"),
    "街头胶片": ("35mm", "街道自然光", "低角度、路人前景遮挡、不居中",
               "过街回头的抓拍瞬间", "明显胶片颗粒、轻微动态模糊"),
    "杂志大片": ("50mm", "有方向的自然侧逆光", "大胆半身裁切、非对称杂志构图",
               "转身时衣摆摆动，不直视镜头", "真实皮肤纹理、细颗粒和明暗层次"),
    "咖啡馆午后": ("50mm", "咖啡馆窗光", "桌沿前景遮挡、侧面半身裁切",
                 "端起杯子时看向窗外", "暖色细颗粒、自然高光过渡"),
    "闪光灯夜拍": ("35mm", "夜间直闪，保留暗处环境光", "近距离偏心构图、低角度",
                 "边走边转头的突然一瞬", "闪光高反差、胶片颗粒与轻微拖影"),
    "复古港风": ("50mm", "霓虹环境光与侧面直闪", "招牌前景遮挡、不对称半身裁切",
               "街边转身整理头发，不看镜头", "暖红复古胶片颗粒、轻微运动拖影"),
    "户外野餐": ("35mm", "树叶间透下的自然逆光", "草叶前景遮挡、低机位三分构图",
               "俯身铺野餐布，衣角随风摆动", "清透绿色、柔和胶片颗粒"),
    "美术馆漫步": ("50mm", "美术馆天窗漫射光", "建筑线条留白、人物不居中",
                 "从作品前走过的侧身瞬间", "低饱和细颗粒、真实织物层次"),
    "雨天街角": ("35mm", "阴雨天自然柔光与路面反光", "雨伞边缘前景遮挡、偏心街景",
               "避开水洼时迈步，不看镜头", "湿润反光、冷调胶片颗粒和轻微动态模糊"),
    "运动机能": ("35mm", "户外侧逆光", "低角度、非对称全身构图",
               "迈步起跑或调整背包带的瞬间", "清晰面料纹理、轻微运动模糊与细颗粒"),
}
DEFAULT_PHOTOGRAPHY = (
    "35mm（细节镜头用 50mm）", "自然光或窗边侧光", "不居中、半身裁切或低角度、前景遮挡",
    "走动或整理衣角的抓拍瞬间，不看镜头", "胶片颗粒、轻微动态模糊",
)
NEGATIVES = "不要棚拍白底、不要对称居中、不要塑料感皮肤。"


def expand_photo_prompt(shot: dict, style_tags: list[str], references: list[dict]) -> str:
    matched = [(tag, STYLE_PHOTOGRAPHY[tag]) for tag in style_tags if tag in STYLE_PHOTOGRAPHY]
    focal, light, composition, moment, texture = (
        matched[0][1] if matched else DEFAULT_PHOTOGRAPHY
    )
    anchors = []
    # The first reference with each actual analysis field is the anchor; an
    # unspecified field may still use style language, rather than invent a fact.
    for field, label in (("lighting", "光线"), ("composition", "构图")):
        reference = next(((index, item[field]) for index, item in enumerate(references, 1)
                          if item.get(field)), None)
        if reference:
            index, value = reference
            anchors.append(f"参考图{index}{label}：{value}")
            if field == "lighting":
                light = value
            else:
                composition = value
    anchor_text = (
        "参考图的构图与光线为最高优先锚点：" + "；".join(anchors)
        + "。风格词仅补充质感，不覆盖参考锚点。"
        if anchors else ""
    )
    style_text = ""
    if matched:
        style_text = f"主风格：{matched[0][0]}。"
        if len(matched) > 1:
            style_text += "辅助风格仅补充质感：" + "；".join(
                f"{tag}（{language[4]}）" for tag, language in matched[1:]
            ) + "。"
    original = "；".join(str(shot[key]) for key in ("scene", "pose", "camera") if shot.get(key))
    return (
        f"摄影脚本：{anchor_text}{style_text}焦段：{focal}；光线：{light}；"
        f"构图：{composition}；瞬间：{moment}；质感：{texture}、真实皮肤纹理、不磨皮。"
        f"镜头原意：{original}。{NEGATIVES}"
    )
