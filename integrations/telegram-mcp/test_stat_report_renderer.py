from pathlib import Path

from PIL import Image

import stat_report_renderer as sr


def test_stat_report_renderer_outputs_html_and_png(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_DATA_DIR", str(tmp_path / "data"))

    for template in sorted(sr.SUPPORTED_TEMPLATES):
        result = sr.render_stat_report(
            {"template": template, "output_name": template},
            output_dir=tmp_path,
        )

        html_path = Path(result["html_path"])
        png_path = Path(result["png_path"])
        assert result["ok"] is True
        assert result["watermark"] == "DEMO"
        assert result["width"] == sr.TEMPLATE_SIZES[template][0]
        assert result["height"] == sr.TEMPLATE_SIZES[template][1]
        assert html_path.exists()
        assert png_path.exists()
        assert "DEMO synthetic Telegram statistics report" in html_path.read_text(encoding="utf-8")
        with Image.open(png_path) as img:
            assert img.width == result["width"]
            assert img.height == result["height"]


def test_stat_report_rejects_unknown_template(tmp_path):
    try:
        sr.render_stat_report({"template": "unknown"}, output_dir=tmp_path)
    except ValueError as exc:
        assert "Unsupported template" in str(exc)
    else:
        raise AssertionError("unknown template should fail")


def test_stat_report_templates_payload_has_examples():
    payload = sr.templates_payload()

    assert payload["watermark"] == "DEMO"
    assert sr.TEMPLATE_TGSTAT_CHANNEL in payload["examples"]
    assert sr.TEMPLATE_TGSTAT_POST in payload["examples"]
    assert sr.TEMPLATE_TRUSTAT_CHANNEL in payload["examples"]
    for template, example in payload["examples"].items():
        assert example["size"]["width"] == sr.TEMPLATE_SIZES[template][0]
        assert example["size"]["height"] == sr.TEMPLATE_SIZES[template][1]
