import json
from argparse import Namespace

import pytest
from PIL import Image

from app.config import settings
from app.edit_guidance import local_edit_prompt
from app.local_edit import prepare_selection
from app.providers import ProviderHub
from scripts import compare_local_edits as experiment


@pytest.fixture
def experiment_inputs(tmp_path, monkeypatch):
    monkeypatch.setattr(experiment, "ROOT", tmp_path)
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    for directory in ("artifacts", "fixtures"):
        (tmp_path / directory).mkdir()
    names = ("artifacts/real-fix2-original.png", "artifacts/real-fix2-initial-original.png",
             "fixtures/shirt.jpg", "fixtures/jeans.jpg")
    for name in names:
        Image.new("RGB", (240, 320), "gray").save(tmp_path / name)
    return tmp_path


def test_more_context_does_not_enlarge_user_mask():
    region = {"x": 0.3, "y": 0.31, "w": 0.13, "h": 0.12}
    old = prepare_selection((1776, 2368), region, context_ratio=0.2)
    candidate = prepare_selection((1776, 2368), region)
    assert old.mask.tobytes() == candidate.mask.tobytes()
    assert old.region == candidate.region
    assert candidate.crop_box[0] < old.crop_box[0]
    assert candidate.crop_box[1] < old.crop_box[1]
    assert candidate.crop_box[2] > old.crop_box[2]
    assert candidate.crop_box[3] > old.crop_box[3]


def test_local_guidance_allows_color_only_requests_and_keeps_user_instruction():
    selection = prepare_selection((512, 768), {"x": .2, "y": .3, "w": .2, "h": .2})
    prompt = local_edit_prompt("只把衬衫换成蓝色，袖口不要动", selection)
    assert "若要求颜色或亮度，仅改变对应属性" in prompt
    assert "用户原始指令：只把衬衫换成蓝色，袖口不要动" in prompt
    assert "倒数第二张是其完整原图" not in prompt


def test_unknown_paid_generation_is_never_repeated(experiment_inputs, monkeypatch):
    calls = []
    monkeypatch.setattr(ProviderHub, "image", lambda *args: calls.append(True))
    entry = {"generation_started": True, "configuration": {}}
    evidence = {"operations": {"cuff-baseline": entry}}
    monkeypatch.setattr(experiment, "configuration", lambda *args: {})
    with pytest.raises(RuntimeError, match="结果未知"):
        experiment.run_variant(Namespace(phase="generate"), experiment_inputs / "evidence.json",
                               evidence, ProviderHub(None), "cuff", "baseline")
    assert not calls


def test_changed_experiment_configuration_never_reuses_a_generated_crop(
    experiment_inputs, monkeypatch
):
    calls = []
    monkeypatch.setattr(ProviderHub, "image", lambda *args: calls.append(True))
    evidence = {"operations": {"cuff-baseline": {
        "configuration": {"old": True}, "prompt": "old prompt",
    }}}
    with pytest.raises(RuntimeError, match="实验配置"):
        experiment.run_variant(Namespace(phase="check"), experiment_inputs / "evidence.json",
                               evidence, ProviderHub(None), "cuff", "baseline")
    assert not calls


def test_mock_experiment_resume_adds_no_model_calls(experiment_inputs, monkeypatch):
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(settings, "model_budget_cny", 5)
    args = Namespace(mode="mock", phase="all", case="cuff", variant="all",
                     output=experiment_inputs / "artifacts/evidence.json")
    experiment.run(args)
    before = json.loads(args.output.read_text())
    monkeypatch.setattr(ProviderHub, "image", lambda *args: pytest.fail("重复生成"))
    monkeypatch.setattr(ProviderHub, "check_edit", lambda *args: pytest.fail("重复核对"))
    experiment.run(args)
    assert json.loads(args.output.read_text()) == before
