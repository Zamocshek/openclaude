import pytest
from telethon import types

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
