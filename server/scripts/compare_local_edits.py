#!/usr/bin/env python3
"""Resumable, single-attempt A/B of three local edits with a private cost ledger.

Credentials are read only from process settings. Each paid request is marked
before submission; an interrupted, unknown result is never submitted again.
Raw model crops are retained so blending can be measured without paying again.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import time
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.edit_guidance import local_edit_prompt  # noqa: E402
from app.local_edit import (  # noqa: E402
    compose_local_edit,
    crop_reference,
    prepare_selection,
    temporary_image_asset,
)
from app.media import label_generated_image  # noqa: E402
from app.models import Asset, Base, UsageLedger  # noqa: E402
from app.providers import GeneratedMedia, ProviderHub  # noqa: E402

CASES = {
    "cuff": {
        "source": "artifacts/real-fix2-original.png",
        "region": {"x": 0.295, "y": 0.31, "w": 0.145, "h": 0.13},
        "instruction": "只把圈选的画面左侧短袖袖口放下来，展开卷起的一折，保留短袖版型。",
    },
    "tuck": {
        "source": "artifacts/real-fix2-original.png",
        "region": {"x": 0.345, "y": 0.425, "w": 0.30, "h": 0.145},
        "instruction": "把衬衫的下摆全部塞进牛仔裤裤腰，露出连续裤腰线，不留垂在裤腰外的衣摆。",
    },
    "tag": {
        "source": "artifacts/real-fix2-initial-original.png",
        "region": {"x": 0.535, "y": 0.268, "w": 0.075, "h": 0.055},
        "instruction": "只去掉圈选的胸前纸吊牌及细绳，恢复同色衬衫布纹，保留口袋和纽扣。",
    },
}


def write(path: Path, evidence: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def reference(relative: str) -> Asset:
    path = (ROOT / relative).resolve()
    assert path.is_relative_to(ROOT)
    with Image.open(path) as image:
        return Asset(id=relative, user_id="local-experiment", kind="reference", path=relative,
                     width=image.width, height=image.height, mime=Image.MIME[image.format],
                     source="generated" if relative.startswith("artifacts/") else "upload")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configuration(spec: dict, variant: str, selected, prompt: str) -> dict:
    references = (["fixtures/shirt.jpg", spec["source"]] if variant == "candidate" else
                  ["fixtures/shirt.jpg", "fixtures/jeans.jpg"])
    return {"source_sha256": digest(ROOT / spec["source"]), "region": spec["region"],
            "instruction": spec["instruction"], "prompt": prompt,
            "context_ratio": 0.2 if variant == "baseline" else 0.6,
            "crop_box": list(selected.crop_box), "canvas_size": list(selected.canvas_size),
            "reference_sha256": {name: digest(ROOT / name) for name in references}}


def usage(session: Session) -> dict:
    groups = defaultdict(lambda: {"calls": 0, "seconds": 0.0, "estimated_cny": Decimal(0)})
    for row in session.scalars(select(UsageLedger).order_by(UsageLedger.created_at)):
        if row.units.get("mock"):
            continue
        group = groups[row.model]
        group["calls"] += 1
        group["seconds"] += row.duration_ms / 1000
        group["estimated_cny"] += row.estimated_cny
    total = sum((group["estimated_cny"] for group in groups.values()), Decimal(0))
    for group in groups.values():
        group["estimated_cny"] = str(group["estimated_cny"])
        group["seconds"] = round(group["seconds"], 3)
    return {"estimated_cny": str(total), "models": dict(groups)}


def comparison(source: Path, baseline: Path, candidate: Path, region: dict, target: Path) -> None:
    with Image.open(source) as image:
        width, height = image.size
    margin = 0.035
    box = (max(0, int((region["x"] - margin) * width)),
           max(0, int((region["y"] - margin) * height)),
           min(width, int((region["x"] + region["w"] + margin) * width)),
           min(height, int((region["y"] + region["h"] + margin) * height)))
    panel = Image.new("RGB", (1440, 720), "white")
    for index, (label, path) in enumerate(
        (("Source", source), ("Baseline / one attempt", baseline),
         ("Candidate / one attempt", candidate))
    ):
        with Image.open(path) as image:
            crop = image.convert("RGB").crop(box)
            crop.thumbnail((470, 670))
            panel.paste(crop, (index * 480 + (480 - crop.width) // 2, 40))
        ImageDraw.Draw(panel).text((index * 480 + 12, 12), label, fill="black")
    panel.save(target)


def run_variant(args, path: Path, evidence: dict, hub: ProviderHub, case: str, variant: str):
    spec = CASES[case]
    key = f"{case}-{variant}"
    entry = evidence.setdefault("operations", {}).setdefault(key, {})
    source = reference(spec["source"])
    source_hash = digest(ROOT / spec["source"])
    if entry.get("source_sha256") not in {None, source_hash}:
        raise RuntimeError("实验原图发生变化，拒绝混用断点。")
    selected = prepare_selection((source.width, source.height), spec["region"],
                                 context_ratio=0.2 if variant == "baseline" else 0.6)
    prompt = (
        "最后一张参考图是唯一待编辑的局部裁剪画布；前面的图片仅供原衣服细节参考。"
        "严格保持最后一张图的画幅、镜头、人物位置和局部构图，输出同一裁剪块。"
        "不要输出全身照，不要扩展到裁剪块之外，不要把原衣服产品图当成编辑画布。"
        "仅做用户要求的局部修改，保留其余内容：" + spec["instruction"]
        if variant == "baseline" else local_edit_prompt(
            spec["instruction"], selected, full_reference=variant == "candidate"
        )
    )
    if args.phase == "check" and entry:
        # Check the exact prompt saved before generation, even if a later
        # strategy revision changes the production guidance.
        prompt = entry["prompt"]
    raw_path = path.parent / f"{path.stem}-{key}-raw.png"
    output_path = path.parent / f"{path.stem}-{key}.png"
    config = configuration(spec, variant, selected, prompt)
    if entry and entry.get("configuration") != config:
        raise RuntimeError("实验配置发生变化或断点不完整，拒绝混用原始生成块。")
    if not entry:
        entry.update(source_sha256=source_hash, source=spec["source"], region=spec["region"],
                     instruction=spec["instruction"], prompt=prompt,
                     crop_box=list(selected.crop_box),
                     raw_path=str(raw_path.relative_to(ROOT)),
                     image_path=str(output_path.relative_to(ROOT)), configuration=config)
        write(path, evidence)
    if args.phase in {"all", "generate"} and not entry.get("generated"):
        if entry.get("generation_started"):
            raise RuntimeError(f"{key} 有结果未知的图片请求，拒绝重复付费。")
        entry["generation_started"] = True
        write(path, evidence)
        started = time.monotonic()
        with temporary_image_asset(crop_reference(source, selected), source) as crop:
            refs = ([reference("fixtures/shirt.jpg"), source, crop] if variant == "candidate" else
                    [reference("fixtures/shirt.jpg"), reference("fixtures/jeans.jpg"), crop])
            raw = hub.image(prompt, refs)
        raw_path.write_bytes(raw.data)
        entry.update(generated=True, generation_seconds=round(time.monotonic() - started, 3),
                     raw_sha256=digest(raw_path), model=raw.model)
        write(path, evidence)
    if args.phase in {"all", "check"}:
        if not entry.get("generated"):
            raise RuntimeError(f"{key} 尚未生成，先运行generate阶段。")
        if digest(raw_path) != entry["raw_sha256"]:
            raise RuntimeError("原始生成块发生变化，拒绝继续。")
        composed = compose_local_edit(
            source, GeneratedMedia(raw_path.read_bytes(), "image/png", entry["model"]), selected
        )
        data = label_generated_image(composed.data, composed.model, draw_label=False)
        if entry.get("checked_sha256") not in {None, hashlib.sha256(data).hexdigest()}:
            raise RuntimeError("已核对的合成图发生变化，拒绝沿用旧核对结果。")
        output_path.write_bytes(data)
        with Image.open(ROOT / spec["source"]) as before, Image.open(io.BytesIO(data)) as after:
            difference = ImageChops.difference(before.convert("RGB"), after.convert("RGB"))
            red, green, blue = difference.split()
            changed = ImageChops.lighter(ImageChops.lighter(red, green), blue).tobytes()
            mask = selected.mask.tobytes()
            entry["outside_pixels"] = mask.count(0)
            entry["outside_changed_pixels"] = sum(
                bool(value) for value, selected_pixel in zip(changed, mask, strict=True)
                if not selected_pixel
            )
            assert entry["outside_changed_pixels"] == 0
        write(path, evidence)
        if not entry.get("edit_check"):
            if entry.get("check_started"):
                raise RuntimeError(f"{key} 有结果未知的核对请求，拒绝重复付费。")
            entry["check_started"] = True
            write(path, evidence)
            entry["edit_check"] = hub.check_edit(
                source, reference(str(output_path.relative_to(ROOT))), spec["instruction"],
                spec["region"],
            )
            entry["checked_sha256"] = hashlib.sha256(data).hexdigest()
            write(path, evidence)
    print(f"{key}: generated={entry.get('generated', False)} check={entry.get('edit_check')}")


def run(args):
    path = args.output.resolve()
    assert path.is_relative_to(ROOT / "artifacts"), "所有实验输出必须在本项目artifacts内"
    assert settings.mock_providers == (args.mode == "mock")
    assert settings.model_budget_cny <= 5, "本轮到5元停止"
    if args.mode == "real":
        assert settings.dashscope_api_key
        assert path == ROOT / "artifacts/local-edit-fix3.json", "真实实验必须共用本轮唯一账本"
        assert settings.dashscope_base_url == "https://dashscope.aliyuncs.com/api/v1"
        assert settings.dashscope_compatible_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    settings.media_dir = ROOT
    path.parent.mkdir(parents=True, exist_ok=True)
    evidence = json.loads(path.read_text()) if path.exists() else {"mode": args.mode}
    assert evidence["mode"] == args.mode
    ledger_path = path.with_suffix(".sqlite")
    if args.mode == "real" and path.exists() != ledger_path.exists():
        raise RuntimeError("费用账本与断点不成对，拒绝重建预算或重复模型调用。")
    engine = create_engine(f"sqlite:///{ledger_path}")
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as session:
            hub = ProviderHub(session)
            try:
                for case in CASES if args.case == "all" else [args.case]:
                    variants = ("baseline", "candidate", "context") if args.variant == "all" else [
                        args.variant]
                    for variant in variants:
                        run_variant(args, path, evidence, hub, case, variant)
                        evidence["usage"] = usage(session)
                        write(path, evidence)
                    entries = evidence.get("operations", {})
                    compared = "context" if f"{case}-context" in entries else "candidate"
                    keys = [f"{case}-{v}" for v in ("baseline", compared)]
                    if all(entries.get(key, {}).get("edit_check") for key in keys):
                        comparison(ROOT / CASES[case]["source"],
                                   ROOT / entries[keys[0]]["image_path"],
                                   ROOT / entries[keys[1]]["image_path"], CASES[case]["region"],
                                   path.parent / f"{path.stem}-{case}-comparison.png")
            finally:
                evidence["usage"] = usage(session)
                write(path, evidence)
    finally:
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("mock", "real"), required=True)
    parser.add_argument("--phase", choices=("generate", "check", "all"), default="all")
    parser.add_argument("--case", choices=("all", *CASES), default="all")
    parser.add_argument("--variant", choices=("all", "baseline", "candidate", "context"),
                        default="all")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/local-edit-fix3.json")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
