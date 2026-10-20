from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegisterInput(StrictInput):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=8, max_length=72)
    nickname: str | None = Field(default=None, max_length=80)


class LoginInput(StrictInput):
    username: str
    password: str


class UserOutput(BaseModel):
    id: str
    username: str
    nickname: str
    created_at: datetime


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


Stage = Literal["brief", "direction", "script", "images", "note", "video", "done"]


class ProjectOutput(BaseModel):
    id: str
    title: str
    brand: str
    brief: str
    stage: Stage
    cover_url: str | None = None
    created_at: datetime
    updated_at: datetime


class ChooseDirection(StrictInput):
    type: Literal["choose_direction"]
    direction_id: str


class ConfirmScript(StrictInput):
    type: Literal["confirm_script"]


class EditImage(StrictInput):
    type: Literal["edit_image"]
    image_id: str
    instruction: str = Field(min_length=1, max_length=3000)


class ApproveImages(StrictInput):
    type: Literal["approve_images"]
    image_ids: list[str] = Field(min_length=1, max_length=20)


class ConfirmVideo(StrictInput):
    type: Literal["confirm_video"]
    image_id: str


Action = Annotated[
    ChooseDirection | ConfirmScript | EditImage | ApproveImages | ConfirmVideo,
    Field(discriminator="type"),
]


class MessageInput(StrictInput):
    text: str | None = Field(default=None, max_length=10000)
    action: Action | None = None

    @model_validator(mode="after")
    def nonempty(self):
        if not (self.text and self.text.strip()) and self.action is None:
            raise ValueError("请发送文字或操作")
        return self


class MessageOutput(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    text: str
    cards: list[dict]
    action: dict | None = None
    created_at: datetime


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


class PendingAction(BaseModel):
    type: Literal["choose_direction", "confirm_script", "confirm_video"]
    prompt: str


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


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorOutput(BaseModel):
    error: ErrorDetail


class HealthOutput(BaseModel):
    ok: bool
    version: str
    providers: dict[str, str | bool]
