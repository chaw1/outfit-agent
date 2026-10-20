"""Paid verification refuses duplicate/unknown submissions; HTTP stays in-process."""

import json
import sqlite3

import httpx
import pytest

from app.providers import ProviderHub
from scripts import verify_profile


@pytest.fixture
def verification(tmp_path, monkeypatch):
    monkeypatch.setattr(verify_profile, "ROOT", tmp_path)
    monkeypatch.setattr(verify_profile.settings, "deepseek_api_key", "test-placeholder")
    monkeypatch.setattr(verify_profile.settings, "deepseek_base_url", "https://api.deepseek.com")
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["max_tokens"] == 1400
        name = payload["tools"][0]["function"]["name"]
        content = json.loads(payload["messages"][1]["content"])
        result = ProviderHub._mock_text(name, content["context"], content["instruction"])
        return httpx.Response(200, json={
            "choices": [{"message": {"tool_calls": [{"function": {
                "name": name, "arguments": json.dumps(result),
            }}]}}], "usage": {"prompt_tokens": 1000, "completion_tokens": 500},
        })

    def enter(self):
        self.client = httpx.Client(transport=httpx.MockTransport(handler))
        return self

    monkeypatch.setattr(verify_profile.LimitedClient, "__enter__", enter)
    return tmp_path / "profile", calls


def test_two_text_calls_are_resume_safe_and_do_not_generate_images(verification):
    output, calls = verification
    verify_profile.run(output)
    verify_profile.run(output)
    assert len(calls) == 2
    assert [item["tools"][0]["function"]["name"] for item in calls] == [
        "propose_directions", "write_script",
    ]
    evidence = json.loads((output / "profile-real.json").read_text())
    assert evidence["no_vision_or_image_calls"] is True
    assert float(evidence["total_cost_or_unknown_reservation_cny"]) < 0.1
    assert all(item["status"] == "succeeded" for item in evidence["calls"])


def test_unknown_started_call_is_never_resubmitted(verification):
    output, calls = verification
    verify_profile.run(output)
    with sqlite3.connect(output / "profile-ledger.sqlite") as connection:
        connection.execute("UPDATE calls SET status='started',response=NULL WHERE step='script'")
    with pytest.raises(RuntimeError, match="refusing resubmission"):
        verify_profile.run(output)
    assert len(calls) == 2
