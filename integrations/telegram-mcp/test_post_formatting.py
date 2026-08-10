import pytest
from telethon import types
from types import SimpleNamespace

import post_formatting as pf


def test_html_parses_formatting_and_premium_emoji():
    post = pf.parse_post(
        '<b>Launch</b> <tg-emoji emoji-id="123456789">🔥</tg-emoji> '
        '<a href="https://example.com">Read</a>',
        "html",
    )

    assert post.text == "Launch 🔥 Read"
    assert any(isinstance(entity, types.MessageEntityBold) for entity in post.entities)
    assert post.custom_emojis == [
        {"document_id": 123456789, "fallback": "🔥", "offset": 7, "length": 2}
    ]
    assert '<tg-emoji emoji-id="123456789">🔥</tg-emoji>' in pf.preview(post)["html_preview"]


def test_markdown_and_plain_modes():
    markdown_post = pf.parse_post("**Bold** and `code`", "markdown")
    plain_post = pf.parse_post("<b>literal</b>", "plain")

    assert markdown_post.text == "Bold and code"
    assert len(markdown_post.entities) == 2
    assert plain_post.text == "<b>literal</b>"
    assert plain_post.entities == []


def test_custom_emoji_requires_an_emoji_fallback():
    with pytest.raises(ValueError, match="fallback emoji"):
        pf.parse_post('<tg-emoji emoji-id="123">not emoji</tg-emoji>', "html")


def test_post_limit_uses_telegram_utf16_units():
    with pytest.raises(ValueError, match="4096"):
        pf.parse_post("🔥" * 2049, "plain")


def test_caption_limit_uses_telegram_utf16_units():
    with pytest.raises(ValueError, match="1024"):
        pf.parse_post("🔥" * 513, "plain", max_utf16_length=pf.MAX_CAPTION_UTF16_LENGTH)


def test_message_formatting_snapshot_preserves_all_rich_entities():
    message = SimpleNamespace(
        message="Read Bold 🔥",
        entities=[
            types.MessageEntityTextUrl(0, 4, "https://example.com/read"),
            types.MessageEntityBold(5, 4),
            types.MessageEntityCustomEmoji(10, 2, 123456789),
        ],
    )

    snapshot = pf.formatting_from_message(message)

    assert snapshot["format_mode"] == "html"
    assert snapshot["entity_count"] == 3
    assert '<a href="https://example.com/read">Read</a>' in snapshot["formatted_text"]
    assert "<strong>Bold</strong>" in snapshot["formatted_text"] or "<b>Bold</b>" in snapshot["formatted_text"]
    assert '<tg-emoji emoji-id="123456789">🔥</tg-emoji>' in snapshot["formatted_text"]
    assert snapshot["has_hidden_targets"] is True


def test_source_formatting_guard_detects_silent_plain_text_loss():
    source_text = "Read Bold 🔥"
    source = pf.formatting_snapshot(
        source_text,
        [
            types.MessageEntityTextUrl(0, 4, "https://example.com/read"),
            types.MessageEntityBold(5, 4),
            types.MessageEntityCustomEmoji(10, 2, 123456789),
        ],
    )

    missing = pf.missing_source_formatting(
        source_text, source, pf.parse_post(source_text, "plain")
    )
    preserved = pf.missing_source_formatting(
        source_text,
        source,
        pf.parse_post(source["formatted_text"], "html"),
    )

    assert {item["kind"] for item in missing} == {"text_url", "bold", "custom_emoji"}
    assert preserved == []


def test_edited_source_requires_only_retained_hidden_targets():
    source = pf.formatting_snapshot(
        "Read Bold",
        [
            types.MessageEntityTextUrl(0, 4, "https://example.com/read"),
            types.MessageEntityBold(5, 4),
        ],
    )

    missing = pf.missing_source_formatting(
        "Read Bold", source, pf.parse_post("Read a different article", "plain")
    )

    assert missing == [
        {
            "kind": "text_url",
            "text": "Read",
            "target": "https://example.com/read",
            "reason": "telegram_entity_was_lost",
        }
    ]
