"""Seven ordered fields shared by shot generation, edits and cover anchors."""

import re

from app.photography import NEGATIVES, expand_photo_prompt

PROMPT_FIELDS = ("人物", "服装", "场景", "光线", "镜头", "构图", "姿势")
COVER_ANCHOR = (
    "以最后一张封面参考图为锚点，保持同一人、同一妆发与同一光线氛围，"
    "服装仍严格遵循原衣服参考图"
)
HARD_REQUIREMENTS = (
    "吊牌、价签、织标贴纸、衣架、包装袋不属于衣服，必须忽略并从成品画面去除。"
    "不要文字水印。" + NEGATIVES
)


def _sentence(*parts: str) -> str:
    """Keep user text inside its field and emit one sentence without repeated clauses."""
    clauses = []
    for part in parts:
        for clause in re.split(r"[；;。！？!?\n]+", part):
            clause = clause.strip(" ，,")
            if clause and clause not in clauses:
                clauses.append(clause)
    return "，".join(clauses) + "。"


def build_shot_fields(
    *, shot: dict, garment_prompt: str, has_model_photo: bool = False,
    identity: str = "", profile: dict | None = None, photo: dict | None = None,
    style_tags: list[str] | None = None, references: list[dict] | None = None,
    identity_anchor: str = "",
) -> dict[str, str]:
    profile, references = profile or {}, references or []
    photo = photo or expand_photo_prompt(shot, style_tags or [], references)
    person = identity or (
        "保持参考图中模特身份" if has_model_photo
        else "使用成年虚构模特：东亚面孔、小红书博主气质，自然妆容"
    )
    preferences = [str(profile[key]) for key in ("body_notes", "style_notes") if profile.get(key)]
    if profile.get("height_cm"):
        preferences.insert(0, f"身高{profile['height_cm']}cm")
    scene_anchors = []
    for index, reference in enumerate(references, 1):
        for field, label in (("scene", "场景"), ("mood", "氛围"), ("palette", "配色")):
            if reference.get(field):
                scene_anchors.append(f"参考图{index}{label}：{reference[field]}")
        if reference.get("style_tags"):
            scene_anchors.append(f"参考图{index}风格：" + "、".join(reference["style_tags"]))
    styling = f"整套搭配（已确认）：{shot['styling']}" if shot.get("styling") else ""
    return {
        "人物": _sentence("小红书穿搭摄影", person, *preferences, identity_anchor),
        "服装": _sentence(garment_prompt, styling),
        "场景": _sentence(shot.get("scene") or "沿用参考画面的场景", *scene_anchors),
        "光线": _sentence(photo["light"]),
        "镜头": _sentence(f"焦段：{photo['focal']}", shot.get("camera") or "自然视角"),
        "构图": _sentence(photo["composition"], "3:4 竖版，人物占画面约三分之二"),
        "姿势": _sentence(shot.get("pose", ""), f"瞬间：{photo['moment']}"),
    }


def build_shot_prompt(
    fields: dict[str, str] | None = None, *, requirements: str = "", **kwargs,
) -> str:
    fields = fields if fields is not None else build_shot_fields(**kwargs)
    photo = kwargs.get("photo") or expand_photo_prompt(
        kwargs.get("shot", {}), kwargs.get("style_tags") or [], kwargs.get("references") or [],
    )
    return "；".join(f"{name}：{fields[name]}" for name in PROMPT_FIELDS) + (
        f"；要求：{HARD_REQUIREMENTS}质感：{_sentence(photo['texture'])}"
        + (_sentence(requirements) if requirements else "")
    )


def attach_identity_anchor(payload: dict, anchor: str = COVER_ANCHOR) -> dict:
    """Return prompt updates without mutating the saved queue payload on retries."""
    fields = payload.get("prompt_fields")
    if not fields or not all(name in fields for name in PROMPT_FIELDS):
        # Jobs queued before seven-field prompts retain their original instructions.
        return {"prompt": f"人物：{_sentence(anchor)}；{payload.get('prompt', '')}"}
    fields = {name: fields[name] for name in PROMPT_FIELDS}
    if _sentence(anchor).rstrip("。") not in fields["人物"]:
        fields["人物"] = _sentence(fields["人物"], anchor)
    requirements = str(payload["prompt"]).partition("；要求：")[2]
    prompt = "；".join(f"{name}：{fields[name]}" for name in PROMPT_FIELDS)
    return {"prompt_fields": fields, "prompt": f"{prompt}；要求：{requirements}"}
