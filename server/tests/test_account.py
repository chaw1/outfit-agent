"""Account closure contracts, including persistence and authentication boundaries."""

import re

from fastapi.testclient import TestClient

from app.account import LEGAL_VERSION
from app.main import app


def test_legal_documents_are_public_complete_and_versioned():
    with TestClient(app, raise_server_exceptions=True) as client:
        index = client.get("/api/legal")
        assert index.status_code == 200
        assert {row["kind"] for row in index.json()} == {"terms", "privacy", "disclaimer"}
        for summary in index.json():
            assert summary["version"] == LEGAL_VERSION == "2026-10-21"
            response = client.get("/api/legal/" + summary["kind"])
            assert response.status_code == 200
            document = response.json()
            assert {key: document[key] for key in summary} == summary
            assert 400 <= len(re.sub(r"\s|[#*`>-]", "", document["markdown"])) <= 900
            assert "衣序（演示版）" in document["markdown"]
            assert "97000945@qq.com" in document["markdown"]
        assert client.get("/api/legal/missing").status_code == 404
