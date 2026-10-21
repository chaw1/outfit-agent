"""Fresh and historical direction cards quote the next preview group."""

from copy import deepcopy
from decimal import Decimal

import pytest
import test_graph_workflow
from sqlalchemy import select

from app import costs
from app.graph import run_turn
from app.models import Job
from app.views import refresh_cards

flow = test_graph_workflow.flow


@pytest.mark.parametrize("count", [2, 3])
def test_direction_quote_covers_three_previews_at_shared_image_price(flow, monkeypatch, count):
    _, _, _, graph = flow
    monkeypatch.setattr(costs, "IMAGE_ESTIMATE_CNY", Decimal("0.70"))
    card = graph.workflow._card("directions", {"options": [{"id": str(i)} for i in range(count)]})
    assert card["regenerate_estimate_cny"] == float(costs.image_cost_cny(3)) == 2.1
    assert card["regenerate_estimate_cny"] > 0


def test_quote_is_available_on_refresh_and_historical_cards_without_changing_preview_keys(flow):
    session, project, _, graph = flow
    initial = run_turn(graph, project, "开始", None)
    card = next(card for card in initial["cards"] if card["type"] == "directions")
    assert card["regenerate_estimate_cny"] == float(costs.image_cost_cny(3))
    before_jobs = [(job.id, job.dedupe_key) for job in session.scalars(select(Job))]
    legacy = {key: deepcopy(value) for key, value in card.items()
              if key != "regenerate_estimate_cny"}
    snapshot = deepcopy(legacy)

    readback = refresh_cards([legacy], session, project.id)[0]
    assert readback["regenerate_estimate_cny"] == card["regenerate_estimate_cny"]
    assert all(option["preview_status"] == "queued" for option in readback["options"])
    assert legacy == snapshot
    assert [(job.id, job.dedupe_key) for job in session.scalars(select(Job))] == before_jobs

    refreshed = run_turn(graph, project, "换一组方向", None)
    new_card = next(card for card in refreshed["cards"] if card["type"] == "directions")
    assert new_card["regenerate_estimate_cny"] == card["regenerate_estimate_cny"] > 0
    assert {option["id"] for option in new_card["options"]}.isdisjoint(
        option["id"] for option in card["options"]
    )
