"""Model adapters. Mock branches are local, including their media and usage records."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import math
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
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.config import settings
from app.costs import image_cost_cny, video_cost_cny
from app.errors import AppError
from app.models import Asset, Project, UsageLedger
from app.observability import log_model
from app.runtime_settings import (
    assert_generation_allowed,
    budget_lock,
    get_runtime_settings,
)

log = logging.getLogger(__name__)


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
UNIT = {"type": "number", "minimum": 0, "maximum": 1}
REGION = _obj(x=UNIT, y=UNIT, w={**UNIT, "exclusiveMinimum": 0}, h={**UNIT, "exclusiveMinimum": 0})
MASK_STROKES = _obj(
    brush={**UNIT, "exclusiveMinimum": 0},
    strokes={
        "type": "array",
        "minItems": 1,
        "items": {"type": "array", "minItems": 1, "items": _obj(x=UNIT, y=UNIT)},
    },
)
EDIT_IMAGE = _obj(image_id=STR, instruction=STR, reply=STR)
EDIT_IMAGE["properties"].update(region=REGION, mask_strokes=MASK_STROKES)
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
    shots={"type": "array", "items": SHOT, "minItems": 3, "maxItems": 6},
    video=_obj(prompt=STR, duration={"type": "integer", "enum": [5]}),
)
TOOL_SCHEMAS = {
    "propose_directions": _obj(
        options={
            "type": "array",
            "items": DIRECTION,
            "minItems": 2,
            "maxItems": 3,
        },
        reply=STR,
    ),
    "write_script": _obj(**SCRIPT["properties"], reply=STR),
    "revise_script": _obj(**SCRIPT["properties"], reply=STR),
    "write_note": _obj(title=STR, body=STR, tags=STRINGS, image_ids=STRINGS, reply=STR),
    "chat": _obj(text=STR, reply=STR),
    "generate_images": _obj(reply=STR),
    "edit_image": EDIT_IMAGE,
    "generate_video": _obj(image_id=STR, reply=STR),
    "restore_script": _obj(checkpoint_id=STR, reply=STR),
}
# Selection returns complete content in the same model call. Only side effects
# remain outside the provider, where stage and confirmation gates are audited.
SELECTION_TOOL_SCHEMAS = {
    **TOOL_SCHEMAS,
    "write_script": _obj(**TOOL_SCHEMAS["write_script"]["properties"], direction_id=STR),
    "chat": _obj(reply=STR, blocked_tool=STR),
}
TOOL_DESCRIPTIONS = {
    "propose_directions": (
        "提出2到3个方向；用户要换一组、再来一组时重新构思不同场景，"
        "保留历史对话和档案中已说过的偏好；仅讨论或询问用chat"
    ),
    "write_script": "用户选定当前某个方向时，解析direction_id并写完整脚本",
    "revise_script": "修改拍摄脚本、镜头或整体创作方向，返回修改后的完整脚本",
    "write_note": "用已完成图片撰写或修改发布笔记；image_ids为用户选择的图和顺序",
    "chat": "解释、聊天或澄清；越阶段请求只回复并在blocked_tool填对应工具名，其他填空串",
    "generate_images": "用户希望按脚本出图；此选择只提示确认，不能代替独立确认动作",
    "edit_image": (
        "用户明确要求修改某张已完成图片；结合refs与referenced_images解析真实image_id。"
        "明确提供圈选时可传region或mask_strokes（二选一）；无圈选时省略，不能猜测坐标"
    ),
    "generate_video": "用户希望出视频；解析首帧image_id，此选择不能代替独立确认动作",
    "restore_script": "恢复历史脚本；从script_versions解析checkpoint_id",
}
SYSTEM_PROMPT = """你是懂小红书穿搭创作的搭档，像博主朋友一样自然说中文。
根据品牌需求和真实衣服分析制作内容，不编造面料、品牌功效或用户经历。
context.profile 是博主保存的档案，context.style_notes 是长期风格偏好。
提出方向、写作和修改脚本时落实这些偏好，例如“不穿高跟鞋”要选平底鞋；
身高和体型仅作穿搭构图参考，不评价身材；本轮明确要求与偏好冲突时按本轮要求。
context.references 是用户上传参考图的真实风格分析，context.reference_style_summary 是其整理摘要。
有参考图时，方向、脚本的场景、光线、构图、氛围与配色必须落实该参考风格，
结合真实衣服发散而不照搬参考中的人物身份、衣服、文字或品牌；无参考时沿用原流程。
根据用户本轮意图，从提供的当前阶段工具中自主选择一个，返回完整结构化结果。
只调用一个允许的工具；参数必须从context与对话理解得出，不能编造资产或方向id。
每个工具的reply写一两句贴合本项目、用户原话的博主搭子口吻回复，不重复固定模板。
只是在提问、反问、否定修改、跑题、没有明确指代时用chat回答或澄清，不擅自改变内容。
用户请求的工具不在允许列表时用chat，blocked_tool填用户实际请求的全局工具名，
包括propose_directions/write_script/revise_script/generate_images/edit_image/write_note/
generate_video/restore_script；普通聊天blocked_tool填空串，不得借其他工具绕过阶段。
图片生成和视频生成都需要独立的确认action，自由文本工具选择不能声称已入队或已生成。
“第二张”“咖啡馆那张”“衬衫那张”等指代须结合images的顺序、scene、caption、instruction、
shot_id与script对应镜头、衣服分析解析image_id；多张都符合且无法确定时先chat询问。
context.refs是本轮引用的真实图片ID，referenced_images含它们的镜头、版本和还原分。
用户说“这张”“它”“这张袖口卷起来了，放下来”时优先指向本轮引用图片，
必须保留被引用的具体版本，不擅自切到同镜头的最新版本；多张引用无法唯一确定则chat澄清。
edit_image仅在用户明确圈选或提供坐标时传region或mask_strokes，二者只能传一个；
坐标是相对原图的0–1归一化值，没有圈选则整张改，不根据袖口等词语编造坐标。
选方向用write_script并填当前directions里的direction_id；修改已有脚本用revise_script。
改发布正文、标题、标签用write_note；改生成照片的画面用edit_image，二者不要混淆。
write_note中的image_ids保持已有选择，除非用户明确重新选图；首次选图从已完成图解析。
方向给 2–3 个，场景、氛围、配色各不相同，id 使用 direction-1 这样的稳定短标识。
方向阶段用户说“换一组方向，保留我刚才说的偏好”“再来一组”等时，
必须选propose_directions，给出区别于context.directions的2–3个新方向和新场景，
不能只改旧方向的名称，也不要选write_script或仅chat。
保留context.recent_messages中用户已明确说过的场景、风格、搭配限制以及档案偏好，
例如之前说“要通勤”，本轮只说“换一组”也要继续给通勤方向；
用户本轮明确改变某项偏好时才更新它，不能把“换一组”当作清空历史偏好。
脚本 3–6 个镜头（品牌需求指定了张数就按需求，否则 4–5 个），id 为 shot-1 等，
outfit_asset_ids 必须引用上下文的衣服资产 ID，
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

GARMENT_ACCESSORY_RULE = (
    "第一优先级：先从参考中剔除所有非服装杂物，再生成或编辑穿搭照片。"
    "吊牌、悬挂纸牌、价签、白色或其他颜色的矩形纸片、织标贴纸、商品说明贴、"
    "衣架、包装袋及其他包装不属于衣服，成品中绝对不能出现。"
    "即使纸牌或贴纸看起来贴在胸口、口袋、裤腰，或有NATURAL FABRIC、DENIM等文字，"
    "也不能把它当logo、衣服印花或布料补丁；禁止将纸牌变成胸前徽章、布贴或腰部标签。"
    "参考图中只印在纸牌、贴纸和可拆标签上的文字，绝不可迁移到人物或服装布料。"
    "把这些物品及其绳子、胶贴和文字彻底去掉，以周围相同颜色的连续面料自然补全，"
    "胸前口袋和裤腰应为干净连续的原布料，不留下白色矩形、贴片边界或残余字样。"
    "保留衣服本体的颜色、版型、面料、纽扣、口袋和确认直接印绣在衣服布料上的logo；"
    "无法确认属于本体的纸片或标签文字一律忽略。"
)

FIDELITY_SYSTEM_PROMPT = (
    "你是严格的服装还原质检员，必须先区分衣服本体与可拆商品标签。"
    "吊牌、纸牌、价签、织标贴纸、衣架和包装及上面的字样不是服装logo；"
    "不能因为纸牌或贴纸上的文字清楚，就把它误认为衣服印花、刺绣、logo或织唛。"
    "尤其胸前口袋上方的矩形纸片、腰带处及口袋露出的商品标签，必须视为应去除的杂物，"
    "即使标签印着NATURAL FABRIC、DENIM等字样，也不得要求恢复、清晰化或补齐这些文字。"
    "还原分只比较衣服本体，标签在成品中消失应视为正确；成品若残留标签或被转成布贴，"
    "必须报告具体位置及去除要求并判overall低于60。不能为标签残留的成品给高分。"
    "只有能确认直接印绣在连续衣服布料上且非独立纸片、贴片或可拆标签的logo才参与还原。"
    "不确定某文字是否属于衣服本体时不要求补字；先按物体外形、位置与载体判定。"
    "遵守用户规定的JSON格式，不要输出额外解释。"
)

_ledger_engines = {}
_ledger_engines_lock = threading.Lock()
_sqlite_reservation_lock = threading.RLock()


class ProviderHub:
    def __init__(
        self, session: Session, project_id: str | None = None, trace_context: dict | None = None,
    ):
        self.session = session
        self.project_id = project_id
        self._active_models: dict[str, str] = {}
        self.trace_context = dict(trace_context or {})
        self.ledger_ids: list[str] = []

    @property
    def mock(self) -> bool:
        return settings.mock_providers

    def _model(self, kind: str) -> str:
        if kind in self._active_models:
            return self._active_models[kind]
        return get_runtime_settings(self.session)["models"][kind]

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
        with _sqlite_reservation_lock, Session(self._ledger_bind()) as ledger_session:
            budget_lock(ledger_session)
            user_id = (
                ledger_session.scalar(select(Project.user_id).where(Project.id == self.project_id))
                if self.project_id else None
            )
            try:
                runtime = assert_generation_allowed(
                    ledger_session, user_id, kinds=(kind,),
                    estimate=Decimal(0) if self.mock else estimate,
                    check_budget=kind in {"image", "video"},
                )
            except AppError as exc:
                if exc.code == "BUDGET_EXCEEDED":
                    raise BudgetExceeded(exc.message) from exc
                error = ProviderError(exc.message)
                error.code = exc.code
                raise error from exc
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
                    raise BudgetExceeded("模型预算已接近配置上限，请先核对账单再继续。")
            row = UsageLedger(
                project_id=self.project_id,
                user_id=user_id,
                model=runtime["models"][kind],
                kind=kind,
                duration_ms=0,
                units={"mock": self.mock, "reserved_cny": str(estimate), **self.trace_context},
                estimated_cny=Decimal(0) if self.mock else estimate,
                status="reserved",
            )
            ledger_session.add(row)
            ledger_session.flush()
            ledger_id = row.id
            ledger_session.commit()
            self.ledger_ids.append(ledger_id)
            self._active_models[kind] = runtime["models"][kind]
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
            log_model(
                model=row.model,
                duration_ms=row.duration_ms,
                cost_cny=row.estimated_cny,
                user_id=row.user_id,
                project_id=row.project_id,
                status=row.status,
            )

    def _call(self, kind: str, estimate: str, operation: Callable) -> Any:
        started = time.monotonic()
        ledger_id = self._reserve(kind, Decimal(estimate))
        try:
            result, units, cost = operation()
        except Exception as exc:
            # A timeout can follow upstream acceptance; retain the reservation as
            # a conservative estimate instead of claiming that failure was free.
            self._finish_safely(
                ledger_id, started, status="failed", units={"error_type": type(exc).__name__}
            )
            if isinstance(exc, (KeyError, ValueError, TypeError)):
                raise ProviderError("模型返回内容格式有误，请稍后重试。") from None
            raise
        else:
            self._finish_safely(ledger_id, started, units=units, cost=cost)
            return result
        finally:
            self._active_models.pop(kind, None)

    def _finish_safely(self, ledger_id: str, started: float, **values) -> None:
        try:
            self._finish(ledger_id, started, **values)
        except Exception as exc:
            # The durable reservation already counts the maximum estimate. A
            # transient accounting outage must not turn paid media into a retry.
            # Log only the type: database driver messages may include parameters.
            log.error("Usage finalization failed; reservation retained (%s)", type(exc).__name__)

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
        cached = {
            asset.id: dict(asset.analysis)
            for asset in assets
            if isinstance(getattr(asset, "analysis", None), dict)
            and asset.analysis.get("asset_id") == asset.id
            and all(
                key in asset.analysis for key in ("category", "color", "material", "style_tags")
            )
        }
        missing = [asset for asset in assets if asset.id not in cached]
        if not missing:
            return [dict(cached[asset.id]) for asset in assets]
        if cached:
            cached.update({item["asset_id"]: item for item in self.analyze_garments(missing)})
            return [dict(cached[asset.id]) for asset in assets]
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
                        "吊牌、价签、织标贴纸、衣架、包装不属于衣服，忽略这些杂物及其文字。"
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
            return items, {**usage, "images": len(assets), "purpose": "analyze_garments"}, cost

        # Resized <=1 MP inputs are far below 16k visual tokens each. Reserve
        # using that generous bound and the most expensive Beijing token tier.
        reserve = Decimal(16_384 * len(assets) * 3 + 1600 * 30 + 3000) / 1_000_000
        items = self._call("vision", str(reserve), operation)
        # Commit only immutable analysis in a short independent transaction.
        # A later direction/model failure may roll back the conversation, but
        # cannot erase an already-paid vision result.
        with Session(self._ledger_bind()) as cache_session:
            for item in items:
                row = cache_session.get(Asset, item["asset_id"])
                if row is None:
                    raise ProviderError("衣服素材已失效，请重新上传。")
                row.analysis = dict(item)
            cache_session.commit()
        by_id = {item["asset_id"]: item for item in items}
        for asset in assets:
            set_committed_value(asset, "analysis", dict(by_id[asset.id]))
        return items

    def analyze_references(self, assets: list[Asset]) -> list[dict]:
        """Read style references separately from garment identity and cache paid work."""
        if not assets:
            return []
        if len(assets) > 3:
            raise ProviderError("参考图最多 3 张。")
        dimensions = ("scene", "lighting", "composition", "mood", "palette")
        public_fields = ("asset_id", *dimensions, "style_tags")
        cache_mock, cache_model = self.mock, self._model("vision")

        def public_item(item):
            return {key: item[key] for key in public_fields}

        def valid(item, asset_id):
            return (
                isinstance(item, dict)
                and item.get("asset_id") == asset_id
                and all(isinstance(item.get(key), str) and item[key].strip() for key in dimensions)
                and isinstance(item.get("style_tags"), list)
                and bool(item["style_tags"])
                and all(isinstance(tag, str) and tag.strip() for tag in item["style_tags"])
            )

        cached = {
            asset.id: public_item(asset.analysis)
            for asset in assets
            if valid(getattr(asset, "analysis", None), asset.id)
            and asset.analysis.get("_reference_mock") is cache_mock
            and asset.analysis.get("_reference_model") == cache_model
        }
        missing = [asset for asset in assets if asset.id not in cached]
        if not missing:
            return [dict(cached[asset.id]) for asset in assets]
        if cached:
            cached.update({item["asset_id"]: item for item in self.analyze_references(missing)})
            return [dict(cached[asset.id]) for asset in assets]

        def operation():
            nonlocal cache_model
            cache_model = self._model("vision")
            units = {"purpose": "analyze_references", "images": len(assets)}
            if self.mock:
                items = [
                    {
                        "asset_id": asset.id,
                        "scene": "夜晚街头与霓虹店招",
                        "lighting": "蓝紫霓虹侧光与暖色环境光",
                        "composition": "竖版街拍，人物偏侧留出街景空间",
                        "mood": "都市夜游，轻松有电影感",
                        "palette": "蓝紫、玫红与暖黄",
                        "style_tags": ["夜晚街头", "霓虹", "电影感"],
                    }
                    for asset in assets
                ]
                return items, units, Decimal(0)
            content = [{"type": "text", "text": (
                "逐张实际查看用户参考图，仅分析可见的场景、光线、构图、氛围与配色。"
                "这不是衣服识别，不推断人物身份、品牌、面料或用户经历。"
                "严格输出JSON对象{items:[{asset_id,scene,lighting,composition,mood,palette,"
                "style_tags:[]}]}；五个风格维度均为非空中文字符串，style_tags为非空短标签数组。"
                "每项保留对应asset_id，每张参考必须分别分析，不根据文件名或提示猜测。"
            )}]
            for asset in assets:
                content.extend([
                    {"type": "text", "text": f"参考图 asset_id={asset.id}"},
                    {"type": "image_url", "image_url": {
                        "url": self._data_url(asset, vision=True),
                    }},
                ])
            with self._client() as client:
                response = self._json(client.post(
                    f"{settings.dashscope_compatible_url.rstrip('/')}/chat/completions",
                    headers=self._headers(settings.dashscope_api_key),
                    json={"model": self._model("vision"),
                          "messages": [{"role": "user", "content": content}],
                          "enable_thinking": False, "response_format": {"type": "json_object"},
                          "max_tokens": 1600},
                ))
            payload = json.loads(response["choices"][0]["message"]["content"])
            items = payload.get("items") if isinstance(payload, dict) else None
            expected = {asset.id for asset in assets}
            if (
                not isinstance(items, list)
                or len(items) != len(assets)
                or any(not isinstance(item, dict) for item in items)
                or {item.get("asset_id") for item in items} != expected
                or any(not valid(item, item["asset_id"]) for item in items)
            ):
                raise ProviderError("参考图风格分析返回了无效结果，请重试。")
            usage = response.get("usage", {})
            tokens = usage.get("prompt_tokens", 0)
            rate = Decimal("1") if tokens <= 32_768 else Decimal("1.5")
            if tokens > 131_072:
                rate = Decimal("3")
            cost = Decimal(tokens) + Decimal(usage.get("completion_tokens", 0)) * 10
            cost = cost * rate / 1_000_000 if "prompt_tokens" in usage else None
            return items, {**usage, **units}, cost

        reserve = Decimal(16_384 * len(assets) * 3 + 1600 * 30 + 3000) / 1_000_000
        items = [public_item(item) for item in self._call("vision", str(reserve), operation)]
        stored = {
            item["asset_id"]: {
                **item, "_reference_mock": cache_mock, "_reference_model": cache_model,
            }
            for item in items
        }
        with Session(self._ledger_bind()) as cache_session:
            for item in items:
                row = cache_session.get(Asset, item["asset_id"])
                if row is None:
                    raise ProviderError("参考图已失效，请重新上传。")
                row.analysis = dict(stored[item["asset_id"]])
            cache_session.commit()
        by_id = {item["asset_id"]: item for item in items}
        for asset in assets:
            set_committed_value(asset, "analysis", dict(stored[asset.id]))
        return [dict(by_id[asset.id]) for asset in assets]

    def text(self, tool_name: str, context: dict, instruction: str = "") -> dict:
        """Generate content for a validated explicit action, using the same tool protocol."""
        if tool_name not in TOOL_SCHEMAS:
            raise ProviderError("该阶段不允许调用这个工具。")
        return self._text_call([tool_name], context, instruction, selection=False)[1]

    def select_tool(
        self, tools: list[str], context: dict, instruction: str = ""
    ) -> tuple[str, dict]:
        """Let the model select from the complete current-stage allowlist."""
        names = list(dict.fromkeys(tools))
        if not names or any(name not in SELECTION_TOOL_SCHEMAS for name in names):
            raise ProviderError("该阶段不允许调用这个工具。")
        if "chat" not in names:
            names.append("chat")
        return self._text_call(names, context, instruction, selection=True)

    def regenerate_reply(self, previous: str, context: dict) -> str:
        """A text-only call: there is deliberately no tools field or dispatcher."""
        content = json.dumps({"previous_reply": previous, "context": context},
                             ensure_ascii=False, default=str)
        prompt = (
            "你是穿搭博主的搭子。只把previous_reply换一种自然简洁的说法，保持事实、确认状态"
            "和承诺一致，不新增动作、不修改卡片、不声称又生成了图片。只返回回复文字。"
        )
        reserve = max(Decimal("0.15"), (
            Decimal(len((prompt + content).encode())) * Decimal("0.3")
            + Decimal(1000) * Decimal("1.2")
        ) * Decimal("7.5") / 1_000_000)

        def operation():
            if self.mock:
                return "换个说法：" + previous, {}, Decimal(0)
            with self._client() as client:
                response = self._json(client.post(
                    f"{settings.deepseek_base_url.rstrip('/')}/chat/completions",
                    headers=self._headers(settings.deepseek_api_key),
                    json={"model": self._model("text"), "thinking": {"type": "disabled"},
                          "messages": [{"role": "system", "content": prompt},
                                       {"role": "user", "content": content}], "max_tokens": 1000},
                ))
            text = response["choices"][0]["message"].get("content")
            if not isinstance(text, str) or not text.strip():
                raise ProviderError("回复重写未完成，请稍后重试。")
            usage = response.get("usage", {})
            cost = (Decimal(usage.get("prompt_tokens", 0)) * Decimal("0.3")
                    + Decimal(usage.get("completion_tokens", 0)) * Decimal("1.2"))
            cost = cost * Decimal("7.5") / 1_000_000 if "prompt_tokens" in usage else None
            return text.strip(), usage, cost

        return self._call("text", str(reserve), operation)

    def _text_call(
        self, names: list[str], context: dict, instruction: str, *, selection: bool
    ) -> tuple[str, dict]:
        schemas = SELECTION_TOOL_SCHEMAS if selection else TOOL_SCHEMAS
        user_content = json.dumps(
            {"context": context, "instruction": instruction}, ensure_ascii=False, default=str
        )
        # UTF-8 byte count bounds token count without a tokenizer dependency.
        input_bound = len(user_content.encode()) + len(SYSTEM_PROMPT.encode())
        input_bound += len(json.dumps([schemas[name] for name in names]).encode()) + 1024
        reserve = Decimal(input_bound) * Decimal("0.3") + Decimal(3500) * Decimal("1.2")
        reserve = max(Decimal("0.15"), reserve * Decimal("7.5") / 1_000_000)

        def operation():
            if self.mock:
                if selection:
                    name, result = self._mock_select_tool(names, context, instruction)
                else:
                    name = names[0]
                    result = self._mock_text(name, context, instruction)
                self._validate_text(name, result, context, selection=selection)
                return (name, result), {}, Decimal(0)
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
                                {"role": "user", "content": user_content},
                            ],
                            "tools": [
                                {
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "description": TOOL_DESCRIPTIONS[name],
                                        "parameters": schemas[name],
                                    },
                                }
                                for name in names
                            ],
                            "tool_choice": "required",
                            "parallel_tool_calls": False,
                            "max_tokens": 3500,
                        },
                    )
                )
            calls = response["choices"][0]["message"].get("tool_calls", [])
            if len(calls) != 1 or calls[0]["function"]["name"] not in names:
                raise ProviderError("对话模型未按当前阶段返回工具结果。")
            name = calls[0]["function"]["name"]
            result = json.loads(calls[0]["function"]["arguments"])
            self._validate_text(name, result, context, selection=selection)
            usage = response.get("usage", {})
            # Peak list prices, no cache discount, conservatively USD/CNY 7.5.
            cost = Decimal(usage.get("prompt_tokens", 0)) * Decimal("0.3") + Decimal(
                usage.get("completion_tokens", 0)
            ) * Decimal("1.2")
            cost = cost * Decimal("7.5") / 1_000_000 if "prompt_tokens" in usage else None
            return (name, result), usage, cost

        return self._call("text", str(reserve), operation)

    @staticmethod
    def _validate_text(name: str, result: dict, context: dict, *, selection: bool = False) -> None:
        def check(schema, value, path="结果"):
            kind = schema["type"]
            if kind == "object":
                if (
                    not isinstance(value, dict)
                    or not set(schema["required"]).issubset(value)
                    or not set(value).issubset(schema["properties"])
                ):
                    raise ProviderError("对话模型返回字段不完整。")
                for key, item in value.items():
                    check(schema["properties"][key], item, key)
            elif kind == "array":
                if not isinstance(value, list):
                    raise ProviderError("对话模型返回列表格式有误。")
                if len(value) < schema.get("minItems", 0) or len(value) > schema.get(
                    "maxItems", math.inf
                ):
                    if path == "strokes":
                        raise ProviderError("圈选轨迹不能为空，请重新涂抹要改的地方。")
                    raise ProviderError(
                        f"对话模型返回的 {path} 列表长度有误（{len(value)} 项），请再试一次。"
                    )
                for item in value:
                    check(schema["items"], item, path)
            elif kind == "string" and not isinstance(value, str):
                raise ProviderError("对话模型返回文本格式有误。")
            elif kind == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
                raise ProviderError("对话模型返回数字格式有误。")
            elif kind == "number":
                if (
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(value)
                    or value < schema.get("minimum", -math.inf)
                    or value > schema.get("maximum", math.inf)
                    or value <= schema.get("exclusiveMinimum", -math.inf)
                ):
                    raise ProviderError("圈选坐标或笔刷大小无效，请使用 0–1 范围内的有效数值。")
            if "enum" in schema and value not in schema["enum"]:
                raise ProviderError("对话模型返回字段取值有误。")

        schemas = SELECTION_TOOL_SCHEMAS if selection else TOOL_SCHEMAS
        check(schemas[name], result)
        if not result.get("reply", "").strip():
            raise ProviderError("对话模型没有返回回复。")
        if name == "edit_image":
            if "region" in result and "mask_strokes" in result:
                raise ProviderError("框选与涂抹轨迹只能选择一种。")
            region = result.get("region")
            if region and (region["x"] + region["w"] > 1 or region["y"] + region["h"] > 1):
                raise ProviderError("框选区域超出图片范围，请重新圈选。")
        if name == "propose_directions" and not 2 <= len(result["options"]) <= 3:
            raise ProviderError("方向建议必须有 2–3 个。")
        if name in {"write_script", "revise_script"}:
            if not 3 <= len(result["shots"]) <= 6:
                raise ProviderError("脚本镜头需要 3–6 个。")
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
            if image_ids and not selection:
                result["image_ids"] = image_ids

    def fidelity(
        self,
        reference_assets: list[Asset],
        generated: Asset | GeneratedMedia,
        *,
        model_asset: Asset | None = None,
        anchor_asset: Asset | None = None,
    ) -> dict:
        """Compare real references with a completed render before any watermark."""
        consistency_assets = [
            (key, asset) for key, asset in (
                ("person_score", model_asset), ("anchor_score", anchor_asset),
            ) if asset is not None
        ]
        image_count = len(reference_assets) + len(consistency_assets) + 1
        if not reference_assets and not consistency_assets:
            return {"score": 100, "diffs": [], "auto_fixed": False}

        def operation():
            if self.mock:
                return (
                    {"score": 92, "diffs": [], "auto_fixed": False,
                     **{key: 94 for key, _ in consistency_assets}},
                    {"purpose": "fidelity", "images": image_count}, Decimal(0),
                )
            if isinstance(generated, Asset):
                rendered_url = self._data_url(generated, vision=True)
            else:
                with Image.open(io.BytesIO(generated.data)) as image:
                    image = ImageOps.exif_transpose(image).convert("RGB")
                    image.thumbnail((1024, 1024))
                    output = io.BytesIO()
                    image.save(output, "JPEG", quality=90, optimize=True)
                rendered_url = (
                    "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode()
                )
            content = [
                {
                    "type": "text",
                    "text": (
                        "你是服装还原质检员，下面先给原衣服图，最后一张是穿搭生成图。"
                        "逐件对比品类、版型、颜色、面料纹理、纽扣数量颜色、口袋和logo。"
                        "人物、姿势、背景变化不扣分；不可见细节不要臆测相同。"
                        "吊牌、价签、织标贴纸、衣架、包装不属于衣服：忽略原衣服图中这些"
                        "杂物及其文字，不因它们在成品中缺失、文字不一致或不可读而扣还原分。"
                        "先检查胸前、裤腰、口袋是否存在纸片、矩形贴纸或标签残留，再给还原分。"
                        "衣服本体的logo与印花仍须比较，不能把吊牌文字当作logo，"
                        "也不能要求补齐、恢复或清晰化可拆标签上的文字。"
                        "若成品仍出现吊牌、价签、织标贴纸、衣架或包装，必须在diffs明确写明"
                        "位置和应去除的杂物，并将overall设为低于60以触发修复。"
                        "缺衣服、错颜色、错版型属于严重差异，overall须低于60。"
                        "只输出JSON：{garments:[{asset_id,score:0到100整数,diffs:[中文差异]}],"
                        "overall:0到100整数,diffs:[可直接用于修图的具体中文差异]}。"
                    ),
                }
            ]
            for asset in reference_assets:
                content.extend(
                    [
                        {"type": "text", "text": f"原衣服 asset_id={asset.id}"},
                        {
                            "type": "image_url",
                            "image_url": {"url": self._data_url(asset, vision=True)},
                        },
                    ]
                )
            if consistency_assets:
                content[0]["text"] += (
                    "以下还有明确标注角色的一致性参考图，必须实际看图分别评分，不能根据提示词"
                    "或声称相同给分；只有给了对应参考才输出该分数。"
                    "person_score只比较本人照片与成品的面部身份特征，不因衣服、动作、背景变化扣分。"
                    "anchor_score比较封面锚点与成品的同一人物、妆发、光线氛围与配色一致性，"
                    "允许脚本要求的姿势、构图和场景变化。脸部不可见或无法确认相同时不能给高分。"
                    "这两个分数独立于服装overall；服装diffs只写服装问题，不把人像问题混入自动修衣。"
                    "JSON额外输出以下0到100数值字段："
                    + "、".join(key for key, _ in consistency_assets) + "。"
                )
            for key, asset in consistency_assets:
                role = "博主本人照片，仅用于person_score" if key == "person_score" else (
                    "封面锚点，仅用于anchor_score"
                )
                content.extend([
                    {"type": "text", "text": f"{role} asset_id={asset.id}"},
                    {"type": "image_url", "image_url": {
                        "url": self._data_url(asset, vision=True),
                    }},
                ])
            content.extend(
                [
                    {"type": "text", "text": "最后一张：需要评分的生成穿搭图"},
                    {"type": "image_url", "image_url": {"url": rendered_url}},
                ]
            )
            with self._client() as client:
                response = self._json(
                    client.post(
                        f"{settings.dashscope_compatible_url.rstrip('/')}/chat/completions",
                        headers=self._headers(settings.dashscope_api_key),
                        json={
                            "model": self._model("vision"),
                            "messages": [
                                {"role": "system", "content": FIDELITY_SYSTEM_PROMPT},
                                {"role": "user", "content": content},
                            ],
                            "enable_thinking": False,
                            "response_format": {"type": "json_object"},
                            "max_tokens": 1600,
                        },
                    )
                )
            result = json.loads(response["choices"][0]["message"]["content"])
            score, diffs = result["overall"], result["diffs"]
            if (
                not isinstance(score, (int, float))
                or isinstance(score, bool)
                or not 0 <= score <= 100
                or not isinstance(diffs, list)
                or any(not isinstance(diff, str) for diff in diffs)
            ):
                raise ProviderError("还原度检查返回了无效结果。")
            scores = {}
            for key, _ in consistency_assets:
                value = result.get(key)
                if (
                    not isinstance(value, (int, float)) or isinstance(value, bool)
                    or not 0 <= value <= 100
                ):
                    raise ProviderError("一致性检查返回了无效分数。")
                scores[key] = round(value)
            usage = response.get("usage", {})
            tokens = usage.get("prompt_tokens", 0)
            rate = Decimal("1") if tokens <= 32_768 else Decimal("1.5")
            if tokens > 131_072:
                rate = Decimal("3")
            cost = Decimal(tokens) + Decimal(usage.get("completion_tokens", 0)) * 10
            cost = cost * rate / 1_000_000 if "prompt_tokens" in usage else None
            return (
                {"score": round(score), "diffs": diffs[:20], "auto_fixed": False, **scores},
                {**usage, "purpose": "fidelity", "images": image_count},
                cost,
            )

        reserve = Decimal(16_384 * image_count * 3 + 1600 * 30 + 3000)
        return self._call("vision", str(reserve / 1_000_000), operation)

    def check_edit(
        self,
        before: Asset,
        after: Asset,
        instruction: str,
        region: dict | None = None,
    ) -> dict:
        """Judge the requested change from both images, independently of garment fidelity."""
        if not instruction.strip():
            raise ProviderError("请说明需要检查的改图要求。")

        def operation():
            if self.mock:
                return (
                    {"passed": True, "reason": "Mock 指令核对通过；真实模式会逐项对比改图前后。"},
                    {"purpose": "edit_check", "images": 2},
                    Decimal(0),
                )
            content = [
                {
                    "type": "text",
                    "text": (
                        "你是严格的改图指令核对员。第一张是改图前，第二张是改图后。"
                        "必须实际看图对比，不根据提示词、文件名或声称已修改来判断通过。"
                        "逐项判断用户指令在第二张画面是否已经做到；变化不足、未改变、只做了"
                        "部分要求、细节不可见或无法确认都判passed=false，并写出具体原因。"
                        "例如‘衬衫塞进裤腰’须看到衬衫衣摆确实进入裤腰，仍垂在裤腰外不能通过；"
                        "‘袖口放下来’须看见袖口不再卷起，不能仅因颜色或背景改变而通过。"
                        "只核对本次指令，人物姿势与无关背景变化不能代替完成指令。"
                        "若提供region，坐标为相对原图的0–1框选范围，请重点检查该处；"
                        "指令需要的变化超出圈选能力时也如实失败。忽略右下角AI生成声明角标。"
                        "只输出JSON对象：{passed:true或false,reason:具体、简短的中文视觉依据}。"
                        f"\n用户指令：{instruction}\nregion："
                        + json.dumps(region, ensure_ascii=False)
                    ),
                },
                {"type": "text", "text": "第一张：改图前"},
                {
                    "type": "image_url",
                    "image_url": {"url": self._data_url(before, vision=True)},
                },
                {"type": "text", "text": "第二张：改图后，需要核对的成品"},
                {
                    "type": "image_url",
                    "image_url": {"url": self._data_url(after, vision=True)},
                },
            ]
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
                            "max_tokens": 800,
                        },
                    )
                )
            result = json.loads(response["choices"][0]["message"]["content"])
            if (
                not isinstance(result, dict)
                or set(result) != {"passed", "reason"}
                or not isinstance(result["passed"], bool)
                or not isinstance(result["reason"], str)
                or not result["reason"].strip()
            ):
                raise ProviderError("改图指令核对返回了无效结果。")
            usage = response.get("usage", {})
            tokens = usage.get("prompt_tokens", 0)
            rate = Decimal("1") if tokens <= 32_768 else Decimal("1.5")
            if tokens > 131_072:
                rate = Decimal("3")
            cost = Decimal(tokens) + Decimal(usage.get("completion_tokens", 0)) * 10
            cost = cost * rate / 1_000_000 if "prompt_tokens" in usage else None
            return (
                {"passed": result["passed"], "reason": result["reason"].strip()[:1000]},
                {**usage, "purpose": "edit_check", "images": 2},
                cost,
            )

        reserve = Decimal(16_384 * 2 * 3 + 800 * 30 + 3000) / 1_000_000
        return self._call("vision", str(reserve), operation)

    def image(self, prompt: str, reference_assets: list[Asset]) -> GeneratedMedia:
        # Wan 2.7 supports up to nine inputs; 2.6 supports four. Keep every
        # garment plus the separate person and cover references in the request.
        limit = 9 if self._model("image").startswith("wan2.7-") else 4
        if len(reference_assets) > limit:
            raise ProviderError(f"当前图片模型最多支持 {limit} 张参考素材，请拆分穿搭。")
        prompt = GARMENT_ACCESSORY_RULE + "\n" + prompt

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
            return media, {"images": 1, "request_id": response.get("request_id")}, image_cost_cny()

        return self._call("image", str(image_cost_cny()), operation)

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
                                "input": {
                                    "prompt": prompt + "。保持人物面部、身份和服装细节不变。",
                                    "img_url": self._data_url(image_asset),
                                },
                                "parameters": {
                                    "resolution": "720P",
                                    "duration": 5,
                                    "audio": True,
                                    "watermark": True,
                                },
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
                            video_cost_cny(),
                        )
                    if status in {"FAILED", "CANCELED", "UNKNOWN"}:
                        raise ProviderError(f"视频任务失败（{status}），请检查素材与额度。")
                    time.sleep(float(getattr(settings, "provider_poll_seconds", 3)))
            raise ProviderError("视频仍在生成，任务稍后会继续查询。", retryable=True)

        if provider_task_id and not self.mock:
            # Resuming a persisted task only polls/downloads; it does not reserve
            # or charge for a second generation. The first attempt retains cost.
            return operation()[0]
        return self._call("video", str(video_cost_cny()), operation)

    @staticmethod
    def _mock_select_tool(names: list[str], context: dict, instruction: str) -> tuple[str, dict]:
        """Deterministic fake model only; production never executes these heuristics."""
        value = instruction.strip()
        stage = context.get("stage", "direction")
        revision = any(
            word in value
            for word in (
                "换成",
                "改成",
                "调整",
                "重写",
                "增加",
                "删除",
                "不要",
                "更松弛",
                "改一下",
                "改",
                "换",
                "精简",
                "再短",
                "更短",
                "加上",
                "分段",
                "通勤风",
                "亮一点",
                "太暗",
                "太亮",
                "暗一点",
                "塞进",
                "修一下",
                "放下来",
                "放下",
                "卷起来",
                "去掉吊牌",
            )
        )
        question = (
            not value
            or value.startswith(("请问", "解释", "你好", "谢谢"))
            or any(word in value for word in ("为什么", "多少钱", "什么区别", "是否", "怎么样"))
            or value.endswith(("?", "？"))
        ) and not revision
        chat = {
            "reply": f"懂你～{context.get('brand') or '这组穿搭'}可以继续聊细节，确认前先不生成。",
            "blocked_tool": "",
        }
        if question or any(word in value for word in ("不要改", "先别", "不改", "不用改")):
            return "chat", chat

        numbers = {word: i for i, word in enumerate("一二三四五六七八九十", 1)}

        def ordinal(text: str, unit: str) -> int | None:
            match = re.search(r"第?\s*(10|[1-9一二三四五六七八九十])\s*(?:" + unit + ")", text)
            if match:
                return int(match[1]) if match[1].isdigit() else numbers[match[1]]
            return None

        def chosen_image() -> dict | None:
            images = [
                image for image in context.get("images", []) if image.get("status") == "succeeded"
            ]
            target = next((image for image in images if image["id"] in value), None)
            number = ordinal(value, "张")
            if target is None and number and number <= len(images):
                target = images[number - 1]
            refs = context.get("refs") or []
            referenced = context.get("referenced_images") or []
            if target is None and len(refs) == 1:
                target = next(
                    (
                        image
                        for image in [*images, *referenced]
                        if image["id"] == refs[0] and image.get("status") == "succeeded"
                    ),
                    None,
                )
            if target is None and len(refs) > 1:
                return None
            if target is None and len(images) == 1:
                target = images[0]
            return target

        tool, result = "chat", chat
        if any(word in value for word in ("恢复", "回到", "还原脚本")):
            tool = "restore_script"
            versions = context.get("script_versions", [])
            selected = next((v for v in versions if v.get("checkpoint_id", "!") in value), None)
            number = ordinal(value, "版")
            if selected is None and number:
                selected = next((v for v in versions if v["version"] == number), None)
            if selected is None:
                return "chat", {**chat, "reply": "想回到哪一版脚本？可以告诉我版本号。"}
            result = {
                "checkpoint_id": selected["checkpoint_id"],
                "reply": "好，回到你选的脚本再看看。",
            }
        elif any(word in value for word in ("生成视频", "出视频", "做视频", "拍视频")):
            tool = "generate_video"
            target = chosen_image()
            result = {
                "image_id": target["id"] if target else "",
                "reply": "可以，视频需要单独确认首帧。",
            }
        elif any(word in value for word in ("生成图片", "生成图", "出图", "开始生成")):
            tool, result = "generate_images", {"reply": "脚本准备好了，确认后就能开始出图。"}
        elif stage == "brief":
            tool = (
                "write_note"
                if any(word in value for word in ("写笔记", "写正文"))
                else "propose_directions"
            )
        elif stage == "direction":
            options = context.get("directions", [])
            selected = next((o for o in options if value == o["id"] or o["name"] in value), None)
            number = ordinal(value, "个|种|方向")
            if selected is None and number and number <= len(options):
                selected = options[number - 1]
            if selected:
                tool = "write_script"
                result = ProviderHub._mock_text(
                    tool, {**context, "chosen_direction": selected}, value
                )
                result["direction_id"] = selected["id"]
            else:
                tool = "propose_directions"
        elif stage == "script" or (
            stage in {"images", "note"}
            and any(word in value for word in ("脚本", "镜头", "通勤风", "重来"))
            and "标题" not in value
        ):
            tool = "revise_script"
        elif (
            stage in {"images", "note"}
            and revision
            and "标题" not in value
            and not any(word in value for word in ("正文", "笔记", "文案", "标签"))
        ):
            target = chosen_image()
            if target:
                tool = "edit_image"
                result = {
                    "image_id": target["id"],
                    "instruction": value,
                    "reply": "好，这张单独改一版，原图留着对比。",
                }
        elif stage in {"images", "note", "video", "done"} and (
            revision or any(word in value for word in ("笔记", "文案", "选图"))
        ):
            tool = "write_note"

        if tool not in names:
            return "chat", {
                **chat,
                "blocked_tool": tool,
                "reply": "这一步还没到，先完成当前阶段的确认就能继续。",
            }
        if tool in {"propose_directions", "revise_script", "write_note"}:
            content_context = context
            if tool == "write_note" and not (
                context.get("selected_image_ids") or context.get("image_ids")
            ):
                target = chosen_image()
                content_context = {
                    **context,
                    "selected_image_ids": [target["id"]]
                    if target
                    else [
                        image["id"]
                        for image in context.get("images", [])
                        if image.get("status") == "succeeded"
                    ],
                }
            result = ProviderHub._mock_text(tool, content_context, instruction)
        return tool, result

    @staticmethod
    def _mock_text(name: str, context: dict, instruction: str) -> dict:
        if name in {"generate_images", "edit_image", "generate_video", "restore_script"}:
            try:
                action = json.loads(instruction)
            except (json.JSONDecodeError, TypeError):
                action = {}
            if not isinstance(action, dict):
                action = {}
            subject = context.get("brand") or "这组穿搭"
            replies = {
                "generate_images": f"{subject}的脚本确认啦，这组图已经安排，细节我们一张张看。",
                "edit_image": f"好，{subject}这张单独改一版，原图留着一起比较。",
                "generate_video": f"{subject}的视频安排好了，做成5秒自然展示穿搭的片段。",
                "restore_script": f"{subject}已经回到你选的脚本，这版确认后再开始出图。",
            }
            result = {"reply": replies[name]}
            for key in TOOL_SCHEMAS[name]["required"]:
                if key != "reply":
                    result[key] = str(action.get(key) or context.get(key) or "")
            if name == "edit_image":
                for key in ("region", "mask_strokes"):
                    if key in action:
                        result[key] = action[key]
            return result
        result = ProviderHub._mock_content(name, context, instruction)
        references = context.get("references") or []
        reference_summary = context.get("reference_style_summary") or "；".join(
            str(item.get(key) or "")
            for item in references
            for key in ("scene", "lighting", "composition", "mood", "palette")
        )
        if reference_summary and name in {"propose_directions", "write_script", "revise_script"}:
            reference = references[0] if references else {}
            scene = reference.get("scene") or reference_summary
            if name == "propose_directions":
                palette = reference.get("palette") or ""
                palette = palette if isinstance(palette, list) else [
                    value.strip() for value in re.split(r"[、，,与和]", palette) if value.strip()
                ]
                details = ("街角漫步", "橱窗光影", "路边小憩", "巷口转身", "街边等车", "过街抓拍")
                previous = {option["scene"] for option in (context.get("directions") or [])}
                fresh = [
                    detail for detail in details if f"{scene}，{detail}" not in previous
                ] or details
                for index, option in enumerate(result["options"]):
                    detail = fresh[index % len(fresh)]
                    option.update(
                        name=f"参考氛围 · {detail}", scene=f"{scene}，{detail}",
                        mood=reference.get("mood") or option["mood"],
                        palette=palette or option["palette"],
                        why=option["why"] + f"；参考风格：{reference_summary}",
                        sample_title=f"{detail}，把氛围穿出门",
                    )
            else:
                result["cover"]["scene"] = scene
                for shot in result["shots"]:
                    shot["scene"] = f"{scene}；参考风格：{reference_summary}"
                    shot["camera"] += "；" + str(reference.get("composition") or "")
                    shot["camera"] += "；" + str(reference.get("lighting") or "")
                result["video"]["prompt"] += f"；参考风格：{reference_summary}"
        brief = context.get("brief")
        subject = context.get("brand") or (
            brief.get("summary", "这组穿搭") if isinstance(brief, dict) else brief or "这组穿搭"
        )
        replies = {
            "chat": f"懂你～{subject}可以继续微调，确认后再开始生成。",
            "propose_directions": f"按{subject}的气质想了几组场景，你更想试哪一个？",
            "write_script": f"{subject}这组的封面和镜头写好了，看看哪处还想调整。",
            "revise_script": f"收到，{subject}这版已经把“{instruction[:48]}”落到镜头里了。",
            "write_note": f"{subject}的笔记写好了，搭配细节和选图顺序都放进去了。",
        }
        style_notes = (
            context.get("style_notes") or (context.get("profile") or {}).get("style_notes")
        )
        if style_notes and name in {"propose_directions", "write_script", "revise_script"}:
            replies[name] += f" 也照顾了你保存的偏好：{style_notes}。"
        fields = TOOL_SCHEMAS[name]["properties"]
        return {
            **{key: value for key, value in result.items() if key in fields},
            "reply": replies[name],
        }

    @staticmethod
    def _mock_content(name: str, context: dict, instruction: str) -> dict:
        style_notes = (
            context.get("style_notes") or (context.get("profile") or {}).get("style_notes") or ""
        )
        preference = style_notes.replace("不穿高跟鞋", "搭配平底鞋")
        preference_suffix = f"；{preference}" if preference else ""
        if name == "chat":
            return {"text": "懂你～我们可以继续微调，等你确认后再开始生成。"}
        if name == "propose_directions":
            user_preferences = [style_notes]
            brief = context.get("brief") or {}
            if isinstance(brief, dict):
                user_preferences.extend([brief.get("original", ""), brief.get("additional", "")])
            elif isinstance(brief, str):
                user_preferences.append(brief)
            user_preferences.extend(
                message.get("text", "")
                for message in context.get("recent_messages", [])
                if message.get("role") == "user"
            )
            user_preferences.append(instruction)
            preference = "；".join(
                dict.fromkeys(
                    text.replace("不穿高跟鞋", "搭配平底鞋").strip()
                    for text in user_preferences
                    if text and not text.lstrip().startswith("{")
                    and not any(word in text for word in ("换一组", "再来一组", "保留偏好"))
                )
            )
            preference_suffix = f"；保留你的偏好：{preference}" if preference else ""
            commute_preferences = [text for text in user_preferences if "通勤" in text]
            commute = bool(commute_preferences) and not any(
                word in commute_preferences[-1] for word in ("不要通勤", "不想通勤", "不拍通勤")
            )
            if context.get("directions") or commute:
                scenes = (
                    [
                        ("城市早班", "玻璃办公楼外的晨光广场", "干净利落"),
                        ("下班散步", "写字楼旁的林荫街道", "松弛轻盈"),
                        ("午休留白", "办公园区的露台咖啡座", "温柔简约"),
                        ("轻装出发", "城市地铁口的石材长廊", "清爽明快"),
                        ("工作日漫步", "商务街区的白墙转角", "从容自然"),
                        ("通勤光影", "办公室窗边与通透门厅", "安静知性"),
                    ]
                    if commute else [
                        ("沿河慢行", "傍晚河岸的木质步道", "轻盈自在"),
                        ("街区小憩", "老街书店的露台", "温柔文艺"),
                        ("周末看展", "美术馆外的白墙长廊", "简洁明亮"),
                        ("市集拾光", "周末花市的石板小街", "自然鲜活"),
                        ("海风散步", "临海木栈道的树荫处", "清新松弛"),
                        ("城市留白", "社区图书馆的窗边", "安静从容"),
                    ]
                )
                previous_scenes = {item["scene"] for item in (context.get("directions") or [])}
                fresh = [item for item in scenes if item[1] not in previous_scenes][:3]
                return {
                    "options": [
                        {
                            "id": f"direction-{index + 1}",
                            "name": f"通勤 · {title}" if commute else title,
                            "scene": scene,
                            "mood": mood,
                            "palette": palette,
                            "why": "换一个场景继续探索衣服的日常搭配" + preference_suffix,
                            "sample_title": f"{title}，今天这样穿",
                        }
                        for index, ((title, scene, mood), palette) in enumerate(
                            zip(fresh, [["米白", "藏蓝"], ["浅灰", "浅蓝"], ["奶油白", "木色"]],
                                strict=False)
                        )
                    ]
                }
            return {
                "options": [
                    {
                        "id": "direction-1",
                        "name": "周末慢下来",
                        "scene": "午后街角咖啡店",
                        "mood": "自然松弛",
                        "palette": ["奶油白", "浅蓝", "木色"],
                        "why": "让衣服的柔和线条融入日常" + preference_suffix,
                        "sample_title": "周末穿得轻一点",
                    },
                    {
                        "id": "direction-2",
                        "name": "清爽通勤",
                        "scene": "城市写字楼和树荫人行道",
                        "mood": "利落轻盈",
                        "palette": ["白色", "藏蓝", "银灰"],
                        "why": "简约配色适合工作日，也能兼顾舒适" + preference_suffix,
                        "sample_title": "上班也想轻松穿",
                    },
                    {
                        "id": "direction-3",
                        "name": "公园透口气",
                        "scene": "草坪与湖边步道",
                        "mood": "明亮自在",
                        "palette": ["浅绿", "米白", "天空蓝"],
                        "why": "用户外自然光拍出夏季新品的清爽感" + preference_suffix,
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
                        "pose": pose + ("，穿平底鞋" if "不穿高跟鞋" in style_notes else ""),
                        "camera": "竖版，真实自然光，全身" if i < 2 else "竖版中近景",
                        "caption": caption + preference_suffix
                        + (f" · {instruction}" if instruction else ""),
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
