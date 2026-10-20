#!/usr/bin/env python3
"""Offline seam replay; no database, model, credentials, or network access.

Default: invert the archived cuff composite to one compatible editing patch.
For retained provider output use --raw, with the original region/context ratio.
A compatible inversion is not the uniquely recovered original model response.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.local_edit import compose_local_edit, prepare_selection  # noqa: E402
from app.models import Asset  # noqa: E402
from app.providers import GeneratedMedia  # noqa: E402


def encode(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def old_alpha(mask, radius):
    return ImageChops.multiply(mask, mask.filter(ImageFilter.GaussianBlur(radius)))


def reconstruct(original, archived, alpha):
    """Find one byte-valued patch that reproduces the old saved composite."""
    before, after, opacity = original.tobytes(), archived.tobytes(), alpha.tobytes()
    values = bytearray(before)
    for pixel, weight in enumerate(opacity):
        if not weight:
            continue
        for channel in range(3):
            index = pixel * 3 + channel
            value = (after[index] * 255 - before[index] * (255 - weight)) / weight
            values[index] = max(0, min(255, round(value)))
    patch = Image.frombytes("RGB", original.size, bytes(values))
    replay = Image.composite(patch, original, alpha)
    assert ImageChops.difference(replay, archived).getbbox() is None, (
        "Archived output cannot be exactly replayed with the supplied geometry"
    )
    return patch


def metrics(original, result, mask, ring_width=16):
    """Measure introduced gradients after subtracting the original gradients.

    Raw inner/outer ring colors can differ naturally (sleeve versus background).
    The residual-gradient metric cancels that existing transition before taking
    absolute values. It is a seam proxy, not a score for fulfilling the edit.
    """
    outside_pixels = mask.histogram()[0]
    red, green, blue = ImageChops.difference(original, result).split()
    changed = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    outside = ImageChops.multiply(changed, ImageChops.invert(mask))
    outside_changes = sum(outside.histogram()[1:])
    left, top, right, bottom = mask.getbbox()
    bounds = (max(0, left - ring_width), max(0, top - ring_width),
              min(original.width, right + ring_width), min(original.height, bottom + ring_width))
    original, result, mask = original.crop(bounds), result.crop(bounds), mask.crop(bounds)
    width, height = original.size
    before, after, selected = original.tobytes(), result.tobytes(), mask.tobytes()
    eroded = mask
    dilated = mask
    eroded2 = eroded8 = None
    for distance in range(1, ring_width + 1):
        eroded = eroded.filter(ImageFilter.MinFilter(3))
        dilated = dilated.filter(ImageFilter.MaxFilter(3))
        if distance == 2:
            eroded2 = eroded.tobytes()
        if distance == 8:
            eroded8 = eroded.tobytes()
    core, expanded = eroded.tobytes(), dilated.tobytes()
    near = [bool(value and not core[i]) for i, value in enumerate(selected)]
    band2to8 = [bool(value and not eroded8[i]) for i, value in enumerate(eroded2)]
    boundary_sum = boundary_pairs = band_sum = band_pairs = 0
    middle_sum = middle_pairs = middle_residual = middle_count = 0
    inner_original, outer_original = [0, 0, 0], [0, 0, 0]
    inner_count = outer_count = 0
    inner_residual = 0
    for pixel, value in enumerate(selected):
        offset = pixel * 3
        residual = [after[offset + c] - before[offset + c] for c in range(3)]
        if band2to8[pixel]:
            middle_residual += sum(abs(v) for v in residual)
            middle_count += 1
        if near[pixel]:
            inner_count += 1
            inner_residual += sum(abs(v) for v in residual)
            for c in range(3):
                inner_original[c] += before[offset + c]
        elif not value and expanded[pixel]:
            outer_count += 1
            for c in range(3):
                outer_original[c] += before[offset + c]
        x, y = pixel % width, pixel // width
        for adjacent in ((pixel + 1 if x + 1 < width else None),
                         (pixel + width if y + 1 < height else None)):
            if adjacent is None:
                continue
            other = adjacent * 3
            gradient_error = sum(abs(
                residual[c] - (after[other + c] - before[other + c])
            ) for c in range(3))
            if bool(value) != bool(selected[adjacent]):
                boundary_sum += gradient_error
                boundary_pairs += 1
            if (near[pixel] or near[adjacent]) and (value or selected[adjacent]):
                band_sum += gradient_error
                band_pairs += 1
            if (band2to8[pixel] or band2to8[adjacent]) and value and selected[adjacent]:
                middle_sum += gradient_error
                middle_pairs += 1
    natural_delta = (
        sum((inner_original[c] / inner_count - outer_original[c] / outer_count) ** 2
            for c in range(3)) ** .5 if inner_count and outer_count else None
    )
    return {
        "boundary_excess_gradient_mae_rgb_255": round(boundary_sum / (3 * boundary_pairs), 6)
        if boundary_pairs else None,
        "boundary_neighbor_pairs": boundary_pairs,
        "inner_16px_residual_gradient_mae_rgb_255": round(band_sum / (3 * band_pairs), 6)
        if band_pairs else None,
        "inner_16px_residual_mae_rgb_255": round(inner_residual / (3 * inner_count), 6)
        if inner_count else None,
        "inner_2to8px_residual_gradient_mae_rgb_255": round(middle_sum / (3 * middle_pairs), 6)
        if middle_pairs else None,
        "inner_2to8px_residual_mae_rgb_255": round(middle_residual / (3 * middle_count), 6)
        if middle_count else None,
        "original_inner_outer_ring_mean_rgb_distance": round(natural_delta, 6)
        if natural_delta is not None else None,
        "outside_changed_pixels": outside_changes,
        "outside_pixels": outside_pixels,
    }


def run(args):
    for name in ("original", "archived", "raw", "output"):
        path = getattr(args, name)
        if path is not None:
            assert path.resolve().is_relative_to(ROOT), "Evidence stays in this worktree"
            setattr(args, name, path.resolve())
    original = Image.open(args.original).convert("RGB")
    region = dict(zip(("x", "y", "w", "h"), args.region, strict=True))
    selection = prepare_selection(original.size, region=region, context_ratio=args.context_ratio)
    crop = original.crop(selection.crop_box)
    mask = selection.mask.crop(selection.crop_box)
    alpha = old_alpha(mask, selection.feather_radius)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    reconstructed = args.raw is None
    if reconstructed:
        archived = Image.open(args.archived).convert("RGB").crop(selection.crop_box)
        patch = reconstruct(crop, archived, alpha)
        # This historical crop has no provider-aspect padding. Be explicit so a
        # future different sample cannot silently use an unsupported inversion.
        assert selection.canvas_size == selection.crop_size
        raw = GeneratedMedia(encode(patch), "image/png", "compatible-history-inversion")
    else:
        raw = GeneratedMedia(args.raw.read_bytes(), "image/png", "retained-provider-response")
        patch = Image.open(io.BytesIO(raw.data)).convert("RGB").resize(
            selection.canvas_size, Image.Resampling.LANCZOS
        ).crop(selection.canvas_box)
    before = original.copy()
    before.paste(Image.composite(patch, crop, alpha), selection.crop_box[:2])
    settings.media_dir = args.original.parent.resolve()
    source = Asset(path=args.original.name, source="upload", mime="image/png",
                   width=original.width, height=original.height)
    after_media = compose_local_edit(source, raw, selection)
    after = Image.open(io.BytesIO(after_media.data)).convert("RGB")
    prefix = args.output.with_suffix("")
    paths = {}
    for name, picture in (("before", before), ("after", after), ("mask", selection.mask)):
        target = prefix.with_name(prefix.name + f"-{name}.png")
        picture.save(target)
        paths[name] = str(target.relative_to(ROOT))
    raw_path = (
        prefix.with_name(prefix.name + "-compatible-patch.png") if reconstructed else args.raw
    )
    if reconstructed:
        patch.save(raw_path)
    paths["raw_or_compatible_patch"] = str(raw_path.relative_to(ROOT))
    # Native crop enlarged by 2x, with identical bounds in all three panels.
    margin, scale = 24, 2
    panel_width, panel_height = crop.width * scale, crop.height * scale
    comparison = Image.new("RGB", (panel_width * 3, panel_height + margin), "white")
    for index, (name, picture) in enumerate((("Original", original), ("Old composite", before),
                                            ("Matched + inward feather", after))):
        detail = picture.crop(selection.crop_box).resize(
            (panel_width, panel_height), Image.Resampling.NEAREST
        )
        comparison.paste(detail, (index * panel_width, margin))
        ImageDraw.Draw(comparison).text((index * panel_width + 4, 4), name, fill="black")
    detail_path = prefix.with_name(prefix.name + "-detail.png")
    comparison.save(detail_path)
    paths["detail"] = str(detail_path.relative_to(ROOT))
    evidence = {
        "mode": "offline", "model_calls": 0, "cost_cny": 0,
        "raw_kind": "compatible_inverse_not_original_response" if reconstructed
        else "retained_provider_response",
        "limitation": (
            "Historical raw was not retained. Inversion finds a compatible, nonunique patch; "
            "old-composite replay is byte-identical, but unselected patch pixels use the source. "
            "It cannot prove what the discarded original response would produce."
            if reconstructed else "Same retained raw response is used by both compositors."
        ),
        "metric_definition": (
            "MAE of (result[p]-result[q])-(source[p]-source[q]) over RGB channels; "
            "p/q are 4-neighbors crossing the selection boundary (or the 16px inner band). "
            "This subtracts natural source edges; values are RGB levels out of 255. "
            "It measures introduced transitions, not instruction success."
        ),
        "region": region, "context_ratio": args.context_ratio,
        "crop_box": selection.crop_box, "feather_radius": selection.feather_radius,
        "original_sha256": hashlib.sha256(args.original.read_bytes()).hexdigest(),
        "raw_or_compatible_sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
        "compatible_old_replay_changed_pixels": 0 if reconstructed else None,
        "before": metrics(original, before, selection.mask),
        "after": metrics(original, after, selection.mask),
        "paths": paths,
    }
    assert evidence["before"]["outside_changed_pixels"] == 0
    assert evidence["after"]["outside_changed_pixels"] == 0
    args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", type=Path, default=ROOT / "artifacts/real-fix2-original.png")
    parser.add_argument("--archived", type=Path, default=ROOT / "artifacts/real-fix2-cuff.png")
    parser.add_argument("--raw", type=Path)
    parser.add_argument("--region", type=float, nargs=4, default=[.3, .31, .13, .12])
    parser.add_argument("--context-ratio", type=float, default=.2)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/seams-fix3-history.json")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
