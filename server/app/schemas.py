import math
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegisterInput(StrictInput):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=8, max_length=72)
    nickname: str | None = Field(default=None, max_length=80)


class LoginInput(StrictInput):
    username: str
    password: str


class Profile(StrictInput):
    model_asset_ids: list[str] = Field(default_factory=list, max_length=20)
    height_cm: float | None = Field(default=None, gt=0, le=300, allow_inf_nan=False)
    body_notes: str | None = Field(default=None, max_length=2000)
    style_notes: str | None = Field(default=None, max_length=2000)

    @field_validator("model_asset_ids")
    @classmethod
    def unique_model_assets(cls, value):
        if any(not item.strip() for item in value) or len(value) != len(set(value)):
            raise ValueError("本人照片编号不能为空或重复。")
        return value


class ProfilePatch(Profile):
    """Same fields as the stored profile; model_fields_set controls partial updates."""


class UserProfilePatch(StrictInput):
    nickname: str | None = Field(default=None, min_length=1, max_length=80)
    profile: ProfilePatch | None = None

    @field_validator("nickname", "profile", mode="before")
    @classmethod
    def provided_value(cls, value):
        if value is None:
            raise ValueError("昵称和档案不能为 null，请传入要修改的内容。")
        return value


class UserOutput(BaseModel):
    id: str
    username: str
    nickname: str
    created_at: datetime
    tier: str = "free"
    daily_budget_cny: float = 0
    today_cost_cny: float = 0
    profile: Profile = Field(default_factory=Profile)


class AuthOutput(BaseModel):
    token: str
    user: UserOutput


class AssetOutput(BaseModel):
    id: str
    kind: str
    url: str
    width: int | None
    height: int | None
    mime: str
    created_at: datetime
    source: Literal["upload", "generated"]
    parent_id: str | None = None
    prompt: str | None = None


class ProjectInput(StrictInput):
    title: str = Field(min_length=1, max_length=200)
    brand: str = Field(min_length=1, max_length=200)
    brief: str = Field(min_length=1, max_length=10000)
    garment_asset_ids: list[str] = Field(min_length=1, max_length=10)
    model_asset_id: str | None = None
    reference_asset_ids: list[str] = Field(default_factory=list, max_length=3)

    @field_validator("reference_asset_ids")
    @classmethod
    def unique_reference_assets(cls, value):
        if any(not item.strip() for item in value) or len(value) != len(set(value)):
            raise ValueError("参考图编号不能为空或重复。")
        return value


Stage = Literal["brief", "direction", "script", "images", "note", "video", "done"]


class ProjectOutput(BaseModel):
    id: str
    title: str
    brand: str
    brief: str
    stage: Stage
    reference_asset_ids: list[str] = Field(default_factory=list)
    cover_url: str | None = None
    created_at: datetime
    updated_at: datetime


class ChooseDirection(StrictInput):
    type: Literal["choose_direction"]
    direction_id: str


class ConfirmScript(StrictInput):
    type: Literal["confirm_script"]


class NormalizedPoint(StrictInput):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)

    @field_validator("x", "y", mode="before")
    @classmethod
    def coordinate(cls, value):
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 <= value <= 1
        ):
            raise ValueError("局部编辑坐标必须是0–1之间的有效数值，不能越界。")
        return value


class ImageRegion(NormalizedPoint):
    w: float = Field(gt=0, le=1, allow_inf_nan=False)
    h: float = Field(gt=0, le=1, allow_inf_nan=False)

    @field_validator("w", "h", mode="before")
    @classmethod
    def dimension(cls, value):
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 < value <= 1
        ):
            raise ValueError("框选区域的宽高必须大于0且不超过1。")
        return value

    @model_validator(mode="after")
    def within_image(self):
        if self.x + self.w > 1 + 1e-9 or self.y + self.h > 1 + 1e-9:
            raise ValueError("框选区域不能超出图片边界。")
        return self


class MaskStrokes(StrictInput):
    brush: float = Field(gt=0, le=1, allow_inf_nan=False)
    strokes: list[list[NormalizedPoint]]

    @field_validator("brush", mode="before")
    @classmethod
    def brush_size(cls, value):
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 < value <= 1
        ):
            raise ValueError("涂抹笔刷大小必须大于0且不超过1。")
        return value

    @model_validator(mode="after")
    def nonempty_strokes(self):
        if not self.strokes or any(not stroke for stroke in self.strokes):
            raise ValueError("涂抹轨迹不能为空，请先涂抹要修改的区域。")
        if len(self.strokes) > 100 or sum(map(len, self.strokes)) > 20000:
            raise ValueError("涂抹轨迹过多，请缩小圈选范围后重试。")
        return self


class EditImage(StrictInput):
    type: Literal["edit_image"]
    image_id: str
    instruction: str = Field(min_length=1, max_length=3000)
    region: ImageRegion | None = None
    mask_strokes: MaskStrokes | None = None
    attempt: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("attempt")
    @classmethod
    def nonblank_attempt(cls, value):
        if value is not None and not value.strip():
            raise ValueError("尝试编号不能为空。")
        return value

    @model_validator(mode="after")
    def one_selection(self):
        if self.region is not None and self.mask_strokes is not None:
            raise ValueError("框选和涂抹只能选择一种，请清除另一种选择。")
        return self


class ApproveImages(StrictInput):
    type: Literal["approve_images"]
    image_ids: list[str] = Field(min_length=1, max_length=20)
    accept_unverified: list[str] = Field(default_factory=list, max_length=20)


class ConfirmVideo(StrictInput):
    type: Literal["confirm_video"]
    image_id: str


class RestoreScript(StrictInput):
    type: Literal["restore_script"]
    checkpoint_id: str = Field(min_length=1, max_length=100)


class RegenerateReply(StrictInput):
    type: Literal["regenerate_reply"]
    message_id: str = Field(min_length=1, max_length=100)


Action = Annotated[
    ChooseDirection | ConfirmScript | EditImage | ApproveImages | ConfirmVideo | RestoreScript
    | RegenerateReply,
    Field(discriminator="type"),
]


class MessageInput(StrictInput):
    text: str | None = Field(default=None, max_length=10000)
    action: Action | None = None
    refs: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("refs")
    @classmethod
    def unique_refs(cls, value):
        if any(not image_id.strip() for image_id in value) or len(value) != len(set(value)):
            raise ValueError("引用图片不能为空或重复。")
        return value

    @model_validator(mode="after")
    def nonempty(self):
        if not (self.text and self.text.strip()) and self.action is None:
            raise ValueError("请发送文字或操作")
        return self


class TraceStep(BaseModel):
    label: str
    duration_ms: int = Field(ge=0)


class MessageTrace(BaseModel):
    tool: str
    model: str
    duration_ms: int = Field(ge=0)
    cost_cny: float = Field(ge=0)
    refs: list[str] = Field(default_factory=list)
    steps: list[TraceStep] = Field(default_factory=list)


class MessageOutput(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    text: str
    cards: list[dict]
    action: dict | None = None
    refs: list[str] = Field(default_factory=list)
    created_at: datetime
    trace: MessageTrace | None = None
    can_regenerate: bool = False


class JobOutput(BaseModel):
    id: str
    project_id: str
    kind: Literal["image", "edit", "video"]
    status: Literal["queued", "running", "succeeded", "failed"]
    result_asset_id: str | None = None
    url: str | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime
    reused: bool | None = None


class PendingAction(BaseModel):
    type: Literal["choose_direction", "confirm_script", "confirm_video"]
    prompt: str
    estimated_cost_cny: float | None = None


class BudgetOutput(BaseModel):
    tier: str
    daily_budget_cny: float
    today_cost_cny: float
    remaining_cny: float


class StateOutput(BaseModel):
    stage: Stage
    garments: list[dict]
    directions: list[dict]
    chosen_direction_id: str | None = None
    script: dict | None = None
    images: list[dict]
    note: dict | None = None
    video: dict | None = None
    active_jobs: list[JobOutput]
    pending_action: PendingAction | None = None
    cost_cny: float = 0
    last_message_id: str | None = None
    script_versions: list[dict] = Field(default_factory=list)
    budget: BudgetOutput | None = None


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorOutput(BaseModel):
    error: ErrorDetail


class HealthOutput(BaseModel):
    ok: bool
    version: str
    providers: dict[str, str | bool]
