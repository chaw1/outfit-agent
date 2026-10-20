import asyncio
import hashlib
import hmac
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from fastapi import Depends, FastAPI, File, Form, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from langgraph.checkpoint.postgres import PostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from sqlalchemy import select
from sqlalchemy import text as sql_text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException

from app.admin import router as admin_router
from app.config import settings
from app.db import SessionLocal
from app.errors import AppError
from app.graph import build_graph, get_graph_state, run_turn, script_versions
from app.log_errors import log_exception
from app.media import asset_dict, asset_path, store_upload
from app.models import Asset, Job, Message, Project, User, utcnow
from app.observability import RequestObservabilityMiddleware, bind_project, bind_user
from app.profile import default_model_asset_id, patch_user
from app.project_cleanup import cleanup_project
from app.rate_limits import RequestProtectionMiddleware, limit_messages, limit_upload
from app.runtime_settings import user_budget
from app.schemas import (
    AssetOutput,
    AuthOutput,
    ErrorOutput,
    HealthOutput,
    JobOutput,
    LoginInput,
    MessageInput,
    MessageOutput,
    ProjectInput,
    ProjectOutput,
    RegisterInput,
    StateOutput,
    UserOutput,
    UserProfilePatch,
)
from app.security import (
    current_user,
    get_session,
    hash_password,
    issue_token,
    media_signature,
    verify_password,
)
from app.tracing import dialogue_trace
from app.views import (
    direction_items,
    image_items,
    job_dict,
    message_dict,
    pending_action_dict,
    project_cost_cny,
    project_dict,
    refresh_cards,
    user_dict,
)
from app.workflow import Workflow

log = logging.getLogger("outfit")


@asynccontextmanager
async def lifespan(application: FastAPI):
    if settings.environment == "production" and settings.jwt_secret.startswith("local-demo"):
        raise RuntimeError("生产环境必须配置 JWT_SECRET")
    with ConnectionPool(
        settings.checkpoint_url,
        min_size=1,
        max_size=8,
        kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": 0},
    ) as pool:
        pool.wait(timeout=30)
        saver = PostgresSaver(pool)
        saver.setup()
        application.state.checkpointer = saver
        application.state.graph = build_graph(saver)
        application.state.observability_session_factory = SessionLocal
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        yield


app = FastAPI(
    title="穿搭笔记智能体 API",
    version="0.1.0",
    lifespan=lifespan,
    responses={
        400: {"model": ErrorOutput},
        401: {"model": ErrorOutput},
        404: {"model": ErrorOutput},
        413: {"model": ErrorOutput},
        415: {"model": ErrorOutput},
        422: {"model": ErrorOutput},
        429: {"model": ErrorOutput},
    },
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id"],
)
app.include_router(admin_router)


@app.middleware("http")
async def admin_switch(request, call_next):
    if (request.url.path.rstrip("/") == "/admin" or
            request.url.path.startswith("/api/admin")) and not settings.admin_token:
        return JSONResponse(
            {"error": {"code": "NOT_FOUND", "message": "管理端未启用"}}, 404
        )
    response = await call_next(request)
    if request.url.path.startswith(("/admin", "/api/admin")):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/admin", include_in_schema=False)
@app.get("/admin/", include_in_schema=False)
def admin_page():
    if not settings.admin_token:
        raise AppError("NOT_FOUND", "管理端未启用", 404)
    return FileResponse(
        Path(__file__).parent / "admin_static" / "index.html",
        headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY"},
    )


@app.exception_handler(AppError)
async def app_error_handler(request, exc):
    headers = (
        {"Retry-After": str(settings.rate_limit_window_seconds)}
        if exc.status_code == 429 else None
    )
    return JSONResponse(
        {"error": {"code": exc.code, "message": exc.message}}, exc.status_code, headers=headers
    )


@app.exception_handler(RequestValidationError)
async def validation_handler(request, exc):
    message = "请求字段无效，请检查输入"
    for error in exc.errors():
        location = set(error.get("loc", ()))
        if location & {"region", "mask_strokes", "refs", "edit_image"}:
            detail = (error.get("ctx") or {}).get("error")
            message = str(detail) if isinstance(detail, ValueError) else (
                "引用图片字段无效，请提供图片编号列表。"
                if "refs" in location
                else "局部编辑字段无效，请检查坐标、框选范围和涂抹轨迹。"
            )
            break
    return JSONResponse(
        {"error": {"code": "VALIDATION_ERROR", "message": message}}, 422
    )


@app.exception_handler(HTTPException)
async def http_error_handler(request, exc):
    return JSONResponse(
        {"error": {"code": "HTTP_ERROR", "message": "请求无法完成"}}, exc.status_code
    )


@app.exception_handler(Exception)
async def internal_error_handler(request, exc):
    log_exception(log, "Request failed", exc)
    return JSONResponse(
        {"error": {"code": "INTERNAL_ERROR", "message": "服务暂时不可用，请稍后重试"}}, 500
    )


def owned_project(session: Session, project_id: str, user_id: str) -> Project:
    project = session.scalar(
        select(Project).where(
            Project.id == project_id, Project.user_id == user_id, Project.deleted_at.is_(None)
        )
    )
    if project is None:
        raise AppError("NOT_FOUND", "项目不存在", 404)
    bind_project(project.id)
    return project


def project_lock(session: Session, project_id: str, *, wait: bool = True) -> bool:
    lock_id = int.from_bytes(hashlib.sha256(project_id.encode()).digest()[:8], "big", signed=True)
    function = "pg_advisory_xact_lock" if wait else "pg_try_advisory_xact_lock"
    result = session.scalar(sql_text(f"SELECT {function}(:id)"), {"id": lock_id})
    return True if wait else bool(result)


@app.get("/api/health", response_model=HealthOutput)
def health(session: Session = Depends(get_session)):
    from app.runtime_settings import get_runtime_settings

    session.execute(sql_text("SELECT 1"))
    models = get_runtime_settings(session)["models"]
    return {
        "ok": True,
        "version": "0.1.0",
        "providers": {
            **models,
            "mock": settings.mock_providers,
        },
    }


@app.post("/api/auth/register", response_model=AuthOutput)
def register(body: RegisterInput, request: Request, session: Session = Depends(get_session)):
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        nickname=body.nickname or body.username,
    )
    session.add(user)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise AppError("USERNAME_TAKEN", "用户名已被使用", 409) from exc
    bind_user(request, user.id, session)
    return {"token": issue_token(user.id), "user": user_dict(user, session)}


@app.post("/api/auth/login", response_model=AuthOutput)
def login(body: LoginInput, request: Request, session: Session = Depends(get_session)):
    user = session.scalar(select(User).where(User.username == body.username))
    if user is None or not verify_password(body.password, user.password_hash):
        raise AppError("INVALID_CREDENTIALS", "用户名或密码错误", 401)
    bind_user(request, user.id, session)
    if user.disabled:
        raise AppError("USER_DISABLED", "账号已被禁用，请联系管理员", 403)
    return {"token": issue_token(user.id), "user": user_dict(user, session)}


@app.get("/api/me", response_model=UserOutput)
def me(user: User = Depends(current_user), session: Session = Depends(get_session)):
    return user_dict(user, session)


@app.patch("/api/me", response_model=UserOutput)
def update_me(
    body: UserProfilePatch,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    patch_user(session, user, body)
    session.commit()
    return user_dict(user, session)


@app.post("/api/assets", response_model=AssetOutput, dependencies=[Depends(limit_upload)])
def upload_asset(
    file: UploadFile = File(...),
    kind: str = Form(..., pattern="^(garment|model|reference)$"),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    data = file.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise AppError("FILE_TOO_LARGE", "图片不能超过 15MB", 413)
    asset = store_upload(session, user_id=user.id, kind=kind, data=data)
    session.commit()
    return asset_dict(asset)


@app.get("/media/{asset_id}", include_in_schema=False)
def get_media(
    asset_id: str,
    exp: int = Query(...),
    sig: str = Query(...),
    session: Session = Depends(get_session),
):
    valid_sig = (
        len(sig) == 64
        and sig.isascii()
        and hmac.compare_digest(media_signature(asset_id, exp), sig)
    )
    if exp <= int(time.time()) or not valid_sig:
        raise AppError("INVALID_SIGNATURE", "文件链接已失效", 403)
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise AppError("NOT_FOUND", "文件不存在", 404)
    if asset.project_id:
        project = session.get(Project, asset.project_id)
        if project is None or project.deleted_at:
            raise AppError("NOT_FOUND", "文件不存在", 404)
    path = asset_path(asset)
    if not path.is_file():
        raise AppError("NOT_FOUND", "文件不存在", 404)
    return FileResponse(
        path,
        media_type=asset.mime,
        headers={"Cache-Control": f"private, max-age={max(0, exp - int(time.time()))}"},
    )


@app.post("/api/projects", response_model=ProjectOutput)
def create_project(
    body: ProjectInput,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    for asset_id in set(body.garment_asset_ids):
        asset = session.get(Asset, asset_id)
        if not asset or asset.user_id != user.id or asset.kind != "garment":
            raise AppError("INVALID_ASSET", "衣服资产不存在或无权使用", 404)
    for asset_id in body.reference_asset_ids:
        asset = session.get(Asset, asset_id)
        if (
            not asset or asset.user_id != user.id or asset.kind != "reference"
            or asset.source != "upload"
        ):
            raise AppError("INVALID_ASSET", "参考图必须是本人上传的参考图资产", 422)
    model_id = body.model_asset_id
    if model_id is None:
        model_id = default_model_asset_id(session, user)
    if model_id:
        asset = session.get(Asset, model_id)
        if not asset or asset.user_id != user.id or asset.kind != "model":
            raise AppError("INVALID_ASSET", "模特资产不存在或无权使用", 404)
    project = Project(user_id=user.id, **{**body.model_dump(), "model_asset_id": model_id})
    session.add(project)
    session.commit()
    bind_project(project.id)
    return project_dict(project, session)


@app.get("/api/projects", response_model=list[ProjectOutput])
def list_projects(user: User = Depends(current_user), session: Session = Depends(get_session)):
    projects = session.scalars(
        select(Project)
        .where(Project.user_id == user.id, Project.deleted_at.is_(None))
        .order_by(Project.updated_at.desc())
    ).all()
    return [project_dict(project, session) for project in projects]


@app.get("/api/projects/{project_id}", response_model=ProjectOutput)
def get_project(
    project_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)
):
    return project_dict(owned_project(session, project_id, user.id), session)


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)
):
    project_lock(session, project_id)
    project = owned_project(session, project_id, user.id)
    cleanup_project(session, project)
    return Response(status_code=204)


def graph_for(session: Session, project: Project):
    workflow = Workflow(session, project)
    return app.state.graph, workflow


def restore_messages(session: Session, project_id: str, state: dict) -> str | None:
    """Checkpoint messages are the durable source; business rows are a projection."""
    latest_assistant_id = None
    existing_ids = set(session.scalars(select(Message.id).where(Message.project_id == project_id)))
    for message in state.get("messages", []):
        metadata = getattr(message, "additional_kwargs", {}).get("display")
        if not metadata or not getattr(message, "id", None):
            continue
        role = {"human": "user", "ai": "assistant"}.get(message.type)
        if not role:
            continue
        message_id = str(uuid5(NAMESPACE_URL, message.id))
        if role == "assistant":
            latest_assistant_id = message_id
        existing = session.get(Message, message_id) if message_id in existing_ids else None
        content = metadata.get("text", message.content)
        if "text" not in metadata and role == "user" and metadata.get("action"):
            if content == json.dumps(metadata["action"], ensure_ascii=False):
                content = ""
        if existing:
            # Same-id rewrites live in checkpoints too, including crash recovery.
            if role == "assistant":
                existing.text = content
                existing.trace = metadata.get("trace")
                existing.can_regenerate = metadata.get("can_regenerate", False)
            continue
        session.add(
            Message(
                id=message_id,
                project_id=project_id,
                role=role,
                text=content,
                cards=metadata.get("cards", []),
                action=metadata.get("action"),
                refs=metadata.get("refs", []),
                trace=metadata.get("trace"),
                can_regenerate=metadata.get("can_regenerate", False),
                created_at=datetime.fromisoformat(metadata["created_at"]),
            )
        )
        existing_ids.add(message_id)
    session.flush()
    return latest_assistant_id


@app.get("/api/projects/{project_id}/state", response_model=StateOutput)
def get_state(
    project_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)
):
    can_repair = project_lock(session, project_id, wait=False)
    project = owned_project(session, project_id, user.id)
    graph, workflow = graph_for(session, project)
    state = get_graph_state(graph, project_id)
    if can_repair:
        workflow.restore_jobs(state)
        restore_messages(session, project_id, state)
    images = image_items(session, project_id)
    jobs = session.scalars(
        select(Job)
        .where(Job.project_id == project_id, Job.status.in_(["queued", "running"]))
        .order_by(Job.created_at)
    ).all()
    garments = [
        dict(item, url=asset_dict(session.get(Asset, item["asset_id"]))["url"])
        for item in state.get("garments", [])
    ]
    video = state.get("video")
    if video and video.get("job_id"):
        vjob = session.get(Job, video["job_id"])
        if vjob:
            video = dict(video, status=vjob.status, url=job_dict(vjob)["url"])
            source = vjob.payload.get("source_asset_id")
            if source and session.get(Asset, source):
                video["poster_url"] = asset_dict(session.get(Asset, source))["url"]
    stage = (
        "done"
        if state.get("stage") in {"video", "done"} and video and video.get("status") == "succeeded"
        else state.get("stage", project.stage)
    )
    if can_repair and project.stage != stage:
        project.stage = stage
    cost = project_cost_cny(session, project_id)
    note = state.get("note")
    if note:
        note = {
            **note,
            "cost_cny": cost,
            "ai_label": "内容含 AI 生成图片，发布时请勾选平台的 AI 内容声明。",
        }
    latest_message_id = session.scalar(
        select(Message.id)
        .where(Message.project_id == project_id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(1)
    )
    directions = direction_items(session, project_id, state.get("directions", []))
    session.commit()
    return {
        "stage": stage,
        "garments": garments,
        "directions": directions,
        "chosen_direction_id": state.get("chosen_direction_id"),
        "script": state.get("script"),
        "images": images,
        "note": note,
        "video": video,
        "active_jobs": [job_dict(job) for job in jobs],
        "pending_action": pending_action_dict(state),
        "budget": user_budget(user, session),
        "cost_cny": cost,
        "last_message_id": latest_message_id,
        "script_versions": script_versions(graph, project_id),
    }


@app.get("/api/projects/{project_id}/messages", response_model=list[MessageOutput])
def list_messages(
    project_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)
):
    can_repair = project_lock(session, project_id, wait=False)
    project = owned_project(session, project_id, user.id)
    graph, workflow = graph_for(session, project)
    state = get_graph_state(graph, project_id)
    if can_repair:
        workflow.restore_jobs(state)
        restore_messages(session, project_id, state)
    session.commit()
    rows = session.scalars(
        select(Message)
        .where(Message.project_id == project_id)
        .order_by(Message.created_at, Message.id)
    ).all()
    return [message_dict(row, session) for row in rows]


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def regenerate_reply(session: Session, graph, workflow: Workflow, message_id: str) -> list[str]:
    project_id = workflow.project.id
    state = get_graph_state(graph, project_id)
    restore_messages(session, project_id, state)
    message = session.get(Message, message_id)
    if not message or message.project_id != project_id or message.role != "assistant":
        raise AppError("message_not_found", "这条回复不存在或不属于当前项目。", 404)
    if not message.can_regenerate:
        raise AppError(
            "cannot_regenerate", "这轮回复包含付费生成任务，不能重新回复，请直接告诉我想改哪里。",
        )
    original = next((item for item in state.get("messages", [])
                     if str(uuid5(NAMESPACE_URL, item.id)) == message_id), None)
    if original is None:
        raise AppError("cannot_regenerate", "这条历史回复暂不支持重写，请发送新的消息。")
    started = time.monotonic()
    workflow.providers.trace_context = {"regenerate_message_id": message_id}
    text = workflow.providers.regenerate_reply(message.text, workflow._context(state))
    refs = list((message.trace or {}).get("refs", []))
    trace = dialogue_trace(
        workflow.providers, "chat", round((time.monotonic() - started) * 1000), refs,
    )
    trace["steps"] = [{**step, "label": "重写回复"} for step in trace["steps"]]
    replacement = original.model_copy(deep=True)
    replacement.content = text
    replacement.additional_kwargs["display"].update(text=text, trace=trace)
    # The next real turn supplies incoming before executing; no tool runs here.
    graph.update_state({"configurable": {"thread_id": project_id}},
                       {"messages": [replacement]}, as_node=f"await_{state['stage']}")
    restore_messages(session, project_id, get_graph_state(graph, project_id))
    workflow.project.updated_at = utcnow()
    session.commit()
    events = [sse("token", {"delta": text[i:i + 24]}) for i in range(0, len(text), 24)]
    return [*events, sse("trace", trace), sse("done", {"message_id": message_id})]


def process_turn(project_id: str, user_id: str, body: MessageInput, emit=None) -> list[str]:
    with SessionLocal() as session:
        try:
            project_lock(session, project_id)
            project = owned_project(session, project_id, user_id)
            user = session.get(User, user_id, populate_existing=True)
            if user is None or user.disabled:
                raise AppError("USER_DISABLED", "账号已被禁用，请联系管理员", 403)
            graph, workflow = graph_for(session, project)
            action = body.action.model_dump(exclude_none=True) if body.action else None
            if action and action["type"] == "regenerate_reply":
                return regenerate_reply(session, graph, workflow, action["message_id"])
            result = run_turn(
                graph, project, body.text, action, workflow=workflow, emit=emit, refs=body.refs
            )
            project.stage = result["stage"]
            project.updated_at = utcnow()
            assistant_id = restore_messages(session, project_id, get_graph_state(graph, project_id))
            session.commit()
            events = [
                sse("token", {"delta": result["text"][i : i + 24]})
                for i in range(0, len(result["text"]), 24)
            ]
            for card in refresh_cards(result.get("cards", []), session, project_id):
                events.append(sse("card", card))
            for job in result.get("jobs", []):
                events.append(sse("job", job_dict(job) if isinstance(job, Job) else job))
            if result.get("trace"):
                events.append(sse("trace", result["trace"]))
            events.append(sse("done", {"message_id": assistant_id}))
            return events
        except Exception as exc:
            session.rollback()
            if not isinstance(exc, AppError):
                log_exception(log, "Conversation failed", exc)
            if hasattr(exc, "code") and hasattr(exc, "message"):
                return [sse("error", {"code": exc.code, "message": exc.message})]
            return [sse("error", {"code": "AGENT_ERROR", "message": "这次没完成，请稍后再试"})]


@app.post(
    "/api/projects/{project_id}/messages",
    response_class=StreamingResponse,
    dependencies=[Depends(limit_messages)],
    responses={
        200: {
            "description": "SSE：token / card / job / trace / done / error；重写回复同 id 覆盖",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    },
)
def post_message(
    project_id: str,
    body: MessageInput,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    owned_project(session, project_id, user.id)
    user_id = user.id
    session.rollback()  # Release the authentication connection before the long SSE response.

    async def generate():
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        def emit(event, data):
            loop.call_soon_threadsafe(queue.put_nowait, sse(event, data))

        task = asyncio.create_task(asyncio.to_thread(process_turn, project_id, user_id, body, emit))
        received = None
        try:
            while not task.done() or not queue.empty():
                if not queue.empty():
                    yield queue.get_nowait()
                    continue
                received = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {task, received}, timeout=10, return_when=asyncio.FIRST_COMPLETED
                )
                if received in done:
                    yield received.result()
                else:
                    received.cancel()
                    await asyncio.gather(received, return_exceptions=True)
                received = None
                if not done:
                    yield ": keepalive\n\n"
            for event in await task:
                yield event
        finally:
            if received is not None:
                received.cancel()
                await asyncio.gather(received, return_exceptions=True)
            # Client disconnect does not cancel durable graph work running in its own thread.
            if not task.done():
                task.add_done_callback(
                    lambda completed: completed.exception() if not completed.cancelled() else None
                )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/jobs/{job_id}", response_model=JobOutput)
def get_job(
    job_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)
):
    job = session.scalar(select(Job).where(Job.id == job_id, Job.user_id == user.id))
    if job is None:
        raise AppError("NOT_FOUND", "任务不存在", 404)
    owned_project(session, job.project_id, user.id)
    return job_dict(job)


app.add_middleware(RequestProtectionMiddleware)
app.add_middleware(RequestObservabilityMiddleware)
