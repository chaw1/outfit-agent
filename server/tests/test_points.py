"""Display points share the ledger's CNY estimates, including old messages."""

from copy import deepcopy
from decimal import Decimal

import pytest
import test_graph_workflow

from app.costs import POINTS_PER_CNY, points, with_points
from app.graph import run_turn
from app.models import Message, User
from app.views import message_dict, pending_action_dict, user_dict

flow = test_graph_workflow.flow


@pytest.mark.parametrize("cny,expected", [(0, 0), (.5, 5), (1.5, 15), (.034, .3)])
def test_points_round_to_one_decimal(cny, expected):
    assert POINTS_PER_CNY == 10
    assert points(Decimal(str(cny))) == expected


def test_historical_nested_fields_are_projected_without_mutation(flow):
    session, project, _, _ = flow
    original = {
        "cost_cny": .034,
        "nested": [{"regenerate_estimate_cny": 1.5}],
        "estimated_cost_cny": None,
    }
    snapshot = deepcopy(original)
    converted = with_points(original)
    assert converted["cost_points"] == .3
    assert converted["nested"][0]["regenerate_estimate_points"] == 15
    assert original == snapshot
    message = Message(
        project_id=project.id, role="assistant", text="旧回复",
        cards=[{"type": "custom", "cost_cny": .5}],
        trace={"tool": "chat", "model": "mock", "duration_ms": 1, "cost_cny": .034},
    )
    session.add(message)
    session.flush()
    output = message_dict(message, session)
    assert output["trace"]["cost_points"] == .3
    assert output["cards"][0]["cost_points"] == 5


def test_confirmation_cards_and_user_budget_use_same_rate(flow):
    session, project, _, graph = flow
    user = user_dict(session.get(User, project.user_id), session)
    assert user["daily_budget_points"] == points(user["daily_budget_cny"])
    assert user["today_cost_points"] == points(user["today_cost_cny"])
    turn = run_turn(graph, project, "开始", None)
    card = next(card for card in turn["cards"] if card["type"] == "directions")
    assert card["regenerate_estimate_points"] == points(card["regenerate_estimate_cny"])
    for state in [
        {"pending_action": {"type": "confirm_script"}, "script": {"shots": [{}, {}, {}]}},
        {"pending_action": {"type": "confirm_video"}},
    ]:
        pending = pending_action_dict(state)
        assert pending["estimated_cost_points"] == points(pending["estimated_cost_cny"])
