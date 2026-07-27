import asyncio

import pytest
from telethon import types

import main


class FakeMe:
    premium = True


class FakeClient:
    def __init__(self):
        self.message_call = None
        self.file_call = None

    async def get_me(self):
        return FakeMe()

    async def get_input_entity(self, value):
        return f"input:{value}"

    async def send_message(self, entity, text, **kwargs):
        self.message_call = (entity, text, kwargs)
        return object()

    async def send_file(self, entity, file_path, **kwargs):
        self.file_call = (entity, file_path, kwargs)
        return object()


def test_plain_pending_action_uses_send_message():
    client = FakeClient()

    sent, sent_text = asyncio.run(
        main._send_pending_rich_post(
            client,
            "target",
            {"message": "Plain text", "reply_to_msg_id": 44},
        )
    )

    assert sent is not None
    assert sent_text == "Plain text"
    assert client.message_call == ("target", "Plain text", {"reply_to": 44})
    assert client.file_call is None


def test_rich_media_pending_action_keeps_caption_entities(tmp_path):
    image = tmp_path / "post.png"
    image.write_bytes(b"not-a-real-image-is-fine-for-payload-validation")
    client = FakeClient()

    sent, sent_text = asyncio.run(
        main._send_pending_rich_post(
            client,
            "target",
            {
                "rich_post": True,
                "message": '<b>Launch</b> <tg-emoji emoji-id="123">🔥</tg-emoji>',
                "format_mode": "html",
                "media_path": str(image),
                "reply_to_msg_id": 5,
                "silent": True,
                "force_document": False,
                "send_as": "@channel",
            },
        )
    )

    assert sent is not None
    assert sent_text == "Launch 🔥"
    entity, file_path, kwargs = client.file_call
    assert entity == "target"
    assert file_path == str(image.resolve())
    assert kwargs["caption"] == "Launch 🔥"
    assert kwargs["reply_to"] == 5
    assert kwargs["silent"] is True
    assert kwargs["force_document"] is False
    assert kwargs["send_as"] == "input:@channel"
    assert any(isinstance(item, types.MessageEntityBold) for item in kwargs["formatting_entities"])
    assert any(
        isinstance(item, types.MessageEntityCustomEmoji) for item in kwargs["formatting_entities"]
    )


def test_rich_media_rechecks_file_before_delivery(tmp_path):
    missing = tmp_path / "missing.png"

    with pytest.raises(ValueError, match="not found"):
        asyncio.run(
            main._send_pending_rich_post(
                FakeClient(),
                "target",
                {
                    "rich_post": True,
                    "message": "Caption",
                    "media_path": str(missing),
                },
            )
        )
