"""Account administration helpers for the local web console."""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Dict, List, Optional

from telethon import TelegramClient
from telethon import connection as tl_connection
from telethon.errors import RPCError

import assistant_memory as am
import operator_config as oc
from runtime_config import get_session_dir

SAFE_ACCOUNT_RE = re.compile(r"^[A-Za-z0-9_.@+-]{1,120}$")
SUPPORTED_UPLOAD_SUFFIXES = {".session", ".json"}
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
PRESERVED_SESSION_FILES = {"smooth.json", "operator_config.json"}
PRESERVED_SESSION_PREFIXES = (
    "assistant_memory.sqlite3",
    "content_workflow.sqlite3",
)


def _session_dir() -> Path:
    path = get_session_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def purge_account_session_files() -> List[str]:
    """Delete Telegram account credentials without touching MCP memory/config."""

    deleted: List[str] = []
    for path in _session_dir().iterdir():
        if not path.is_file():
            continue
        name = path.name
        if name in PRESERVED_SESSION_FILES:
            continue
        if any(name.startswith(prefix) for prefix in PRESERVED_SESSION_PREFIXES):
            continue
        if (
            name == "proxies.json"
            or name.endswith(".json")
            or ".session" in name
        ):
            path.unlink()
            deleted.append(name)
    return sorted(deleted)


def validate_account_id(account_id: str) -> str:
    value = str(account_id or "").strip()
    if not value or not SAFE_ACCOUNT_RE.fullmatch(value):
        raise ValueError("Invalid account id")
    return value


def _safe_upload_name(filename: str) -> str:
    name = Path(filename or "").name
    suffix = Path(name).suffix.lower()
    stem = Path(name).stem
    if suffix not in SUPPORTED_UPLOAD_SUFFIXES:
        raise ValueError("Only .session and .json files are supported")
    validate_account_id(stem)
    return f"{stem}{suffix}"


def _file_info(path: Path) -> Dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "updated_at": int(stat.st_mtime),
    }


def session_health_from_sqlite(account_id: str) -> Optional[str]:
    """Return a human-readable session-file problem, or None when it looks sane."""

    account_id = validate_account_id(account_id)
    path = _session_dir() / f"{account_id}.session"
    if not path.exists():
        return f"missing session file: {path.name}"

    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1.5) as conn:
            row = conn.execute(
                "select dc_id, server_address, port, auth_key from sessions limit 1"
            ).fetchone()
    except sqlite3.DatabaseError as exc:
        return f"session sqlite error: {exc}"
    except OSError as exc:
        return f"session read error: {exc}"

    if not row:
        return "session sqlite has no sessions row"
    if row[3] is None:
        return "session sqlite has no auth key"
    return None


def load_session_config(account_id: str) -> Dict[str, Any]:
    account_id = validate_account_id(account_id)
    path = _session_dir() / f"{account_id}.json"
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _load_proxies_config() -> Dict[str, Any]:
    path = _session_dir() / "proxies.json"
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _normalize_mtproto_secret(value: Any) -> Optional[str]:
    if value is None:
        return None
    secret = str(value).strip()
    if not secret:
        return None
    if secret.startswith("ee"):
        secret = secret[2:]
    return secret


def _build_proxy_kwargs(proxy: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not proxy:
        return {}

    kind = str(proxy.get("type", "socks5")).lower()
    host = proxy.get("host") or proxy.get("addr") or proxy.get("server")
    port = int(proxy.get("port", 0) or 0)
    if not host or not port:
        return {}

    if kind in {"mtproxy", "mtproto"}:
        secret = _normalize_mtproto_secret(proxy.get("secret"))
        if not secret:
            return {}
        return {
            "connection": tl_connection.ConnectionTcpMTProxyRandomizedIntermediate,
            "proxy": (str(host), port, secret),
        }

    try:
        import socks  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on optional proxy setup
        raise RuntimeError("PySocks is required for SOCKS/HTTP proxies") from exc

    proxy_type = socks.SOCKS5
    if kind in {"socks4", "socks4a"}:
        proxy_type = socks.SOCKS4
    elif kind in {"http", "https"}:
        proxy_type = socks.HTTP

    return {
        "proxy": (
            proxy_type,
            str(host),
            port,
            bool(proxy.get("rdns", True)),
            proxy.get("username") or proxy.get("user"),
            proxy.get("password") or proxy.get("pass"),
        )
    }


def _resolve_proxy(account_id: str, config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    direct = config.get("proxy")
    if isinstance(direct, dict):
        return direct

    proxies = _load_proxies_config()
    proxy_id = config.get("proxy_id") or config.get("proxy")
    if proxy_id and isinstance(proxies.get(str(proxy_id)), dict):
        return proxies[str(proxy_id)]

    accounts = proxies.get("accounts")
    if isinstance(accounts, dict):
        mapped = accounts.get(account_id)
        if isinstance(mapped, dict):
            return mapped
        if mapped and isinstance(proxies.get(str(mapped)), dict):
            return proxies[str(mapped)]

    default = proxies.get("default")
    return default if isinstance(default, dict) else None


def _api_credentials(config: Dict[str, Any]) -> tuple[int, str]:
    api_id = config.get("app_id") or config.get("api_id") or os.getenv("TELEGRAM_API_ID")
    api_hash = config.get("app_hash") or config.get("api_hash") or os.getenv("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        raise ValueError("TELEGRAM_API_ID/TELEGRAM_API_HASH or account .json config is required")
    return int(api_id), str(api_hash)


def _session_stem(account_id: str) -> Path:
    account_id = validate_account_id(account_id)
    return _session_dir() / account_id


def _phone_value(value: Any) -> Optional[str]:
    phone = str(value or "").strip()
    if not phone:
        return None
    if oc.web_flag("show_sensitive_account_fields"):
        return phone
    if len(phone) <= 4:
        return "*" * len(phone)
    return f"{'*' * max(0, len(phone) - 4)}{phone[-4:]}"


def _restriction_reasons(entity: Any) -> List[str]:
    reasons = getattr(entity, "restriction_reason", None) or []
    result: List[str] = []
    for item in reasons:
        platform = getattr(item, "platform", None)
        reason = getattr(item, "reason", None)
        text = getattr(item, "text", None)
        parts = [str(part) for part in (platform, reason, text) if part]
        if parts:
            result.append(": ".join(parts))
    return result


def _entity_type(entity: Any) -> str:
    if getattr(entity, "bot", False):
        return "bot"
    if getattr(entity, "broadcast", False):
        return "channel"
    if getattr(entity, "megagroup", False):
        return "supergroup"
    if getattr(entity, "gigagroup", False):
        return "gigagroup"
    if entity.__class__.__name__.lower().endswith("chat"):
        return "group"
    return "user"


def _json_safe(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, Iterable) and not isinstance(value, (bytes, bytearray)):
        return [_json_safe(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _client_for(account_id: str) -> TelegramClient:
    account_id = validate_account_id(account_id)
    config = load_session_config(account_id)
    api_id, api_hash = _api_credentials(config)
    proxy = _resolve_proxy(account_id, config)
    return TelegramClient(
        str(_session_stem(account_id)), api_id, api_hash, **_build_proxy_kwargs(proxy)
    )


async def _connect_client(account_id: str) -> TelegramClient:
    client = _client_for(account_id)
    await asyncio.wait_for(client.connect(), timeout=oc.limit("connect_timeout_sec"))
    return client


def list_session_files() -> List[Dict[str, Any]]:
    accounts: List[Dict[str, Any]] = []
    for path in sorted(_session_dir().glob("*.session")):
        account_id = path.stem
        config_path = path.with_suffix(".json")
        item = {
            "account_id": account_id,
            "session": _file_info(path),
            "config": _file_info(config_path) if config_path.exists() else None,
            "health": None,
            "memory": {
                "chats": 0,
                "messages": 0,
                "todos": 0,
                "reminders": 0,
            },
        }
        try:
            item["health"] = session_health_from_sqlite(account_id)
            item["memory"] = _memory_counts(account_id)
        except Exception as exc:
            item["health"] = str(exc)
        accounts.append(item)
    return accounts


def _memory_counts(account_id: str) -> Dict[str, int]:
    with am.connect() as conn:
        return {
            "chats": conn.execute(
                "SELECT COUNT(*) FROM assistant_chats WHERE account_id=?", (account_id,)
            ).fetchone()[0],
            "messages": conn.execute(
                "SELECT COUNT(*) FROM assistant_messages WHERE account_id=?", (account_id,)
            ).fetchone()[0],
            "todos": conn.execute(
                "SELECT COUNT(*) FROM assistant_todos WHERE account_id=?", (account_id,)
            ).fetchone()[0],
            "reminders": conn.execute(
                "SELECT COUNT(*) FROM assistant_reminders WHERE account_id=?", (account_id,)
            ).fetchone()[0],
        }


def save_account_upload(
    filename: str,
    content: bytes,
    overwrite: bool = False,
    max_upload_bytes: Optional[int] = None,
) -> Dict[str, Any]:
    limit = max_upload_bytes or oc.max_upload_bytes()
    if len(content) > limit:
        raise ValueError("Uploaded file is too large")
    safe_name = _safe_upload_name(filename)
    target = _session_dir() / safe_name
    if target.exists() and not overwrite:
        raise FileExistsError(f"{safe_name} already exists")
    target.write_bytes(content)
    return {
        "account_id": target.stem,
        "file": _file_info(target),
        "type": target.suffix.lower().lstrip("."),
    }


async def inspect_account(account_id: str) -> Dict[str, Any]:
    account_id = validate_account_id(account_id)
    result: Dict[str, Any] = {
        "account_id": account_id,
        "status": "unknown",
        "authorized": False,
        "health": session_health_from_sqlite(account_id),
        "session": None,
        "me": None,
        "proxy": None,
        "error": None,
    }

    session_path = _session_dir() / f"{account_id}.session"
    if session_path.exists():
        result["session"] = _file_info(session_path)

    config = load_session_config(account_id)
    proxy = _resolve_proxy(account_id, config)
    result["proxy"] = _json_safe(proxy)

    if result["health"]:
        result["status"] = "session_error"
        return result

    client: Optional[TelegramClient] = None
    try:
        client = await _connect_client(account_id)
        request_timeout = oc.limit("request_timeout_sec")
        authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=request_timeout)
        result["authorized"] = bool(authorized)
        if not authorized:
            result["status"] = "unauthorized"
            return result

        me = await asyncio.wait_for(client.get_me(), timeout=request_timeout)
        result["status"] = "ok"
        result["me"] = {
            "id": getattr(me, "id", None),
            "username": getattr(me, "username", None),
            "first_name": getattr(me, "first_name", None),
            "last_name": getattr(me, "last_name", None),
            "phone": _phone_value(getattr(me, "phone", None)),
            "bot": bool(getattr(me, "bot", False)),
            "premium": bool(getattr(me, "premium", False)),
            "verified": bool(getattr(me, "verified", False)),
            "restricted": bool(getattr(me, "restricted", False)),
            "scam": bool(getattr(me, "scam", False)),
            "fake": bool(getattr(me, "fake", False)),
            "restriction_reason": _restriction_reasons(me),
        }
    except (asyncio.TimeoutError, ValueError, RuntimeError, RPCError, OSError) as exc:
        result["status"] = "error"
        result["error"] = str(exc)
    finally:
        if client is not None:
            await client.disconnect()
    return result


async def list_dialogs(account_id: str, limit: int = 30) -> Dict[str, Any]:
    account_id = validate_account_id(account_id)
    cfg = oc.load_config()
    limit = max(
        1, min(int(limit or cfg["web"]["default_dialog_limit"]), oc.limit("max_dialog_limit"))
    )
    client: Optional[TelegramClient] = None
    dialogs: List[Dict[str, Any]] = []
    try:
        client = await _connect_client(account_id)
        if not await client.is_user_authorized():
            return {"account_id": account_id, "dialogs": [], "error": "account is not authorized"}

        now = int(time.time())
        async for dialog in client.iter_dialogs(limit=limit):
            entity = dialog.entity
            settings = getattr(getattr(dialog, "dialog", None), "notify_settings", None)
            mute_until = getattr(settings, "mute_until", None)
            mute_ts: Optional[int] = None
            if hasattr(mute_until, "timestamp"):
                mute_ts = int(mute_until.timestamp())
            elif isinstance(mute_until, int):
                mute_ts = int(mute_until)

            message = getattr(dialog, "message", None)
            dialogs.append(
                {
                    "id": getattr(dialog, "id", None),
                    "title": getattr(dialog, "title", None)
                    or getattr(entity, "username", None)
                    or str(getattr(dialog, "id", "")),
                    "entity_type": _entity_type(entity),
                    "username": getattr(entity, "username", None),
                    "unread_count": getattr(dialog, "unread_count", 0) or 0,
                    "unread_mentions_count": getattr(dialog, "unread_mentions_count", 0) or 0,
                    "muted": bool(mute_ts and mute_ts > now),
                    "mute_until": mute_ts,
                    "last_message_id": getattr(message, "id", None),
                    "last_message_date": _json_safe(getattr(message, "date", None)),
                    "last_message": (
                        (getattr(message, "message", None) or "")[:500] if message else ""
                    ),
                }
            )
    finally:
        if client is not None:
            await client.disconnect()
    return {"account_id": account_id, "dialogs": dialogs}


async def send_message(
    account_id: str, peer_id: str, text: str, reply_to_msg_id: Optional[int] = None
) -> Dict[str, Any]:
    account_id = validate_account_id(account_id)
    peer_value = str(peer_id or "").strip()
    if not peer_value:
        raise ValueError("peer_id is required")
    message_text = str(text or "").strip()
    if not message_text:
        raise ValueError("message text is required")
    max_chars = oc.limit("max_manual_send_chars")
    if len(message_text) > max_chars:
        raise ValueError(f"message text is too long; max {max_chars} chars")

    client: Optional[TelegramClient] = None
    try:
        client = await _connect_client(account_id)
        if not await client.is_user_authorized():
            raise ValueError("account is not authorized")
        peer: Any = int(peer_value) if re.fullmatch(r"-?\d+", peer_value) else peer_value
        sent = await client.send_message(peer, message_text, reply_to=reply_to_msg_id)
        return {
            "account_id": account_id,
            "peer_id": peer_value,
            "message_id": getattr(sent, "id", None),
            "date": _json_safe(getattr(sent, "date", None)),
            "status": "sent",
        }
    finally:
        if client is not None:
            await client.disconnect()


async def sync_dialogs_to_memory(
    account_id: str, limit: int = 30, messages_per_dialog: int = 0
) -> Dict[str, Any]:
    account_id = validate_account_id(account_id)
    cfg = oc.load_config()
    limit = max(
        1, min(int(limit or cfg["web"]["default_dialog_limit"]), oc.limit("max_dialog_limit"))
    )
    messages_per_dialog = max(
        0,
        min(
            int(messages_per_dialog or cfg["web"]["default_sync_messages_per_dialog"]),
            oc.limit("max_sync_messages_per_dialog"),
        ),
    )
    client: Optional[TelegramClient] = None
    saved_chats = 0
    saved_messages = 0
    try:
        client = await _connect_client(account_id)
        if not await client.is_user_authorized():
            return {
                "account_id": account_id,
                "saved_chats": 0,
                "saved_messages": 0,
                "error": "account is not authorized",
            }

        with am.connect() as conn:
            async for dialog in client.iter_dialogs(limit=limit):
                entity = dialog.entity
                peer_id = am.peer_id(entity)
                message = getattr(dialog, "message", None)
                am.upsert_chat(
                    conn,
                    account_id=account_id,
                    peer_id=peer_id,
                    peer_kind=am.peer_kind(entity),
                    title=am.display_name(entity),
                    username=getattr(entity, "username", None),
                    is_archived=am.dialog_is_archived(dialog),
                    last_message_id=getattr(message, "id", None),
                )
                saved_chats += 1

                if messages_per_dialog:
                    async for msg in client.iter_messages(entity, limit=messages_per_dialog):
                        am.upsert_message(
                            conn,
                            account_id=account_id,
                            peer_id=peer_id,
                            message_id=int(getattr(msg, "id", 0) or 0),
                            sender_id=getattr(msg, "sender_id", None),
                            sender_name=None,
                            is_outgoing=bool(getattr(msg, "out", False)),
                            date=getattr(msg, "date", None),
                            kind=am.message_kind(msg),
                            text=am.message_text(msg),
                            extra={"source": "web_admin_sync"},
                        )
                        saved_messages += 1
            conn.commit()
    finally:
        if client is not None:
            await client.disconnect()
    return {"account_id": account_id, "saved_chats": saved_chats, "saved_messages": saved_messages}
