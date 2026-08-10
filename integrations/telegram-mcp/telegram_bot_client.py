import os
import logging
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

import httpx


# Telegram embeds the bot token in the request URL. Never let httpx INFO logs
# serialize that URL into container logs.
logging.getLogger("httpx").setLevel(logging.WARNING)


class TelegramBotError(Exception):
    """Base error for the local Telegram Bot API publisher."""


class TelegramBotAPIError(TelegramBotError):
    """Telegram returned a valid error response."""

    outcome_known = True
    delivery_state = "not_sent"


@dataclass(frozen=True)
class TelegramBotConfig:
    token: str
    api_url: str = "https://api.telegram.org"
    timeout: float = 30.0

    @classmethod
    def from_env(cls) -> "TelegramBotConfig":
        token = os.getenv("TELEGRAM_MCP_BOT_TOKEN", "").strip()
        api_url = os.getenv("TELEGRAM_MCP_BOT_API_URL", "https://api.telegram.org").strip()
        if api_url.rstrip("/") != "https://api.telegram.org":
            raise TelegramBotError("TELEGRAM_MCP_BOT_API_URL must be https://api.telegram.org")
        try:
            timeout = float(os.getenv("TELEGRAM_MCP_BOT_TIMEOUT", "30"))
        except ValueError as exc:
            raise TelegramBotError("TELEGRAM_MCP_BOT_TIMEOUT must be a number") from exc
        if timeout <= 0:
            raise TelegramBotError("TELEGRAM_MCP_BOT_TIMEOUT must be positive")
        return cls(token=token, api_url=api_url.rstrip("/"), timeout=timeout)

    @property
    def configured(self) -> bool:
        return bool(self.token)


def config_status() -> Dict[str, Any]:
    config = TelegramBotConfig.from_env()
    return {
        "configured": config.configured,
        "api_url": config.api_url,
        "timeout": config.timeout,
        "token_source": "TELEGRAM_MCP_BOT_TOKEN" if config.configured else None,
    }


class TelegramBotClient:
    def __init__(
        self,
        config: Optional[TelegramBotConfig] = None,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.config = config or TelegramBotConfig.from_env()
        self._transport = transport

    def _require_configured(self) -> None:
        if not self.config.configured:
            raise TelegramBotError("TELEGRAM_MCP_BOT_TOKEN is not configured")

    async def request(
        self, method: str, body: Optional[Mapping[str, Any]] = None
    ) -> Dict[str, Any]:
        self._require_configured()
        method = str(method or "").strip()
        if not method or not method.replace("_", "").isalnum():
            raise ValueError("Telegram Bot API method is invalid")
        async with httpx.AsyncClient(
            timeout=self.config.timeout,
            transport=self._transport,
            follow_redirects=False,
        ) as client:
            response = await client.post(
                f"{self.config.api_url}/bot{self.config.token}/{method}",
                json=dict(body or {}),
            )
        try:
            payload: Any = response.json()
        except ValueError as exc:
            raise TelegramBotAPIError(
                f"Telegram Bot API returned HTTP {response.status_code} with invalid JSON"
            ) from exc
        if not isinstance(payload, dict):
            raise TelegramBotAPIError("Telegram Bot API response must be an object")
        if response.is_error or payload.get("ok") is not True:
            error_code = payload.get("error_code", response.status_code)
            description = str(payload.get("description") or "request failed")
            raise TelegramBotAPIError(
                f"Telegram Bot API error {error_code}: {description}"
            )
        return payload

    async def get_me(self) -> Dict[str, Any]:
        return await self.request("getMe")

    async def get_chat_member(self, chat_id: str, user_id: int) -> Dict[str, Any]:
        return await self.request(
            "getChatMember", {"chat_id": chat_id, "user_id": int(user_id)}
        )

    async def check_posting_access(self, chat_id: str) -> Dict[str, Any]:
        me = (await self.get_me()).get("result", {})
        member = (await self.get_chat_member(chat_id, int(me["id"]))).get("result", {})
        status = str(member.get("status", ""))
        can_post = status == "creator" or (
            status == "administrator" and bool(member.get("can_post_messages"))
        )
        return {
            "ok": True,
            "chat_id": chat_id,
            "bot": {"id": me.get("id"), "username": me.get("username")},
            "status": status,
            "can_post": can_post,
            "can_edit_messages": bool(member.get("can_edit_messages")),
            "basis": (
                "creator"
                if status == "creator"
                else "administrator.can_post_messages"
                if can_post
                else "bot lacks channel posting rights"
            ),
        }

    async def send_message(self, body: Mapping[str, Any]) -> Dict[str, Any]:
        return await self.request("sendMessage", body)
