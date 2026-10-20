#!/usr/bin/env python3
"""Independent, predeclared tool-selection cases; no image/video side effects."""

import argparse
import json
import sys
import time
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.errors import AppError  # noqa: E402
from app.providers import ProviderHub  # noqa: E402
from app.workflow import ALLOWED_TOOLS, Workflow  # noqa: E402

# Expectations are declared before any paid evaluation. Failed cases stay in
# the evidence and denominator; a rerun writes a separate output file.
CASES = [
    ("brief", "夏季新品，想拍得松弛一些，给我几个思路吧", "propose_directions", None),
    ("brief", "你先说说咱们合作的流程可以吗？", "chat", None),
    ("brief", "不用看方向了，直接生成五秒视频", "chat", "generate_video"),
    ("direction", "第二个吧，就它了", "write_script", "direction-2"),
    ("direction", "我更想去雨天画廊，就按那组拍", "write_script", "direction-3"),
    ("direction", "这几个都太正式了，重新给我些周末去海边的灵感", "propose_directions", None),
    ("direction", "我是不是一定要有自己的模特照片呀？", "chat", None),
    ("direction", "别写脚本了，现在直接把照片生成出来", "chat", "generate_images"),
    ("script", "整套从办公室改成周末海边，动作也随意些", "revise_script", None),
    ("script", "第三个镜头换成站着，文案少一些", "revise_script", None),
    ("script", "先不改，我只是想知道这样拍要多久？", "chat", None),
    ("script", "难道拍之前不需要确认吗？", "chat", None),
    ("script", "请直接给我做视频，跳过照片", "chat", "generate_video"),
    ("script", "还是最初那版好，恢复第一版脚本", "restore_script", "checkpoint-v1"),
    ("images", "第二张有点暗，帮我把背景提亮", "edit_image", "image-2"),
    ("images", "咖啡馆那张换成暖一点的灯光", "edit_image", "image-2"),
    ("images", "把衬衫那张修一下，袖口卷起来", "edit_image", "image-1"),
    ("images", "先别修图，为什么同一件衣服有色差？", "chat", None),
    ("images", "方向不对，整套脚本重新改成通勤风", "revise_script", None),
    ("images", "选第一张和第三张，就按这个顺序写发布笔记", "write_note", ["image-1", "image-3"]),
    ("note", "咖啡馆那张背景再亮一点，笔记先保留", "edit_image", "image-2"),
    ("note", "标题别那么长，正文多分两段，加点表情", "write_note", None),
    ("note", "这套镜头不行，重新写脚本，换成更利落的通勤场景", "revise_script", None),
    ("note", "你能给我讲个笑话吗？", "chat", None),
    ("video", "视频先跑着，笔记标题改成雨天也很轻盈", "write_note", None),
    ("video", "现在还要等多久呀？", "chat", None),
    ("video", "重做第二张照片，换个背景", "chat", "edit_image"),
    ("done", "正文最后一段删掉，标签保留", "write_note", None),
    ("done", "谢谢你，今天先到这里", "chat", None),
    ("done", "重新给我三组创作方向", "chat", "propose_directions"),
]


def context_for(stage):
    garments = [
        {"asset_id": "garment-shirt", "category": "衬衫", "color": "白色", "material": "棉"},
        {"asset_id": "garment-jeans", "category": "牛仔裤", "color": "蓝色", "material": "牛仔"},
        {"asset_id": "garment-dress", "category": "连衣裙", "color": "黑色", "material": "棉"},
        {"asset_id": "garment-coat", "category": "风衣", "color": "卡其色", "material": "斜纹"},
    ]
    directions = [
        {"id": "direction-1", "name": "公园慢走", "scene": "绿色公园", "mood": "清新"},
        {"id": "direction-2", "name": "咖啡馆午后", "scene": "窗边咖啡馆", "mood": "松弛"},
        {"id": "direction-3", "name": "雨天画廊", "scene": "现代画廊", "mood": "安静"},
    ]
    shots = [{"id": f"shot-{index}", "scene": scene,
              "outfit_asset_ids": [garments[index - 1]["asset_id"]],
              "pose": "自然站立", "camera": "全身", "caption": scene}
             for index, scene in enumerate(["绿色公园", "窗边咖啡馆", "现代画廊", "地铁口"], 1)]
    script = {"status": "draft" if stage == "script" else "confirmed", "version": 2,
              "title_ideas": ["城市里的轻松一天"],
              "cover": {"scene": "公园", "pose": "站立", "text_overlay": "松弛穿搭"},
              "shots": shots, "video": {"prompt": "轻轻转身", "duration": 5}}
    images = [{"id": f"image-{i}", "shot_id": shot["id"], "position": i,
               "scene": shot["scene"], "shot": shot, "status": "succeeded", "version": 1,
               "garment_asset_ids": shot["outfit_asset_ids"], "instruction": ""}
              for i, shot in enumerate(shots, 1)]
    if stage not in {"images", "note", "video", "done"}:
        images = []
    selected = [image["id"] for image in images] if stage in {"note", "video", "done"} else []
    return {"stage": stage, "brand": "白昼衣橱", "brief": {"original": "夏季新品，想要松弛感"},
            "garments": garments, "directions": directions,
            "chosen_direction_id": "direction-2", "chosen_direction": directions[1],
            "script": script if stage not in {"brief", "direction"} else None,
            "images": images, "selected_image_ids": selected,
            "note": {"title": "城市里的轻松一天", "body": "☀️ 一组穿搭灵感\n\n从公园到咖啡馆。",
                     "tags": ["穿搭", "夏季", "简约", "灵感", "日常"], "image_ids": selected}
            if selected else None,
            "video": {"status": "running" if stage == "video" else "succeeded"}
            if stage in {"video", "done"} else None,
            "script_versions": [{"version": 1, "checkpoint_id": "checkpoint-v1",
                                 "summary": "最初松弛公园版", "current": False},
                                {"version": 2, "checkpoint_id": "checkpoint-v2",
                                 "summary": "咖啡馆版", "current": True}],
            "max_outfit_assets_per_shot": 2, "recent_messages": []}


def run(output):
    result = {"started_at": datetime.now(UTC).isoformat(), "mode": "real",
              "project_id": str(uuid4()), "cases": []}
    output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

    with SessionLocal() as session:
        hub = ProviderHub(session, result["project_id"])
        for index, (stage, text, expected, target) in enumerate(CASES, 1):
            started = time.monotonic()
            record = {"number": index, "stage": stage, "text": text,
                      "expected": expected, "expected_target": target}
            try:
                name, args = hub.select_tool(sorted(ALLOWED_TOOLS[stage]),
                                             deepcopy(context_for(stage)), text)
                correct = name == expected
                actual_target = None
                if target is not None:
                    key = {"chat": "blocked_tool", "write_script": "direction_id",
                           "edit_image": "image_id", "restore_script": "checkpoint_id",
                           "write_note": "image_ids"}[expected]
                    actual_target = args.get(key)
                    correct = correct and actual_target == target
                rejected = False
                if name == "chat" and args.get("blocked_tool"):
                    try:
                        Workflow._allow(None, stage, args["blocked_tool"])
                    except AppError as exc:
                        rejected = exc.code == "tool_not_allowed" and "当前阶段" in exc.message
                    correct = correct and rejected
                record.update(actual=name, actual_target=actual_target, reply=args.get("reply"),
                              gate_rejected=rejected, correct=correct)
            except Exception as exc:
                record.update(correct=False, error_type=type(exc).__name__)
            record["seconds"] = round(time.monotonic() - started, 3)
            result["cases"].append(record)
            save()
            print(f"{index:02d} {stage:9s} {'PASS' if record['correct'] else 'FAIL'} "
                  f"{record.get('actual', record.get('error_type'))}", flush=True)
        result["correct"] = sum(case["correct"] for case in result["cases"])
        result["total"] = len(CASES)
        result["accuracy"] = result["correct"] / result["total"]
        result["finished_at"] = datetime.now(UTC).isoformat()
        save()
    return result


def check_project_replies(output):
    records = []
    with SessionLocal() as session:
        for brand, brief, garment in [
            ("白昼衣橱", "夏季棉衬衫新品，想要松弛感", context_for("brief")["garments"][0]),
            ("夜色工作室", "黑色连衣裙合作，希望有安静的艺术氛围",
             context_for("brief")["garments"][2]),
        ]:
            context = context_for("brief")
            context.update(brand=brand, brief={"original": brief}, garments=[garment])
            project_id = str(uuid4())
            name, result = ProviderHub(session, project_id).select_tool(
                sorted(ALLOWED_TOOLS["brief"]), context, "帮我想几个适合这次合作的拍摄方向")
            assert name == "propose_directions"
            records.append({"project_id": project_id, "brand": brand, "reply": result["reply"]})
    distinct = len({record["reply"] for record in records}) == len(records)
    evidence = {"same_stage": "brief", "projects": records, "distinct": distinct}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    assert distinct, "Different projects received identical model replies"
    print("PASS: same-stage replies differ across two projects")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/intents-fix1.json")
    parser.add_argument("--replies-only", action="store_true")
    args = parser.parse_args()
    if settings.mock_providers or not settings.deepseek_api_key:
        raise SystemExit("Requires MOCK_PROVIDERS=0 and an in-process DEEPSEEK_API_KEY")
    if args.replies_only:
        check_project_replies(args.output)
        return 0
    result = run(args.output)
    print(f"Accuracy {result['correct']}/{result['total']} = {result['accuracy']:.1%}")
    return 0 if result["accuracy"] >= 0.9 else 1


if __name__ == "__main__":
    raise SystemExit(main())
