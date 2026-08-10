import httpx
import pytest

from telegram_bot_client import (
    TelegramBotAPIError,
    TelegramBotClient,
    TelegramBotConfig,
)


@pytest.mark.asyncio
async def test_bot_client_pins_telegram_host_and_returns_message():
    def handler(request):
        assert request.url.host == "api.telegram.org"
        assert request.url.path == "/bottest-token/sendMessage"
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": {"message_id": 17, "chat": {"id": -1001}, "text": "test"},
            },
        )

    client = TelegramBotClient(
        TelegramBotConfig(token="test-token"),
        transport=httpx.MockTransport(handler),
    )
    result = await client.send_message({"chat_id": "@channel", "text": "test"})
    assert result["result"]["message_id"] == 17


@pytest.mark.asyncio
async def test_bot_client_preserves_telegram_error_details():
    def handler(_request):
        return httpx.Response(
            400,
            json={"ok": False, "error_code": 400, "description": "chat not found"},
        )

    client = TelegramBotClient(
        TelegramBotConfig(token="test-token"),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(TelegramBotAPIError, match="chat not found"):
        await client.send_message({"chat_id": "@missing", "text": "test"})


@pytest.mark.asyncio
async def test_bot_posting_access_requires_channel_right(monkeypatch):
    responses = {
        "getMe": {"ok": True, "result": {"id": 7, "username": "nova_bot"}},
        "getChatMember": {
            "ok": True,
            "result": {"status": "administrator", "can_post_messages": True},
        },
    }

    class FakeClient(TelegramBotClient):
        async def request(self, method, body=None):
            return responses[method]

    result = await FakeClient(TelegramBotConfig(token="test-token")).check_posting_access(
        "@channel"
    )
    assert result["can_post"] is True
    assert result["bot"]["username"] == "nova_bot"
