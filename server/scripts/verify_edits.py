#!/usr/bin/env python3
"""Resumable real-image checks on private local jobs, without changing the Mock API.

Run with process-only model credentials and MOCK_PROVIDERS=0. Start with
--name original, inspect the image, then --name cuff --region x,y,w,h and
--name tuck. Every phase checkpoints its running job before calling a model.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw
from sqlalchemy import select
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.local_edit import prepare_selection  # noqa: E402
from app.media import asset_path, store_upload  # noqa: E402
from app.models import Asset, Job, Project, User, utcnow  # noqa: E402
from app.providers import ProviderHub  # noqa: E402
from app.views import image_items  # noqa: E402
from app.worker import process_job  # noqa: E402
from app.workflow import Workflow  # noqa: E402
from scripts.e2e import safe  # noqa: E402


def write(path, evidence):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(safe(evidence), ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def initialize(path, evidence):
    if evidence.get("project_id"):
        return
    with SessionLocal() as session:
        user = User(username=f"fix2_{time.time_ns()}", password_hash="!", nickname="局部编辑验证")
        session.add(user)
        session.flush()
        assets = [store_upload(session, user_id=user.id, kind=kind,
                               data=(ROOT / "fixtures" / filename).read_bytes())
                  for filename, kind in (("shirt.jpg", "garment"),
                                         ("jeans.jpg", "garment"), ("model.jpg", "model"))]
        project = Project(user_id=user.id, title="带吊牌衣服与局部编辑真实验证", brand="本地验证",
                          brief="验证袖口放下、衬衫塞腰和忽略吊牌", stage="images",
                          garment_asset_ids=[a.id for a in assets[:2]],
                          model_asset_id=assets[2].id)
        session.add(project)
        session.commit()
        evidence.update(project_id=project.id, operations={})
        write(path, evidence)


def create_operation(path, evidence, name, region):
    if name in evidence["operations"]:
        saved_id = evidence["operations"][name].get("job_id")
        if saved_id:
            return saved_id
        with SessionLocal() as session:
            saved = session.scalar(select(Job).where(
                Job.project_id == evidence["project_id"],
                Job.payload["verification_name"].as_string() == name,
            ))
            if saved:
                evidence["operations"][name].update(job_id=saved.id, status=saved.status)
                write(path, evidence)
                return saved.id
        raise RuntimeError("准备阶段已开始但结果未知，请核对账本，不自动重复调用模型。")
    evidence["operations"][name] = {"status": "preparing"}
    write(path, evidence)
    with SessionLocal() as session:
        project = session.get(Project, evidence["project_id"])
        garments = [session.get(Asset, i) for i in project.garment_asset_ids]
        descriptions = ProviderHub(session, project.id).analyze_garments(garments)
        if name == "original":
            prompt = (
                "真实穿搭摄影，参考图1的成年模特穿参考图2奶油白衬衫和参考图3浅蓝牛仔裤，"
                "干净的浅灰摄影棚，正面站立双臂自然略张开，头到小腿都完整入镜。"
                "衬衫扣好扣子，下摆必须全部松松放在裤腰外面，两边短袖袖口都向外卷起一折。"
                "袖口和衬衫下摆清晰可见。保持原衣服版型、面料、颜色、口袋和纽扣。"
                "吊牌、价签、织标贴纸、衣架、包装袋属于拍摄附件，不能穿在身上或生成出来。"
            )
            job = Job(project_id=project.id, user_id=project.user_id, kind="image",
                      status="running", attempts=1, locked_at=utcnow(),
                      dedupe_key=f"{project.id}:real-fix2:original",
                      payload={"shot_id": "shot-real", "version": 1, "script_version": 1,
                               "prompt": prompt, "reference_asset_ids": [
                                   project.model_asset_id, *project.garment_asset_ids],
                               "garment_asset_ids": project.garment_asset_ids,
                               "shot": {"id": "shot-real", "scene": "浅灰摄影棚",
                                        "pose": "衬衫下摆在裤腰外，袖口卷一折"}}, result={})
            session.add(job)
            session.flush()
        else:
            parent_id = evidence["operations"]["original"]["job_id"]
            parent = session.get(Job, parent_id)
            assert parent.status == "succeeded"
            instruction = ("只把圈选的袖口放下来，展开卷起的一折，其他地方保持完全不变。"
                           if name == "cuff" else "把整件衬衫的下摆全部塞进牛仔裤裤腰，"
                           "露出清晰裤腰线，不要仍留在裤腰外，人物、衬衫和场景不变。")
            action = {"type": "edit_image", "image_id": parent_id, "instruction": instruction}
            if region:
                action["region"] = region
            state = {"stage": "images", "garments": descriptions, "images": image_items(
                session, project.id), "script": {"version": 1}, "messages": []}
            result = Workflow(session, project).handle(state, {"action": action})
            assert len(result["turn_jobs"]) == 1
            job = session.get(Job, result["turn_jobs"][0]["id"])
            # This experiment owns its running row; the always-Mock worker cannot claim it.
            job.status, job.attempts, job.locked_at = "running", 1, utcnow()
        job.payload = {**job.payload, "verification_name": name}
        session.commit()
        evidence["operations"][name] = {"job_id": job.id, "status": "running"}
        write(path, evidence)
        return job.id


def comparison(original, edited, path):
    with Image.open(original) as first, Image.open(edited) as second:
        first, second = first.convert("RGB"), second.convert("RGB")
        if first.size == second.size:
            diff = ImageChops.difference(first, second)
            red, green, blue = diff.split()
            changed = sum(bool(p) for p in ImageChops.lighter(
                ImageChops.lighter(red, green), blue).tobytes())
        else:
            changed = None
        panels = []
        for label, picture in (("Before", first), ("After", second)):
            picture.thumbnail((560, 760))
            panel = Image.new("RGB", (580, 810), "white")
            panel.paste(picture, ((580 - picture.width) // 2, 40))
            ImageDraw.Draw(panel).text((20, 12), label, fill="black")
            panels.append(panel)
        canvas = Image.new("RGB", (1160, 810), "white")
        for index, panel in enumerate(panels):
            canvas.paste(panel, (index * 580, 0))
        canvas.save(path)
        return changed


def run_operation(args, path, evidence):
    url = make_url(settings.database_url)
    assert url.host in {"localhost", "127.0.0.1"} and url.port == 18432
    assert url.database.startswith("outfit_fix2_"), "真实实验必须使用本地专属数据库"
    assert not settings.mock_providers and settings.dashscope_api_key
    assert settings.media_dir.resolve().is_relative_to(ROOT)
    initialize(path, evidence)
    region = dict(zip(("x", "y", "w", "h"), args.region, strict=True)) if args.region else None
    job_id = create_operation(path, evidence, args.name, region)
    started = time.monotonic()
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        if job.status == "running":
            # A saved external request cannot safely be resubmitted after process death.
            assert not job.result.get("external_request_started"), "已有未知付费请求，停止重复提交"
            process_job(job.id, job.attempts)
        else:
            assert job.status == "succeeded", "失败任务不能作为新请求自动重提"
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        operation = evidence["operations"][args.name]
        operation.update(status=job.status, result=safe(job.result), error=job.error)
        operation.setdefault("duration_s", round(time.monotonic() - started, 3))
        evidence["database"] = url.database
        if job.result_asset_id:
            asset = session.get(Asset, job.result_asset_id)
            source_path = asset_path(asset)
            target = (ROOT / operation["image_path"] if operation.get("image_path") else
                      path.parent / f"{path.stem}-{args.name}.png")
            assert target.resolve().is_relative_to(ROOT)
            target.write_bytes(source_path.read_bytes())
            operation["image_path"] = str(target.relative_to(ROOT))
            if args.name != "original":
                original = ROOT / evidence["operations"]["original"]["image_path"]
                compare = (ROOT / operation["comparison_path"] if operation.get("comparison_path")
                           else path.parent / f"{path.stem}-{args.name}-comparison.png")
                assert compare.resolve().is_relative_to(ROOT)
                operation["changed_pixels"] = comparison(original, target, compare)
                operation["comparison_path"] = str(compare.relative_to(ROOT))
                operation["region"] = job.payload.get("region")
                if operation["region"]:
                    with Image.open(original) as first, Image.open(target) as second:
                        assert first.size == second.size
                        selection = prepare_selection(first.size, job.payload.get("region"),
                                                      job.payload.get("mask_strokes"))
                        difference = ImageChops.difference(first.convert("RGB"),
                                                          second.convert("RGB"))
                        red, green, blue = difference.split()
                        changed = ImageChops.lighter(ImageChops.lighter(red, green), blue)
                        outside = [bool(pixel) for pixel, mask in zip(
                            changed.tobytes(), selection.mask.tobytes(), strict=True) if mask == 0]
                        operation["outside_pixels"] = len(outside)
                        operation["outside_changed_pixels"] = sum(outside)
                        write(path, evidence)
                        assert operation["outside_changed_pixels"] == 0
        write(path, evidence)
        assert job.status == "succeeded", f"任务失败，已保存证据：{job.error}"
        if args.name != "original":
            assert isinstance(job.result["edit_check"]["passed"], bool)
        print(f"PASS {args.name}: {path.relative_to(ROOT)}")


def run(args):
    path = args.output.resolve()
    assert path.is_relative_to(ROOT)
    evidence = json.loads(path.read_text()) if path.exists() else {"mode": "real"}
    try:
        run_operation(args, path, evidence)
    except BaseException as exc:
        evidence["last_error_type"] = type(exc).__name__
        raise
    finally:
        write(path, evidence)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", choices=("original", "cuff", "tuck"), required=True)
    parser.add_argument("--region", type=float, nargs=4)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/real-fix2.json")
    args = parser.parse_args()
    assert (args.name == "cuff") == bool(args.region), "袖口必须提供region，其他步骤不圈选"
    run(args)


if __name__ == "__main__":
    main()
