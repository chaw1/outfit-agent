"""Reference roles and optional consistency scores at the real provider boundary."""

import io
import json
from decimal import Decimal

import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models import Asset, Base, UsageLedger, User
from app.providers import GeneratedMedia, ProviderError, ProviderHub


@pytest.fixture
def reference_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'reference-provider.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    monkeypatch.setattr(settings, "dashscope_api_key", "local-transport-placeholder")
    monkeypatch.setattr(settings, "model_budget_cny", 12)
    buffer = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(buffer, "PNG")
    (tmp_path / "original.png").write_bytes(buffer.getvalue())
    with factory() as session:
        user = User(username="reference", password_hash="unused", nickname="reference")
        session.add(user)
        session.flush()
        assets = [
            Asset(user_id=user.id, kind=kind, path="original.png", mime="image/png")
            for kind in ("garment", "reference", "model", "reference")
        ]
        session.add_all(assets)
        session.commit()
        ids = [asset.id for asset in assets]
    yield factory, ids
    engine.dispose()


def intercept(monkeypatch, handler):
    monkeypatch.setattr(
        ProviderHub, "_client", lambda self: httpx.Client(transport=httpx.MockTransport(handler))
    )


def response(payload):
    return httpx.Response(200, json={
        "choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}],
        "usage": {"prompt_tokens": 2000, "completion_tokens": 100},
    })


def style(asset_id):
    return {
        "asset_id": asset_id, "scene": "夜晚街头霓虹", "lighting": "蓝紫侧光",
        "composition": "竖版留白全身", "mood": "都市电影感", "palette": "蓝紫、玫红",
        "style_tags": ["夜晚", "霓虹"],
    }


def test_reference_analysis_reads_every_image_and_caches_paid_results(reference_db, monkeypatch):
    factory, ids = reference_db
    expected = [style(ids[1]), style(ids[3])]
    requests = []

    def handler(request):
        content = json.loads(request.content)["messages"][0]["content"]
        assert len([part for part in content if part["type"] == "image_url"]) == 2
        assert ids[1] in json.dumps(content) and ids[3] in json.dumps(content)
        requests.append(True)
        return response({"items": list(reversed(expected))})

    intercept(monkeypatch, handler)
    with factory() as session:
        assets = [session.get(Asset, asset_id) for asset_id in (ids[1], ids[3])]
        hub = ProviderHub(session)
        assert hub.analyze_references(assets) == expected
        session.rollback()
    with factory() as session:
        assets = [session.get(Asset, asset_id) for asset_id in (ids[1], ids[3])]
        assert ProviderHub(session).analyze_references(assets) == expected
        assert requests == [True]
        assert assets[0].analysis["_reference_mock"] is False
        assert assets[0].analysis["_reference_model"] == "qwen3-vl-plus"
        assert not any(key.startswith("_reference_") for item in expected for key in item)
        ledger = session.scalar(select(UsageLedger))
        assert ledger.units["purpose"] == "analyze_references" and ledger.units["images"] == 2
        assert ledger.estimated_cny == Decimal("0.003000") and ledger.status == "succeeded"


@pytest.mark.parametrize("change", [
    {"asset_id": "not-the-reference"}, {"scene": ""}, {"lighting": []},
    {"palette": ["blue"]}, {"style_tags": []}, {"style_tags": [12]},
])
def test_reference_analysis_rejects_wrong_identity_or_missing_style(
    reference_db, monkeypatch, change,
):
    factory, ids = reference_db
    intercept(monkeypatch, lambda request: response({"items": [{**style(ids[1]), **change}]}))
    with factory() as session:
        with pytest.raises(ProviderError, match="参考图风格分析"):
            ProviderHub(session).analyze_references([session.get(Asset, ids[1])])
        assert session.get(Asset, ids[1]).analysis is None
        assert session.scalar(select(UsageLedger)).status == "failed"


def test_empty_references_make_no_call_or_ledger(reference_db, monkeypatch):
    factory, _ = reference_db
    monkeypatch.setattr(ProviderHub, "_client", lambda _: pytest.fail("unexpected HTTP"))
    with factory() as session:
        assert ProviderHub(session).analyze_references([]) == []
        assert session.scalar(select(UsageLedger)) is None


@pytest.mark.parametrize(
    "person,anchor", [(False, False), (True, False), (False, True), (True, True)],
)
def test_consistency_scores_use_only_corresponding_images_and_real_response(
    reference_db, monkeypatch, person, anchor,
):
    factory, ids = reference_db
    supplied = {"person_score": 37, "anchor_score": 81}

    def handler(request):
        content = json.loads(request.content)["messages"][-1]["content"]
        images = [part for part in content if part["type"] == "image_url"]
        assert len(images) == 2 + person + anchor
        labels = " ".join(part.get("text", "") for part in content[1:])
        assert ("博主本人照片，仅用于person_score" in labels) is person
        assert ("封面锚点，仅用于anchor_score" in labels) is anchor
        return response({"overall": 92, "diffs": [], **supplied})

    intercept(monkeypatch, handler)
    with factory() as session:
        garment, _, model, cover = [session.get(Asset, asset_id) for asset_id in ids]
        kwargs = {}
        if person:
            kwargs["model_asset"] = model
        if anchor:
            kwargs["anchor_asset"] = cover
        result = ProviderHub(session).fidelity([garment], garment, **kwargs)
        assert result == {
            "score": 92, "diffs": [], "auto_fixed": False,
            **({"person_score": 37} if person else {}),
            **({"anchor_score": 81} if anchor else {}),
        }
        ledger = session.scalar(select(UsageLedger))
        assert ledger.units["images"] == 2 + person + anchor
        assert ledger.units["purpose"] == "fidelity" and ledger.status == "succeeded"


@pytest.mark.parametrize("value", [None, True, "92", -1, 101, float("nan")])
def test_invalid_or_missing_consistency_score_is_never_reported_as_success(
    reference_db, monkeypatch, value,
):
    factory, ids = reference_db
    intercept(monkeypatch, lambda request: response({
        "overall": 92, "diffs": [], "person_score": value,
    }))
    with factory() as session:
        with pytest.raises(ProviderError, match="一致性检查"):
            ProviderHub(session).fidelity(
                [session.get(Asset, ids[0])], session.get(Asset, ids[0]),
                model_asset=session.get(Asset, ids[2]),
            )
        assert session.scalar(select(UsageLedger)).status == "failed"


def test_wan27_keeps_all_garments_person_and_cover_without_truncation(reference_db, monkeypatch):
    factory, ids = reference_db
    seen = []

    def handler(request):
        body = json.loads(request.content)
        assert body["model"] == "wan2.7-image-pro"
        content = body["input"]["messages"][0]["content"]
        seen.extend(part["image"] for part in content if "image" in part)
        return httpx.Response(200, json={"output": {"choices": [{"message": {
            "content": [{"image": "https://media.invalid/output"}],
        }}]}})

    intercept(monkeypatch, handler)
    monkeypatch.setattr(ProviderHub, "_data_url", staticmethod(lambda asset: f"data:{asset.id}"))
    monkeypatch.setattr(ProviderHub, "_download", staticmethod(
        lambda *args: GeneratedMedia(b"image", "image/png", "test"),
    ))
    with factory() as session:
        assets = [session.get(Asset, asset_id) for asset_id in ids]
        assert ProviderHub(session).image("保持封面同一人物", assets).data == b"image"
        assert seen == [f"data:{asset_id}" for asset_id in ids]


def test_mock_reference_styles_affect_directions_and_scripts_without_http(
    reference_db, monkeypatch,
):
    factory, ids = reference_db
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(ProviderHub, "_client", lambda _: pytest.fail("unexpected HTTP"))
    with factory() as session:
        hub = ProviderHub(session)
        references = hub.analyze_references([session.get(Asset, ids[1])])
        plain = hub.text("propose_directions", {})
        context = {"references": references, "garment_asset_ids": [ids[0]], "directions": None}
        themed = hub.text("propose_directions", context)
        assert themed != plain
        assert all("夜晚街头" in option["scene"] for option in themed["options"])
        script = hub.text("write_script", context)
        assert "夜晚街头" in script["cover"]["scene"]
        assert all("蓝紫霓虹" in shot["scene"] for shot in script["shots"])
        result = hub.fidelity(
            [session.get(Asset, ids[0])], session.get(Asset, ids[0]),
            model_asset=session.get(Asset, ids[2]), anchor_asset=session.get(Asset, ids[3]),
        )
        assert {"person_score", "anchor_score"}.issubset(result)
        assert all(row.estimated_cny == 0 and row.units["mock"] for row in session.scalars(
            select(UsageLedger),
        ))


@pytest.mark.parametrize("model,limit", [("wan2.7-image-pro", 9), ("wan2.6-image", 4)])
def test_image_limit_is_model_specific_and_rejects_before_spending(
    reference_db, monkeypatch, model, limit,
):
    factory, ids = reference_db
    monkeypatch.setattr(ProviderHub, "_client", lambda _: pytest.fail("unexpected HTTP"))
    with factory() as session:
        hub = ProviderHub(session)
        monkeypatch.setattr(hub, "_model", lambda kind: model)
        with pytest.raises(ProviderError, match=f"最多支持 {limit}"):
            hub.image("穿搭", [session.get(Asset, ids[0])] * (limit + 1))
        assert session.scalar(select(UsageLedger)) is None


def test_mock_refresh_keeps_reference_style_but_changes_scenes():
    context = {"references": [style("reference-1")]}
    first = ProviderHub._mock_text("propose_directions", context, "给几组方向")
    refreshed = ProviderHub._mock_text("propose_directions", {
        **context, "directions": first["options"],
    }, "换一组")
    assert {option["scene"] for option in first["options"]}.isdisjoint(
        {option["scene"] for option in refreshed["options"]},
    )
    assert all("夜晚街头霓虹" in option["scene"] for option in refreshed["options"])


@pytest.mark.parametrize("first_mock,second_mock", [(True, False), (False, True)])
def test_reference_cache_does_not_cross_mock_real_mode(reference_db, monkeypatch,
                                                       first_mock, second_mock):
    factory, ids = reference_db
    expected = {**style(ids[1]), "scene": "真实可见的阳光庭院"}
    requests = []

    def handler(request):
        requests.append(True)
        return response({"items": [expected]})

    intercept(monkeypatch, handler)
    monkeypatch.setattr(settings, "mock_providers", first_mock)
    with factory() as session:
        first = ProviderHub(session).analyze_references([session.get(Asset, ids[1])])
    monkeypatch.setattr(settings, "mock_providers", second_mock)
    with factory() as session:
        asset = session.get(Asset, ids[1])
        second = ProviderHub(session).analyze_references([asset])
        assert first != second
        assert (second == [expected]) is (not second_mock)
        assert asset.analysis["_reference_mock"] is second_mock
        assert len(session.scalars(select(UsageLedger)).all()) == 2
        assert all(not key.startswith("_reference_") for key in second[0])
    assert requests == [True]


def test_reference_cache_does_not_cross_vision_models(reference_db, monkeypatch):
    factory, ids = reference_db
    requests = []

    def handler(request):
        model = json.loads(request.content)["model"]
        requests.append(model)
        return response({"items": [{**style(ids[1]), "scene": model + "视觉场景"}]})

    intercept(monkeypatch, handler)
    with factory() as session:
        first = ProviderHub(session).analyze_references([session.get(Asset, ids[1])])
    monkeypatch.setattr(settings, "vision_model", "qwen-vl-plus")
    with factory() as session:
        asset = session.get(Asset, ids[1])
        hub = ProviderHub(session)
        second = hub.analyze_references([asset])
        assert first != second
        assert hub.analyze_references([asset]) == second
        assert asset.analysis["_reference_model"] == "qwen-vl-plus"
        assert len(session.scalars(select(UsageLedger)).all()) == 2
        assert all(not key.startswith("_reference_") for key in second[0])
    assert requests == ["qwen3-vl-plus", "qwen-vl-plus"]


def test_legacy_reference_cache_without_provenance_is_reanalyzed(reference_db, monkeypatch):
    factory, ids = reference_db
    with factory() as session:
        session.get(Asset, ids[1]).analysis = style(ids[1])
        session.commit()
    requests = []

    def handler(request):
        requests.append(True)
        return response({"items": [{**style(ids[1]), "scene": "重新看图后的真实场景"}]})

    intercept(monkeypatch, handler)
    with factory() as session:
        asset = session.get(Asset, ids[1])
        hub = ProviderHub(session)
        result = hub.analyze_references([asset])
        assert result[0]["scene"] == "重新看图后的真实场景"
        assert hub.analyze_references([asset]) == result
        assert asset.analysis["_reference_mock"] is False
        assert asset.analysis["_reference_model"] == "qwen3-vl-plus"
    assert requests == [True]
