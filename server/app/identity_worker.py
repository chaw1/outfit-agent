"""独立身份卡任务；逐步落盘，未知付费请求不重复提交。"""

from sqlalchemy import select

from app.config import settings
from app.media import store_generated
from app.model_library import ANGLE_LABELS, identity_quote_values
from app.models import Asset, Job, Model, User
from app.providers import ProviderError, ProviderHub
from app.runtime_settings import assert_generation_allowed


def process_identity(job_id: str, attempt: int, session_factory) -> None:
    # Import lazily so both workers share the lease mechanism without a cycle.
    from app.worker import LeaseHeartbeat

    with session_factory() as session:
        job = session.get(Job, job_id)
        if not job or job.status != "running" or job.attempts != attempt:
            return
        model = session.get(Model, job.payload["model_id"])
        try:
            if not model or model.status == "deleted":
                raise ProviderError("模特已删除。")
            user = session.get(User, job.user_id)
            if not user or user.disabled or user.deleted_at:
                raise ProviderError("账号已停用。")
            runtime_models, _, _ = identity_quote_values(
                session,
                len(job.payload["input_asset_ids"]),
            )
            if job.payload["models"] != runtime_models:
                raise ProviderError("模型配置已变化，请重新预估并建立身份卡。")
            assert_generation_allowed(session, job.user_id, kinds=("image", "vision"))
            model.status = "building"
            session.commit()
            hub = ProviderHub(session, trace_context={"job_id": job_id}, user_id=job.user_id)

            def fence():
                session.refresh(model, with_for_update=True)
                session.refresh(job, with_for_update=True)
                if job.status != "running" or job.attempts != attempt or model.status == "deleted":
                    session.rollback()
                    raise ProviderError("身份卡任务已停止。")

            def mark_request():
                fence()
                job.result = {**job.result, "external_request_started": not settings.mock_providers}
                session.commit()

            def complete_step():
                job.result = {
                    **job.result,
                    "external_request_started": False,
                    "completed_angles": len(model.sheet_asset_ids),
                }
                session.commit()

            with LeaseHeartbeat(job_id, attempt, session_factory):
                inputs = [
                    session.get(Asset, asset_id) for asset_id in job.payload["input_asset_ids"]
                ]
                if any(not asset or asset.user_id != job.user_id for asset in inputs):
                    raise ProviderError("身份卡照片已失效。")
                if not model.identity_text:
                    mark_request()
                    identity_text = hub.describe_identity(inputs)
                    fence()
                    model.identity_text = identity_text
                    complete_step()
                while len(model.sheet_asset_ids) < 4:
                    index = len(model.sheet_asset_ids)
                    mark_request()
                    prompt = (
                        "建立同一位成年人的身份卡，严格保留参考照片中的面部身份、肤色、体型、发型发色。"
                        f"人物：{model.identity_text}。本张角度：{ANGLE_LABELS[index]}。"
                        "自然光、纯净浅色背景、简单日常着装，不加首饰和文字。"
                    )
                    media = hub.image(prompt, inputs)
                    fence()
                    asset = store_generated(
                        session,
                        user_id=job.user_id,
                        project_id=None,
                        kind="model",
                        media=media,
                        prompt=prompt,
                    )
                    asset.analysis = {"identity_model_id": model.id}
                    model.sheet_asset_ids = [*model.sheet_asset_ids, asset.id]
                    complete_step()
                fence()
                model.status = "ready"
                job.status, job.locked_at, job.error = "succeeded", None, None
                job.result = {**job.result, "model_id": model.id}
                session.commit()
        except Exception as exc:
            session.rollback()
            # Account deletion and lease recovery take model-before-job locks too.
            session.get(Model, job.payload["model_id"], with_for_update=True)
            job = session.scalar(select(Job).where(Job.id == job_id).with_for_update())
            if not job or job.status != "running" or job.attempts != attempt:
                return
            job.status, job.locked_at = "failed", None
            job.error = (
                str(exc)[:500] if isinstance(exc, ProviderError) else "身份卡建立失败，请重试。"
            )
            model = session.get(Model, job.payload["model_id"])
            if model and model.status != "deleted":
                model.status = "failed"
            session.commit()
