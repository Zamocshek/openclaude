import asyncio
import json

import assistant_memory as am
import main


def test_local_bot_prepare_and_confirm_are_idempotent(tmp_path, monkeypatch):
    old_session_dir = am.SESSION_DIR
    old_db_path = am.DB_PATH
    am.SESSION_DIR = str(tmp_path)
    am.DB_PATH = str(tmp_path / "assistant_memory.sqlite3")
    monkeypatch.setenv("TELEGRAM_MCP_BOT_TOKEN", "test-token")
    async def unrestricted(_chat_id):
        return {"checked": True, "restricted": False, "restriction_reasons": []}

    monkeypatch.setattr(main, "_telegram_platform_restriction", unrestricted)
    calls = []

    class FakeBotClient:
        async def send_message(self, body):
            calls.append(body)
            return {
                "ok": True,
                "result": {
                    "message_id": 77,
                    "chat": {
                        "id": -100123,
                        "title": "Channel",
                        "username": "channel",
                    },
                    "text": "Test",
                    "entities": [{"type": "bold", "offset": 0, "length": 4}],
                },
            }

    monkeypatch.setattr(main.tbot, "TelegramBotClient", FakeBotClient)
    try:
        prepared = json.loads(
            asyncio.run(
                main.telegram_bot_prepare_send_message(
                    chat_id="@channel", text="<b>Test</b>", parse_mode="html"
                )
            )
        )
        action_id = prepared["pending_action_id"]
        first = json.loads(asyncio.run(main.assistant_confirm_action(action_id)))
        second = json.loads(asyncio.run(main.assistant_confirm_action(action_id)))

        assert first["message_id"] == 77
        assert first["publisher"] == "telegram_bot_api"
        assert second["idempotent_replay"] is True
        assert len(calls) == 1
        assert calls[0]["link_preview_options"] == {"is_disabled": False}
        with am.connect() as conn:
            action = am.get_pending_action(conn, action_id)
        assert action["status"] == "sent"
        assert action["attempt_count"] == 1
    finally:
        am.SESSION_DIR = old_session_dir
        am.DB_PATH = old_db_path


def test_local_bot_prepare_refuses_platform_restricted_channel(monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_BOT_TOKEN", "test-token")

    async def restricted(_chat_id):
        return {
            "checked": True,
            "restricted": True,
            "restriction_reasons": [
                {"platform": "all", "reason": "terms", "text": "channel restricted"}
            ],
        }

    monkeypatch.setattr(main, "_telegram_platform_restriction", restricted)
    result = json.loads(
        asyncio.run(
            main.telegram_bot_prepare_send_message(
                chat_id="@channel", text="<b>Test</b>", parse_mode="html"
            )
        )
    )
    assert result["ok"] is False
    assert result["error_type"] == "validation_error"
    assert "channel restricted" in result["error"]


def test_bot_api_rejection_is_recorded_as_not_sent(tmp_path, monkeypatch):
    old_session_dir = am.SESSION_DIR
    old_db_path = am.DB_PATH
    am.SESSION_DIR = str(tmp_path)
    am.DB_PATH = str(tmp_path / "assistant_memory.sqlite3")

    class RejectingBotClient:
        async def send_message(self, _body):
            raise main.tbot.TelegramBotAPIError(
                "Telegram Bot API error 400: Bad Request: CHAT_RESTRICTED"
            )

    monkeypatch.setattr(main.tbot, "TelegramBotClient", RejectingBotClient)
    try:
        with am.connect() as conn:
            action_id = am.create_pending_action(
                conn,
                action_type="telegram_bot_send_message",
                account_id="telegram-bot:configured",
                target_chat="@restricted",
                target_label="Restricted channel",
                payload={"body": {"chat_id": "@restricted", "text": "Test"}},
            )
            conn.commit()

        asyncio.run(main.assistant_confirm_action(action_id))

        with am.connect() as conn:
            action = am.get_pending_action(conn, action_id)
        error = json.loads(action["error_json"])
        assert action["status"] == "failed"
        assert action["attempt_count"] == 1
        assert error["delivery_state"] == "not_sent"
    finally:
        am.SESSION_DIR = old_session_dir
        am.DB_PATH = old_db_path
