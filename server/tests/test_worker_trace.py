from decimal import Decimal

from langchain_core.messages import AIMessage
from sqlalchemy import select
from test_worker_providers import add_job
from test_worker_providers import local_db as local_db

from app import main, worker
from app.models import Job, Message, UsageLedger, utcnow
from app.providers import ProviderError, ProviderHub
from app.schemas import MessageOutput
from app.views import message_dict


def test_worker_batch_trace_correlates_every_call_and_cannot_regenerate(local_db):
    factory, ids = local_db
    first = add_job(factory, ids, payload={"prompt": "通勤", "script_hash": "batch"})
    second = add_job(factory, ids, payload={"prompt": "日常", "script_hash": "batch"})
    assert worker.run_once(factory)
    with factory() as session:
        assert session.scalars(select(Message)).all() == []
    assert worker.run_once(factory)
    with factory() as session:
        message = session.scalar(select(Message))
        assert message.can_regenerate is False
        trace = message.trace
        assert trace["tool"] == "generate_images"
        assert trace["model"] == "wan2.7-image-pro"
        assert trace["refs"] == [first, second]
        assert trace["steps"][0]["label"] == "出图 2 张"
        assert any(item["label"] == "还原检查 2 次" for item in trace["steps"])
        rows = session.scalars(select(UsageLedger)).all()
        assert len(rows) == 4
        assert {row.units["job_id"] for row in rows} == {first, second}
        assert trace["cost_cny"] == sum(float(row.estimated_cny) for row in rows) == 0
        assert trace["duration_ms"] >= sum(step["duration_ms"] for step in trace["steps"])


def test_message_projection_preserves_trace_and_regeneration_flag(local_db):
    factory, ids = local_db
    trace = {
        "tool": "write_script", "model": "deepseek-flash", "duration_ms": 123,
        "cost_cny": 0.001234, "refs": ["selected-image"],
        "steps": [{"label": "写脚本", "duration_ms": 123}],
    }
    with factory() as session:
        message = Message(
            project_id=ids[1], role="assistant", text="脚本写好了。", cards=[],
            trace=trace, can_regenerate=True,
        )
        session.add(message)
        session.commit()
        projected = MessageOutput.model_validate(message_dict(message, session)).model_dump()
        assert projected["trace"] == {**trace, "cost_points": 0.0}
        assert projected["can_regenerate"] is True


def test_trace_and_same_id_rewrite_recover_from_checkpoint_after_rollback(local_db):
    factory, ids = local_db
    trace = {
        "tool": "write_script", "model": "deepseek-flash", "duration_ms": 123,
        "cost_cny": 0.001234, "refs": [],
        "steps": [{"label": "写脚本", "duration_ms": 123}],
    }
    display = {
        "text": "脚本写好了。", "cards": [], "trace": trace, "can_regenerate": True,
        "created_at": utcnow().isoformat(),
    }
    state = {"messages": [AIMessage(
        id="recoverable-turn:assistant", content=display["text"],
        additional_kwargs={"display": display},
    )]}
    with factory() as session:
        message_id = main.restore_messages(session, ids[1], state)
        session.rollback()
        assert session.get(Message, message_id) is None
        assert main.restore_messages(session, ids[1], state) == message_id
        session.commit()
        message = session.get(Message, message_id)
        assert message.trace == trace and message.can_regenerate is True
        replacement = state["messages"][0].model_copy(deep=True)
        replacement.content = "换个说法，脚本已经准备好了。"
        rewrite_trace = {**trace, "tool": "chat", "cost_cny": 0.000123}
        replacement.additional_kwargs["display"].update(
            text=replacement.content, trace=rewrite_trace,
        )
        state["messages"] = [replacement]
        main.restore_messages(session, ids[1], state)
        session.rollback()
        assert session.get(Message, message_id).text == display["text"]
        assert main.restore_messages(session, ids[1], state) == message_id
        session.commit()
        rows = session.scalars(select(Message)).all()
        assert len(rows) == 1 and rows[0].text == replacement.content
        assert rows[0].trace == rewrite_trace and rows[0].can_regenerate is True


def test_batch_trace_excludes_concurrent_spend_and_includes_failed_attempts(local_db):
    factory, ids = local_db
    job_id = add_job(factory, ids, status="succeeded", result={"duration_ms": 100})
    with factory() as session:
        job = session.get(Job, job_id)
        for target, kind, cost, status, purpose, duration in [
            (job_id, "image", "0.5", "failed", None, 20),
            (job_id, "image", "0.5", "succeeded", None, 30),
            (job_id, "vision", "0.004321", "succeeded", "fidelity", 10),
            ("another-job", "image", "0.5", "succeeded", None, 50),
            (None, "text", "0.00315", "succeeded", None, 20),
        ]:
            units = {"job_id": target} if target else {"turn_id": "concurrent-turn"}
            if purpose:
                units["purpose"] = purpose
            session.add(UsageLedger(
                project_id=ids[1], user_id=ids[0], model=f"unit-{kind}", kind=kind,
                estimated_cny=Decimal(cost), status=status, units=units, duration_ms=duration,
            ))
        session.commit()
        worker._notify_completion(session, job)
        session.commit()
        trace = session.scalar(select(Message)).trace
        assert trace["cost_cny"] == 1.004321
        assert trace["model"] == "unit-image"
        assert trace["duration_ms"] == 100
        assert trace["steps"] == [
            {"label": "出图 1 张", "duration_ms": 50},
            {"label": "还原检查 1 次", "duration_ms": 10},
        ]


def test_edit_trace_references_source_and_accounts_instruction_check(local_db):
    factory, ids = local_db
    job_id = add_job(factory, ids, kind="edit", payload={
        "prompt": "袖口放下来", "instruction": "袖口放下来", "image_id": "new-image",
        "parent_id": "source-image", "source_asset_id": ids[2],
        "reference_asset_ids": [ids[2]],
    })
    assert worker.run_once(factory)
    with factory() as session:
        assert session.get(Job, job_id).status == "succeeded"
        message = session.scalar(select(Message))
        assert message.trace["tool"] == "edit_image"
        assert message.trace["refs"] == ["source-image"]
        assert message.trace["steps"][0]["label"] == "改图 1 张"
        assert any(step["label"] == "改图指令核对 1 次" for step in message.trace["steps"])


def test_video_trace_keeps_source_image_and_video_model(local_db):
    factory, ids = local_db
    add_job(factory, ids, kind="video", payload={
        "prompt": "轻轻转身", "image_id": "selected-image", "source_asset_id": ids[2],
    })
    assert worker.run_once(factory)
    with factory() as session:
        message = session.scalar(select(Message))
        assert message.can_regenerate is False
        assert message.trace["tool"] == "generate_video"
        assert message.trace["model"] == "wan2.6-i2v-flash"
        assert message.trace["refs"] == ["selected-image"]
        assert message.trace["steps"][0]["label"] == "生成视频 1 条"


def test_failed_job_still_publishes_trace_once_without_accounting_rows(local_db, monkeypatch):
    factory, ids = local_db
    job_id = add_job(factory, ids)

    def reject(*args):
        raise ProviderError("生成服务拒绝了这次请求。")

    monkeypatch.setattr(ProviderHub, "image", reject)
    assert worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "failed"
        worker._notify_completion(session, job)
        session.commit()
        messages = session.scalars(select(Message)).all()
        assert len(messages) == 1
        assert messages[0].trace["cost_cny"] == 0
        assert messages[0].trace["steps"][0]["label"] == "出图 1 张"
        assert messages[0].can_regenerate is False


def test_auto_repair_and_batch_trace_have_explicit_scopes(local_db, monkeypatch):
    factory, ids = local_db
    original = add_job(factory, ids, payload={"prompt": "通勤", "script_hash": "repair-batch"})
    real_fidelity = ProviderHub.fidelity
    calls = []

    def low_once(self, *args):
        result = real_fidelity(self, *args)
        calls.append(True)
        if len(calls) == 1:
            return {**result, "score": 42, "diffs": ["口袋缺失"]}
        return result

    monkeypatch.setattr(ProviderHub, "fidelity", low_once)
    assert worker.run_once(factory)
    assert worker.run_once(factory)
    with factory() as session:
        fix_id = session.get(Job, original).result["auto_fix_job_id"]
        messages = session.scalars(select(Message)).all()
        assert len(messages) == 2
        batch = next(message.trace for message in messages if "成功 1 张" in message.text)
        repair = next(message.trace for message in messages if "自动还原修复做好了" in message.text)
        assert batch["tool"] == "generate_images"
        assert set(batch["refs"]) == {original, fix_id}
        assert any(step["label"] == "自动还原修复 1 张" for step in batch["steps"])
        assert repair["tool"] == "edit_image"
        assert repair["refs"] == [original]
        assert all(message.can_regenerate is False for message in messages)
