"""Model adapters. Mock branches are local, including their media and usage records."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from PIL import Image, ImageDraw, ImageOps
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Asset, UsageLedger


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code = "PROVIDER_ERROR"
        self.message = message
        self.retryable = retryable


class BudgetExceeded(ProviderError):
    def __init__(self, message: str):
        super().__init__(message)
        self.code = "BUDGET_EXCEEDED"


@dataclass
class GeneratedMedia:
    data: bytes
    mime: str
    model: str
    width: int | None = None
    height: int | None = None


def _obj(**properties: dict) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


STR = {"type": "string"}
STRINGS = {"type": "array", "items": STR}
DIRECTION = _obj(
    id=STR,
    name=STR,
    scene=STR,
    mood=STR,
    palette=STRINGS,
    why=STR,
    sample_title=STR,
)
SHOT = _obj(id=STR, scene=STR, outfit_asset_ids=STRINGS, pose=STR, camera=STR, caption=STR)
SCRIPT = _obj(
    status={"type": "string", "enum": ["draft"]},
    title_ideas=STRINGS,
    cover=_obj(scene=STR, pose=STR, text_overlay=STR),
    shots={"type": "array", "items": SHOT, "minItems": 4, "maxItems": 6},
    video=_obj(prompt=STR, duration={"type": "integer", "enum": [5]}),
)
TOOL_SCHEMAS = {
    "propose_directions": _obj(
        options={
            "type": "array",
            "items": DIRECTION,
            "minItems": 2,
            "maxItems": 3,
        }
    ),
    "write_script": SCRIPT,
    "revise_script": SCRIPT,
    "write_note": _obj(title=STR, body=STR, tags=STRINGS, image_ids=STRINGS),
    "chat": _obj(text=STR),
}
SYSTEM_PROMPT = """你是懂小红书穿搭创作的搭档，像博主朋友一样自然说中文。
根据品牌需求和真实衣服分析制作内容，不编造面料、品牌功效或用户经历。
通过唯一提供的工具返回完整结构化结果，不调用任何其他工具，不承诺已生成媒体。
方向给 2–3 个，场景、氛围、配色各不相同，id 使用 direction-1 这样的稳定短标识。
脚本至少 4 个镜头，id 为 shot-1 等，outfit_asset_ids 必须引用上下文的衣服资产 ID，
每个镜头引用衣服数量不得超过 context.max_outfit_assets_per_shot，衣服多时分镜分开搭配。
保持已存在镜头的 id，覆盖封面、全身、细节和生活场景。修改时逐条落实用户指令，
例如“换成通勤风”要重写场景、动作、文案；status 始终 draft 等博主确认。
笔记标题不超过 20 个字，正文有自然分段和适量表情，话题标签 5–8 个，
image_ids 严格使用用户选择的图片 ID 和顺序。
write_note 必须逐张查看已选 images 的 instruction，按最终选图与本轮用户 instruction 写正文；
事实优先级：本轮用户修正 > 已选图片的改图 instruction > 旧 script、旧笔记和原图描述。
例如已选 v2 要求“衬衫塞进裤腰”，正文就应写塞进裤腰，不能沿用旧稿“衬衫外放”。
用户要求改穿搭、场景或风格，必须实际改写正文相应段落，不能只改标题和标签。
没有用户明确提供的亲身体验，禁止杜撰“我穿了一整天”“坐一天也舒服”“肩颈不勒”
“透气不闷”“亲肤”等试穿感受或功能结论；自然口吻不等于编造经历。
围绕衣服分析和已选图片可确认的配色、版型、衣摆处理与搭配建议来写，
无法确认的面料、性能、身体感受和生活经历直接省略。视频 5 秒，保持人物和衣服一致。
所有字段填完整，工具参数中不要放额外解释。"""

_ledger_engines = {}
_ledger_engines_lock = threading.Lock()


class ProviderHub:
    def __init__(self, session: Session, project_id: str | None = None):
        self.session = session
        self.project_id = project_id

    @property
    def mock(self) -> bool:
        return settings.mock_providers

    def _model(self, kind: str) -> str:
        defaults = {
            "text": "deepseek-flash",
            "vision": "qwen3-vl-plus",
            "image": "wan2.7-image-pro",
            "video": "wan2.6-i2v-flash",
        }
        return getattr(settings, f"{kind}_model", defaults[kind])

    def _ledger_bind(self):
        bind = self.session.get_bind()
        if bind.dialect.name != "postgresql":
            return bind
        # Accounting must remain available while every business connection is
        # held by an in-flight conversation. This pool has an independent cap.
        url = bind.engine.url
        with _ledger_engines_lock:
            if url not in _ledger_engines:
                _ledger_engines[url] = create_engine(
                    url,
                    pool_size=2,
                    max_overflow=4,
                    pool_pre_ping=True,
                )
            return _ledger_engines[url]

    def _reserve(self, kind: str, estimate: Decimal) -> str:
        """Commit accounting separately so a failed API transaction cannot erase spend.

        The Postgres advisory lock serializes reservations across API and workers.
        Outstanding reservations count against the cap even after a process crashes.
        """
        with Session(self._ledger_bind()) as ledger_session:
            if ledger_session.bind.dialect.name == "postgresql":
                ledger_session.execute(text("SELECT pg_advisory_xact_lock(708827141)"))
            if not self.mock:
                spent = ledger_session.scalar(
                    select(
                        func.coalesce(
                            func.sum(UsageLedger.estimated_cny),
                            0,
                        )
                    )
                )
                cap = Decimal(str(getattr(settings, "model_budget_cny", 12)))
                if Decimal(str(spent)) + estimate > cap:
                    raise BudgetExceeded("本轮模型预算已接近 12 元，请先核对账单再继续。")
            row = UsageLedger(
                project_id=self.project_id,
                model=self._model(kind),
                kind=kind,
                duration_ms=0,
                units={"mock": self.mock, "reserved_cny": str(estimate)},
                estimated_cny=Decimal(0) if self.mock else estimate,
                status="reserved",
            )
            ledger_session.add(row)
            ledger_session.flush()
            ledger_id = row.id
            ledger_session.commit()
            return ledger_id

    def _finish(
        self,
        ledger_id: str,
        started: float,
        *,
        units: dict | None = None,
        cost: Decimal | None = None,
        status: str = "succeeded",
    ) -> None:
        with Session(self._ledger_bind()) as ledger_session:
            row = ledger_session.get(UsageLedger, ledger_id)
            row.duration_ms = round((time.monotonic() - started) * 1000)
            row.units = {**row.units, **(units or {})}
            row.status = status
            if cost is not None:
                row.estimated_cny = Decimal(0) if self.mock else cost
            ledger_session.commit()

    def _call(self, kind: str, estimate: str, operation: Callable) -> Any:
        started = time.monotonic()
        ledger_id = self._reserve(kind, Decimal(estimate))
        try:
            result, units, cost = operation()
        except Exception as exc:
            # A timeout can follow upstream acceptance; retain the reservation as
            # a conservative estimate instead of claiming that failure was free.
            self._finish(
                ledger_id,
                started,
                status="failed",
                units={
                    "error_type": type(exc).__name__,
                },
            )
            if isinstance(exc, (KeyError, ValueError, TypeError)):
                raise ProviderError("模型返回内容格式有误，请稍后重试。") from None
            raise
        self._finish(ledger_id, started, units=units, cost=cost)
        return result

    def _client(self) -> httpx.Client:
        return httpx.Client(
            timeout=httpx.Timeout(float(getattr(settings, "provider_timeout_seconds", 180))),
            follow_redirects=False,
            trust_env=False,
        )

    @staticmethod
    def _headers(key: str) -> dict:
        if not key:
            raise ProviderError("模型密钥未配置。")
        return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    @staticmethod
    def _json(response: httpx.Response) -> dict:
        if response.is_error:
            # Do not expose response bodies, request headers, or signed media URLs.
            try:
                body = response.json()
                code = body.get("code") or body.get("error", {}).get("code", "HTTPError")
            except (ValueError, AttributeError):
                code = "HTTPError"
            safe_code = "".join(c for c in str(code) if c.isalnum() or c in "._-")[:80]
            raise ProviderError(
                f"模型服务返回 {response.status_code}（{safe_code}）。",
                retryable=response.status_code == 429 or response.status_code >= 500,
            )
        result = response.json()
        if result.get("code"):
            raise ProviderError("模型服务拒绝了请求，请核对模型和额度。")
        return result

    @staticmethod
    def _data_url(asset: Asset, *, vision: bool = False) -> str:
        root = Path(settings.media_dir).resolve()
        path = (root / asset.path).resolve()
        if not path.is_relative_to(root):
            raise ProviderError("素材路径无效。")
        # Upload compact oriented copies so large generated PNGs do not create
        # multi-megabyte Base64 bodies for an edit or a video first frame.
        # The source file and asset metadata remain unchanged.
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, "white")
                image.paste(rgba, mask=rgba.getchannel("A"))
            else:
                image = image.convert("RGB")
            longest_side = 1024 if vision else 1536
            image.thumbnail((longest_side, longest_side))
            output = io.BytesIO()
            image.save(output, "JPEG", quality=90, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode()

    @staticmethod
    def _download(client: httpx.Client, url: str, mime: str, model: str) -> GeneratedMedia:
        parsed = urlparse(url)
        # The URL comes exclusively from the configured model service, but still
        # reject non-HTTPS and literal local destinations before server fetch.
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not host or host in {"localhost", "127.0.0.1", "::1"}:
            raise ProviderError("模型返回了无效的媒体下载地址。")
        data = b""
        for attempt in range(3):
            try:
                with client.stream("GET", url, follow_redirects=True) as response:
                    response.raise_for_status()
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 100 * 1024 * 1024:
                            raise ProviderError("生成媒体超过 100 MB 限制。")
                        chunks.append(chunk)
                    data = b"".join(chunks)
                break
            except httpx.HTTPError:
                if attempt == 2:
                    raise ProviderError("生成结果下载失败，请稍后重试。", retryable=True) from None
                time.sleep(attempt + 1)
        width = height = None
        if mime.startswith("image/"):
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
                width, height = image.size
        return GeneratedMedia(data=data, mime=mime, model=model, width=width, height=height)

    def analyze_garments(self, assets: list[Asset]) -> list[dict]:
        if not assets:
            raise ProviderError("请先上传至少一张衣服图片。")
        if len(assets) > 6:
            items = []
            for offset in range(0, len(assets), 6):
                items.extend(self.analyze_garments(assets[offset : offset + 6]))
            return items

        def operation():
            if self.mock:
                items = [
                    {
                        "asset_id": a.id,
                        "category": "衬衫" if i % 2 == 0 else "牛仔裤",
                        "color": "奶油白" if i % 2 == 0 else "浅蓝色",
                        "material": "待确认",
                        "style_tags": ["松弛", "日常", "简约"],
                    }
                    for i, a in enumerate(assets)
                ]
                return items, {"images": len(assets)}, Decimal(0)
            content = [
                {
                    "type": "text",
                    "text": (
                        "逐张分析衣服，严格输出 JSON 对象 "
                        "{items:[{asset_id,category,color,material,style_tags:[]}]}。"
                        "材质无法确定时写‘视觉判断，待确认’，保留对应的资产 ID。"
                    ),
                }
            ]
            for asset in assets:
                content.extend(
                    [
                        {"type": "text", "text": f"资产 ID：{asset.id}"},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": self._data_url(
                                    asset,
                                    vision=True,
                                )
                            },
                        },
                    ]
                )
            with self._client() as client:
                response = self._json(
                    client.post(
                        f"{settings.dashscope_compatible_url.rstrip('/')}/chat/completions",
                        headers=self._headers(settings.dashscope_api_key),
                        json={
                            "model": self._model("vision"),
                            "messages": [{"role": "user", "content": content}],
                            "enable_thinking": False,
                            "response_format": {"type": "json_object"},
                            "max_tokens": 1600,
                        },
                    )
                )
            items = json.loads(response["choices"][0]["message"]["content"])["items"]
            expected = {asset.id for asset in assets}
            if len(items) != len(assets) or {item.get("asset_id") for item in items} != expected:
                raise ProviderError("看图结果未正确关联衣服，请重试。")
            for item in items:
                if not all(key in item for key in ("category", "color", "material", "style_tags")):
                    raise ProviderError("看图结果缺少必要字段。")
            usage = response.get("usage", {})
            tokens = usage.get("prompt_tokens", 0)
            rate = Decimal("1") if tokens <= 32_768 else Decimal("1.5")
            if tokens > 131_072:
                rate = Decimal("3")
            cost = Decimal(tokens) + Decimal(usage.get("completion_tokens", 0)) * 10
            cost = cost * rate / 1_000_000 if "prompt_tokens" in usage else None
            return items, usage, cost

        # Resized <=1 MP inputs are far below 16k visual tokens each. Reserve
        # using that generous bound and the most expensive Beijing token tier.
        reserve = Decimal(16_384 * len(assets) * 3 + 1600 * 30 + 3000) / 1_000_000
        return self._call("vision", str(reserve), operation)

    def text(self, tool_name: str, context: dict, instruction: str = "") -> dict:
        if tool_name not in TOOL_SCHEMAS:
            raise ProviderError("该阶段不允许调用这个工具。")
        user_content = json.dumps(
            {"context": context, "instruction": instruction}, ensure_ascii=False, default=str
        )
        # UTF-8 byte count bounds token count without a tokenizer dependency.
        input_bound = len(user_content.encode()) + len(SYSTEM_PROMPT.encode())
        input_bound += len(json.dumps(TOOL_SCHEMAS[tool_name]).encode()) + 1024
        reserve = Decimal(input_bound) * Decimal("0.3") + Decimal(3500) * Decimal("1.2")
        reserve = max(Decimal("0.15"), reserve * Decimal("7.5") / 1_000_000)

        def operation():
            if self.mock:
                return self._mock_text(tool_name, context, instruction), {}, Decimal(0)
            with self._client() as client:
                response = self._json(
                    client.post(
                        f"{settings.deepseek_base_url.rstrip('/')}/chat/completions",
                        headers=self._headers(settings.deepseek_api_key),
                        json={
                            "model": self._model("text"),
                            "thinking": {"type": "disabled"},
                            "messages": [
                                {"role": "system", "content": SYSTEM_PROMPT},
                                {
                                    "role": "user",
                                    "content": user_content,
                                },
                            ],
                            "tools": [
                                {
                                    "type": "function",
                                    "function": {
                                        "name": tool_name,
                                        "description": "返回当前阶段的完整内容",
                                        "parameters": TOOL_SCHEMAS[tool_name],
                                    },
                                }
                            ],
                            "tool_choice": {"type": "function", "function": {"name": tool_name}},
                            "max_tokens": 3500,
                        },
                    )
                )
            calls = response["choices"][0]["message"].get("tool_calls", [])
            if len(calls) != 1 or calls[0]["function"]["name"] != tool_name:
                raise ProviderError("对话模型未按当前阶段返回工具结果。")
            result = json.loads(calls[0]["function"]["arguments"])
            self._validate_text(tool_name, result, context)
            usage = response.get("usage", {})
            # Peak list prices, no cache discount, conservatively USD/CNY 7.5.
            cost = Decimal(usage.get("prompt_tokens", 0)) * Decimal("0.3") + Decimal(
                usage.get("completion_tokens", 0)
            ) * Decimal("1.2")
            cost = cost * Decimal("7.5") / 1_000_000 if "prompt_tokens" in usage else None
            return result, usage, cost

        return self._call("text", str(reserve), operation)

    @staticmethod
    def _validate_text(name: str, result: dict, context: dict) -> None:
        def check(schema, value):
            kind = schema["type"]
            if kind == "object":
                if not isinstance(value, dict) or set(value) != set(schema["required"]):
                    raise ProviderError("对话模型返回字段不完整。")
                for key, child in schema["properties"].items():
                    check(child, value[key])
            elif kind == "array":
                if not isinstance(value, list):
                    raise ProviderError("对话模型返回列表格式有误。")
                for item in value:
                    check(schema["items"], item)
            elif kind == "string" and not isinstance(value, str):
                raise ProviderError("对话模型返回文本格式有误。")
            elif kind == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
                raise ProviderError("对话模型返回数字格式有误。")
            if "enum" in schema and value not in schema["enum"]:
                raise ProviderError("对话模型返回字段取值有误。")

        check(TOOL_SCHEMAS[name], result)
        if name == "propose_directions" and not 2 <= len(result["options"]) <= 3:
            raise ProviderError("方向建议必须有 2–3 个。")
        if name in {"write_script", "revise_script"}:
            if not 4 <= len(result["shots"]) <= 6:
                raise ProviderError("脚本镜头不足 4 个。")
            garment_ids = set(
                context.get("garment_asset_ids")
                or [item["asset_id"] for item in (context.get("garments") or [])]
            )
            if any(
                not shot["outfit_asset_ids"]
                or not set(shot["outfit_asset_ids"]).issubset(garment_ids)
                for shot in result["shots"]
            ):
                raise ProviderError("脚本必须引用当前项目的具体衣服。")
            shot_ids = [shot["id"] for shot in result["shots"]]
            if len(set(shot_ids)) != len(shot_ids):
                raise ProviderError("脚本镜头编号重复。")
            result["status"] = "draft"
        if name == "write_note":
            result["title"] = result["title"][:20]
            result["tags"] = list(dict.fromkeys(result["tags"]))[:8]
            if len(result["tags"]) < 5:
                raise ProviderError("笔记话题标签不足 5 个。")
            image_ids = context.get("image_ids") or context.get("selected_image_ids")
            if image_ids:
                result["image_ids"] = image_ids

    def image(self, prompt: str, reference_assets: list[Asset]) -> GeneratedMedia:
        if len(reference_assets) > 3:
            raise ProviderError("单张图片最多支持 3 张参考素材，请拆分穿搭。")

        def operation():
            if self.mock:
                digest = hashlib.sha256(prompt.encode()).digest()
                image = Image.new("RGB", (768, 1024), tuple(170 + c % 70 for c in digest[:3]))
                draw = ImageDraw.Draw(image)
                draw.ellipse((294, 130, 474, 310), fill="#e7cbb2")
                draw.polygon([(300, 310), (468, 310), (540, 620), (228, 620)], fill="#faf6e9")
                draw.rectangle((290, 620, 370, 940), fill="#7898b6")
                draw.rectangle((398, 620, 478, 940), fill="#7898b6")
                draw.text((30, 30), "Outfit studio / mock", fill="#343f42")
                output = io.BytesIO()
                image.save(output, "PNG")
                return (
                    GeneratedMedia(output.getvalue(), "image/png", self._model("image"), 768, 1024),
                    {"images": 1},
                    Decimal(0),
                )
            content = [{"image": self._data_url(asset)} for asset in reference_assets]
            content.append({"text": prompt})
            with self._client() as client:
                response = self._json(
                    client.post(
                        f"{settings.dashscope_base_url.rstrip('/')}/services/aigc/"
                        "multimodal-generation/generation",
                        headers=self._headers(settings.dashscope_api_key),
                        json={
                            "model": self._model("image"),
                            "input": {"messages": [{"role": "user", "content": content}]},
                            "parameters": {"n": 1, "size": "2K", "watermark": False},
                        },
                    )
                )
                items = response["output"]["choices"][0]["message"]["content"]
                urls = [item["image"] for item in items if item.get("image")]
                if not urls:
                    raise ProviderError("生图模型没有返回图片。")
                try:
                    media = self._download(client, urls[0], "image/png", self._model("image"))
                except ProviderError:
                    raise ProviderError("图片已生成但转存失败，为避免重复计费已停止。") from None
            return media, {"images": 1, "request_id": response.get("request_id")}, Decimal("0.5")

        return self._call("image", "0.50", operation)

    def video(
        self,
        prompt: str,
        image_asset: Asset,
        provider_task_id: str | None = None,
        on_submitted: Callable[[str], None] | None = None,
    ) -> GeneratedMedia:
        def operation():
            if self.mock:
                if on_submitted and not provider_task_id:
                    on_submitted("mock-" + hashlib.sha256(prompt.encode()).hexdigest()[:20])
                data = (Path(__file__).parent / "fixtures" / "mock.mp4").read_bytes()
                return (
                    GeneratedMedia(data, "video/mp4", self._model("video"), 256, 384),
                    {
                        "seconds": 5,
                        "resolution": "720P",
                        "resumed": bool(provider_task_id),
                    },
                    Decimal(0),
                )
            task_id = provider_task_id
            with self._client() as client:
                headers = self._headers(settings.dashscope_api_key)
                if not task_id:
                    response = self._json(
                        client.post(
                            f"{settings.dashscope_base_url.rstrip('/')}/services/aigc/"
                            "video-generation/video-synthesis",
                            headers={**headers, "X-DashScope-Async": "enable"},
                            json={
                                "model": self._model("video"),
                                "input": {"prompt": prompt, "img_url": self._data_url(image_asset)},
                                "parameters": {"resolution": "720P", "duration": 5, "audio": True},
                            },
                        )
                    )
                    task_id = response["output"]["task_id"]
                    if on_submitted:
                        on_submitted(task_id)
                deadline = time.monotonic() + float(
                    getattr(settings, "video_timeout_seconds", 600),
                )
                while time.monotonic() < deadline:
                    response = self._json(
                        client.get(
                            f"{settings.dashscope_base_url.rstrip('/')}/tasks/{task_id}",
                            headers=headers,
                        )
                    )
                    output = response["output"]
                    status = output["task_status"]
                    if status == "SUCCEEDED":
                        media = self._download(
                            client, output["video_url"], "video/mp4", self._model("video")
                        )
                        return (
                            media,
                            {
                                "seconds": 5,
                                "resolution": "720P",
                                "audio": True,
                                "provider_task_id": task_id,
                            },
                            Decimal("1.5"),
                        )
                    if status in {"FAILED", "CANCELED", "UNKNOWN"}:
                        raise ProviderError(f"视频任务失败（{status}），请检查素材与额度。")
                    time.sleep(float(getattr(settings, "provider_poll_seconds", 3)))
            raise ProviderError("视频仍在生成，任务稍后会继续查询。", retryable=True)

        if provider_task_id and not self.mock:
            # Resuming a persisted task only polls/downloads; it does not reserve
            # or charge for a second generation. The first attempt retains cost.
            return operation()[0]
        return self._call("video", "1.50", operation)

    @staticmethod
    def _mock_text(name: str, context: dict, instruction: str) -> dict:
        if name == "chat":
            return {"text": "懂你～我们可以继续微调，等你确认后再开始生成。"}
        if name == "propose_directions":
            return {
                "options": [
                    {
                        "id": "direction-1",
                        "name": "周末慢下来",
                        "scene": "午后街角咖啡店",
                        "mood": "自然松弛",
                        "palette": ["奶油白", "浅蓝", "木色"],
                        "why": "让衣服的柔和线条融入日常",
                        "sample_title": "周末穿得轻一点",
                    },
                    {
                        "id": "direction-2",
                        "name": "清爽通勤",
                        "scene": "城市写字楼和树荫人行道",
                        "mood": "利落轻盈",
                        "palette": ["白色", "藏蓝", "银灰"],
                        "why": "简约配色适合工作日，也能兼顾舒适",
                        "sample_title": "上班也想轻松穿",
                    },
                    {
                        "id": "direction-3",
                        "name": "公园透口气",
                        "scene": "草坪与湖边步道",
                        "mood": "明亮自在",
                        "palette": ["浅绿", "米白", "天空蓝"],
                        "why": "用户外自然光拍出夏季新品的清爽感",
                        "sample_title": "把夏天穿在身上",
                    },
                ]
            }
        if name in {"write_script", "revise_script"}:
            ids = context.get("garment_asset_ids") or [
                item["asset_id"] for item in context.get("garments", [])
            ]
            direction = context.get("chosen_direction") or context.get("direction") or {}
            commute = "通勤" in instruction or "通勤" in str(direction)
            scene = "写字楼外的树荫步道" if commute else "阳光洒进来的街角咖啡店"
            return {
                "status": "draft",
                "title_ideas": ["今天穿得轻松一点", "清爽出门刚刚好"],
                "cover": {
                    "scene": scene,
                    "pose": "自然站立，轻轻回头",
                    "text_overlay": "轻松穿日常",
                },
                "shots": [
                    {
                        "id": f"shot-{i + 1}",
                        "scene": scene if i != 2 else "窗边自然光下",
                        "outfit_asset_ids": ids,
                        "pose": pose,
                        "camera": "竖版，真实自然光，全身" if i < 2 else "竖版中近景",
                        "caption": caption + (f" · {instruction}" if instruction else ""),
                    }
                    for i, (pose, caption) in enumerate(
                        [
                            (
                                "一手拿包，轻松向前走",
                                "通勤也能很轻松" if commute else "慢一点也很好",
                            ),
                            ("侧身回头，展示衣服版型", "喜欢这份刚刚好的利落"),
                            ("近景整理袖口与衣摆", "细节让日常穿搭更耐看"),
                            ("坐下喝水，自然看向窗外", "舒服自在，就是今天的状态"),
                        ]
                    )
                ],
                "video": {
                    "prompt": f"{scene}，人物轻轻走来并转身，保持衣服细节，镜头平稳",
                    "duration": 5,
                },
            }
        image_ids = context.get("image_ids") or context.get("selected_image_ids") or []
        previous_note = context.get("note") or {}
        title_match = re.search(r"标题(?:改成|改为|换成|换为)[：:\s]*([^\n，。！!]+)", instruction)
        title = title_match.group(1).strip("‘’“”\"' ")[:20] if title_match else None
        result = {
            "title": "今天穿得轻松一点",
            "body": (
                "最近很喜欢这种不费力的搭配 ☁️\n\n奶油白配浅蓝，看着就很清爽。"
                "把袖口轻轻挽起，出门买杯咖啡，连脚步都慢了下来。\n\n"
                "舒服、自在，也留一点小细节给自己 🌿\n\n品牌合作分享，穿搭感受因人而异。"
            ),
            "tags": ["夏日穿搭", "日常穿搭", "松弛感", "简约穿搭", "穿搭灵感", "品牌合作"],
            "image_ids": image_ids,
        }
        if previous_note:
            result = {**previous_note, "image_ids": image_ids}
            if instruction and not title:
                result["body"] = result["body"] + "\n\n" + instruction.split("：")[-1]
        if title:
            result["title"] = title
        return result
