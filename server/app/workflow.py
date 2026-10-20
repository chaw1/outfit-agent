"""Model-selected tools within deterministic, replay-safe stage boundaries."""

import hashlib
import json
from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.media import asset_dict
from app.models import Asset, Job, Project, utcnow
from app.providers import ProviderHub
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
    "video": {"write_note", "chat"},
    "done": {"write_note", "chat"},
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

    def _allow(self, stage: str, tool: str) -> None:
        if tool not in ALLOWED_TOOLS.get(stage, set()):
            raise AppError("tool_not_allowed", "当前阶段不能执行这个操作，请先完成前面的确认。")

    def _card(self, kind: str, content: dict) -> dict:
        return {"id": f"{self.project.id}:{kind}", "type": kind, **content}

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
        context.update(
            brand=self.project.brand,
            stage=state.get("stage", "brief"),
            max_outfit_assets_per_shot=2 if self.project.model_asset_id else 3,
            script_versions=self.script_versions,
        )
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
                }
            )
        recent_messages = []
        for message in state.get("messages", [])[-12:]:
            if isinstance(message, dict):
                role, content = message.get("role"), message.get("content", "")
            else:
                role, content = getattr(message, "type", ""), getattr(message, "content", "")
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
                recent_messages.append({"role": role, "text": content[:1000]})
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

    def _action_reply(self, tool: str, state: dict, action: dict, fallback: str) -> str:
        result = self._text_tool(
            state["stage"], tool, state, json.dumps(action, ensure_ascii=False)
        )
        return self._reply(result, fallback)

    def validate(self, state: dict, event: dict) -> None:
        """Validate outside interrupt, so a rejected action leaves its pause intact."""
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
        if kind == "approve_images" and stage in {"video", "done"}:
            raise AppError("tool_not_allowed", "视频确认后可以修改笔记文字，图片顺序保留。")
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
            self._image_job(action.get("image_id", ""))
            if not isinstance(action.get("instruction"), str) or not action["instruction"].strip():
                raise AppError("instruction_required", "请告诉我这张图想改哪里。")
        elif kind == "approve_images":
            ids = action.get("image_ids")
            if (
                not isinstance(ids, list)
                or not ids
                or any(not isinstance(value, str) for value in ids)
                or len(ids) != len(set(ids))
            ):
                raise AppError("images_required", "请按笔记顺序选择至少一张图片，不要重复。")
            for image_id in ids:
                self._image_job(image_id)
        elif kind == "confirm_video":
            self._image_job(action.get("image_id", ""))
            if not state.get("note"):
                raise AppError("note_not_ready", "先选好笔记图片，再确认视频。")
            if action["image_id"] not in state["note"].get("image_ids", []):
                raise AppError("image_not_selected", "请从已选入笔记的图片里选择视频首帧。")
            if repeated_video:
                video_job = self.session.get(Job, (state.get("video") or {}).get("job_id"))
                if not video_job or video_job.payload.get("image_id") != action["image_id"]:
                    raise AppError("video_already_confirmed", "这个项目已经确认了视频生成。")

    def start(self, event: dict, emit=None) -> dict:
        assets = [self._asset(asset_id) for asset_id in self.project.garment_asset_ids]
        garments = self.providers.analyze_garments(assets)
        for item in garments:
            item["url"] = asset_dict(self._asset(item["asset_id"]))["url"]
        garment_card = self._card("garments", {"items": garments})
        if emit:
            emit({"event": "card", "data": garment_card})
        garment_summary = "、".join(
            f"{item.get('color', '')}{item.get('category', '衣服')}" for item in garments
        )
        summary = f"品牌：{self.project.brand}；合作需求：{self.project.brief[:300]}"
        if event.get("text"):
            summary += f"；博主补充：{event['text'][:300]}"
        summary += f"；已识别衣服：{garment_summary}"
        state = {
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
        name, result = self.providers.select_tool(
            sorted(ALLOWED_TOOLS["brief"]), self._context(state), event.get("text", "")
        )
        self._allow("brief", name)
        if name == "chat":
            if result.get("blocked_tool"):
                self._allow("brief", result["blocked_tool"])
            state.update(directions=[], pending_action=None)
            return self._finish(
                state, self._reply(result, "说说这次想拍什么样的穿搭吧。"), [garment_card]
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
            [garment_card, self._card("directions", {"options": state["directions"]})],
            jobs,
        )

    @staticmethod
    def _directions(result: dict) -> list[dict]:
        directions = result.get("options", [])
        if not 2 <= len(directions) <= 3 or len({x.get("id") for x in directions}) != len(
            directions
        ):
            raise AppError("provider_invalid_response", "方向生成没有完成，请再试一次。", 502)
        return directions

    def _script(self, result: dict, state: dict) -> dict:
        script = {
            key: value for key, value in result.items() if key not in {"reply", "direction_id"}
        }
        shots = script.get("shots", [])
        if len(shots) < 4:
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
                "approve_images": self._write_note,
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
                directions=self._directions(args),
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
            self.validate(state, {"action": action})
            return self._edit_image(state, action, result=args)
        if name == "write_note":
            selected = args.get("image_ids")
            if stage in {"note", "video", "done"}:
                selected = state["note"]["image_ids"]
                for image_id in selected:
                    self._image_job(image_id)
            else:
                self.validate(state, {"action": {"type": "approve_images", "image_ids": selected}})
            return self._write_note(state, {"image_ids": selected}, text, result=args)
        # Free text may express intent, but spending requires the explicit UI action.
        if name in {"generate_images", "generate_video"}:
            kind = "confirm_script" if name == "generate_images" else "confirm_video"
            state["pending_action"] = self._pending(kind)
            reply = self._reply(args, "准备好了，请在确认卡片上确认后开始生成。")
            return self._finish(state, reply + "\n" + state["pending_action"]["prompt"], [])
        raise AppError("tool_not_allowed", "当前阶段不能执行这个操作，请先完成前面的确认。")

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
        return job

    def restore_jobs(self, state: dict) -> None:
        for intent in state.get("job_intents", []):
            self._restore_job(intent)

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
        )

    def _preview_directions(self, state: dict) -> list[Job]:
        jobs = []
        clothes = self.project.garment_asset_ids[: 2 if self.project.model_asset_id else 3]
        refs = ([self.project.model_asset_id] if self.project.model_asset_id else []) + clothes
        for direction in state["directions"]:
            prompt = (
                f"穿搭方向灵感预览：{direction['name']}；场景：{direction['scene']}；"
                f"氛围：{direction['mood']}；配色：{direction['palette']}。"
                + self._garment_prompt(state, clothes)
            )
            key = f"{self.project.id}:preview:{fingerprint(direction)}"
            payload = {
                "purpose": "preview",
                "direction_id": direction["id"],
                "prompt": prompt,
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
        for shot in script["shots"]:
            references = [self.project.model_asset_id] if self.project.model_asset_id else []
            references = list(dict.fromkeys(references + shot["outfit_asset_ids"]))
            prompt = (
                "小红书穿搭摄影，保持参考图中模特身份。"
                if self.project.model_asset_id
                else "小红书穿搭摄影，使用成年虚构模特。"
            )
            prompt += self._garment_prompt(state, shot["outfit_asset_ids"])
            prompt += f"场景：{shot['scene']}；动作：{shot['pose']}；镜头：{shot['camera']}。"
            payload = {
                "shot_id": shot["id"],
                "version": 1,
                "prompt": prompt,
                "reference_asset_ids": references,
                "script_hash": script_hash,
                "garment_asset_ids": shot["outfit_asset_ids"],
                "script_version": script.get("version", 1),
                "shot": deepcopy(shot),
            }
            key = f"{self.project.id}:image:{script_hash}:{shot['id']}"
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

    def _edit_image(self, state: dict, action: dict, result: dict | None = None) -> dict:
        self._allow(state["stage"], "edit_image")
        parent, instruction = self._image_job(action["image_id"]), action["instruction"].strip()
        reply = (
            self._reply(result, "这张会单独改一版，原图保留。")
            if result
            else self._action_reply("edit_image", state, action, "这张会单独改一版，原图保留。")
        )
        key = f"{self.project.id}:edit:{fingerprint([parent.id, instruction])}"
        existing = self.session.scalar(select(Job).where(Job.dedupe_key == key))
        if existing:
            return self._finish(
                state,
                reply,
                [self._card("images", {"items": image_items(self.session, self.project.id)})],
                [existing],
            )
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
        payload = {
            "shot_id": shot_id,
            "version": max(versions, default=1) + 1,
            "parent_id": parent.id,
            "parent_asset_id": parent.result_asset_id,
            "source_asset_id": parent.result_asset_id,
            "instruction": instruction,
            "prompt": "保留模特身份和未提到的画面细节。"
            + self._garment_prompt(state, clothes)
            + "只做以下修改："
            + instruction,
            "reference_asset_ids": [parent.result_asset_id, *clothes[:2]],
            "garment_asset_ids": clothes,
            "script_version": parent.payload.get("script_version"),
            "script_hash": parent.payload.get("script_hash"),
            "shot": deepcopy(parent.payload.get("shot", {})),
        }
        job = self._enqueue(state, "edit", payload, key)
        # Editing an image must preserve the note and its video-confirmation pause.
        return self._finish(
            state,
            reply,
            [self._card("images", {"items": image_items(self.session, self.project.id)})],
            [job],
        )

    def _write_note(
        self, state: dict, action: dict, instruction: str = "", result: dict | None = None
    ) -> dict:
        self._allow(state["stage"], "write_note")
        original_stage, selected = state["stage"], action["image_ids"]
        context = {**state, "selected_image_ids": selected}
        context["images"] = [
            next(x for x in state["images"] if x["id"] == image_id) for image_id in selected
        ]
        result = result or self._text_tool(
            state["stage"],
            "write_note",
            context,
            "按已选图片顺序写小红书笔记，标题不超过20字，正文分段带表情，5到8个标签。"
            + ("保留原笔记未要求更改的内容，落实以下修改：" + instruction if instruction else ""),
        )
        note = {key: value for key, value in result.items() if key != "reply"}
        note.update(
            title=str(note.get("title", "今天这套刚刚好"))[:20],
            image_ids=selected,
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

    def _video_card_content(self, job: Job) -> dict:
        source = self._asset(job.payload["image_asset_id"])
        return {
            "status": job.status,
            "job_id": job.id,
            "url": job_dict(job)["url"],
            "poster_url": asset_dict(source)["url"],
        }

    def _generate_video(self, state: dict, action: dict) -> dict:
        if state["stage"] == "note":
            self._allow("note", "generate_video")
        reply = self._action_reply(
            "generate_video",
            {**state, "stage": "note"},
            action,
            "5 秒穿搭视频已安排好，完成后会出现在这里。",
        )
        image = self._image_job(action["image_id"])
        prompt = state["script"].get("video", {}).get("prompt", "模特自然展示穿搭，镜头缓慢移动")
        prompt += "；人物面部和服装保持不变。"
        key = f"{self.project.id}:video:{fingerprint([image.id, prompt])}"
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

    def _finish(self, state: dict, text: str, cards: list, jobs: list | None = None) -> dict:
        self.project.stage = state["stage"]
        self.project.updated_at = utcnow()
        state["images"] = image_items(self.session, self.project.id)
        state.update(
            turn_text=text,
            turn_cards=cards,
            turn_jobs=[job_dict(job, self.session) for job in jobs or []],
        )
        return state
