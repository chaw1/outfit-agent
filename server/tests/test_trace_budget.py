"""Confirmation prices and current-day quotas use the existing accounting data."""

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import main
from app.costs import AUTO_FIX_ALLOWANCE, image_cost_cny, video_cost_cny
from app.models import Base, Project, UsageLedger, User
from app.runtime_settings import (
    day_bounds,
    default_runtime_settings,
    save_runtime_settings,
    user_budget,
)
from app.schemas import StateOutput
from app.views import pending_action_dict, user_dict


@pytest.fixture
def budget_session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'trace-budget.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(username="budget-owner", nickname="博主", password_hash="unused", tier="pro")
        other = User(username="budget-other", nickname="其他博主", password_hash="unused")
        session.add_all([user, other])
        session.flush()
        project = Project(user_id=user.id, title="预算", brand="本地品牌", brief="通勤")
        session.add(project)
        session.commit()
        yield session, user, other, project
    engine.dispose()


@pytest.mark.parametrize("shots, expected", [(0, 0), (1, 0.6), (4, 2.4)])
def test_script_quote_includes_twenty_percent_auto_fix_without_mutating_state(shots, expected):
    pending = {"type": "confirm_script", "prompt": "请确认脚本。"}
    state = {"pending_action": pending, "script": {"shots": [{"id": i} for i in range(shots)]}}
    result = pending_action_dict(state)
    assert result == {**pending, "estimated_cost_cny": expected}
    assert Decimal(str(result["estimated_cost_cny"])) == image_cost_cny(shots) * AUTO_FIX_ALLOWANCE
    assert "estimated_cost_cny" not in pending


def test_video_quote_uses_supported_five_second_request_and_other_pauses_stay_compatible():
    pending = {"type": "confirm_video", "prompt": "请单独确认视频。"}
    # Video generation currently always requests five seconds, even for legacy
    # scripts that contain a different duration hint.
    quote = pending_action_dict({"pending_action": pending, "script": {"video": {"duration": 10}}})
    assert quote["estimated_cost_cny"] == float(video_cost_cny()) == 1.5
    direction = {"type": "choose_direction", "prompt": "请选择方向。"}
    assert pending_action_dict({"pending_action": direction}) == direction
    assert pending_action_dict({}) is None
    assert pending_action_dict({"pending_action": None}) is None


def test_budget_matches_me_runtime_tier_and_shanghai_day_across_all_ledger_statuses(budget_session):
    session, user, other, project = budget_session
    config = default_runtime_settings()
    config["tiers"]["pro"]["daily_budget_cny"] = 7.5
    save_runtime_settings(session, config)
    start, end = day_bounds()
    for when, cost, status, owner in (
        (start - timedelta(microseconds=1), "10", "succeeded", user),
        (start, "1.2", "succeeded", user),
        (start, "0.3", "failed", user),
        (end - timedelta(microseconds=1), "0.5", "reserved", user),
        (end, "10", "succeeded", user),
        (start, "99", "succeeded", other),
    ):
        session.add(UsageLedger(
            project_id=project.id, user_id=owner.id, model="test-accounting", kind="image",
            status=status, estimated_cny=Decimal(cost), created_at=when,
        ))
    session.commit()
    budget = user_budget(user, session)
    assert budget == {
        "tier": "pro", "daily_budget_cny": 7.5, "today_cost_cny": 2.0, "remaining_cny": 5.5,
    }
    me = user_dict(user, session)
    fields = ("tier", "daily_budget_cny", "today_cost_cny")
    assert all(me[field] == budget[field] for field in fields)
    config["tiers"]["pro"]["daily_budget_cny"] = 1
    save_runtime_settings(session, config)
    session.commit()
    assert user_budget(user, session)["remaining_cny"] == 0
    assert user_dict(user, session)["daily_budget_cny"] == 1


def test_state_exposes_live_budget_and_current_confirmation_quote(budget_session, monkeypatch):
    session, user, _, project = budget_session
    config = default_runtime_settings()
    config["tiers"]["pro"]["daily_budget_cny"] = 5
    save_runtime_settings(session, config)
    session.add(UsageLedger(
        project_id=project.id, user_id=user.id, model="test-accounting", kind="image",
        status="reserved", estimated_cny=Decimal("0.75"),
    ))
    session.commit()
    state = {
        "stage": "script", "script": {"shots": [{"id": "one"}, {"id": "two"}]},
        "pending_action": {"type": "confirm_script", "prompt": "确认后出图。"},
    }
    monkeypatch.setattr(main, "project_lock", lambda *args, **kwargs: False)
    monkeypatch.setattr(main, "graph_for", lambda *args: (object(), object()))
    monkeypatch.setattr(main, "get_graph_state", lambda *args: state)
    monkeypatch.setattr(main, "script_versions", lambda *args: [])
    response = main.get_state(project.id, user, session)
    validated = StateOutput.model_validate(response).model_dump()
    assert validated["pending_action"]["estimated_cost_cny"] == 1.2
    assert validated["budget"] == {
        "tier": "pro", "daily_budget_cny": 5, "today_cost_cny": 0.75, "remaining_cny": 4.25,
    }
    assert "estimated_cost_cny" not in state["pending_action"]
