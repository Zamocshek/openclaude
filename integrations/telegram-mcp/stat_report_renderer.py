"""Synthetic Telegram statistics report renderer.

The renderer intentionally adds a visible DEMO watermark to every output.
It is meant for mockups, presentations, and UI previews, not official stats.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

from runtime_config import get_data_dir

TEMPLATE_TGSTAT_CHANNEL = "tgstat_channel"
TEMPLATE_TGSTAT_POST = "tgstat_post"
TEMPLATE_TRUSTAT_CHANNEL = "trustat_channel"
SUPPORTED_TEMPLATES = {
    TEMPLATE_TGSTAT_CHANNEL,
    TEMPLATE_TGSTAT_POST,
    TEMPLATE_TRUSTAT_CHANNEL,
}
TEMPLATE_SIZES = {
    TEMPLATE_TGSTAT_CHANNEL: (1928, 1210),
    TEMPLATE_TGSTAT_POST: (2240, 1320),
    TEMPLATE_TRUSTAT_CHANNEL: (1280, 925),
}
WATERMARK_TEXT = "DEMO"


def _default_output_dir() -> Path:
    path = get_data_dir() / "stat_reports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_.@+-]+", "_", str(value or "").strip()).strip("._")
    if not name:
        name = f"stat_report_{int(time.time())}"
    return name[:90]


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    merged = json.loads(json.dumps(base, ensure_ascii=False))
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _font(size: int, bold: bool = False, light: bool = False) -> ImageFont.FreeTypeFont:
    names = []
    if os.name == "nt":
        root = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "Fonts"
        if bold:
            names.extend([root / "segoeuib.ttf", root / "arialbd.ttf"])
        elif light:
            names.extend([root / "segoeuil.ttf", root / "segoeuisl.ttf"])
        names.extend([root / "segoeui.ttf", root / "arial.ttf"])
    names.extend(
        [
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
            Path("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"),
        ]
    )
    for path in names:
        try:
            if path.exists():
                return ImageFont.truetype(str(path), size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _text_bbox(
    draw: ImageDraw.ImageDraw, xy: Tuple[int, int], text: str, font: ImageFont.ImageFont
):
    return draw.textbbox(xy, text, font=font)


def _draw_text(
    draw: ImageDraw.ImageDraw,
    xy: Tuple[int, int],
    text: Any,
    size: int,
    fill: str = "#424a57",
    bold: bool = False,
    anchor: Optional[str] = None,
    light: bool = False,
) -> None:
    draw.text(xy, str(text), fill=fill, font=_font(size, bold=bold, light=light), anchor=anchor)


def _rounded_rect(
    draw: ImageDraw.ImageDraw,
    box: Tuple[int, int, int, int],
    radius: int,
    fill: str = "#ffffff",
    outline: str = "#d9dde4",
    width: int = 2,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def _hex_rgb(value: str) -> Tuple[int, int, int]:
    value = value.lstrip("#")
    if len(value) != 6:
        return (0, 0, 0)
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def _has_colored_avatar_frame(img: Image.Image, border: str) -> bool:
    sample = img.convert("RGB").resize((96, 96), Image.Resampling.LANCZOS)
    target = _hex_rgb(border)
    center = 47.5
    frame_hits = 0
    frame_total = 0
    for y in range(96):
        for x in range(96):
            dx = x - center
            dy = y - center
            distance = (dx * dx + dy * dy) ** 0.5
            if 41 <= distance <= 48:
                frame_total += 1
                r, g, b = sample.getpixel((x, y))
                close = abs(r - target[0]) + abs(g - target[1]) + abs(b - target[2])
                if close < 95 or (g > 155 and b > 120 and r < 120 and g - r > 45):
                    frame_hits += 1
    return frame_total > 0 and frame_hits / frame_total > 0.12


def _load_avatar(
    path: Optional[str],
    size: int,
    border: str = "#dfe3ea",
    border_width: int = 4,
    auto_frame: bool = False,
) -> Image.Image:
    avatar = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    effective_border = border_width
    if path:
        try:
            img = Image.open(path).convert("RGBA")
            if auto_frame and border_width and _has_colored_avatar_frame(img, border):
                effective_border = 0
            canvas_size = size - effective_border * 2
            img.thumbnail(
                (canvas_size, canvas_size),
                Image.Resampling.LANCZOS,
            )
            canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
            canvas.paste(
                img,
                ((canvas.width - img.width) // 2, (canvas.height - img.height) // 2),
                img,
            )
        except Exception:
            canvas = _placeholder_avatar(size - effective_border * 2)
    else:
        canvas = _placeholder_avatar(size - effective_border * 2)

    mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, canvas.width - 1, canvas.height - 1), fill=255)
    border_layer = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    bd = ImageDraw.Draw(border_layer)
    bd.ellipse((0, 0, size - 1, size - 1), fill=border)
    bd.ellipse(
        (
            effective_border,
            effective_border,
            size - effective_border - 1,
            size - effective_border - 1,
        ),
        fill="#ffffff",
    )
    avatar.alpha_composite(border_layer)
    avatar.paste(canvas, (effective_border, effective_border), mask)
    return avatar


def _placeholder_avatar(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), "#1f2937")
    draw = ImageDraw.Draw(img)
    draw.ellipse((0, 0, size - 1, size - 1), fill="#111827")
    draw.polygon(
        [
            (size * 0.18, size * 0.70),
            (size * 0.48, size * 0.25),
            (size * 0.83, size * 0.72),
        ],
        fill="#334155",
    )
    _draw_text(draw, (size // 2, size // 2), "TG", size // 4, "#e5e7eb", bold=True, anchor="mm")
    return img


def _add_watermark(img: Image.Image, text: str = WATERMARK_TEXT) -> None:
    draw = ImageDraw.Draw(img)
    size = max(22, min(38, img.width // 52))
    font = _font(size, bold=True)
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    pad_x = 22
    pad_y = 12
    block_w = text_w + pad_x * 2
    block_h = text_h + pad_y * 2
    margin = max(32, img.width // 40)
    if img.width > 1500:
        x2 = int(img.width * 0.62)
    else:
        x2 = img.width - margin - 96
    y2 = img.height - margin
    x1 = x2 - block_w
    y1 = y2 - block_h
    _rounded_rect(draw, (x1, y1, x2, y2), 10, "#ffffff", "#cfd5dc", 2)
    draw.text(
        (x1 + pad_x, y1 + pad_y - 2),
        text,
        font=font,
        fill="#111111",
    )


def _draw_tgstat_logo(draw: ImageDraw.ImageDraw, xy: Tuple[int, int]) -> None:
    x, y = xy
    blue = "#2ba9e6"
    light_blue = "#91d7f7"
    draw.polygon(
        [
            (x + 5, y + 38),
            (x + 55, y + 10),
            (x + 55, y + 34),
            (x + 34, y + 49),
            (x + 26, y + 78),
            (x + 16, y + 78),
            (x + 20, y + 55),
        ],
        fill=light_blue,
    )
    draw.rounded_rectangle((x, y + 50, x + 34, y + 88), radius=4, fill=blue)
    draw.rounded_rectangle((x + 42, y + 32, x + 66, y + 88), radius=4, fill=blue)
    draw.rounded_rectangle((x + 74, y + 10, x + 96, y + 88), radius=4, fill=blue)


def _draw_qr_placeholder(draw: ImageDraw.ImageDraw, box: Tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    color = "#38c66b"
    draw.rectangle(box, fill="#ffffff")
    modules = 25
    quiet = 1
    size = min(x2 - x1, y2 - y1)
    cell = max(2, size // (modules + quiet * 2))
    offset_x = x1 + (x2 - x1 - cell * (modules + quiet * 2)) // 2 + quiet * cell
    offset_y = y1 + (y2 - y1 - cell * (modules + quiet * 2)) // 2 + quiet * cell
    occupied = set()

    def module(cx: int, cy: int, w: int = 1, h: int = 1) -> None:
        for ox in range(w):
            for oy in range(h):
                occupied.add((cx + ox, cy + oy))
        draw.rectangle(
            (
                offset_x + cx * cell,
                offset_y + cy * cell,
                offset_x + (cx + w) * cell - 1,
                offset_y + (cy + h) * cell - 1,
            ),
            fill=color,
        )

    def finder(fx: int, fy: int) -> None:
        module(fx, fy, 7, 7)
        draw.rectangle(
            (
                offset_x + (fx + 1) * cell,
                offset_y + (fy + 1) * cell,
                offset_x + (fx + 6) * cell - 1,
                offset_y + (fy + 6) * cell - 1,
            ),
            fill="#ffffff",
        )
        module(fx + 2, fy + 2, 3, 3)

    for fx, fy in ((0, 0), (modules - 7, 0), (0, modules - 7)):
        finder(fx, fy)

    for idx in range(8, modules - 8):
        if idx % 2 == 0:
            module(idx, 6)
            module(6, idx)

    for cy in range(modules):
        for cx in range(modules):
            if (cx, cy) in occupied:
                continue
            if (cx * 17 + cy * 31 + cx * cy) % 7 in {0, 2, 5} or (cx + cy * 3) % 11 == 0:
                module(cx, cy)


def _draw_calendar_icon(draw: ImageDraw.ImageDraw, xy: Tuple[int, int], size: int = 26) -> None:
    x, y = xy
    color = "#424a57"
    radius = max(2, size // 10)
    draw.rounded_rectangle(
        (x, y + 3, x + size, y + size),
        radius=radius,
        outline=color,
        width=2,
        fill=None,
    )
    draw.rectangle((x + 1, y + 8, x + size - 1, y + 12), fill=color)
    ring_w = max(2, size // 8)
    draw.rounded_rectangle((x + 5, y, x + 8, y + 8), radius=1, fill=color)
    draw.rounded_rectangle((x + size - 8, y, x + size - 5, y + 8), radius=1, fill=color)
    dot = max(2, size // 9)
    for row in range(2):
        for col in range(3):
            dx = x + 6 + col * ring_w * 3
            dy = y + 16 + row * ring_w * 3
            draw.rectangle((dx, dy, dx + dot, dy + dot), fill=color)


def _draw_eye_icon(draw: ImageDraw.ImageDraw, xy: Tuple[int, int], size: int = 30) -> None:
    x, y = xy
    color = "#424a57"
    center_y = y + size // 2
    draw.ellipse((x, y + 6, x + size, y + size - 6), outline=color, width=3)
    draw.ellipse(
        (
            x + size // 2 - 5,
            center_y - 5,
            x + size // 2 + 5,
            center_y + 5,
        ),
        fill=color,
    )


def _finalize_image(img: Image.Image, cfg: Dict[str, Any]) -> Image.Image:
    size_cfg = cfg.get("size") or {}
    default_size = TEMPLATE_SIZES[cfg["template"]]
    width = int(size_cfg.get("width") or default_size[0])
    height = int(size_cfg.get("height") or default_size[1])
    if img.size != (width, height):
        img = img.resize((width, height), Image.Resampling.LANCZOS)
    img = img.convert("RGBA")
    _add_watermark(img)
    return img


def _data_url(path: Optional[str]) -> str:
    if not path:
        return ""
    try:
        raw = Path(path).read_bytes()
        suffix = Path(path).suffix.lower().lstrip(".") or "png"
        mime = "jpeg" if suffix in {"jpg", "jpeg"} else suffix
        return f"data:image/{mime};base64,{base64.b64encode(raw).decode('ascii')}"
    except Exception:
        return ""


def _points(values: Iterable[Any]) -> List[float]:
    out: List[float] = []
    for value in values:
        try:
            out.append(float(value))
        except Exception:
            pass
    return out or [0.0]


def _chart_coords(
    values: List[float], box: Tuple[int, int, int, int]
) -> List[Tuple[float, float]]:
    x1, y1, x2, y2 = box
    if len(values) == 1:
        values = [values[0], values[0]]
    mn = min(values)
    mx = max(values)
    if math.isclose(mx, mn):
        mx = mn + 1
    coords = []
    for i, value in enumerate(values):
        x = x1 + (x2 - x1) * i / (len(values) - 1)
        y = y2 - (value - mn) / (mx - mn) * (y2 - y1)
        coords.append((x, y))
    return coords


def _draw_sparkline(
    draw: ImageDraw.ImageDraw,
    values: List[float],
    box: Tuple[int, int, int, int],
    color: str,
    fill: str,
) -> None:
    coords = _chart_coords(values, box)
    polygon = [(box[0], box[3])] + coords + [(box[2], box[3])]
    draw.polygon(polygon, fill=fill)
    draw.line(coords, fill=color, width=6, joint="curve")


def _draw_line_chart(
    draw: ImageDraw.ImageDraw,
    values: List[float],
    labels: List[str],
    box: Tuple[int, int, int, int],
    color: str = "#2e96de",
    y_labels: Optional[List[str]] = None,
) -> None:
    x1, y1, x2, y2 = box
    for i in range(5):
        y = y1 + (y2 - y1) * i / 4
        draw.line((x1, y, x2, y), fill="#cfd5dc", width=1)
        if y_labels and i < len(y_labels):
            _draw_text(draw, (x1 - 20, int(y) - 2), y_labels[i], 11, "#4b5563", anchor="rm")
    for i in range(4):
        x = x1 + (x2 - x1) * i / 3
        draw.line((x, y1, x, y2), fill="#cfd5dc", width=1)
    coords = _chart_coords(values, box)
    draw.line(coords, fill=color, width=3, joint="curve")
    if labels:
        for idx, label in enumerate(labels[:4]):
            x = x1 + (x2 - x1) * idx / max(1, min(3, len(labels[:4]) - 1))
            _draw_text(draw, (int(x), y2 + 16), label, 16, "#4b5563", anchor="ma")


def _draw_bar_chart(
    draw: ImageDraw.ImageDraw,
    bars: List[Dict[str, Any]],
    box: Tuple[int, int, int, int],
    color: str = "#559daf",
    max_value: Optional[float] = None,
    bar_width: Optional[int] = None,
    bar_gap: Optional[int] = None,
) -> None:
    x1, y1, x2, y2 = box
    max_v = max([float(b.get("value", 0) or 0) for b in bars] + [float(max_value or 0), 1])
    for i in range(5):
        y = y1 + (y2 - y1) * i / 4
        draw.line((x1, y, x2, y), fill="#edf0f3", width=2)
        value = int(max_v * (4 - i) / 4)
        _draw_text(draw, (x1 - 18, int(y)), value, 22, "#b9c0c9", anchor="rm")
    gap = int(bar_gap if bar_gap is not None else 55)
    width = int(
        bar_width
        if bar_width is not None
        else max(24, (x2 - x1 - gap * (len(bars) + 1)) / max(1, len(bars)))
    )
    total_width = width * len(bars) + gap * max(0, len(bars) - 1)
    start_x = x1 + max(0, (x2 - x1 - total_width) // 2)
    base = y2
    for i, bar in enumerate(bars):
        value = float(bar.get("value", 0) or 0)
        bx = start_x + i * (width + gap)
        bh = int((value / max_v) * (y2 - y1 - 20))
        draw.rounded_rectangle(
            (bx, base - bh, bx + width, base), radius=12, fill=color, outline="#408a9b", width=2
        )
        _draw_text(
            draw,
            (bx + width // 2, base - bh - 14),
            int(value),
            24,
            "#3490a5",
            bold=True,
            anchor="mm",
        )
        _draw_text(
            draw, (bx + width // 2, base + 28), bar.get("label", ""), 24, "#b9c0c9", anchor="ma"
        )


def default_report(template: str) -> Dict[str, Any]:
    if template == TEMPLATE_TGSTAT_POST:
        return {
            "template": TEMPLATE_TGSTAT_POST,
            "size": {
                "width": TEMPLATE_SIZES[TEMPLATE_TGSTAT_POST][0],
                "height": TEMPLATE_SIZES[TEMPLATE_TGSTAT_POST][1],
            },
            "output_name": "tgstat_post_demo",
            "channel": {"title": "Out'Darkness", "avatar_path": "", "verified": True},
            "post": {"number": "565", "date": "28 Feb, 18:19"},
            "chart": {
                "max": 36,
                "bar_width": 157,
                "bar_gap": 105,
                "bars": [
                    {"label": "28 Feb", "value": 34},
                    {"label": "1 Mar", "value": 32},
                    {"label": "2 Mar", "value": 6},
                    {"label": "3 Mar", "value": 6},
                    {"label": "4 Mar", "value": 1},
                ],
            },
            "views": {
                "percent": "6.9%",
                "rows": [
                    ["1 час", 24],
                    ["12 часов", 37],
                    ["24 часа", 60],
                    ["48 часов", 69],
                    ["72 часа", 76],
                    ["Всего", 79],
                ],
            },
            "activity": {
                "percent": "2.5%",
                "rows": [
                    ["Пересылки", 2],
                    ["Комментарии", 0],
                    ["Реакции", 0],
                    ["Репосты", 0],
                    ["Упоминания", 0],
                ],
            },
            "timestamp": "04.03.2026 15:04:19",
        }
    if template == TEMPLATE_TRUSTAT_CHANNEL:
        return {
            "template": TEMPLATE_TRUSTAT_CHANNEL,
            "size": {
                "width": TEMPLATE_SIZES[TEMPLATE_TRUSTAT_CHANNEL][0],
                "height": TEMPLATE_SIZES[TEMPLATE_TRUSTAT_CHANNEL][1],
            },
            "output_name": "trustat_channel_demo",
            "channel": {
                "title": "TRON | Самооборон...",
                "url": "https://t.me/+mZYtqdOEZdY2ZDky",
                "avatar_path": "",
                "tag": "тегов нет",
            },
            "summary": [
                ["27.9K", "подписчиков"],
                ["1.4K", "просмотров в сутки"],
                ["5%", "ER"],
                ["?₽", "цена рекламы"],
                ["?₽", "CPM"],
            ],
            "subscribers": {"today": "+87", "week": "-151", "month": "+531"},
            "stats": {"mentions": "N/A", "ad_posts": "N/A", "daily_er": "5%"},
            "line": {
                "labels": ["2025-03-10", "2025-03-13", "2025-03-16", "2025-03-19"],
                "y_labels": ["28200", "28000", "27800", "27600", "27400"],
                "values": [
                    27390,
                    27750,
                    27940,
                    27940,
                    28080,
                    28140,
                    28265,
                    28110,
                    27890,
                    27830,
                    27920,
                ],
            },
            "table": [
                ["20 марта 2025", "27,920", "+87"],
                ["19 марта 2025", "27,833", "-57"],
                ["18 марта 2025", "27,890", "-192"],
                ["17 марта 2025", "28,082", "-183"],
                ["16 марта 2025", "28,265", "+129"],
                ["15 марта 2025", "28,136", "+65"],
                ["14 марта 2025", "28,071", "+133"],
            ],
            "timestamp": "Актуально на 17:11, 20 мар. 2025г.",
        }
    return {
        "template": TEMPLATE_TGSTAT_CHANNEL,
        "size": {
            "width": TEMPLATE_SIZES[TEMPLATE_TGSTAT_CHANNEL][0],
            "height": TEMPLATE_SIZES[TEMPLATE_TGSTAT_CHANNEL][1],
        },
        "output_name": "tgstat_channel_demo",
        "channel": {
            "title": "КАЗАНОВА",
            "category": "Психология",
            "avatar_path": "",
            "geo_language": "Россия / Русский",
            "age": "4 месяца 20 дней",
            "posts": "397",
        },
        "cards": {
            "subscribers": {
                "value": "22 890",
                "today": "-56",
                "week": "+652",
                "month": "+216",
                "series": [80, 70, 61, 52, 44, 37, 29, 22, 15, 30, 35, 36, 48, 38, 80, 86, 84, 75],
            },
            "reach": {
                "value": "4 024",
                "err": "17.6%",
                "err24": "8.9%",
                "series": [88, 78, 74, 58, 69, 63, 61, 52, 41, 36, 38, 39, 50, 38, 41, 24, 38, 44],
            },
            "citation": {
                "value": "58.3",
                "channels": "852",
                "mentions": "1 397",
                "reposts": "0",
                "series": [0, 0, 0, 0, 0, 0, 35, 35, 35, 100, 100],
            },
            "ad_reach": {
                "value": "1 978",
                "h12": "1.5k",
                "h24": "2k",
                "h48": "2.4k",
                "series": [70, 64, 50, 32, 24, 22, 16, 8, 5, 8, 20, 36, 45],
            },
        },
        "timestamp": "19.06.2024 17:59:36",
    }


def normalize_report(report: Dict[str, Any]) -> Dict[str, Any]:
    template = str(report.get("template") or TEMPLATE_TGSTAT_CHANNEL)
    if template not in SUPPORTED_TEMPLATES:
        raise ValueError(f"Unsupported template: {template}")
    normalized = _deep_merge(default_report(template), report)
    normalized["template"] = template
    normalized["watermark"] = WATERMARK_TEXT
    return normalized


def render_stat_report(
    report: Dict[str, Any],
    output_dir: Optional[str | Path] = None,
    output_name: Optional[str] = None,
) -> Dict[str, Any]:
    cfg = normalize_report(report)
    out_dir = Path(output_dir) if output_dir else _default_output_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    name = _safe_name(output_name or cfg.get("output_name") or cfg["template"])
    html_text = render_html(cfg)
    png = render_png(cfg)
    html_path = out_dir / f"{name}.html"
    png_path = out_dir / f"{name}.png"
    html_path.write_text(html_text, encoding="utf-8")
    png.save(png_path)
    return {
        "ok": True,
        "template": cfg["template"],
        "watermark": WATERMARK_TEXT,
        "html_path": str(html_path.resolve()),
        "png_path": str(png_path.resolve()),
        "width": png.width,
        "height": png.height,
    }


def render_png(cfg: Dict[str, Any]) -> Image.Image:
    template = cfg["template"]
    if template == TEMPLATE_TGSTAT_POST:
        return _render_tgstat_post_png(cfg)
    if template == TEMPLATE_TRUSTAT_CHANNEL:
        return _render_trustat_png(cfg)
    return _render_tgstat_channel_png(cfg)


def _render_tgstat_channel_png(cfg: Dict[str, Any]) -> Image.Image:
    img = Image.new("RGBA", (2048, 1251), "#ffffff")
    draw = ImageDraw.Draw(img)
    ch = cfg["channel"]
    img.alpha_composite(_load_avatar(ch.get("avatar_path"), 210), (52, 64))
    _draw_text(draw, (315, 72), ch.get("title", ""), 72, "#424a57", light=True)
    _rounded_rect(draw, (314, 186, 628, 272), 8, "#eef1f5", "#d9dde4", 2)
    _draw_text(draw, (471, 229), ch.get("category", ""), 38, "#424a57", anchor="mm")
    _rounded_rect(draw, (1212, 52, 1990, 242), 8, "#f9fafc", "#d9dde4", 2)
    _draw_text(draw, (1264, 88), "Гео / Язык", 30, "#424a57", bold=True)
    _draw_text(draw, (1264, 133), "Возраст", 30, "#424a57", bold=True)
    _draw_text(draw, (1264, 178), "Постов", 30, "#424a57", bold=True)
    _draw_text(draw, (1506, 88), ch.get("geo_language", ""), 30, "#424a57")
    _draw_text(draw, (1506, 133), ch.get("age", ""), 30, "#424a57")
    _draw_text(draw, (1506, 178), ch.get("posts", ""), 30, "#424a57")
    draw.line((50, 323, 1990, 323), fill="#e8ebef", width=2)
    cards = cfg["cards"]
    _tgstat_card(
        draw,
        (52, 363, 994, 690),
        "ПОДПИСЧИКИ",
        cards["subscribers"],
        "#29aeca",
        "#d6f3f8",
        "subscribers",
    )
    _tgstat_card(
        draw,
        (1045, 363, 1988, 690),
        "СРЕДНИЙ ОХВАТ\n1 ПУБЛИКАЦИИ",
        cards["reach"],
        "#ffb400",
        "#ffefc2",
        "reach",
    )
    _tgstat_card(
        draw,
        (52, 742, 994, 1069),
        "ⓘ  ИНДЕКС ЦИТИРОВАНИЯ",
        cards["citation"],
        "#38bf65",
        "#d8f5df",
        "citation",
    )
    _tgstat_card(
        draw,
        (1045, 742, 1988, 1069),
        "ⓘ  СРЕДНИЙ РЕКЛАМНЫЙ\nОХВАТ 1 ПУБЛИКАЦИИ",
        cards["ad_reach"],
        "#ff8200",
        "#ffe5c5",
        "ad",
    )
    draw.line((50, 1083, 1990, 1083), fill="#e8ebef", width=2)
    _draw_tgstat_logo(draw, (52, 1125))
    _draw_text(draw, (180, 1138), "TGStat.ru", 32, "#424a57", bold=True)
    _draw_text(draw, (180, 1184), "Аналитика Telegram-каналов и чатов", 30, "#7b8490")
    _draw_text(draw, (1640, 1138), cfg.get("timestamp", ""), 26, "#7b8490")
    _draw_text(draw, (1312, 1184), "Создано с помощью бота @TGStat_Bot", 30, "#7b8490")
    _draw_qr_placeholder(draw, (1905, 1115, 1995, 1205))
    return _finalize_image(img, cfg)


def _tgstat_card(
    draw: ImageDraw.ImageDraw,
    box: Tuple[int, int, int, int],
    title: str,
    data: Dict[str, Any],
    color: str,
    fill: str,
    kind: str,
) -> None:
    _rounded_rect(draw, box, 8, "#ffffff", "#d9dde4", 2)
    x1, y1, x2, y2 = box
    _draw_text(draw, (x1 + 54, y1 + 46), data.get("value", ""), 58, "#424a57", bold=True)
    lines = title.split("\n")
    for i, line in enumerate(lines):
        _draw_text(draw, (x2 - 34, y1 + 42 + i * 38), line, 27, "#424a57", anchor="ra")
    if kind == "subscribers":
        rows = [
            ("today", "сегодня", "#ef555b"),
            ("week", "за неделю", "#42c99a"),
            ("month", "за месяц", "#42c99a"),
        ]
        for idx, (key, label, col) in enumerate(rows):
            y = y1 + 150 + idx * 48
            _draw_text(draw, (x1 + 54, y), data.get(key, ""), 30, col, bold=True)
            _draw_text(draw, (x1 + 155, y), label, 30, "#818a96")
    elif kind == "reach":
        _draw_text(draw, (x1 + 54, y1 + 178), data.get("err", ""), 30, "#424a57", bold=True)
        _draw_text(draw, (x1 + 184, y1 + 178), "ERR", 36, "#8b929d")
        _draw_text(draw, (x1 + 54, y1 + 235), data.get("err24", ""), 30, "#424a57", bold=True)
        _draw_text(draw, (x1 + 184, y1 + 235), "ERR24", 36, "#8b929d")
    elif kind == "citation":
        rows = [("channels", "уп. каналов"), ("mentions", "упоминаний"), ("reposts", "репостов")]
        for idx, (key, label) in enumerate(rows):
            y = y1 + 174 + idx * 48
            _draw_text(draw, (x1 + 54, y), data.get(key, ""), 30, "#424a57", bold=True)
            _draw_text(draw, (x1 + 164, y), label, 30, "#818a96")
    else:
        rows = [("h12", "за 12 часов"), ("h24", "за 24 часа"), ("h48", "за 48 часов")]
        for idx, (key, label) in enumerate(rows):
            y = y1 + 174 + idx * 48
            _draw_text(draw, (x1 + 54, y), data.get(key, ""), 30, "#424a57", bold=True)
            _draw_text(draw, (x1 + 145, y), label, 30, "#818a96")
    _draw_sparkline(
        draw, _points(data.get("series", [])), (x2 - 372, y1 + 115, x2 - 3, y2 - 3), color, fill
    )


def _render_tgstat_post_png(cfg: Dict[str, Any]) -> Image.Image:
    img = Image.new("RGBA", TEMPLATE_SIZES[TEMPLATE_TGSTAT_POST], "#ffffff")
    draw = ImageDraw.Draw(img)
    ch = cfg["channel"]
    avatar = _load_avatar(
        ch.get("avatar_path"),
        210,
        border="#42d6a5",
        border_width=8,
        auto_frame=True,
    )
    img.alpha_composite(avatar, (48, 50))
    if ch.get("verified", True):
        draw.ellipse((38, 40, 116, 118), fill="#85c638")
        draw.line((60, 78, 78, 96, 100, 62), fill="#ffffff", width=8)
    _draw_text(draw, (292, 78), ch.get("title", ""), 70, "#424a57", light=True)
    _draw_text(draw, (292, 158), "Статистика публикации", 46, "#424a57")
    _draw_text(draw, (842, 158), f"#{cfg['post'].get('number', '')}", 46, "#44c6e2")
    _draw_calendar_icon(draw, (302, 222), 26)
    _draw_text(draw, (344, 239), cfg["post"].get("date", ""), 30, "#5b6570")
    draw.line((48, 304, 1448, 304), fill="#e8ebef", width=2)
    _rounded_rect(draw, (48, 348, 1448, 1020), 8, "#ffffff", "#d9dde4", 2)
    _draw_bar_chart(
        draw,
        cfg["chart"].get("bars", []),
        (134, 434, 1431, 1011),
        max_value=cfg["chart"].get("max"),
        bar_width=cfg["chart"].get("bar_width"),
        bar_gap=cfg["chart"].get("bar_gap"),
    )
    _post_side_card(
        draw,
        (1494, 110, 2160, 590),
        "Просмотры",
        cfg["views"],
        "#44c6e2",
        icon="eye",
    )
    _post_side_card(draw, (1494, 635, 2160, 1020), "Активность", cfg["activity"], "#44c6e2")
    draw.line((48, 1115, 2192, 1115), fill="#e8ebef", width=2)
    _draw_tgstat_logo(draw, (50, 1090))
    _draw_text(draw, (168, 1118), "TGStat.ru", 32, "#424a57", bold=True)
    _draw_text(draw, (168, 1164), "Аналитика Telegram-каналов и чатов", 28, "#7b8490")
    _draw_text(draw, (1910, 1116), cfg.get("timestamp", ""), 24, "#7b8490", anchor="ra")
    _draw_text(draw, (1504, 1162), "Создано с помощью бота @TGStat_Bot", 28, "#7b8490")
    _draw_qr_placeholder(draw, (2095, 1087, 2178, 1170))
    return _finalize_image(img, cfg)


def _post_side_card(
    draw: ImageDraw.ImageDraw,
    box: Tuple[int, int, int, int],
    title: str,
    data: Dict[str, Any],
    accent: str,
    icon: Optional[str] = None,
) -> None:
    _rounded_rect(draw, box, 8, "#ffffff", "#d9dde4", 2)
    x1, y1, x2, y2 = box
    title_x = x1 + 46
    if icon == "eye":
        _draw_eye_icon(draw, (x1 + 46, y1 + 31), 30)
        title_x = x1 + 88
    _draw_text(draw, (title_x, y1 + 44), title, 34, "#424a57", bold=True)
    _draw_text(
        draw, (x2 - 46, y1 + 44), data.get("percent", ""), 34, accent, bold=True, anchor="ra"
    )
    draw.line((x1 + 46, y1 + 88, x2 - 46, y1 + 88), fill="#eceff3", width=2)
    rows = data.get("rows", [])
    step = min(62, max(46, (y2 - y1 - 180) // max(1, len(rows) - 1)))
    for i, row in enumerate(rows):
        y = y1 + 132 + i * step
        label, value = row[0], row[1]
        _draw_text(draw, (x1 + 46, y), label, 34, "#424a57")
        _draw_text(draw, (x2 - 46, y), value, 34, "#424a57", bold=True, anchor="ra")


def _render_trustat_png(cfg: Dict[str, Any]) -> Image.Image:
    img = Image.new("RGBA", TEMPLATE_SIZES[TEMPLATE_TRUSTAT_CHANNEL], "#e9edf4")
    draw = ImageDraw.Draw(img)
    ch = cfg["channel"]
    _rounded_rect(draw, (50, 50, 620, 300), 20, "#ffffff", "#edf1f5", 1)
    img.alpha_composite(
        _load_avatar(ch.get("avatar_path"), 100, border="#111111", border_width=0), (88, 88)
    )
    _draw_text(draw, (216, 94), ch.get("title", ""), 28, "#111111", bold=True)
    _draw_text(draw, (216, 130), ch.get("url", ""), 13, "#111111")
    _rounded_rect(draw, (216, 158, 294, 180), 8, "#f2f3f5", "#d8dde3", 1)
    _draw_text(draw, (255, 171), ch.get("tag", ""), 12, "#444444", anchor="mm")
    x = 108
    for value, label in cfg.get("summary", []):
        _draw_text(draw, (x, 240), value, 22, "#111111", bold=True, anchor="ma")
        _draw_text(draw, (x, 266), label, 11, "#111111", anchor="ma")
        x += 92
    _trustat_small_card(
        draw,
        (658, 50, 923, 300),
        "Подписчиков",
        [
            ["Сегодня:", cfg["subscribers"]["today"]],
            ["За неделю:", cfg["subscribers"]["week"]],
            ["За месяц:", cfg["subscribers"]["month"]],
        ],
    )
    _trustat_small_card(
        draw,
        (965, 50, 1230, 300),
        "Статистика",
        [
            ["Упоминаний:", cfg["stats"]["mentions"]],
            ["Рекламных постов:", cfg["stats"]["ad_posts"]],
            ["Суточный ER:", cfg["stats"]["daily_er"]],
        ],
        blue=True,
    )
    _rounded_rect(draw, (50, 340, 620, 750), 20, "#ffffff", "#edf1f5", 1)
    _draw_line_chart(
        draw,
        _points(cfg["line"].get("values", [])),
        cfg["line"].get("labels", []),
        (132, 388, 604, 695),
        "#2f94df",
        y_labels=cfg["line"].get("y_labels", []),
    )
    _rounded_rect(draw, (658, 340, 1230, 750), 20, "#ffffff", "#edf1f5", 1)
    _draw_text(draw, (728, 382), "День", 20, "#111111", bold=True)
    _draw_text(draw, (888, 382), "Подписчиков", 20, "#111111", bold=True)
    _draw_text(draw, (1092, 382), "Прирост", 20, "#111111", bold=True)
    for i, row in enumerate(cfg.get("table", [])):
        y = 431 + i * 43
        if i % 2 == 0:
            draw.rectangle((674, y - 24, 1214, y + 18), fill="#f8fafc")
        _draw_text(draw, (696, y), row[0], 15, "#111111")
        _draw_text(draw, (920, y), row[1], 16, "#1686d9", bold=True)
        col = "#08c24a" if str(row[2]).startswith("+") else "#e21d2b"
        _draw_text(draw, (1106, y), row[2], 16, col, bold=True)
    _rounded_rect(draw, (50, 800, 1230, 875), 18, "#ffffff", "#edf1f5", 1)
    _draw_text(draw, (88, 844), cfg.get("timestamp", ""), 18, "#111111", bold=True)
    _draw_text(draw, (428, 844), "|", 20, "#111111", bold=True)
    _draw_text(
        draw,
        (464, 844),
        "Trustat — аналитика телеграм-каналов — @trustatbot  /  trustat.ru",
        18,
        "#111111",
        bold=True,
    )
    _draw_text(draw, (1188, 850), "↻", 48, "#1686d9", bold=True, anchor="mm")
    return _finalize_image(img, cfg)


def _trustat_small_card(
    draw: ImageDraw.ImageDraw, box, title: str, rows: List[List[Any]], blue: bool = False
) -> None:
    _rounded_rect(draw, box, 20, "#ffffff", "#edf1f5", 1)
    x1, y1, x2, _ = box
    _draw_text(draw, ((x1 + x2) // 2, y1 + 56), title, 25, "#111111", bold=True, anchor="mm")
    for i, (label, value) in enumerate(rows):
        y = y1 + 103 + i * 55
        _draw_text(draw, (x1 + 22, y), label, 16, "#111111", bold=True)
        val = str(value)
        col = (
            "#1686d9"
            if blue or val == "N/A"
            else ("#08c24a" if val.startswith("+") else "#e21d2b")
        )
        _draw_text(draw, (x2 - 48, y), val, 16, col, bold=True, anchor="ra")


def render_html(cfg: Dict[str, Any]) -> str:
    template = cfg["template"]
    image = render_png(cfg)
    from io import BytesIO

    buf = BytesIO()
    image.save(buf, format="PNG")
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    title = html.escape(str(cfg.get("channel", {}).get("title", "Telegram stat report")))
    return f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} - {html.escape(template)}</title>
  <style>
    html, body {{ margin:0; background:#e9edf4; font-family:Segoe UI, Arial, sans-serif; }}
    .wrap {{ min-height:100vh; display:grid; place-items:center; padding:24px; }}
    img {{ width:min(100%, {image.width}px); height:auto; box-shadow:0 18px 42px rgba(15,23,42,.16); }}
  </style>
</head>
<body>
  <div class="wrap">
    <img alt="DEMO synthetic Telegram statistics report" src="data:image/png;base64,{data}">
  </div>
</body>
</html>
"""


def templates_payload() -> Dict[str, Any]:
    return {
        "templates": sorted(SUPPORTED_TEMPLATES),
        "watermark": WATERMARK_TEXT,
        "examples": {name: default_report(name) for name in sorted(SUPPORTED_TEMPLATES)},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Render synthetic Telegram stat reports.")
    parser.add_argument("json_file", help="Path to report JSON payload")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--output-name", default=None)
    args = parser.parse_args()
    payload = json.loads(Path(args.json_file).read_text(encoding="utf-8"))
    result = render_stat_report(payload, output_dir=args.output_dir, output_name=args.output_name)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
