"""Stage-limited tools and replay-safe generation intents for the LangGraph."""

import hashlib
import json
import re
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.media import asset_dict
from app.models import Asset, Job, Project, utcnow
from app.providers import ProviderHub
from app.views import image_items, job_dict

ALLOWED_TOOLS = {
    "brief": {"analyze_garments", "propose_directions"},
    "direction": {"propose_directions", "write_script", "chat"},
    "script": {"revise_script", "generate_images", "chat"},
    "images": {"edit_image", "write_note", "chat"},
    "note": {"edit_image", "write_note", "generate_video", "chat"},
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
        ):
            raise AppError("image_not_found", "这张图片不属于当前项目。", 404)
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
        )
        context = {key: state.get(key) for key in keys}
        context.update(
            brand=self.project.brand,
            stage=state.get("stage", "brief"),
            max_outfit_assets_per_shot=2 if self.project.model_asset_id else 3,
        )
        context["selected_image_ids"] = state.get("selected_image_ids", [])
        context["chosen_direction"] = next(
            (
                item
                for item in state.get("directions", [])
                if item["id"] == state.get("chosen_direction_id")
            ),
            {},
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

    def validate(self, state: dict, event: dict) -> None:
        """Validate outside the interrupt so rejected actions leave it resumable."""
        action = event.get("action")
        if not action:
            return
        if not isinstance(action, dict) or not isinstance(action.get("type"), str):
            raise AppError("invalid_action", "无法识别这个操作。")
        stage = state.get("stage", "brief")
        kind = action.get("type")
        required = {
            "choose_direction": "write_script",
            "confirm_script": "generate_images",
            "edit_image": "edit_image",
            "approve_images": "write_note",
            "confirm_video": "generate_video",
        }
        if kind not in required:
            raise AppError("invalid_action", "无法识别这个操作。")
        if kind == "approve_images" and stage in {"video", "done"}:
            raise AppError("tool_not_allowed", "视频确认后可以修改笔记文字，图片顺序保留。")
        # Repeated confirmations are reads of the original jobs, not new spends.
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

    def start(self, event: dict) -> dict:
        self._allow("brief", "analyze_garments")
        assets = [self._asset(asset_id) for asset_id in self.project.garment_asset_ids]
        garments = self.providers.analyze_garments(assets)
        for item in garments:
            item["url"] = asset_dict(self._asset(item["asset_id"]))["url"]
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
        }
        result = self._text_tool("brief", "propose_directions", state, event.get("text", ""))
        directions = self._directions(result)
        state.update(
            directions=directions,
            stage="direction",
            pending_action=self._pending("choose_direction"),
        )
        return self._finish(
            state,
            "衣服我看过啦，颜色和质感很适合做一组有生活感的穿搭。"
            "我想了这几个拍摄方向，你更想先试哪一个？",
            [
                self._card("garments", {"items": garments}),
                self._card("directions", {"options": directions}),
            ],
        )

    @staticmethod
    def _directions(result: dict) -> list[dict]:
        directions = result.get("options", [])
        if not 2 <= len(directions) <= 3 or len({x.get("id") for x in directions}) != len(
            directions
        ):
            raise AppError("provider_invalid_response", "方向生成没有完成，请再试一次。", 502)
        return directions

    def _script(self, result: dict) -> dict:
        script = dict(result)
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
        script.update(status="draft", shots=clean_shots)
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
        self.validate(state, event)
        action = event.get("action")
        if action:
            handlers = {
                "choose_direction": self._choose,
                "confirm_script": self._generate_images,
                "edit_image": self._edit_image,
                "approve_images": self._write_note,
                "confirm_video": self._generate_video,
            }
            return handlers[action["type"]](state, action)
        text = event.get("text", "").strip()
        stage = state["stage"]
        if stage == "direction":
            chosen = self._direction_from_text(state, text)
            if chosen:
                return self._choose(state, {"direction_id": chosen})
            if not self._question(text):
                result = self._text_tool(stage, "propose_directions", state, text)
                state["directions"] = self._directions(result)
                return self._finish(
                    state,
                    "好呀，我按你说的换了几组思路，看看这次更接近吗？",
                    [self._card("directions", {"options": state["directions"]})],
                )
        elif stage == "script" and not self._question(text):
            result = self._text_tool(stage, "revise_script", state, text)
            state["script"] = self._script(result)
            return self._finish(
                state,
                "收到，我把场景、动作和配文一起改好了。你看看这版顺不顺，满意后再确认出图。",
                [self._card("script", state["script"])],
            )
        elif stage == "images":
            edit_action = self._image_edit_from_text(state, text)
            if edit_action:
                return self._edit_image(state, edit_action)
        elif (
            stage in {"note", "video", "done"}
            and state.get("note")
            and self._revision_requested(text)
            and not self._question(text)
        ):
            return self._write_note(state, {"image_ids": state["note"]["image_ids"]}, text)
        if stage == "video" and state.get("video"):
            job = self.session.get(Job, state["video"]["job_id"])
            if job:
                state["video"] = self._video_card_content(job)
                if job.status == "succeeded":
                    state["stage"] = "done"
        reply = self._text_tool(state["stage"], "chat", state, text)
        cards = []
        if state["images"]:
            cards.append(self._card("images", {"items": state["images"]}))
        if state.get("video"):
            cards.append(self._card("video", state["video"]))
        return self._finish(state, reply.get("text", "我们继续把这组穿搭打磨好。"), cards)

    @staticmethod
    def _question(text: str) -> bool:
        revision = ("换成", "改成", "调整", "重写", "增加", "删除", "不要", "更松弛", "改一下")
        if any(word in text for word in revision):
            return False
        return (
            not text
            or text.startswith(("请问", "解释", "你好", "谢谢"))
            or any(
                word in text
                for word in ("为什么", "多少钱", "什么区别", "是否", "怎么样", "怎么拍", "怎么搭")
            )
            or text.endswith(("?", "？"))
        )

    @staticmethod
    def _revision_requested(text: str) -> bool:
        return any(
            word in text
            for word in (
                "改",
                "换",
                "重写",
                "调整",
                "增加",
                "删除",
                "精简",
                "再短",
                "更短",
                "不要",
                "加上",
                "分段",
                "通勤风",
                "松弛一点",
            )
        )

    def _image_edit_from_text(self, state: dict, text: str) -> dict | None:
        if any(word in text for word in ("不要改", "先别", "不改", "不用改")):
            return None
        requested = self._revision_requested(text) or any(
            word in text for word in ("太暗", "太亮", "亮一点", "暗一点", "塞进", "修一下")
        )
        if not requested or ("为什么" in text and not self._revision_requested(text)):
            return None
        images = state["images"]
        target = next((item for item in images if item["id"] in text), None)
        ordinal = re.search(r"第\s*(10|[1-9一二三四五六七八九十])\s*张", text)
        if target is None and ordinal:
            numbers = {word: index for index, word in enumerate("一二三四五六七八九十", 1)}
            number = int(ordinal[1]) if ordinal[1].isdigit() else numbers[ordinal[1]]
            if 0 < number <= len(images):
                target = images[number - 1]
        if target is None and len(images) == 1:
            target = images[0]
        if target is None or target["status"] != "succeeded":
            return None
        return {"type": "edit_image", "image_id": target["id"], "instruction": text}

    @staticmethod
    def _direction_from_text(state: dict, text: str) -> str | None:
        for option in state["directions"]:
            if text in {option["id"], option.get("name")}:
                return option["id"]
        match = re.fullmatch(
            r"(?:我选|选择|就选|选)?\s*第?\s*([123一二三])\s*(?:个|种|吧|方向)?", text
        )
        if match:
            index = {"一": 0, "二": 1, "三": 2, "1": 0, "2": 1, "3": 2}[match[1]]
            if index < len(state["directions"]):
                return state["directions"][index]["id"]
        return None

    def _choose(self, state: dict, action: dict) -> dict:
        self._allow(state["stage"], "write_script")
        state["chosen_direction_id"] = action["direction_id"]
        result = self._text_tool("direction", "write_script", state)
        state.update(
            script=self._script(result),
            stage="script",
            pending_action=self._pending("confirm_script"),
        )
        return self._finish(
            state,
            "就拍这个方向吧！我把封面和每张图的穿搭、动作都写好了。"
            "先看看脚本，想换成通勤风或者再松弛一点都可以继续改。",
            [self._card("script", state["script"])],
        )

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
        """Repair checkpoint/transaction commit gaps without creating new spends."""
        for intent in state.get("job_intents", []):
            self._restore_job(intent)

    def _generate_images(self, state: dict, action: dict) -> dict:
        script = dict(state["script"])
        if state["stage"] == "script":
            self._allow("script", "generate_images")
        script["status"] = "confirmed"
        state["script"] = script
        script_hash = fingerprint(script)
        jobs = []
        for shot in script["shots"]:
            references = [self.project.model_asset_id] if self.project.model_asset_id else []
            references += shot["outfit_asset_ids"]
            references = list(dict.fromkeys(references))
            prompt = (
                "小红书穿搭摄影，保持参考图中模特身份和品牌衣服细节。"
                if self.project.model_asset_id
                else "小红书穿搭摄影，使用成年虚构模特，保持参考品牌衣服的颜色面料细节。"
            )
            prompt += f"场景：{shot['scene']}；动作：{shot['pose']}；镜头：{shot['camera']}。"
            payload = {
                "shot_id": shot["id"],
                "version": 1,
                "prompt": prompt,
                "reference_asset_ids": references,
                "script_hash": script_hash,
            }
            key = f"{self.project.id}:image:{script_hash}:{shot['id']}"
            jobs.append(self._enqueue(state, "image", payload, key))
        state.update(stage="images", pending_action=None)
        return self._finish(
            state,
            "脚本确认啦，我已经把这组图安排上了。"
            "图片会陆续出现在工作台，喜欢的留下，细节不满意我们再改。",
            [
                self._card("script", script),
                self._card("images", {"items": image_items(self.session, self.project.id)}),
            ],
            jobs,
        )

    def _edit_image(self, state: dict, action: dict) -> dict:
        self._allow(state["stage"], "edit_image")
        parent = self._image_job(action["image_id"])
        instruction = action["instruction"].strip()
        key = f"{self.project.id}:edit:{fingerprint([parent.id, instruction])}"
        existing = self.session.scalar(select(Job).where(Job.dedupe_key == key))
        if existing:
            return self._finish(
                state,
                "这处修改已经安排好了，我会保留原图方便你比较。",
                [self._card("images", {"items": image_items(self.session, self.project.id)})],
                [existing],
            )
        shot_id = parent.payload["shot_id"]
        versions = [
            item["version"]
            for item in image_items(self.session, self.project.id)
            if item["shot_id"] == shot_id
        ]
        payload = {
            "shot_id": shot_id,
            "version": max(versions, default=1) + 1,
            "parent_id": parent.id,
            "parent_asset_id": parent.result_asset_id,
            "source_asset_id": parent.result_asset_id,
            "instruction": instruction,
            "prompt": "保留模特身份、衣服和画面未提到的细节，只做以下修改：" + instruction,
            "reference_asset_ids": [parent.result_asset_id],
        }
        job = self._enqueue(state, "edit", payload, key)
        state.update(stage="images", pending_action=None)
        return self._finish(
            state,
            "好，这张我单独改一版，原图也会保留。等新图出来我们对比着挑。",
            [self._card("images", {"items": image_items(self.session, self.project.id)})],
            [job],
        )

    def _write_note(self, state: dict, action: dict, instruction: str = "") -> dict:
        self._allow(state["stage"], "write_note")
        original_stage = state["stage"]
        selected = action["image_ids"]
        context = {**state, "selected_image_ids": selected}
        # The selected order is part of the tool context and ultimately authoritative.
        context["images"] = [
            next(x for x in state["images"] if x["id"] == image_id) for image_id in selected
        ]
        note = self._text_tool(
            state["stage"],
            "write_note",
            context,
            "按已选图片顺序写小红书笔记，标题不超过20字，正文分段带表情，5到8个标签。"
            + ("保留原笔记未要求更改的内容，落实以下修改：" + instruction if instruction else ""),
        )
        note = {
            **note,
            "title": str(note.get("title", "今天这套刚刚好"))[:20],
            "image_ids": selected,
        }
        if original_stage in {"video", "done"}:
            state.update(note=note, pending_action=None)
            return self._finish(
                state,
                "好，我把笔记文字改好了，你再看看这版。",
                [self._card("note", note)],
            )
        state.update(note=note, stage="note", pending_action=self._pending("confirm_video"))
        return self._finish(
            state,
            "这几张放在一起很顺，我按你选的顺序写好笔记了。"
            "想再加一条 5 秒穿搭视频的话，选一张最喜欢的图确认就好。",
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
        image = self._image_job(action["image_id"])
        prompt = state["script"].get("video", {}).get("prompt", "模特自然展示穿搭，镜头缓慢移动")
        key = f"{self.project.id}:video:{fingerprint([image.id, prompt])}"
        payload = {
            "image_id": image.id,
            "image_asset_id": image.result_asset_id,
            "source_asset_id": image.result_asset_id,
            "poster_asset_id": image.result_asset_id,
            "prompt": prompt,
            "duration": 5,
        }
        job = self._enqueue(state, "video", payload, key)
        state.update(
            video=self._video_card_content(job),
            pending_action=None,
            stage="done" if job.status == "succeeded" else "video",
        )
        return self._finish(
            state,
            "视频也安排好啦，做成 5 秒自然展示穿搭的小片段，做好就会出现在这里。",
            [self._card("video", state["video"])],
            [job],
        )

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
