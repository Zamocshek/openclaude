import asyncio
import json

import pytest

import main


class FakeMatonClient:
    def __init__(self, connections=None):
        self.connections = connections or [
            {
                "connection_id": "telegram_conn",
                "app": "telegram",
                "status": "ACTIVE",
            }
        ]

    async def list_connections(self, *, app=None, status=None):
        assert app == "telegram"
        assert status == "ACTIVE"
        return {"connections": self.connections}

    async def get_connection(self, connection_id):
        return {
            "connection": next(
                item for item in self.connections if item["connection_id"] == connection_id
            )
        }


def install_pending_action_fakes(monkeypatch):
    captured = {}

    class Connection:
        def commit(self):
            captured["committed"] = True

    class Context:
        def __enter__(self):
            return Connection()

        def __exit__(self, exc_type, exc, traceback):
            return False

    def create_pending_action(_connection, **kwargs):
        captured.update(kwargs)
        return 41

    monkeypatch.setattr(main.am, "connect", lambda: Context())
    monkeypatch.setattr(main.am, "create_pending_action", create_pending_action)
    return captured


def test_telegram_connection_auto_selects_only_active_connection(monkeypatch):
    monkeypatch.setattr(main.mt, "MatonClient", FakeMatonClient)
    selected = asyncio.run(main._maton_telegram_connection_id())
    assert selected == "telegram_conn"


def test_telegram_connection_requires_explicit_id_when_multiple(monkeypatch):
    connections = [
        {"connection_id": "one", "app": "telegram", "status": "ACTIVE"},
        {"connection_id": "two", "app": "telegram", "status": "ACTIVE"},
    ]
    monkeypatch.setattr(main.mt, "MatonClient", lambda: FakeMatonClient(connections))
    with pytest.raises(ValueError, match="multiple active"):
        asyncio.run(main._maton_telegram_connection_id())


def test_telegram_reads_use_maton_token_route(monkeypatch):
    requests = []

    class Client(FakeMatonClient):
        async def request(self, **kwargs):
            requests.append(kwargs)
            return {"status_code": 200, "data": {"ok": True, "result": {}}}

    monkeypatch.setattr(main.mt, "MatonClient", Client)

    get_me = json.loads(asyncio.run(main.maton_telegram_get_me()))
    get_chat = json.loads(asyncio.run(main.maton_telegram_get_chat("@example")))

    assert get_me["ok"] is True
    assert get_chat["ok"] is True
    assert requests[0]["path"] == ":token/getMe"
    assert requests[1]["path"] == ":token/getChat?chat_id=%40example"


def test_prepare_message_uses_short_safe_contract(monkeypatch):
    monkeypatch.setattr(main.mt, "MatonClient", FakeMatonClient)
    captured = install_pending_action_fakes(monkeypatch)

    result = json.loads(
        asyncio.run(
            main.maton_telegram_prepare_send_message(
                chat_id="@example",
                text="<b>Test</b>",
                parse_mode="html",
                silent=True,
                link_preview=False,
            )
        )
    )

    assert result["ok"] is True
    assert result["pending_action_id"] == 41
    assert captured["action_type"] == "maton_request"
    payload = captured["payload"]
    assert payload["app"] == "telegram"
    assert payload["path"] == ":token/sendMessage"
    assert payload["body"] == {
        "chat_id": "@example",
        "text": "<b>Test</b>",
        "disable_notification": True,
        "disable_web_page_preview": True,
        "protect_content": False,
        "parse_mode": "HTML",
    }
    assert captured["committed"] is True


def test_prepare_animation_validates_caption_limit(monkeypatch):
    monkeypatch.setattr(main.mt, "MatonClient", FakeMatonClient)
    install_pending_action_fakes(monkeypatch)

    result = json.loads(
        asyncio.run(
            main.maton_telegram_prepare_send_animation(
                chat_id="-100123",
                animation="telegram-file-id",
                caption="x" * 1025,
            )
        )
    )

    assert result["ok"] is False
    assert "1024-character limit" in result["error"]


def test_maton_telegram_validator_rejects_inner_api_failure():
    with pytest.raises(main._MatonTelegramOperationError, match="chat not found"):
        main._require_maton_telegram_success(
            {
                "status_code": 200,
                "data": {"ok": False, "description": "Bad Request: chat not found"},
            },
            ":token/sendMessage",
        )


def test_maton_telegram_validator_requires_message_id_for_send():
    with pytest.raises(main._MatonTelegramOperationError, match="message_id"):
        main._require_maton_telegram_success(
            {"status_code": 200, "data": {"ok": True, "result": {}}},
            ":token/sendMessage",
        )


def test_confirmed_maton_rejection_is_persisted_as_not_sent(monkeypatch):
    action = {
        "status": "pending",
        "result_json": None,
        "payload_json": json.dumps(
            {
                "app": "telegram",
                "connection_id": "telegram_conn",
                "method": "POST",
                "path": ":token/sendMessage",
                "body": {"chat_id": "@missing", "text": "test"},
            }
        ),
        "account_id": "maton:telegram_conn",
        "action_type": "maton_request",
    }
    resolved = {}

    class Connection:
        def commit(self):
            pass

    class Context:
        def __enter__(self):
            return Connection()

        def __exit__(self, exc_type, exc, traceback):
            return False

    class Client(FakeMatonClient):
        async def request(self, **kwargs):
            return {
                "status_code": 200,
                "data": {"ok": False, "description": "Bad Request: chat not found"},
            }

    monkeypatch.setattr(main.mt, "MatonClient", Client)
    monkeypatch.setattr(main.am, "connect", lambda: Context())
    monkeypatch.setattr(main.am, "get_pending_action", lambda _conn, _id: action)
    monkeypatch.setattr(main.am, "claim_pending_action", lambda _conn, _id: action)

    def resolve_pending_action(_conn, _id, status, *, result=None, error=None):
        resolved.update(status=status, result=result, error=error)

    monkeypatch.setattr(main.am, "resolve_pending_action", resolve_pending_action)

    asyncio.run(main.assistant_confirm_action(77))

    assert resolved["status"] == "failed"
    assert resolved["error"]["delivery_state"] == "not_sent"
