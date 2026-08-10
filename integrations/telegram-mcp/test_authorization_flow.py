import asyncio
import time

import main


class FakePendingClient:
    def __init__(self, *, require_password: bool = False):
        self.connected = True
        self.disconnected = False
        self.require_password = require_password

    def is_connected(self):
        return self.connected

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False
        self.disconnected = True

    async def sign_in(self, **kwargs):
        if self.require_password and "password" not in kwargs:
            error_type = type("SessionPasswordNeededError", (Exception,), {})
            raise error_type("Two-steps verification is enabled")


def pending(client, *, expires_at=None):
    return {
        "client": client,
        "phone": "+10000000000",
        "phone_code_hash": "hash",
        "api_id": 1,
        "api_hash": "api-hash",
        "expires_at": expires_at or time.monotonic() + 600,
    }


def test_2fa_prompt_never_echoes_confirmation_code():
    client = FakePendingClient(require_password=True)
    main._pending_auth.clear()
    main._pending_auth["account"] = pending(client)
    try:
        response = asyncio.run(
            main.authorize_complete("account", "12345", password=None)
        )
        assert "2FA password required" in response
        assert "12345" not in response
        assert "account" in main._pending_auth
    finally:
        asyncio.run(main._discard_pending_auth("account"))


def test_expired_pending_authorization_disconnects_client():
    client = FakePendingClient()
    main._pending_auth.clear()
    main._pending_auth["expired"] = pending(client, expires_at=1)

    expired = asyncio.run(main._purge_expired_pending_auth(now=2))

    assert expired == {"expired"}
    assert client.disconnected is True
    assert "expired" not in main._pending_auth
