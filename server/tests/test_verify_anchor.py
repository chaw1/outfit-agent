"""The paid anchor experiment cannot resubmit unknown work or mutate offline accounting."""

import hashlib
import json
import shutil
import sqlite3
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import Asset, UsageLedger
from app.providers import ProviderHub
from scripts import verify_anchor


@pytest.fixture
def verification(tmp_path, monkeypatch):
    root = tmp_path / "anchor-verification"
    fixtures = root / "fixtures"
    fixtures.mkdir(parents=True)
    for name in ("shirt.jpg", "model.jpg"):
        shutil.copyfile(verify_anchor.ROOT / "fixtures" / name, fixtures / name)
    monkeypatch.setattr(verify_anchor, "ROOT", root)
    for key, value in {
        "mock_providers": True,
        "media_dir": root / "unused-media",
        "model_budget_cny": 5,
        "deepseek_api_key": "test-placeholder",
        "dashscope_api_key": "test-placeholder",
        "deepseek_base_url": "https://api.deepseek.com",
        "dashscope_base_url": "https://dashscope.aliyuncs.com/api/v1",
        "dashscope_compatible_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }.items():
        monkeypatch.setattr(verify_anchor.settings, key, value)
    operations = []
    original = ProviderHub._call

    def counted(self, kind, estimate, operation):
        operations.append((kind, estimate))
        return original(self, kind, estimate, operation)

    def no_network(self):
        raise AssertionError("Verification tests must never open a network client")

    monkeypatch.setattr(ProviderHub, "_call", counted)
    monkeypatch.setattr(verify_anchor.OfficialClient, "__enter__", no_network)
    return root / "evidence" / "anchor-mock", operations


def journal_rows(output):
    with sqlite3.connect(output / "calls.sqlite") as connection:
        return connection.execute("SELECT * FROM calls ORDER BY step").fetchall()


def ledger_count(output):
    engine = create_engine(f"sqlite:///{output / 'business.sqlite'}")
    try:
        with Session(engine) as session:
            return session.scalar(select(func.count()).select_from(UsageLedger))
    finally:
        engine.dispose()


def media_hashes(output):
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (output / "media").iterdir() if path.is_file()}


def test_mock_evidence_and_offline_resume_create_no_new_provider_operations(verification):
    output, operations = verification
    verify_anchor.run(output, mock=True, offline=False)
    before = journal_rows(output), ledger_count(output), media_hashes(output), list(operations)
    evidence = json.loads((output / "anchor-real.json").read_text())
    assert evidence["status"] == "succeeded"
    assert Decimal(evidence["cost_or_unknown_reservation_cny"]) == 0
    assert len(evidence["jobs"]) == 3
    assert all(row["status"] == "succeeded" for row in evidence["calls"])
    assert all("person_score" in job["result"]["fidelity"] for job in evidence["jobs"])
    assert all(job["payload"]["anchor_id"] for job in evidence["jobs"][1:])
    verify_anchor.run(output, mock=True, offline=True)
    after = journal_rows(output), ledger_count(output), media_hashes(output), operations
    assert after == before
    assert json.loads((output / "anchor-real.json").read_text())["offline_resume"] is True


def test_unknown_started_call_is_preserved_and_never_resubmitted(verification):
    output, operations = verification
    verify_anchor.run(output, mock=True, offline=False)
    with sqlite3.connect(output / "calls.sqlite") as connection:
        connection.execute(
            "UPDATE calls SET status='started',result=NULL,actual_cost=NULL "
            "WHERE step='r1-baseline:text:_text_call'"
        )
    before = journal_rows(output), ledger_count(output), list(operations)
    with pytest.raises(RuntimeError, match="refusing resubmission"):
        verify_anchor.run(output, mock=True, offline=False)
    assert (journal_rows(output), ledger_count(output), operations) == before


def test_offline_missing_step_refuses_before_inserting_a_reservation_or_call(verification):
    output, operations = verification
    verify_anchor.run(output, mock=True, offline=False)
    with sqlite3.connect(output / "calls.sqlite") as connection:
        connection.execute("DELETE FROM calls WHERE step='r1-baseline:text:_text_call'")
    before = journal_rows(output), ledger_count(output), list(operations)
    with pytest.raises(RuntimeError, match="[Oo]ffline"):
        verify_anchor.run(output, mock=True, offline=True)
    assert (journal_rows(output), ledger_count(output), operations) == before


def test_cached_reference_analysis_needs_no_journal_row_or_provider_call(verification):
    output, operations = verification
    verify_anchor.run(output, mock=True, offline=False)
    with sqlite3.connect(output / "calls.sqlite") as connection:
        connection.execute("DELETE FROM calls WHERE step='r1-reference:vision:analyze_references'")
    engine = create_engine(f"sqlite:///{output / 'business.sqlite'}")
    before = journal_rows(output), ledger_count(output), list(operations)
    try:
        with Session(engine) as session:
            reference = session.scalar(select(Asset).where(
                Asset.kind == "reference", Asset.source == "upload",
            ))
            hub = verify_anchor.AnchorHub(
                session, None, output=output, label="r1-reference", group="R1", offline=True,
            )
            result = hub.analyze_references([reference])
            assert result == [{key: value for key, value in reference.analysis.items()
                               if not key.startswith("_reference_")}]
            assert all(not key.startswith("_reference_") for key in result[0])
    finally:
        engine.dispose()
    assert (journal_rows(output), ledger_count(output), operations) == before


def test_unknown_reservation_blocks_budget_without_a_new_journal_row(verification):
    output, operations = verification
    verify_anchor.run(output, mock=True, offline=False)
    with sqlite3.connect(output / "calls.sqlite") as connection:
        connection.execute(
            "INSERT INTO calls(step,call_group,status,reservation) "
            "VALUES ('unknown-r2','R2','started','1.60')"
        )
    before = journal_rows(output), ledger_count(output), list(operations)
    engine = create_engine(f"sqlite:///{output / 'business.sqlite'}")
    try:
        with Session(engine) as session:
            hub = verify_anchor.AnchorHub(session, None, output=output, label="blocked", group="R2")
            with pytest.raises(RuntimeError, match="budget reached"):
                hub._call("image", "0.5", lambda: pytest.fail("Budget must reject first"))
    finally:
        engine.dispose()
    assert (journal_rows(output), ledger_count(output), operations) == before


def test_started_journal_is_committed_before_operation_and_failure_cannot_retry(verification):
    output, operations = verification
    verify_anchor.run(output, mock=True, offline=False)
    engine = create_engine(f"sqlite:///{output / 'business.sqlite'}")
    invoked = []
    try:
        with Session(engine) as session:
            hub = verify_anchor.AnchorHub(session, None, output=output, label="failure", group="R1")

            def fail_after_start():
                with sqlite3.connect(output / "calls.sqlite") as connection:
                    row = connection.execute(
                        "SELECT status,reservation FROM calls WHERE step LIKE 'failure:%'",
                    ).fetchone()
                assert row == ("started", "0.1")
                invoked.append("once")
                raise RuntimeError("Simulated unknown response")

            with pytest.raises(RuntimeError, match="Simulated unknown response"):
                hub._call("text", "0.1", fail_after_start)
            before = list(operations), ledger_count(output)
            with pytest.raises(RuntimeError, match="refusing resubmission"):
                hub._call("text", "0.1", fail_after_start)
            assert invoked == ["once"]
            assert (operations, ledger_count(output)) == before
    finally:
        engine.dispose()


def test_real_output_cannot_change_directory_to_bypass_unknown_calls(verification):
    output, operations = verification
    alternate = output.parent / "anchor-real-new"
    with pytest.raises(RuntimeError):
        verify_anchor.run(alternate, mock=False, offline=False)
    assert not alternate.exists() and operations == []


def test_changed_fixture_or_incomplete_pair_refuses_to_recreate_results(verification):
    output, operations = verification
    verify_anchor.run(output, mock=True, offline=False)
    before = journal_rows(output), ledger_count(output), list(operations)
    fixture = verify_anchor.ROOT / "fixtures" / "shirt.jpg"
    fixture.write_bytes(fixture.read_bytes() + b"changed")
    with pytest.raises(RuntimeError, match="configuration changed"):
        verify_anchor.run(output, mock=True, offline=False)
    assert (journal_rows(output), ledger_count(output), operations) == before
    (output / "calls.sqlite").rename(output / "retained-calls.sqlite")
    with pytest.raises(RuntimeError, match="pair incomplete"):
        verify_anchor.run(output, mock=True, offline=False)
    assert not (output / "calls.sqlite").exists()


def test_cost_counts_unknown_reservations_and_exact_zero_actuals():
    assert verify_anchor.cost([
        {"actual_cost": "0", "reservation": "0.5"},
        {"actual_cost": "0.0123", "reservation": "0.15"},
        {"actual_cost": None, "reservation": "0.5"},
    ]) == Decimal("0.5123")
