import pytest
from test_assets_library import library_api as library_api

from app.garment_tags import garment_tags
from app.models import Asset


@pytest.mark.parametrize("analysis,expected", [
    (None, []), ({}, []), ([], []),
    ({"category": " 衬衫 ", "color": "米白色", "season": ["春", "秋"],
      "style_tags": ["简约", "松弛", "日常"]}, ["衬衫", "米白色", "春", "秋", "简约", "松弛"]),
    ({"category": "衬衫", "material": "棉", "fit": "宽松"}, ["衬衫"]),
    ({"品类": "外套", "颜色": "深蓝色", "季节": "秋、冬", "风格": "通勤/简约"},
     ["外套", "深蓝色", "秋", "冬", "通勤", "简约"]),
    ({"category": 7, "color": None, "style_tags": [None, {}, "", "简约", "简约", "细节" * 20]},
     ["简约"]),
    ({"category": "衬衫", "style_tags": ["衬衫", "日常", "日常", "松弛"]},
     ["衬衫", "日常", "松弛"]),
])
def test_tags_are_short_unique_bounded_and_do_not_invent_missing_dimensions(analysis, expected):
    assert garment_tags(analysis) == expected


def test_library_tag_filter_counts_and_pagination_share_owner_visible_assets(library_api):
    env = library_api
    with env.factory() as session:
        session.get(Asset, "upload-garment").analysis = {
            "category": "衬衫", "color": "米白色", "style_tags": ["简约", "简约"],
        }
        for asset_id, user_id, analysis in (
            ("owner-pants", "owner", {"category": "牛仔裤", "color": "浅蓝色",
                                      "style_tags": ["简约", "通勤"]}),
            ("owner-unknown", "owner", None),
            ("owner-hidden", "owner", {"category": "衬衫", "library_hidden": True}),
            ("other-shirt", "other", {"category": "衬衫", "style_tags": ["他人标签"]}),
        ):
            session.add(Asset(id=asset_id, user_id=user_id, kind="garment", source="upload",
                              path="unused.png", mime="image/png", analysis=analysis))
        session.commit()
    response = env.client.get("/api/me/assets", params={"kind": "garment"})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total"] == 3
    assert next(item for item in data["items"] if item["id"] == "owner-unknown")["tags"] == []
    tagged = env.client.get("/api/me/assets", params={
        "kind": "garment", "tag": "衬衫", "limit": 1, "offset": 0,
    }).json()
    assert tagged["total"] == 1
    assert [item["id"] for item in tagged["items"]] == ["upload-garment"]
    first = env.client.get("/api/me/assets?kind=garment&tag=简约&limit=1").json()
    second = env.client.get("/api/me/assets?kind=garment&tag=简约&limit=1&offset=1").json()
    assert first["total"] == second["total"] == 2
    assert first["items"][0]["id"] != second["items"][0]["id"]
    assert env.client.get("/api/me/assets?kind=garment&tag=不存在").json() == {
        "items": [], "total": 0,
    }
    response = env.client.get("/api/me/assets/tags?kind=garment")
    assert response.status_code == 200, response.text
    counts = {item["tag"]: item["count"] for item in response.json()["items"]}
    assert counts == {"衬衫": 1, "米白色": 1, "简约": 2, "牛仔裤": 1, "浅蓝色": 1, "通勤": 1}
    assert env.client.get("/api/me/assets/tags?kind=model").status_code == 422
    assert env.client.get("/api/me/assets?kind=garment&tag=" + "长" * 13).status_code == 422


def test_tag_endpoint_requires_authentication(library_api):
    response = library_api.client.get("/api/me/assets/tags?kind=garment", headers={
        "Authorization": "Bearer invalid-token",
    })
    assert response.status_code == 401
