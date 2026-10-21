"""Reference thumbnails describe owned durable inputs and remain usable in history."""

from copy import deepcopy

from sqlalchemy import select
from test_anchor_worker import anchor_db as anchor_db
from test_anchor_worker import seed_batch

from app import worker
from app.models import Asset, Job, Message, Project
from app.schemas import MessageOutput
from app.tracing import job_reference_images
from app.views import message_dict
from app.workflow import Workflow


def test_submission_and_worker_completion_expose_inputs_and_resolved_anchor(anchor_db):
    factory, calls, _ = anchor_db
    project_id, ids, state = seed_batch(factory)
    with factory() as session:
        project = session.get(Project, project_id)
        jobs = [session.get(Job, job_id) for job_id in ids]
        workflow = Workflow(session, project)
        workflow.tool = "generate_images"
        submitted = workflow._finish(state, "已开始出图", [], jobs)["turn_trace"]
        expected_inputs = {project.model_asset_id, *project.garment_asset_ids}
        assert {item["id"] for item in submitted["reference_images"]} == expected_inputs
        assert {item["role"] for item in submitted["reference_images"]} == {"模特", "衣服"}
        session.commit()
    for _ in ids:
        assert worker.run_once(factory)
    with factory() as session:
        message = session.scalar(select(Message))
        trace = MessageOutput.model_validate(message_dict(message, session)).trace
        cover_asset = session.get(Job, ids[0]).result_asset_id
        refs = trace.reference_images
        assert {item.id for item in refs} == expected_inputs | {cover_asset}
        assert sum(item.role == "封面锚点" for item in refs) == 1
        assert next(item for item in refs if item.id == cover_asset).role == "封面锚点"
        assert {item.id for item in refs} == set().union(
            *(set(call["references"]) for call in calls)
        )
        assert all("/media/" in item.url and "sig=" in item.url for item in refs)


def test_edit_trace_includes_source_and_inherited_anchor_and_filters_unowned_inputs(anchor_db):
    factory, _, _ = anchor_db
    project_id, ids, _ = seed_batch(factory)
    for _ in ids:
        assert worker.run_once(factory)
    with factory() as session:
        project = session.get(Project, project_id)
        source = session.get(Job, ids[1]).result_asset_id
        anchor = session.get(Job, ids[0]).result_asset_id
        foreign = Asset(
            id="foreign",
            user_id="another-owner",
            kind="model",
            path="unused.png",
            mime="image/png",
        )
        unrelated = Asset(
            id="unrelated",
            user_id=project.user_id,
            project_id="other-project",
            kind="reference",
            path="unused.png",
            mime="image/png",
        )
        session.add_all([foreign, unrelated])
        session.flush()
        edit = Job(
            user_id=project.user_id,
            project_id=project_id,
            kind="edit",
            dedupe_key="trace-edit",
            payload={
                "source_asset_id": source,
                "anchor_asset_id": anchor,
                "reference_asset_ids": [
                    source,
                    *project.garment_asset_ids,
                    anchor,
                    source,
                    "foreign",
                    "unrelated",
                    "missing",
                ],
            },
        )
        session.add(edit)
        session.flush()
        workflow = Workflow(session, project)
        workflow.tool = "edit_image"
        trace = workflow._finish({"stage": "images"}, "正在改", [], [edit])["turn_trace"]
        roles = {item["id"]: item["role"] for item in trace["reference_images"]}
        assert roles[source] == "参考图"
        assert roles[anchor] == "封面锚点"
        assert roles[project.model_asset_id] == "模特"
        assert not {"foreign", "unrelated", "missing"} & roles.keys()
        assert len(trace["reference_images"]) == len(roles)


def test_history_resigns_links_without_mutating_trace_and_removes_missing_assets(
    anchor_db, monkeypatch
):
    factory, _, _ = anchor_db
    project_id, ids, _ = seed_batch(factory)
    with factory() as session:
        job = session.get(Job, ids[0])
        trace = {
            "tool": "generate_images",
            "model": "mock",
            "duration_ms": 0,
            "cost_cny": 0,
            "refs": [],
            "steps": [],
            "reference_images": job_reference_images(session, [job]),
        }
        trace["reference_images"].append({"id": "missing", "url": "expired", "role": "参考图"})
        original = deepcopy(trace)
        message = Message(
            project_id=project_id, role="assistant", text="已完成", cards=[], trace=trace
        )
        session.add(message)
        session.flush()
        monkeypatch.setattr("app.tracing.signed_url", lambda asset_id: f"fresh/{asset_id}")
        result = message_dict(message, session)["trace"]
        assert message.trace == original
        assert len(result["reference_images"]) == len(original["reference_images"]) - 1
        assert all(item["url"] == f"fresh/{item['id']}" for item in result["reference_images"])
        assert "missing" not in {item["id"] for item in result["reference_images"]}


def test_legacy_trace_without_thumbnails_remains_readable(anchor_db):
    factory, _, _ = anchor_db
    project_id, _, _ = seed_batch(factory)
    with factory() as session:
        message = Message(
            project_id=project_id,
            role="assistant",
            text="旧回复",
            cards=[],
            trace={
                "tool": "chat",
                "model": "mock",
                "duration_ms": 0,
                "cost_cny": 0,
            },
        )
        session.add(message)
        session.flush()
        assert (
            MessageOutput.model_validate(message_dict(message, session)).trace.reference_images
            == []
        )
