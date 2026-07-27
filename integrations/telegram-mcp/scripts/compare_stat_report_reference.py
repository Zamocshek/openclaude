"""Compare a rendered stat report against a reference screenshot.

The script is intentionally local/dev-only. It renders one of the synthetic
stat templates, optionally extracts the avatar from the reference image, then
stores the generated PNG and a boosted diff image for visual tuning.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from statistics import mean
from typing import Any, Dict, Optional, Tuple

from PIL import Image, ImageChops, ImageDraw, ImageStat

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import stat_report_renderer as sr  # noqa: E402

Box = Tuple[int, int, int, int]


def _parse_crop(value: Optional[str]) -> Optional[Box]:
    if not value:
        return None
    parts = [int(part.strip()) for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("crop must be x,y,width,height")
    x, y, width, height = parts
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("crop width and height must be positive")
    return (x, y, x + width, y + height)


def _load_report(path: Optional[str], template: str) -> Dict[str, Any]:
    if not path:
        return {"template": template}
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    report["template"] = report.get("template") or template
    return report


def _demo_box(size: Tuple[int, int]) -> Box:
    width, height = size
    text = sr.WATERMARK_TEXT
    font_size = max(22, min(38, width // 52))
    font = sr._font(font_size, bold=True)  # noqa: SLF001
    scratch = Image.new("RGB", (1, 1))
    bbox = ImageDraw.Draw(scratch).textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    pad_x = 22
    pad_y = 12
    margin = max(32, width // 40)
    if width > 1500:
        x2 = int(width * 0.62)
    else:
        x2 = width - margin - 96
    y2 = height - margin
    x1 = x2 - text_w - pad_x * 2
    y1 = y2 - text_h - pad_y * 2
    return (max(0, x1 - 4), max(0, y1 - 4), min(width, x2 + 4), min(height, y2 + 4))


def _masked_for_demo(img: Image.Image) -> Image.Image:
    masked = img.copy()
    ImageDraw.Draw(masked).rectangle(_demo_box(masked.size), fill="#ffffff")
    return masked


def _metrics(reference: Image.Image, generated: Image.Image) -> Dict[str, float]:
    diff = ImageChops.difference(reference, generated)
    stat = ImageStat.Stat(diff)
    changed = diff.convert("L").point(lambda px: 255 if px > 16 else 0)
    changed_count = changed.histogram()[255]
    total = reference.width * reference.height
    return {
        "mae": round(mean(stat.mean), 3),
        "rms": round(mean(stat.rms), 3),
        "changed_pixels_gt16_pct": round(changed_count / total * 100, 3),
    }


def compare(args: argparse.Namespace) -> Dict[str, Any]:
    reference_path = Path(args.reference).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    reference = Image.open(reference_path).convert("RGB")
    report = _load_report(args.report_json, args.template)

    crop = _parse_crop(args.avatar_crop)
    avatar_path = None
    if crop:
        avatar = reference.crop(crop)
        avatar_path = output_dir / f"{args.output_name}_avatar.png"
        avatar.save(avatar_path)
        report.setdefault("channel", {})["avatar_path"] = str(avatar_path)

    result = sr.render_stat_report(report, output_dir=output_dir, output_name=args.output_name)
    generated_path = Path(result["png_path"])
    generated = Image.open(generated_path).convert("RGB")
    size_match = reference.size == generated.size
    comparable = (
        generated if size_match else generated.resize(reference.size, Image.Resampling.LANCZOS)
    )

    reference_cmp = reference if args.include_demo else _masked_for_demo(reference)
    generated_cmp = comparable if args.include_demo else _masked_for_demo(comparable)
    diff = ImageChops.difference(reference_cmp, generated_cmp)
    diff_path = output_dir / f"{args.output_name}_diff.png"
    diff.point(lambda px: min(255, px * args.diff_gain)).save(diff_path)

    return {
        "template": args.template,
        "reference": str(reference_path),
        "generated": str(generated_path),
        "diff": str(diff_path),
        "avatar": str(avatar_path) if avatar_path else None,
        "reference_size": reference.size,
        "generated_size": generated.size,
        "size_match": size_match,
        "ignored_demo_block": not args.include_demo,
        "metrics": _metrics(reference_cmp, generated_cmp),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, help="Reference PNG/JPEG path")
    parser.add_argument("--template", required=True, choices=sorted(sr.SUPPORTED_TEMPLATES))
    parser.add_argument("--report-json", default=None, help="Optional report JSON override")
    parser.add_argument("--output-dir", default="data/stat_reports/reference_compare")
    parser.add_argument("--output-name", default="stat_report_compare")
    parser.add_argument(
        "--avatar-crop",
        default=None,
        help="Optional avatar crop from reference as x,y,width,height",
    )
    parser.add_argument(
        "--include-demo",
        action="store_true",
        help="Include the DEMO block area in metrics instead of masking it",
    )
    parser.add_argument("--diff-gain", type=int, default=4, help="Diff brightness multiplier")
    args = parser.parse_args()
    print(json.dumps(compare(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
