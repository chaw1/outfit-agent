"""Model-selected tools within deterministic, replay-safe stage boundaries."""

import hashlib
import json
import time
from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.costs import image_cost_cny, with_points
from app.errors import AppError
from app.local_edit import prepare_selection
from app.media import asset_dict
from app.model_library import model_references
from app.models import Asset, Job, Project, User, utcnow
from app.photography import expand_photo_prompt
from app.providers import ProviderHub
from app.runtime_settings import assert_generation_allowed
from app.schemas import EditImage
from app.tracing import dialogue_trace
from app.views import image_items, job_dict

ALLOWED_TOOLS = {
    "brief": {"propose_directions", "chat"},
    "direction": {"propose_directions", "write_script", "chat"},
    "script": {"revise_script", "restore_script", "generate_images", "chat"},
    "images": {"revise_script", "restore_script", "edit_image", "write_note", "chat"},
    "note": {
        "revise_script",
        "restore_script",
        "edit_image",
        "write_note",
        "generate_video",
        "chat",
    },
    # 短片出完后仍允许改图：改好的版本直接换进笔记，短片不会自动重做。
    "video": {"edit_image", "write_note", "chat"},
    "done": {"edit_image", "write_note", "generate_video", "chat"},
}

# 被拦下时告诉用户这一步能做什么，而不是一句"请先完成确认"。
STAGE_HINTS = {
    "brief": "先说说这次合作的需求和衣服，我会给出几个拍摄方向。",
    "direction": "先在方向卡里选一个方向，我再写脚本。",
    "script": "脚本确认后才会开始出图；现在可以改脚本或直接确认。",
    "images": "这一步可以改图或定稿写笔记；视频要等笔记写好以后。",
    "note": "现在可以改图、改笔记，或选一张图做 5 秒短片。",
    "video": "短片正在生成，这期间可以改图、改笔记文字；做好后可以再做一条。",
    "done": "全套已完成：可以改图、改笔记文字，或再做一条短片。",
}


def fingerprint(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class Workflow:
    def __init__(self, session: Session, project: Project):
        self.session = session
        self.project = project
        self.providers = ProviderHub(session, project.id)
        # Populated from this thread's checkpoint history at the turn boundary.
        self.restore_scripts: dict[str, dict] = {}
        self.script_versions: list[dict] = []
        self.begin_turn({})

    def begin_turn(self, event: dict) -> None:
        self.started = time.monotonic()
        self.tool = "chat"
        self.created_paid_jobs = False
        self.providers.ledger_ids = []
        self.providers.trace_context = {"turn_id": event.get("turn_id", "")}

    def _allow(self, stage: str, tool: str) -> None:
        if tool not in ALLOWED_TOOLS.get(stage, set()):
            raise AppError("tool_not_allowed", "这一步现在还做不了。" + STAGE_HINTS.get(stage, ""))
        self.tool = tool

    def _card(self, kind: str, content: dict) -> dict:
        if kind == "directions":
            content = {**content, "regenerate_estimate_cny": float(image_cost_cny(3))}
        return with_points({"id": f"{self.project.id}:{kind}", "type": kind, **content})

    def _asset(self, asset_id: str) -> Asset:
        asset = self.session.get(Asset, asset_id)
        if not asset or asset.user_id != self.project.user_id:
            raise AppError("asset_not_found", "图片不存在或无权访问。", 404)
        return asset

    def _image_job(self, image_id: str, *, succeeded: bool = True) -> Job:
        job = self.session.get(Job, image_id)
        if (
            not job
            or job.project_id != self.project.id
            or job.user_id != self.project.user_id
            or job.kind not in {"image", "edit"}
            or job.payload.get("purpose") == "preview"
        ):
            raise AppError("image_not_found", "这张图片不属于当前项目的脚本图片。", 404)
        if succeeded and (job.status != "succeeded" or not job.result_asset_id):
            raise AppError("image_not_ready", "请等图片生成成功后再操作。")
        return job

    def _validate_image_selection(self, ids: list[str], accepted: list[str]) -> list[str]:
        if (
            not isinstance(ids, list)
            or not ids
            or len(ids) > 20
            or any(not isinstance(value, str) for value in ids)
            or len(ids) != len(set(ids))
        ):
            raise AppError("images_required", "请按笔记顺序选择至少一张图片，不要重复。")
        if (
            not isinstance(accepted, list)
            or any(not isinstance(value, str) for value in accepted)
            or len(accepted) != len(set(accepted))
            or not set(accepted).issubset(ids)
        ):
            raise AppError(
                "invalid_accept_unverified", "手动采用的图片必须在本次选图中且不重复。", 422
            )
        unverified, missing = [], []
        for image_id in ids:
            job = self._image_job(image_id)
            check = job.result.get("edit_check") or {}
            if check.get("passed") is False:
                unverified.append(image_id)
                if image_id not in accepted:
                    shot = job.payload.get("shot_id", "未知")
                    shot_number = shot.removeprefix("shot-")
                    reason = check.get("reason") or "修改尚未核对通过"
                    missing.append(f"镜头{shot_number}：{reason}")
        if missing:
            raise AppError(
                "unverified_image", "以下图片未改到位，请确认仍然采用后重试：" + "；".join(missing)
            )
        return unverified

    def _confirmed_visual_facts(self, job: Job | None, accepted: set[str]) -> list[str]:
        lineage, visited = [], set()
        while job and job.id not in visited:
            if job.project_id != self.project.id or job.user_id != self.project.user_id:
                break
            visited.add(job.id)
            lineage.append(job)
            parent_id = job.payload.get("parent_id")
            job = self.session.get(Job, parent_id) if parent_id else None
        if not lineage:
            return []
        original_shot = lineage[-1].payload.get("shot") or {}
        facts = [original_shot[key] for key in ("scene", "caption") if original_shot.get(key)]
        for version in reversed(lineage):
            change = version.payload.get("instruction")
            check = version.result.get("edit_check") or {}
            if change and (check.get("passed") is True or version.id in accepted):
                facts.append(change)
        # Keep the latest occurrence so a repeated edit can supersede its reversal.
        return list(reversed(dict.fromkeys(reversed(facts))))

    def _context(self, state: dict) -> dict:
        keys = (
            "brief",
            "garments",
            "directions",
            "chosen_direction_id",
            "script",
            "images",
            "note",
            "video",
            "pending_action",
        )
        context = {key: state.get(key) for key in keys}
        if state.get("references"):
            context["references"] = state["references"]
            context["reference_style_summary"] = self._reference_prompt(state)
        context.update(
            brand=self.project.brand,
            mode=self.project.mode,
            style_tags=list(self.project.style_tags or []),
            stage=state.get("stage", "brief"),
            max_outfit_assets_per_shot=2 if self.project.model_asset_id else 3,
            script_versions=self.script_versions,
        )
        # Query the scalar value each turn so saved preferences apply to existing
        # project threads too, even when their checkpoint predates the profile.
        profile = self.session.scalar(select(User.profile).where(User.id == self.project.user_id))
        context["profile"] = profile or {"model_asset_ids": []}
        context["style_notes"] = (profile or {}).get("style_notes") or ""
        context["selected_image_ids"] = state.get(
            "selected_image_ids", (state.get("note") or {}).get("image_ids", [])
        )
        context["chosen_direction"] = next(
            (
                item
                for item in state.get("directions", [])
                if item["id"] == state.get("chosen_direction_id")
            ),
            {},
        )
        # Image order, shot descriptions and edit instructions let the model resolve
        # references such as "the cafe one" without a second hard-coded router.
        shots = {shot["id"]: shot for shot in (state.get("script") or {}).get("shots", [])}
        accepted = set(state.get(
            "_accepted_unverified_ids", (state.get("note") or {}).get("accepted_unverified_ids", [])
        ))
        context["images"] = []
        for index, item in enumerate(state.get("images", []), 1):
            job = self.session.get(Job, item["id"])
            payload = job.payload if job else {}
            shot = payload.get("shot", {})
            if not shot and payload.get("script_version") == (state.get("script") or {}).get(
                "version"
            ):
                shot = shots.get(item.get("shot_id"), {})
            context["images"].append(
                {
                    **item,
                    "position": index,
                    "shot": shot,
                    "scene": shot.get("scene", ""),
                    "caption": shot.get("caption", ""),
                    "prompt": payload.get("prompt", ""),
                    "garment_asset_ids": payload.get("garment_asset_ids", []),
                    "requested_change": payload.get("instruction", ""),
                    "confirmed_visual_facts": self._confirmed_visual_facts(job, accepted),
                }
            )
        context["refs"] = list((state.get("incoming") or {}).get("refs", []))
        images_by_id = {item["id"]: item for item in context["images"]}
        context["referenced_images"] = [
            images_by_id[image_id] for image_id in context["refs"] if image_id in images_by_id
        ]
        recent_messages = []
        for message in state.get("messages", [])[-12:]:
            if isinstance(message, dict):
                role, content = message.get("role"), message.get("content", "")
                metadata = message.get("additional_kwargs", {})
            else:
                role, content = getattr(message, "type", ""), getattr(message, "content", "")
                metadata = getattr(message, "additional_kwargs", {})
            role = {"human": "user", "ai": "assistant"}.get(role, role)
            if role not in {"user", "assistant"}:
                continue
            if isinstance(content, list):
                content = "\n".join(
                    block["text"]
                    for block in content
                    if isinstance(block, dict)
                    and isinstance(block.get("text"), str)
                    and block.get("type") == "text"
                )
            if isinstance(content, str):
                recent = {"role": role, "text": content[:1000]}
                if metadata.get("display", {}).get("refs"):
                    recent["refs"] = metadata["display"]["refs"]
                recent_messages.append(recent)
        context["recent_messages"] = recent_messages
        return context

    def _text_tool(self, stage: str, tool: str, state: dict, instruction: str = "") -> dict:
        self._allow(stage, tool)
        return self.providers.text(tool, self._context(state), instruction)

    @staticmethod
    def _reply(result: dict, fallback: str) -> str:
        result = result or {}
        reply = result.get("reply") or result.get("text")
        return reply.strip() if isinstance(reply, str) and reply.strip() else fallback

    def _action_reply(
        self, tool: str, state: dict, action: dict, fallback: str, note: str = ""
    ) -> str:
        instruction = json.dumps(action, ensure_ascii=False)
        if note:
            instruction += "\n" + note
        result = self._text_tool(state["stage"], tool, state, instruction)
        return self._reply(result, fallback)

    def validate(self, state: dict, event: dict) -> None:
        """Validate outside interrupt, so a rejected action leaves its pause intact."""
        refs = event.get("refs", [])
        if (
            not isinstance(refs, list)
            or len(refs) > 20
            or any(not isinstance(value, str) or not value.strip() for value in refs)
            or len(refs) != len(set(refs))
        ):
            raise AppError("invalid_refs", "引用图片编号无效或重复，请重新选择。", 422)
        for image_id in refs:
            self._image_job(image_id)
        action = event.get("action")
        if not action:
            return
        if not isinstance(action, dict) or not isinstance(action.get("type"), str):
            raise AppError("invalid_action", "无法识别这个操作。")
        stage, kind = state.get("stage", "brief"), action["type"]
        required = {
            "choose_direction": "write_script",
            "confirm_script": "generate_images",
            "edit_image": "edit_image",
            "approve_images": "write_note",
            "confirm_video": "generate_video",
            "restore_script": "restore_script",
        }
        if kind not in required:
            raise AppError("invalid_action", "无法识别这个操作。")
        repeated_script = (
            kind == "confirm_script"
            and stage == "images"
            and (state.get("script") or {}).get("status") == "confirmed"
        )
        repeated_video = kind == "confirm_video" and stage in {"video", "done"}
        if not (repeated_script or repeated_video):
            self._allow(stage, required[kind])
        if kind == "choose_direction":
            if action.get("direction_id") not in [item["id"] for item in state["directions"]]:
                raise AppError("direction_not_found", "请从当前方向卡里选择一个方向。")
        elif kind == "confirm_script":
            if not state.get("script"):
                raise AppError("script_not_ready", "先一起写好脚本，再确认生成。")
        elif kind == "restore_script":
            if action.get("checkpoint_id") not in self.restore_scripts:
                raise AppError("script_version_not_found", "这版脚本不属于当前项目的历史。", 404)
        elif kind == "edit_image":
            parent = self._image_job(action.get("image_id", ""))
            if not isinstance(action.get("instruction"), str) or not action["instruction"].strip():
                raise AppError("instruction_required", "请告诉我这张图想改哪里。")
            try:
                normalized = EditImage.model_validate(action).model_dump(exclude_none=True)
            except ValidationError as exc:
                detail = (exc.errors()[0].get("ctx") or {}).get("error")
                raise AppError(
                    "invalid_edit_region",
                    str(detail)
                    if isinstance(detail, ValueError)
                    else "局部编辑字段无效，请重新圈选。",
                    422,
                ) from exc
            action.clear()
            action.update(normalized)
            if "region" in action or "mask_strokes" in action:
                asset = self._asset(parent.result_asset_id)
                if asset.width and asset.height:
                    prepare_selection(
                        (asset.width, asset.height),
                        action.get("region"),
                        action.get("mask_strokes"),
                    )
        elif kind == "approve_images":
            self._validate_image_selection(
                action.get("image_ids"), action.get("accept_unverified", [])
            )
        elif kind == "confirm_video":
            self._image_job(action.get("image_id", ""))
            if not state.get("note"):
                raise AppError("note_not_ready", "先选好笔记图片，再确认视频。")
            if action["image_id"] not in state["note"].get("image_ids", []):
                raise AppError("image_not_selected", "请从已选入笔记的图片里选择视频首帧。")
            self._validate_image_selection(
                [action["image_id"]],
                [image_id for image_id in state["note"].get("accepted_unverified_ids", [])
                 if image_id == action["image_id"]],
            )
            if repeated_video:
                video_job = self._current_video_job(state)
                # 上一条还在做时只接受同一次确认的重发；做完（或失败）后可以换图再做一条。
                if (
                    video_job is not None
                    and video_job.status in {"queued", "running"}
                    and video_job.payload.get("image_id") != action["image_id"]
                ):
                    raise AppError(
                        "video_in_progress", "上一条短片还在做，等它出来后再换一张图重做。"
                    )
        replayed_edit = (
            kind == "edit_image"
            and action.get("attempt") is not None
            and self.session.scalar(select(Job.id).where(Job.dedupe_key == self._edit_key(action)))
            is not None
        )
        if kind in {"confirm_script", "edit_image", "confirm_video"} and not replayed_edit:
            assert_generation_allowed(
                self.session, self.project.user_id,
                kinds=("video",) if kind == "confirm_video" else ("image",),
            )

    def start(self, event: dict, emit=None) -> dict:
        assets = [self._asset(asset_id) for asset_id in self.project.garment_asset_ids]
        garments = self.providers.analyze_garments(assets)
        for item in garments:
            item["url"] = asset_dict(self._asset(item["asset_id"]))["url"]
        garment_card = self._card("garments", {"items": garments})
        cards = [garment_card]
        if emit:
            emit({"event": "card", "data": garment_card})
        references = []
        if self.project.reference_asset_ids:
            reference_assets = [
                self._asset(asset_id) for asset_id in self.project.reference_asset_ids
            ]
            references = self.providers.analyze_references(reference_assets)
            for item in references:
                item["url"] = asset_dict(self._asset(item["asset_id"]))["url"]
            reference_card = self._card("references", {"items": [
                {"asset_id": item["asset_id"], "url": item["url"],
                 "style_tags": item["style_tags"]}
                for item in references
            ]})
            cards.append(reference_card)
            if emit:
                emit({"event": "card", "data": reference_card})
        garment_summary = "、".join(
            f"{item.get('color', '')}{item.get('category', '衣服')}" for item in garments
        )
        summary = f"品牌：{self.project.brand}；合作需求：{self.project.brief[:300]}"
        if event.get("text"):
            summary += f"；博主补充：{event['text'][:300]}"
        summary += f"；已识别衣服：{garment_summary}"
        if references:
            summary += "；" + self._reference_prompt({"references": references})
        state = {
            "incoming": event,
            "stage": "brief",
            "brief": {
                "original": self.project.brief,
                "additional": event.get("text", ""),
                "summary": summary,
            },
            "garments": garments,
            "model_asset_id": self.project.model_asset_id,
            "images": [],
            "note": None,
            "video": None,
            "script": None,
            "chosen_direction_id": None,
            "job_intents": [],
            "script_revision": 0,
        }
        if references:
            state["references"] = references
        if self.project.mode == "auto":
            name = "propose_directions"
            result = self._text_tool("brief", name, state, event.get("text", ""))
        else:
            name, result = self.providers.select_tool(
                sorted(ALLOWED_TOOLS["brief"]), self._context(state), event.get("text", "")
            )
        self._allow("brief", name)
        if name == "chat":
            if result.get("blocked_tool"):
                self._allow("brief", result["blocked_tool"])
            state.update(directions=[], pending_action=None)
            return self._finish(
                state, self._reply(result, "说说这次想拍什么样的穿搭吧。"), cards
            )
        state.update(
            directions=self._directions(result),
            stage="direction",
            pending_action=self._pending("choose_direction"),
        )
        jobs = self._preview_directions(state)
        return self._finish(
            state,
            self._reply(result, "方向已经整理好了，挑一个喜欢的，我们继续细化。"),
            [*cards, self._card("directions", {"options": state["directions"]})],
            jobs,
        )

    def _directions(self, result: dict, *, fresh: bool = False) -> list[dict]:
        directions = result.get("options", [])
        if not 2 <= len(directions) <= 3 or len({x.get("id") for x in directions}) != len(
            directions
        ):
            raise AppError("provider_invalid_response", "方向生成没有完成，请再试一次。", 502)
        recommended = next((i for i, item in enumerate(directions)
                            if item.get("recommended") is True), 0)
        directions = [dict(item, recommended=index == recommended)
                      for index, item in enumerate(directions)]
        if not fresh:
            return directions
        turn_id = self.providers.trace_context.get("turn_id", "")
        return [dict(item, id=str(uuid5(NAMESPACE_URL, f"{turn_id}:direction:{index}")))
                for index, item in enumerate(directions)]

    def _script(self, result: dict, state: dict) -> dict:
        script = {
            key: value for key, value in result.items() if key not in {"reply", "direction_id"}
        }
        shots = script.get("shots", [])
        if len(shots) < 3:
            raise AppError("provider_invalid_response", "脚本镜头不足，请再试一次。", 502)
        clean_shots = []
        for index, shot in enumerate(shots, 1):
            outfits = shot.get("outfit_asset_ids", [])
            if not outfits or any(x not in self.project.garment_asset_ids for x in outfits):
                raise AppError(
                    "provider_invalid_response", "脚本没有正确引用品牌衣服，请再试一次。", 502
                )
            limit = 2 if self.project.model_asset_id else 3
            if len(set(outfits)) > limit:
                raise AppError(
                    "provider_invalid_response",
                    f"单个镜头最多参考{limit}件衣服，请拆分穿搭后再试。",
                    502,
                )
            clean_shots.append({**shot, "id": f"shot-{index}", "outfit_asset_ids": outfits})
        state["script_revision"] = (
            max(
                state.get("script_revision", 0),
                (state.get("script") or {}).get("version", 1 if state.get("script") else 0),
            )
            + 1
        )
        script.update(status="draft", shots=clean_shots, version=state["script_revision"])
        script["video"] = {**script.get("video", {}), "duration": 5}
        return script

    @staticmethod
    def _pending(kind: str) -> dict:
        prompts = {
            "choose_direction": "挑一个喜欢的方向，也可以继续说说你想要的氛围。",
            "confirm_script": "脚本可以继续改，确认后才会批量生成图片。",
            "confirm_video": "图文笔记已准备好，想做 5 秒视频的话，请选一张图单独确认。",
        }
        return {"type": kind, "prompt": prompts[kind]}

    def handle(self, old_state: dict, event: dict) -> dict:
        state = dict(old_state)
        state["incoming"] = event
        state["images"] = image_items(self.session, self.project.id)
        if state.get("stage") == "video" and state.get("video"):
            job = self.session.get(Job, state["video"]["job_id"])
            if job:
                state["video"] = self._video_card_content(job)
                if job.status == "succeeded":
                    state["stage"] = "done"
        self.validate(state, event)
        action = event.get("action")
        if action:
            handlers = {
                "choose_direction": self._choose,
                "confirm_script": self._generate_images,
                "edit_image": self._edit_image,
                "approve_images": self._approve_images,
                "confirm_video": self._generate_video,
                "restore_script": self._restore_script,
            }
            return handlers[action["type"]](state, action)
        text, stage = event.get("text", "").strip(), state["stage"]
        name, args = self.providers.select_tool(
            sorted(ALLOWED_TOOLS[stage]), self._context(state), text
        )
        self._allow(stage, name)
        if name == "chat":
            if args.get("blocked_tool"):
                self._allow(stage, args["blocked_tool"])
            cards = []
            if state["images"]:
                cards.append(self._card("images", {"items": state["images"]}))
            if state.get("video"):
                cards.append(self._card("video", state["video"]))
            return self._finish(state, self._reply(args, "我们继续把这组穿搭打磨好。"), cards)
        if name == "propose_directions":
            state.update(
                directions=self._directions(args, fresh=True),
                stage="direction",
                pending_action=self._pending("choose_direction"),
            )
            jobs = self._preview_directions(state)
            return self._finish(
                state,
                self._reply(args, "新的方向准备好了，看看更喜欢哪一个。"),
                [self._card("directions", {"options": state["directions"]})],
                jobs,
            )
        if name == "write_script":
            action = {"type": "choose_direction", "direction_id": args.get("direction_id")}
            self.validate(state, {"action": action})
            return self._choose(state, action, result=args)
        if name == "revise_script":
            state.update(
                script=self._script(args, state),
                stage="script",
                pending_action=self._pending("confirm_script"),
            )
            return self._finish(
                state,
                self._reply(args, "脚本改好了，确认后再安排出图。"),
                [self._card("script", state["script"])],
            )
        if name == "restore_script":
            action = {"type": name, "checkpoint_id": args.get("checkpoint_id")}
            self.validate(state, {"action": action})
            return self._restore_script(state, action, result=args)
        if name == "edit_image":
            action = {
                "type": name,
                "image_id": args.get("image_id"),
                "instruction": args.get("instruction"),
            }
            for field in ("region", "mask_strokes"):
                if args.get(field) is not None:
                    action[field] = args[field]
            self.validate(state, {"action": action})
            return self._edit_image(state, action, result=args)
        if name == "write_note":
            selected = args.get("image_ids")
            accepted = []
            if stage in {"note", "video", "done"}:
                selected = state["note"]["image_ids"]
                accepted = state["note"].get("accepted_unverified_ids", [])
            return self._write_note(
                state, {"image_ids": selected, "accept_unverified": accepted}, text, result=args
            )
        # Free text may express intent, but spending requires the explicit UI action.
        if name in {"generate_images", "generate_video"}:
            kind = "confirm_script" if name == "generate_images" else "confirm_video"
            state["pending_action"] = self._pending(kind)
            reply = self._reply(args, "准备好了，请在确认卡片上确认后开始生成。")
            # 再做一条短片时把笔记卡带回来，选图确认就在最新消息里，不用往上翻。
            cards = []
            if kind == "confirm_video" and state.get("note"):
                cards.append(self._card("note", state["note"]))
            return self._finish(state, reply + "\n" + state["pending_action"]["prompt"], cards)
        raise AppError("tool_not_allowed", "这一步现在还做不了。" + STAGE_HINTS.get(stage, ""))

    def _choose(self, state: dict, action: dict, result: dict | None = None) -> dict:
        self._allow(state["stage"], "write_script")
        state["chosen_direction_id"] = action["direction_id"]
        result = result or self._text_tool("direction", "write_script", state)
        state.update(
            script=self._script(result, state),
            stage="script",
            pending_action=self._pending("confirm_script"),
        )
        return self._finish(
            state,
            self._reply(result, "脚本写好了，先看看，确认后再出图。"),
            [self._card("script", state["script"])],
        )

    def _restore_script(self, state: dict, action: dict, result: dict | None = None) -> dict:
        script = deepcopy(self.restore_scripts[action["checkpoint_id"]])
        script["status"] = "draft"
        fallback = "已恢复这版脚本，原来的图片也保留着，确认后可以按这版出图。"
        reply = (
            self._reply(result, fallback)
            if result
            else self._action_reply("restore_script", state, action, fallback)
        )
        state.update(script=script, stage="script", pending_action=self._pending("confirm_script"))
        return self._finish(state, reply, [self._card("script", script)])

    def _enqueue(self, state: dict, kind: str, payload: dict, dedupe_key: str) -> Job:
        job_id = str(uuid5(NAMESPACE_URL, dedupe_key))
        intent = {"id": job_id, "kind": kind, "payload": payload, "dedupe_key": dedupe_key}
        intents = {item["dedupe_key"]: item for item in state.get("job_intents", [])}
        intents[dedupe_key] = intent
        state["job_intents"] = list(intents.values())
        return self._restore_job(intent)

    def _restore_job(self, intent: dict) -> Job:
        job = self.session.scalar(select(Job).where(Job.dedupe_key == intent["dedupe_key"]))
        if job:
            return job
        assert_generation_allowed(
            self.session, self.project.user_id,
            kinds=("video",) if intent["kind"] == "video" else ("image",),
        )
        job = Job(
            id=intent["id"],
            project_id=self.project.id,
            user_id=self.project.user_id,
            kind=intent["kind"],
            status="queued",
            payload=intent["payload"],
            result={},
            dedupe_key=intent["dedupe_key"],
        )
        self.session.add(job)
        self.session.flush()
        self.created_paid_jobs = True
        return job

    def restore_jobs(self, state: dict) -> None:
        disabled = self.session.scalar(select(User.disabled).where(User.id == self.project.user_id))
        if disabled:
            return
        for intent in state.get("job_intents", []):
            try:
                self._restore_job(intent)
            except AppError as exc:
                if exc.code not in {"BUDGET_EXCEEDED", "MODEL_NOT_ALLOWED", "USER_DISABLED"}:
                    raise
                # State reads and ordinary chat remain available at a daily cap.
                # Missing paid work is recovered only once permission returns.
                return

    @staticmethod
    def _reference_prompt(state: dict) -> str:
        references = state.get("references") or []
        if not references:
            return ""
        labels = {
            "scene": "场景", "lighting": "光线", "composition": "构图",
            "mood": "氛围", "palette": "配色",
        }
        descriptions = []
        for index, reference in enumerate(references, 1):
            details = [f"{label}：{reference[key]}" for key, label in labels.items()
                       if reference.get(key)]
            if reference.get("style_tags"):
                details.append("风格：" + "、".join(reference["style_tags"]))
            descriptions.append(f"参考图{index}（{'；'.join(details)}）")
        return "参考图风格：" + "；".join(descriptions) + "。只借鉴风格，保留品牌衣服与博主身份。"

    def _garment_prompt(self, state: dict, asset_ids: list[str]) -> str:
        garments = {item["asset_id"]: item for item in state.get("garments", [])}
        parts = [
            f"原衣服{index}：{garments.get(asset_id, {}).get('color', '')}"
            f"{garments.get(asset_id, {}).get('material', '')}"
            f"{garments.get(asset_id, {}).get('category', '品牌衣服')}"
            for index, asset_id in enumerate(asset_ids, 1)
        ]
        return (
            "；".join(parts)
            + "。严格保持原衣服版型、颜色、面料、纽扣、口袋、logo，不得增删或改变。"
            + "吊牌、价签、织标贴纸、衣架、包装袋不属于衣服，必须忽略并从成品画面去除。"
            + self._reference_prompt(state)
        )

    def _preview_directions(self, state: dict) -> list[Job]:
        assert_generation_allowed(self.session, self.project.user_id)
        jobs = []
        clothes = self.project.garment_asset_ids[: 2 if self.project.model_asset_id else 3]
        person_refs, identity_text = model_references(self.session, self.project)
        refs = list(dict.fromkeys(person_refs + clothes))
        for direction in state["directions"]:
            photo_prompt = expand_photo_prompt(
                {"scene": direction["scene"]}, self.project.style_tags or [],
                state.get("references") or [],
            )
            prompt = (
                (f"人物身份：{identity_text}。" if identity_text else "")
                + f"穿搭方向灵感预览：{direction['name']}；场景：{direction['scene']}；"
                f"氛围：{direction['mood']}；配色：{direction['palette']}。"
                + (f"搭配建议：{direction['styling']}。" if direction.get("styling") else "")
                + self._garment_prompt(state, clothes)
            )
            prompt += photo_prompt
            key = f"{self.project.id}:preview:{fingerprint(direction)}"
            payload = {
                "purpose": "preview",
                "direction_id": direction["id"],
                "preview_group": fingerprint([item["id"] for item in state["directions"]]),
                "prompt": prompt,
                "photo_prompt": photo_prompt,
                "reference_asset_ids": refs,
                "garment_asset_ids": clothes,
            }
            job = self._enqueue(state, "image", payload, key)
            direction.update(preview_status=job.status)
            if job.result_asset_id:
                direction["preview_url"] = asset_dict(self._asset(job.result_asset_id))["url"]
            jobs.append(job)
        return jobs

    def _generate_images(self, state: dict, action: dict) -> dict:
        original_stage = state["stage"]
        if original_stage == "script":
            self._allow("script", "generate_images")
        reply = self._action_reply(
            "generate_images",
            {**state, "stage": "script"},
            action,
            "脚本确认了，图片会陆续出现在工作台。",
        )
        script = dict(state["script"])
        script["status"] = "confirmed"
        state["script"] = script
        script_hash, jobs = fingerprint(script), []
        # The first shot is the cover; every dependency is saved in both the
        # queue payload and graph intent before any worker can see the batch.
        cover_key = (
            f"{self.project.id}:image:{script_hash}:{script['shots'][0]['id']}"
            if script["shots"] else None
        )
        cover_id = str(uuid5(NAMESPACE_URL, cover_key)) if cover_key else None
        for shot in script["shots"]:
            photo_prompt = expand_photo_prompt(
                shot, self.project.style_tags or [], state.get("references") or [],
            )
            references, identity_text = model_references(self.session, self.project)
            references = list(dict.fromkeys(references + shot["outfit_asset_ids"]))
            prompt = (
                "小红书穿搭摄影，保持参考图中模特身份。"
                if self.project.model_asset_id
                else "小红书穿搭摄影，使用成年虚构模特：东亚面孔、小红书博主气质，自然妆容。"
            )
            if identity_text:
                prompt += f"人物身份卡：{identity_text}。"
            prompt += self._garment_prompt(state, shot["outfit_asset_ids"])
            prompt += f"场景：{shot['scene']}；动作：{shot['pose']}；镜头：{shot['camera']}。"
            if shot.get("styling"):
                # 博主在脚本里确认过的整套搭配：下装、鞋、配饰按这里画，不让模型随机配。
                prompt += f"整套搭配（已确认）：{shot['styling']}。"
            prompt += photo_prompt
            payload = {
                "shot_id": shot["id"],
                "photo_prompt": photo_prompt,
                "version": 1,
                "prompt": prompt,
                "reference_asset_ids": references,
                "script_hash": script_hash,
                "garment_asset_ids": shot["outfit_asset_ids"],
                "script_version": script.get("version", 1),
                "shot": deepcopy(shot),
            }
            key = f"{self.project.id}:image:{script_hash}:{shot['id']}"
            if references and (self.project.model_id or self.project.model_asset_id):
                payload["model_asset_id"] = references[0]
                payload["identity_asset_ids"], payload["identity_text"] = (
                    model_references(self.session, self.project)
                )
                if self.project.model_id:
                    payload["model_id"] = self.project.model_id
            if state.get("references"):
                payload["reference_style_prompt"] = self._reference_prompt(state)
            if cover_id and key != cover_key:
                payload["anchor_job_id"] = cover_id
            jobs.append(self._enqueue(state, "image", payload, key))
        state.update(stage="images", pending_action=None)
        return self._finish(
            state,
            reply,
            [
                self._card("script", script),
                self._card("images", {"items": image_items(self.session, self.project.id)}),
            ],
            jobs,
        )

    def _edit_key(self, action: dict) -> str:
        selection = {key: action[key] for key in ("region", "mask_strokes") if key in action}
        identity = [action["image_id"], action["instruction"].strip()]
        if selection:
            identity.append(selection)
        if action.get("attempt") is not None:
            identity.append(action["attempt"])
        return f"{self.project.id}:edit:{fingerprint(identity)}"

    def _edit_image(self, state: dict, action: dict, result: dict | None = None) -> dict:
        self._allow(state["stage"], "edit_image")
        parent, instruction = self._image_job(action["image_id"]), action["instruction"].strip()
        key = self._edit_key(action)
        existing = self.session.scalar(select(Job).where(Job.dedupe_key == key))
        if existing:
            return self._finish(
                state,
                "这次和上次一样，没有重新生成。",
                [self._card("images", {"items": image_items(self.session, self.project.id)})],
                [existing],
                reused=True,
            )
        reply = (
            self._reply(result, "这张会单独改一版，原图保留。")
            if result
            else self._action_reply("edit_image", state, action, "这张会单独改一版，原图保留。")
        )
        selection = {
            key: deepcopy(action[key]) for key in ("region", "mask_strokes") if key in action
        }
        shot_id = parent.payload["shot_id"]
        versions = [
            item["version"]
            for item in image_items(self.session, self.project.id)
            if item["shot_id"] == shot_id
        ]
        clothes = parent.payload.get("garment_asset_ids") or next(
            (
                shot["outfit_asset_ids"]
                for shot in (state.get("script") or {}).get("shots", [])
                if shot["id"] == shot_id
            ),
            self.project.garment_asset_ids,
        )
        clothes = list(dict.fromkeys(clothes))
        anchor_references = (
            [parent.payload["anchor_asset_id"]] if parent.payload.get("anchor_asset_id") else []
        )
        edit_clothes = clothes if anchor_references else clothes[:2]
        person_refs, identity_text = model_references(self.session, self.project)
        payload = {
            "shot_id": shot_id,
            "version": max(versions, default=1) + 1,
            "parent_id": parent.id,
            "parent_asset_id": parent.result_asset_id,
            "source_asset_id": parent.result_asset_id,
            "instruction": instruction,
            "prompt": "保留模特身份和未提到的画面细节。"
            + ("首张是待修原图，第二张是人物正脸，仅用于保持身份。" if person_refs else "")
            + (f"人物身份卡：{identity_text}。" if identity_text else "")
            + self._garment_prompt(state, clothes)
            + "只做以下修改："
            + instruction,
            "reference_asset_ids": list(dict.fromkeys([
                parent.result_asset_id, *person_refs[:1], *edit_clothes, *anchor_references,
            ])),
            "garment_asset_ids": clothes,
            "script_version": parent.payload.get("script_version"),
            "script_hash": parent.payload.get("script_hash"),
            "shot": deepcopy(parent.payload.get("shot", {})),
            **selection,
        }
        for field in ("anchor_id", "anchor_asset_id", "model_asset_id"):
            if parent.payload.get(field):
                payload[field] = parent.payload[field]
        if self.project.model_asset_id and not payload.get("model_asset_id"):
            payload["model_asset_id"] = self.project.model_asset_id
        if state.get("references"):
            payload["reference_style_prompt"] = self._reference_prompt(state)
        if action.get("attempt") is not None:
            payload["attempt"] = action["attempt"]
        job = self._enqueue(state, "edit", payload, key)
        # Editing an image must preserve the note and its video-confirmation pause.
        return self._finish(
            state,
            reply,
            [self._card("images", {"items": image_items(self.session, self.project.id)})],
            [job],
            reused=False,
        )

    def _approve_images(self, state: dict, action: dict) -> dict:
        if state["stage"] in {"video", "done"}:
            return self._swap_note_images(state, action)
        return self._write_note(state, action)

    def _swap_note_images(self, state: dict, action: dict) -> dict:
        """短片阶段以后换图：只换笔记里的图片，文字原样保留，不再花一次写笔记的钱。"""
        self._allow(state["stage"], "write_note")
        selected = action["image_ids"]
        accepted = self._validate_image_selection(selected, action.get("accept_unverified", []))
        previous = state["note"].get("image_ids", [])
        note = {**state["note"], "image_ids": selected, "accepted_unverified_ids": accepted}
        state.update(note=note, pending_action=None)
        reply = "笔记里的图已经换成这版，文字没动。"
        video = self._current_video_job(state)
        if video is not None and video.payload.get("image_id") in previous and (
            video.payload.get("image_id") not in selected
        ):
            reply += "短片用的还是原来那张首帧，想让短片也换成新版，就再做一条。"
        return self._finish(state, reply, [self._card("note", note)])

    def _write_note(
        self, state: dict, action: dict, instruction: str = "", result: dict | None = None
    ) -> dict:
        self._allow(state["stage"], "write_note")
        original_stage, selected = state["stage"], action["image_ids"]
        accepted = self._validate_image_selection(selected, action.get("accept_unverified", []))
        context = {**state, "selected_image_ids": selected, "_accepted_unverified_ids": accepted}
        context["images"] = [
            next(x for x in state["images"] if x["id"] == image_id) for image_id in selected
        ]
        result = result or self._text_tool(
            state["stage"],
            "write_note",
            context,
            "按已选图片顺序写小红书笔记：标题不超过20字；正文120到250字，最多5个短段，"
            "每段一两句，表情点到为止，不写长文；5到8个标签。用户要求更短或更长时以用户为准。"
            "正文要写进脚本各镜头 styling 里确认过的整套搭配（下装、鞋、配饰怎么配）。"
            + ("保留原笔记未要求更改的内容，落实以下修改：" + instruction if instruction else ""),
        )
        note = {key: value for key, value in result.items() if key != "reply"}
        note.update(
            title=str(note.get("title", "今天这套刚刚好"))[:20],
            image_ids=selected,
            accepted_unverified_ids=accepted,
            ai_label="本篇图片与视频含 AI 生成内容，发布时请勾选平台的 AI 内容声明。",
        )
        if original_stage in {"video", "done"}:
            state.update(note=note, pending_action=None)
        else:
            state.update(note=note, stage="note", pending_action=self._pending("confirm_video"))
        return self._finish(
            state,
            self._reply(result, "笔记写好了，可以再一起打磨文字。"),
            [self._card("note", note)],
        )

    def _current_video_job(self, state: dict) -> Job | None:
        job_id = (state.get("video") or {}).get("job_id")
        return self.session.get(Job, job_id) if job_id else None

    def _video_card_content(self, job: Job) -> dict:
        source = self._asset(job.payload["image_asset_id"])
        return {
            "status": job.status,
            "job_id": job.id,
            "url": job_dict(job)["url"],
            "poster_url": asset_dict(source)["url"],
        }

    def _generate_video(self, state: dict, action: dict) -> dict:
        if state["stage"] in {"note", "done"}:
            self._allow(state["stage"], "generate_video")
        reply = self._action_reply(
            "generate_video",
            {**state, "stage": "note"},
            action,
            "短片开始做了，大概两三分钟；做好我在这里喊你，这期间可以先改图或改笔记。",
            note=(
                "用户已经按下确认按钮，这一步本身就是确认，短片已经进入排队。"
                "回复只需告诉用户：短片开始做了、大概两三分钟、做好会在这里提醒、"
                "这期间可以改图或改笔记。不要再要求用户确认，不要说「确认后再生成」之类的话。"
            ),
        )
        image = self._image_job(action["image_id"])
        prompt = state["script"].get("video", {}).get("prompt", "模特自然展示穿搭，镜头缓慢移动")
        prompt += "；人物面部和服装保持不变。"
        identity = [image.id, prompt]
        previous = self._current_video_job(state)
        if previous is not None and (
            previous.status not in {"queued", "running"}
            or previous.payload.get("image_id") != image.id
        ):
            # 已有一条短片（做完或失败）后再做一条：换一个制作序号，不被旧任务去重。
            state["video_attempt"] = int(state.get("video_attempt") or 0) + 1
        if state.get("video_attempt"):
            identity.append(state["video_attempt"])
        key = f"{self.project.id}:video:{fingerprint(identity)}"
        payload = {
            "image_id": image.id,
            "image_asset_id": image.result_asset_id,
            "source_asset_id": image.result_asset_id,
            "poster_asset_id": image.result_asset_id,
            "prompt": prompt,
            "duration": 5,
            "watermark": True,
        }
        job = self._enqueue(state, "video", payload, key)
        state.update(
            video=self._video_card_content(job),
            pending_action=None,
            stage="done" if job.status == "succeeded" else "video",
        )
        return self._finish(state, reply, [self._card("video", state["video"])], [job])

    def _finish(
        self, state: dict, text: str, cards: list, jobs: list | None = None,
        *, reused: bool | None = None,
    ) -> dict:
        state.update(mode=self.project.mode, style_tags=list(self.project.style_tags or []))
        if self.project.mode == "auto":
            state["pending_action"] = None
        self.project.stage = state["stage"]
        self.project.updated_at = utcnow()
        state["images"] = image_items(self.session, self.project.id)
        state.update(
            turn_text=text,
            turn_cards=cards,
            turn_jobs=[
                {**job_dict(job, self.session),
                 **({"reused": reused} if reused is not None else {})}
                for job in jobs or []
            ],
            turn_trace=dialogue_trace(
                self.providers, self.tool, round((time.monotonic() - self.started) * 1000),
                list((state.get("incoming") or {}).get("refs", [])),
            ),
            turn_can_regenerate=not self.created_paid_jobs,
        )
        return state
