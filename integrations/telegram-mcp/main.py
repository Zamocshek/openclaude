import os
import sys
import json
import time
import asyncio
import sqlite3
import logging
import mimetypes
import random
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import List, Dict, Optional, Union, Any

# Third-party libraries
import nest_asyncio
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pythonjsonlogger import jsonlogger
from telethon import TelegramClient, connection as tl_connection, functions, types, utils
from telethon.sessions import StringSession
from telethon.tl.types import (
    User,
    Chat,
    Channel,
    ChatAdminRights,
    ChatBannedRights,
    ChannelParticipantsKicked,
    ChannelParticipantsAdmins,
    InputChatPhoto,
    InputChatUploadedPhoto,
    InputChatPhotoEmpty,
    InputPeerUser,
    InputPeerChat,
    InputPeerChannel,
    DialogFilter,
    DialogFilterDefault,
    TextWithEntities,
)
from telethon.network.connection.tcpmtproxy import TcpMTProxy as _TcpMTProxy

from runtime_config import ensure_runtime_dirs, get_default_session_name, get_log_file, get_session_dir
import assistant_memory as am
import content_workflow as cw
import post_formatting as pf
import operator_config as oc
import stat_report_renderer as sr
import maton_client as mt
import vpromotions_client as vp

_orig_normalize_secret = _TcpMTProxy.normalize_secret

@staticmethod
def _patched_normalize_secret(secret):
    if isinstance(secret, (bytes, bytearray)):
        return bytes(secret[:16])
    return _orig_normalize_secret(secret)

_TcpMTProxy.normalize_secret = _patched_normalize_secret
import re
from functools import wraps
import telethon.errors.rpcerrorlist
from telethon.errors import FloodWaitError


class ValidationError(Exception):
    """Custom exception for validation errors."""

    pass


def json_serializer(obj):
    """Helper function to convert non-serializable objects for JSON serialization."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    # Add other non-serializable types as needed
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def get_entity_type(entity: Any) -> str:
    """Return a normalized, human-readable chat/entity type."""
    if isinstance(entity, User):
        return "User"
    if isinstance(entity, Chat):
        return "Group (Basic)"
    if isinstance(entity, Channel):
        if getattr(entity, "megagroup", False):
            return "Supergroup"
        return "Channel" if getattr(entity, "broadcast", False) else "Group"
    return type(entity).__name__


def get_entity_filter_type(entity: Any) -> Optional[str]:
    """Return list_chats-compatible filter type: user/group/channel."""
    entity_type = get_entity_type(entity)
    if entity_type == "User":
        return "user"
    if entity_type in ("Group (Basic)", "Group", "Supergroup"):
        return "group"
    if entity_type == "Channel":
        return "channel"
    return None


ensure_runtime_dirs()

_TELEGRAM_API_ID_RAW = os.getenv("TELEGRAM_API_ID", "").strip()
_TELEGRAM_API_HASH_RAW = os.getenv("TELEGRAM_API_HASH", "").strip()
try:
    TELEGRAM_API_ID = int(_TELEGRAM_API_ID_RAW)
except ValueError:
    TELEGRAM_API_ID = 0
TELEGRAM_API_HASH = _TELEGRAM_API_HASH_RAW
TELEGRAM_CONFIGURED = TELEGRAM_API_ID > 0 and bool(TELEGRAM_API_HASH)
if not TELEGRAM_CONFIGURED:
    # Telethon validates credentials during object construction. Keep the MCP
    # control plane available so configuration and Maton status tools still
    # work, but skip Telegram network startup below.
    TELEGRAM_API_ID = 1
    TELEGRAM_API_HASH = "0" * 32
TELEGRAM_SESSION_NAME = get_default_session_name(os.getenv("TELEGRAM_SESSION_NAME"))
MCP_TRANSPORT = os.getenv("TELEGRAM_MCP_TRANSPORT", "stdio").strip().lower()
MCP_HOST = os.getenv("TELEGRAM_MCP_HOST", "127.0.0.1").strip() or "127.0.0.1"
MCP_PORT = int(os.getenv("TELEGRAM_MCP_PORT", "8000"))

# Check if a string session exists in environment, otherwise use file-based session
SESSION_STRING = os.getenv("TELEGRAM_SESSION_STRING")

mcp = FastMCP("telegram", host=MCP_HOST, port=MCP_PORT)

if SESSION_STRING:
    # Use the string session if available
    client = TelegramClient(StringSession(SESSION_STRING), TELEGRAM_API_ID, TELEGRAM_API_HASH)
else:
    # Use file-based session
    client = TelegramClient(TELEGRAM_SESSION_NAME, TELEGRAM_API_ID, TELEGRAM_API_HASH)

# Setup robust logging with both file and console output
logger = logging.getLogger("telegram_mcp")
logger.setLevel(logging.ERROR)  # Set to ERROR for production, INFO for debugging

# Create console handler
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.ERROR)  # Set to ERROR for production, INFO for debugging

# Create file handler with configurable runtime path
log_file_path = str(get_log_file())

try:
    file_handler = logging.FileHandler(log_file_path, mode="a")  # Append mode
    file_handler.setLevel(logging.ERROR)

    # Create formatters
    # Console formatter remains in the old format
    console_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s - %(message)s")
    console_handler.setFormatter(console_formatter)

    # File formatter is now JSON
    json_formatter = jsonlogger.JsonFormatter(
        "%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )
    file_handler.setFormatter(json_formatter)

    # Add handlers to logger
    logger.addHandler(console_handler)
    logger.addHandler(file_handler)
    logger.info(f"Logging initialized to {log_file_path}")
except Exception as log_error:
    print(f"WARNING: Error setting up log file: {log_error}")
    # Fallback to console-only logging
    logger.addHandler(console_handler)
    logger.error(f"Failed to set up log file handler: {log_error}")


# Error code prefix mapping for better error tracing
class ErrorCategory(str, Enum):
    CHAT = "CHAT"
    MSG = "MSG"
    CONTACT = "CONTACT"
    GROUP = "GROUP"
    MEDIA = "MEDIA"
    PROFILE = "PROFILE"
    AUTH = "AUTH"
    ADMIN = "ADMIN"
    FOLDER = "FOLDER"


def log_and_format_error(
    function_name: str,
    error: Exception,
    prefix: Optional[Union[ErrorCategory, str]] = None,
    user_message: str = None,
    **kwargs,
) -> str:
    """
    Centralized error handling function.

    Logs an error and returns a formatted, user-friendly message.

    Args:
        function_name: Name of the function where the error occurred.
        error: The exception that was raised.
        prefix: Error code prefix (e.g., ErrorCategory.CHAT, "VALIDATION-001").
            If None, it will be derived from the function_name.
        user_message: A custom user-facing message to return. If None, a generic one is created.
        **kwargs: Additional context parameters to include in the log.

    Returns:
        A user-friendly error message with an error code.
    """
    # Generate a consistent error code
    if isinstance(prefix, str) and prefix == "VALIDATION-001":
        # Special case for validation errors
        error_code = prefix
    else:
        if prefix is None:
            # Try to derive prefix from function name
            for category in ErrorCategory:
                if category.name.lower() in function_name.lower():
                    prefix = category
                    break

        prefix_str = prefix.value if isinstance(prefix, ErrorCategory) else (prefix or "GEN")
        error_code = f"{prefix_str}-ERR-{abs(hash(function_name)) % 1000:03d}"

    # Format the additional context parameters
    context = ", ".join(f"{k}={v}" for k, v in kwargs.items())

    # Log the full technical error
    logger.error(f"Error in {function_name} ({context}) - Code: {error_code}", exc_info=True)

    # Return a user-friendly message
    if user_message:
        return user_message

    return f"An error occurred (code: {error_code}). Check {log_file_path} for details."


def validate_id(*param_names_to_validate):
    """
    Decorator to validate chat_id and user_id parameters, including lists of IDs.
    It checks for valid integer ranges, string representations of integers,
    and username formats.
    """

    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            for param_name in param_names_to_validate:
                if param_name not in kwargs or kwargs[param_name] is None:
                    continue

                param_value = kwargs[param_name]

                def validate_single_id(value, p_name):
                    # Handle integer IDs
                    if isinstance(value, int):
                        if not (-(2**63) <= value <= 2**63 - 1):
                            return (
                                None,
                                f"Invalid {p_name}: {value}. ID is out of the valid integer range.",
                            )
                        return value, None

                    # Handle string IDs
                    if isinstance(value, str):
                        try:
                            int_value = int(value)
                            if not (-(2**63) <= int_value <= 2**63 - 1):
                                return (
                                    None,
                                    f"Invalid {p_name}: {value}. ID is out of the valid integer range.",
                                )
                            return int_value, None
                        except ValueError:
                            if re.match(r"^@?[a-zA-Z0-9_]{5,}$", value):
                                return value, None
                            else:
                                return (
                                    None,
                                    f"Invalid {p_name}: '{value}'. Must be a valid integer ID, or a username string.",
                                )

                    # Handle other invalid types
                    return (
                        None,
                        f"Invalid {p_name}: {value}. Type must be an integer or a string.",
                    )

                if isinstance(param_value, list):
                    validated_list = []
                    for item in param_value:
                        validated_item, error_msg = validate_single_id(item, param_name)
                        if error_msg:
                            return log_and_format_error(
                                func.__name__,
                                ValidationError(error_msg),
                                prefix="VALIDATION-001",
                                user_message=error_msg,
                                **{param_name: param_value},
                            )
                        validated_list.append(validated_item)
                    kwargs[param_name] = validated_list
                else:
                    validated_value, error_msg = validate_single_id(param_value, param_name)
                    if error_msg:
                        return log_and_format_error(
                            func.__name__,
                            ValidationError(error_msg),
                            prefix="VALIDATION-001",
                            user_message=error_msg,
                            **{param_name: param_value},
                        )
                    kwargs[param_name] = validated_value

            return await func(*args, **kwargs)

        return wrapper

    return decorator


def format_entity(entity) -> Dict[str, Any]:
    """Helper function to format entity information consistently."""
    result = {"id": entity.id}

    if hasattr(entity, "title"):
        result["name"] = entity.title
        result["type"] = "group" if isinstance(entity, Chat) else "channel"
    elif hasattr(entity, "first_name"):
        name_parts = []
        if entity.first_name:
            name_parts.append(entity.first_name)
        if hasattr(entity, "last_name") and entity.last_name:
            name_parts.append(entity.last_name)
        result["name"] = " ".join(name_parts)
        result["type"] = "user"
        if hasattr(entity, "username") and entity.username:
            result["username"] = entity.username
        if hasattr(entity, "phone") and entity.phone:
            result["phone"] = entity.phone

    return result


def get_sender_name(message) -> str:
    """Helper function to get sender name from a message."""
    if not message.sender:
        return "Unknown"

    # Check for group/channel title first
    if hasattr(message.sender, "title") and message.sender.title:
        return message.sender.title
    elif hasattr(message.sender, "first_name"):
        # User sender
        first_name = getattr(message.sender, "first_name", "") or ""
        last_name = getattr(message.sender, "last_name", "") or ""
        full_name = f"{first_name} {last_name}".strip()
        return full_name if full_name else "Unknown"
    else:
        return "Unknown"


def get_engagement_info(message) -> str:
    """Helper function to get engagement metrics (views, forwards, reactions) from a message."""
    engagement_parts = []
    views = getattr(message, "views", None)
    if views is not None:
        engagement_parts.append(f"views:{views}")
    forwards = getattr(message, "forwards", None)
    if forwards is not None:
        engagement_parts.append(f"forwards:{forwards}")
    reactions = getattr(message, "reactions", None)
    if reactions is not None:
        results = getattr(reactions, "results", None)
        total_reactions = sum(getattr(r, "count", 0) or 0 for r in results) if results else 0
        engagement_parts.append(f"reactions:{total_reactions}")
    return f" | {', '.join(engagement_parts)}" if engagement_parts else ""


# ---------------------------------------------------------------------------
# Multi-account system: constants, helpers, session loading, smooth mode
# ---------------------------------------------------------------------------

SESSION_DIR = str(get_session_dir())
START_SESSION_TIMEOUT = 10
TOOL_OPERATION_TIMEOUT = 25

MULTI_ACCOUNT_CLIENTS: Dict[str, TelegramClient] = {}
_session_configs: Dict[str, Dict[str, Any]] = {}
_proxies_config: Dict[str, Any] = {}
_started_accounts: set = set()
_failed_accounts: set = set()

_FATAL_ERRORS = (
    "auth_key_unregistered", "user_deactivated", "session_revoked",
    "session_expired", "auth_key_duplicated",
)

# --- Smooth mode config ---
_SMOOTH_CFG_PATH = os.path.join(SESSION_DIR, "smooth.json")
_smooth_config: Dict[str, Any] = {
    "enabled": True,
    "delay_between_requests": 8,
    "delay_between_accounts": 8,
    "max_parallel": 1,
}
_account_last_request: Dict[str, float] = {}
_account_rate_locks: Dict[str, asyncio.Lock] = {}


def _get_account_rate_lock(key: str) -> asyncio.Lock:
    lock = _account_rate_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _account_rate_locks[key] = lock
    return lock

def _load_smooth_config() -> None:
    global _smooth_config
    if os.path.isfile(_SMOOTH_CFG_PATH):
        try:
            with open(_SMOOTH_CFG_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            _smooth_config.update(loaded)
        except Exception:
            pass

def _save_smooth_config() -> None:
    try:
        with open(_SMOOTH_CFG_PATH, "w", encoding="utf-8") as f:
            json.dump(_smooth_config, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

_load_smooth_config()


async def _smooth_wait(account_id: Optional[str] = None) -> None:
    """Enforce minimum delay between Telegram API calls for an account.
    Adds ±30% randomization to avoid pattern detection."""
    if not _smooth_config.get("enabled", True):
        return
    key = account_id or "__default__"
    async with _get_account_rate_lock(key):
        base_delay = _smooth_config.get("delay_between_requests", 8)
        jitter = base_delay * 0.3
        delay = base_delay + random.uniform(-jitter, jitter)
        delay = max(1.0, delay)
        last = _account_last_request.get(key, 0)
        elapsed = time.time() - last
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        _account_last_request[key] = time.time()


# --- FloodWait-safe wrapper ---

async def _safe_call(coro, max_retries: int = 2):
    """Execute a Telegram API coroutine with FloodWait retry.
    Waits up to 60s per retry. Re-raises after max_retries."""
    for attempt in range(max_retries + 1):
        try:
            return await coro
        except FloodWaitError as e:
            if attempt >= max_retries:
                raise
            wait_sec = min(e.seconds + 1, 60)
            print(f"FloodWait: sleeping {wait_sec}s (attempt {attempt + 1}/{max_retries})", file=sys.stderr)
            await asyncio.sleep(wait_sec)
    raise RuntimeError("_safe_call: max retries exceeded")


# --- tool_timeout decorator ---

def tool_timeout(seconds: int = TOOL_OPERATION_TIMEOUT):
    """Timeout decorator for MCP tools. Does NOT cache account in _failed_accounts on timeout."""
    def deco(f):
        @wraps(f)
        async def wrapped(*args, **kwargs):
            try:
                return await asyncio.wait_for(f(*args, **kwargs), timeout=seconds)
            except asyncio.TimeoutError:
                return f"Error: operation timed out ({seconds}s). Retry or use check_account."
            except Exception as e:
                return log_and_format_error(f.__name__, e, **kwargs)
        return wrapped
    return deco


# --- Session config loading ---

def _load_session_config(name: str) -> Dict[str, Any]:
    p = os.path.join(SESSION_DIR, f"{name}.json")
    if os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def _save_session_config(name: str, cfg: Dict[str, Any]) -> None:
    p = os.path.join(SESSION_DIR, f"{name}.json")
    try:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


# --- Proxy helpers ---

def _normalize_mtproto_secret(raw: str) -> bytes:
    h = raw.lower()
    if h.startswith("ee") or h.startswith("dd"):
        if len(h) > 32:
            h = h[2:]
    secret_bytes = bytes.fromhex(h)
    return secret_bytes[:16]

def _build_proxy_kwargs(proxy_cfg: Dict[str, Any]) -> Dict[str, Any]:
    ptype = proxy_cfg.get("type", "").lower()
    host = proxy_cfg.get("host")
    port = int(proxy_cfg.get("port", 0))
    if not host or not port:
        return {}
    if ptype == "mtproto":
        secret_raw = proxy_cfg.get("secret", "")
        secret = _normalize_mtproto_secret(secret_raw) if secret_raw else b""
        return dict(
            connection=tl_connection.ConnectionTcpMTProxyRandomizedIntermediate,
            proxy=(host, port, secret),
        )
    elif ptype in ("socks5", "socks4"):
        import socks as pysocks
        pt = pysocks.SOCKS5 if ptype == "socks5" else pysocks.SOCKS4
        return dict(proxy=(pt, host, port,
                           True,
                           proxy_cfg.get("username"),
                           proxy_cfg.get("password")))
    elif ptype in ("http", "https"):
        import socks as pysocks
        return dict(proxy=(pysocks.HTTP, host, port,
                           True,
                           proxy_cfg.get("username"),
                           proxy_cfg.get("password")))
    return {}


def _resolve_proxy(name: str) -> Optional[Dict[str, Any]]:
    cfg = _session_configs.get(name, {})
    p = cfg.get("proxy")
    if p and p.get("host"):
        return p
    dp = _proxies_config.get("default_proxy")
    if dp and dp.get("host"):
        return dp
    return None


def _proxy_display(p: Optional[Dict[str, Any]]) -> str:
    if not p or not p.get("host"):
        return "direct (no proxy)"
    return f"{p.get('type', '?')} {p['host']}:{p.get('port', '?')}"


# --- API credentials ---

def _resolve_api_credentials(cfg: Dict[str, Any]) -> tuple:
    api_id = cfg.get("app_id") or TELEGRAM_API_ID
    api_hash = cfg.get("app_hash") or TELEGRAM_API_HASH
    return int(api_id), str(api_hash)


# --- Client creation ---

def _create_session_client(name: str) -> TelegramClient:
    cfg = _session_configs.get(name, {})
    api_id, api_hash = _resolve_api_credentials(cfg)
    session_path = os.path.join(SESSION_DIR, name)
    kwargs: Dict[str, Any] = {}
    proxy = _resolve_proxy(name)
    if proxy:
        kwargs.update(_build_proxy_kwargs(proxy))

    device = cfg.get("device", "Desktop")
    sdk = cfg.get("sdk", "Windows 10")
    app_ver = cfg.get("app_version", "4.16.8 x64")
    lang = cfg.get("lang_code", "en")
    sys_lang = cfg.get("system_lang_code", "en")

    c = TelegramClient(
        session_path, api_id, api_hash,
        device_model=device, system_version=sdk, app_version=app_ver,
        lang_code=lang, system_lang_code=sys_lang,
        timeout=10, connection_retries=2, retry_delay=3,
        request_retries=3,
        flood_sleep_threshold=60,
        auto_reconnect=True,
        **kwargs,
    )
    return c


# --- Safe helpers ---

async def _safe_disconnect(c: TelegramClient, timeout: float = 3) -> None:
    try:
        if c.is_connected():
            await asyncio.wait_for(c.disconnect(), timeout=timeout)
    except Exception:
        pass


async def _test_proxy_reachable(proxy_cfg: Dict[str, Any], timeout: float = 4) -> bool:
    host = proxy_cfg.get("host")
    port = int(proxy_cfg.get("port", 0))
    if not host or not port:
        return True
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        w.close()
        try:
            await w.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


def _is_fatal_error(e: Exception) -> bool:
    msg = str(e).lower()
    return any(fe in msg for fe in _FATAL_ERRORS)


async def _safe_start(c: TelegramClient, timeout: float, account_id: str) -> None:
    proxy = _resolve_proxy(account_id)
    if proxy and proxy.get("host"):
        reachable = await _test_proxy_reachable(proxy, timeout=4)
        if not reachable:
            raise ConnectionError(f"proxy unreachable ({proxy['host']}:{proxy.get('port', '?')})")
    await asyncio.wait_for(c.connect(), timeout=timeout)
    if not await asyncio.wait_for(c.is_user_authorized(), timeout=4):
        raise ConnectionError(f"session '{account_id}' not authorized (expired/revoked)")


def _session_health_from_sqlite(account_id: str) -> Optional[str]:
    db_path = os.path.join(SESSION_DIR, f"{account_id}.session")
    if not os.path.isfile(db_path):
        return "session file missing"
    try:
        conn = sqlite3.connect(db_path, timeout=2)
        cur = conn.cursor()
        rows = cur.execute("SELECT dc_id, auth_key FROM sessions LIMIT 1").fetchall()
        conn.close()
        if not rows:
            return "session DB empty (no auth_key)"
        dc_id, auth_key = rows[0]
        if not auth_key or (isinstance(auth_key, bytes) and len(auth_key) < 256):
            return "auth_key missing or truncated"
        if dc_id is None or dc_id == 0:
            return "dc_id invalid"
        return None
    except Exception as e:
        return f"session DB read error: {e!s}"


# --- _get_client: main entry point for multi-account ---

_default_client_authorized: Optional[bool] = None

async def _get_client(account_id: Optional[str] = None) -> TelegramClient:
    global _default_client_authorized
    if account_id is None or account_id not in MULTI_ACCOUNT_CLIENTS:
        if _default_client_authorized is None:
            try:
                if client.is_connected():
                    _default_client_authorized = await asyncio.wait_for(
                        client.is_user_authorized(), timeout=3
                    )
                else:
                    _default_client_authorized = False
            except Exception:
                _default_client_authorized = False

        if _default_client_authorized:
            return client

        if account_id is not None and account_id not in MULTI_ACCOUNT_CLIENTS:
            raise ValueError(f"Account '{account_id}' not found in session pool.")

        for aid in sorted(MULTI_ACCOUNT_CLIENTS.keys()):
            if aid not in _failed_accounts:
                account_id = aid
                break

        if account_id is None:
            raise ValueError(
                "Default session not authorized and no working accounts in pool. "
                "Use authorize_send_code or add_session_string to add an account."
            )

    if account_id in _failed_accounts:
        raise ValueError(
            f"Session '{account_id}' invalid or expired (cached). "
            f"Use clear_failed_accounts to retry."
        )

    await _smooth_wait(account_id)

    c = MULTI_ACCOUNT_CLIENTS[account_id]
    if account_id in _started_accounts:
        if c.is_connected():
            return c
        _started_accounts.discard(account_id)

    try:
        await _safe_start(c, START_SESSION_TIMEOUT, account_id)
        _started_accounts.add(account_id)
        return c
    except Exception as e:
        if _is_fatal_error(e):
            _failed_accounts.add(account_id)

        try:
            c = _create_session_client(account_id)
            MULTI_ACCOUNT_CLIENTS[account_id] = c
            await _safe_start(c, START_SESSION_TIMEOUT, account_id)
            _started_accounts.add(account_id)
            return c
        except Exception as e2:
            if _is_fatal_error(e2):
                _failed_accounts.add(account_id)
            raise ValueError(f"Session '{account_id}' failed: {e2!s}")


def _reload_account_client(name: str) -> None:
    old = MULTI_ACCOUNT_CLIENTS.get(name)
    if old:
        loop = asyncio.get_event_loop()
        loop.create_task(_safe_disconnect(old, timeout=3))
    _started_accounts.discard(name)
    _failed_accounts.discard(name)
    cfg = _load_session_config(name)
    _session_configs[name] = cfg
    MULTI_ACCOUNT_CLIENTS[name] = _create_session_client(name)


def _format_me(me) -> str:
    fn = getattr(me, "first_name", "") or ""
    ln = getattr(me, "last_name", "") or ""
    un = getattr(me, "username", "") or ""
    return f"ok: {me.id} {fn} {ln} @{un}".strip()


# --- Load proxies.json ---

_proxies_json_path = os.path.join(SESSION_DIR, "proxies.json")
if os.path.isfile(_proxies_json_path):
    try:
        with open(_proxies_json_path, "r", encoding="utf-8") as _f:
            _proxies_config = json.load(_f)
    except Exception:
        pass


# --- Scan configured session directory, create clients ---

if os.path.isdir(SESSION_DIR):
    for _f_name in sorted(os.listdir(SESSION_DIR)):
        if _f_name.endswith(".session"):
            _name = _f_name[:-8]
            _session_configs[_name] = _load_session_config(_name)
            MULTI_ACCOUNT_CLIENTS[_name] = _create_session_client(_name)


# ---------------------------------------------------------------------------
# Multi-account MCP tools
# ---------------------------------------------------------------------------

@mcp.tool(
    annotations=ToolAnnotations(title="List Accounts", openWorldHint=True, readOnlyHint=True)
)
async def list_accounts() -> str:
    """
    List all available Telegram accounts (sessions) with status and proxy info.
    """
    session_ids = sorted(MULTI_ACCOUNT_CLIENTS.keys())
    if not session_ids:
        return f"No multi-account sessions found in {SESSION_DIR}."
    lines = [f"Found {len(session_ids)} account(s):", ""]
    lines.append(f"{'ID':<25} {'Status':<12} {'Proxy':<30}")
    lines.append("-" * 70)
    for aid in session_ids:
        proxy = _resolve_proxy(aid)
        proxy_str = _proxy_display(proxy)
        if not proxy or not proxy.get("host"):
            proxy_str += " WARNING"
        if aid in _failed_accounts:
            status = "FAILED"
        elif aid in _started_accounts:
            status = "started"
        else:
            status = "idle"
        lines.append(f"{aid:<25} {status:<12} {proxy_str:<30}")
    return "\n".join(lines)


@mcp.tool(
    annotations=ToolAnnotations(title="Check Account", openWorldHint=True, readOnlyHint=True)
)
async def check_account(account_id: str) -> str:
    """
    Check if a specific account session is valid and can connect.
    Uses disposable client with aggressive timeouts.
    Args:
        account_id: Session name from list_accounts.
    """
    if account_id not in MULTI_ACCOUNT_CLIENTS:
        return f"error: account '{account_id}' not found"

    await _smooth_wait(account_id)

    if account_id in _started_accounts:
        c = MULTI_ACCOUNT_CLIENTS[account_id]
        if c.is_connected():
            try:
                me = await asyncio.wait_for(c.get_me(), timeout=5)
                if me:
                    proxy = _resolve_proxy(account_id)
                    proxy_str = _proxy_display(proxy)
                    return f"{_format_me(me)} | proxy: {proxy_str}"
            except Exception:
                _started_accounts.discard(account_id)

    health = _session_health_from_sqlite(account_id)
    if health:
        return f"error: {health}"

    cfg = _session_configs.get(account_id, {})
    api_id, api_hash = _resolve_api_credentials(cfg)

    proxy = _resolve_proxy(account_id)
    if proxy and proxy.get("host"):
        reachable = await _test_proxy_reachable(proxy, timeout=4)
        if not reachable:
            return f"error: proxy unreachable ({proxy['host']}:{proxy.get('port', '?')})"

    tmp = _create_session_client(account_id)
    try:
        await asyncio.wait_for(tmp.connect(), timeout=6)
        auth = await asyncio.wait_for(tmp.is_user_authorized(), timeout=4)
        if not auth:
            await _safe_disconnect(tmp)
            return f"error: session not authorized (expired/revoked) [api_id={api_id}]"
        me = await asyncio.wait_for(tmp.get_me(), timeout=5)
        if not me:
            await _safe_disconnect(tmp)
            return f"error: get_me returned None [api_id={api_id}]"

        old = MULTI_ACCOUNT_CLIENTS.get(account_id)
        if old and old is not tmp:
            await _safe_disconnect(old)
        MULTI_ACCOUNT_CLIENTS[account_id] = tmp
        _started_accounts.add(account_id)
        _failed_accounts.discard(account_id)
        proxy_str = _proxy_display(proxy)
        return f"{_format_me(me)} | proxy: {proxy_str}"
    except asyncio.TimeoutError:
        await _safe_disconnect(tmp)
        return f"error: connect/auth timeout [api_id={api_id}]"
    except Exception as e:
        await _safe_disconnect(tmp)
        if _is_fatal_error(e):
            _failed_accounts.add(account_id)
        return f"error: {e!s} [api_id={api_id}]"


async def _check_account_for_table(aid: str) -> Dict[str, str]:
    try:
        result = await asyncio.wait_for(check_account(aid), timeout=20)
    except asyncio.TimeoutError:
        result = "error: overall timeout"
    except Exception as e:
        result = f"error: {e!s}"
    status = "ok" if result.startswith("ok:") else "FAIL"
    return {"id": aid, "status": status, "detail": result}


@mcp.tool(
    annotations=ToolAnnotations(title="Check All Accounts", openWorldHint=True, readOnlyHint=True)
)
async def check_all_accounts() -> str:
    """
    Check ALL accounts one by one with smooth delays. Returns a table.
    Safe: each account has its own timeout, one bad account won't block the rest.
    """
    results = []
    all_ids = sorted(MULTI_ACCOUNT_CLIENTS.keys())
    delay = _smooth_config.get("delay_between_accounts", 8)
    max_parallel = max(1, int(_smooth_config.get("max_parallel", 1) or 1))

    batches = _chunked(all_ids, max_parallel)
    for i, batch in enumerate(batches):
        results.extend(await asyncio.gather(*[_check_account_for_table(aid) for aid in batch]))
        if i < len(batches) - 1 and _smooth_config.get("enabled", True):
            await asyncio.sleep(delay)

    ok_count = sum(1 for r in results if r["status"] == "ok")
    fail_count = len(results) - ok_count
    lines = [f"Checked {len(results)} accounts: {ok_count} OK, {fail_count} FAIL", ""]
    lines.append(f"{'ID':<25} {'Status':<6} {'Detail'}")
    lines.append("-" * 80)
    for r in results:
        lines.append(f"{r['id']:<25} {r['status']:<6} {r['detail']}")
    return "\n".join(lines)


@mcp.tool(
    annotations=ToolAnnotations(title="Clear Failed Accounts", openWorldHint=True, destructiveHint=True)
)
async def clear_failed_accounts() -> str:
    """Clear the cache of failed accounts so they can be retried."""
    count = len(_failed_accounts)
    _failed_accounts.clear()
    return f"Cleared {count} failed account(s). They will be retried on next use."


@mcp.tool(
    annotations=ToolAnnotations(title="Delete Session", openWorldHint=True, destructiveHint=True)
)
async def delete_session(account_id: str) -> str:
    """
    Delete a session file and remove the account from memory. No MCP restart needed.
    Args:
        account_id: Session name to delete.
    """
    if account_id not in MULTI_ACCOUNT_CLIENTS:
        return f"Account '{account_id}' not found."

    c = MULTI_ACCOUNT_CLIENTS.pop(account_id, None)
    _started_accounts.discard(account_id)
    _failed_accounts.discard(account_id)
    _session_configs.pop(account_id, None)

    if c:
        await _safe_disconnect(c, timeout=5)

    import gc
    gc.collect()
    await asyncio.sleep(0.3)

    deleted = []
    for ext in (".session", ".session-journal", ".json"):
        fp = os.path.join(SESSION_DIR, f"{account_id}{ext}")
        if os.path.isfile(fp):
            for attempt in range(5):
                try:
                    os.remove(fp)
                    deleted.append(os.path.basename(fp))
                    break
                except PermissionError:
                    gc.collect()
                    await asyncio.sleep(0.5 * (attempt + 1))
                except Exception as e:
                    return f"Error deleting {fp}: {e}"

    if deleted:
        return f"Deleted: {', '.join(deleted)}. Account '{account_id}' removed."
    return f"Account '{account_id}' removed from memory (no files found to delete)."


# ---------------------------------------------------------------------------
# Session authorization tools (add new accounts without MCP restart)
# ---------------------------------------------------------------------------

_pending_auth: Dict[str, Dict[str, Any]] = {}


@mcp.tool(
    annotations=ToolAnnotations(title="Authorize Session - Send Code", openWorldHint=True, destructiveHint=True)
)
async def authorize_send_code(
    phone: str,
    session_name: Optional[str] = None,
    api_id: Optional[int] = None,
    api_hash: Optional[str] = None,
) -> str:
    """
    Step 1 of adding a new account: send auth code to the phone number.
    After calling this, use authorize_complete with the code received via SMS/Telegram.
    Args:
        phone: Phone number in international format (e.g. +79001234567).
        session_name: Name for the session file (default: derived from phone).
        api_id: Telegram API ID (default: from .env).
        api_hash: Telegram API Hash (default: from .env).
    """
    name = session_name or phone.lstrip("+").replace("-", "").replace(" ", "")
    aid = api_id or TELEGRAM_API_ID
    ahash = api_hash or TELEGRAM_API_HASH

    session_path = os.path.join(SESSION_DIR, name)
    tmp = TelegramClient(session_path, aid, ahash, timeout=10, connection_retries=2)

    try:
        await tmp.connect()
        if await tmp.is_user_authorized():
            me = await tmp.get_me()
            MULTI_ACCOUNT_CLIENTS[name] = tmp
            _session_configs[name] = _load_session_config(name)
            _started_accounts.add(name)
            display = f"{me.first_name or ''} {me.last_name or ''}".strip() or str(me.id)
            return f"Account '{name}' is already authorized as {display} (id={me.id}). Added to pool."

        sent = await tmp.send_code_request(phone)
        _pending_auth[name] = {
            "client": tmp,
            "phone": phone,
            "phone_code_hash": sent.phone_code_hash,
            "api_id": aid,
            "api_hash": ahash,
        }
        return (
            f"Code sent to {phone}. Session name: '{name}'.\n"
            f"Now call authorize_complete(session_name='{name}', code=<the code you received>)."
        )
    except Exception as e:
        await _safe_disconnect(tmp)
        return f"Error sending code to {phone}: {e}"


@mcp.tool(
    annotations=ToolAnnotations(title="Authorize Session - Complete", openWorldHint=True, destructiveHint=True)
)
async def authorize_complete(
    session_name: str,
    code: str,
    password: Optional[str] = None,
) -> str:
    """
    Step 2: complete authorization with the code (and optional 2FA password).
    Args:
        session_name: Session name from authorize_send_code response.
        code: The auth code received via SMS or Telegram.
        password: 2FA password if enabled on the account.
    """
    pending = _pending_auth.pop(session_name, None)
    if not pending:
        return (
            f"No pending authorization for '{session_name}'. "
            "Call authorize_send_code first."
        )

    tmp: TelegramClient = pending["client"]
    phone = pending["phone"]
    phone_code_hash = pending["phone_code_hash"]

    try:
        if not tmp.is_connected():
            await tmp.connect()

        try:
            await tmp.sign_in(phone=phone, code=code, phone_code_hash=phone_code_hash)
        except Exception as sign_err:
            err_name = type(sign_err).__name__
            if "SessionPasswordNeededError" in err_name or "Two-steps" in str(sign_err):
                if not password:
                    _pending_auth[session_name] = pending
                    return (
                        "2FA password required. Call authorize_complete again with the password parameter.\n"
                        f"authorize_complete(session_name='{session_name}', code='{code}', password='your_2fa_password')"
                    )
                await tmp.sign_in(password=password)
            else:
                raise

        me = await tmp.get_me()
        if not me:
            await _safe_disconnect(tmp)
            return "Authorization failed: get_me returned None."

        MULTI_ACCOUNT_CLIENTS[session_name] = tmp
        _session_configs[session_name] = _load_session_config(session_name)
        _started_accounts.add(session_name)
        _failed_accounts.discard(session_name)

        cfg = _load_session_config(session_name)
        cfg["id"] = me.id
        cfg["phone"] = phone
        cfg["username"] = me.username
        cfg["first_name"] = me.first_name or ""
        cfg["last_name"] = me.last_name or ""
        if not cfg.get("app_id"):
            cfg["app_id"] = pending["api_id"]
            cfg["app_hash"] = pending["api_hash"]
        _save_session_config(session_name, cfg)
        _session_configs[session_name] = cfg

        display = f"{me.first_name or ''} {me.last_name or ''}".strip() or str(me.id)
        return (
            f"Authorized as {display} (id={me.id}, @{me.username or 'N/A'}).\n"
            f"Session '{session_name}' saved and added to active pool."
        )
    except Exception as e:
        await _safe_disconnect(tmp)
        return f"Authorization failed: {e}"


@mcp.tool(
    annotations=ToolAnnotations(title="Add Session String", openWorldHint=True, destructiveHint=True)
)
async def add_session_string(
    session_string: str,
    session_name: Optional[str] = None,
    api_id: Optional[int] = None,
    api_hash: Optional[str] = None,
) -> str:
    """
    Add an account using a Telethon session string (no phone/code needed).
    The string session is converted to a file-based session in TELEGRAM_MCP_SESSION_DIR.
    Args:
        session_string: Telethon session string (from session_string_generator.py or similar).
        session_name: Name for the session (default: auto-generated from user id).
        api_id: Telegram API ID (default: from .env).
        api_hash: Telegram API Hash (default: from .env).
    """
    aid = api_id or TELEGRAM_API_ID
    ahash = api_hash or TELEGRAM_API_HASH

    tmp = TelegramClient(StringSession(session_string), aid, ahash, timeout=10, connection_retries=2)
    try:
        await tmp.connect()
        if not await tmp.is_user_authorized():
            await _safe_disconnect(tmp)
            return "Error: session string is not authorized (expired or invalid)."

        me = await tmp.get_me()
        if not me:
            await _safe_disconnect(tmp)
            return "Error: get_me returned None."

        name = session_name or str(me.id)
        session_path = os.path.join(SESSION_DIR, name)

        file_client = TelegramClient(session_path, aid, ahash, timeout=10)
        file_client.session.set_dc(tmp.session.dc_id, tmp.session.server_address, tmp.session.port)
        file_client.session.auth_key = tmp.session.auth_key
        file_client.session.save()

        await _safe_disconnect(tmp)

        MULTI_ACCOUNT_CLIENTS[name] = file_client
        _session_configs[name] = _load_session_config(name)
        _started_accounts.discard(name)
        _failed_accounts.discard(name)

        cfg = _load_session_config(name)
        cfg["id"] = me.id
        cfg["phone"] = me.phone
        cfg["username"] = me.username
        cfg["first_name"] = me.first_name or ""
        cfg["last_name"] = me.last_name or ""
        cfg["app_id"] = aid
        cfg["app_hash"] = ahash
        _save_session_config(name, cfg)
        _session_configs[name] = cfg

        display = f"{me.first_name or ''} {me.last_name or ''}".strip() or str(me.id)
        return (
            f"Added account '{name}': {display} (id={me.id}, @{me.username or 'N/A'}).\n"
            f"Session file saved to {session_path}.session"
        )
    except Exception as e:
        await _safe_disconnect(tmp)
        return f"Error adding session string: {e}"


@mcp.tool(
    annotations=ToolAnnotations(title="Set Account Proxy", openWorldHint=True, destructiveHint=True)
)
def set_account_proxy(
    account_id: str,
    proxy_type: str,
    host: str,
    port: int,
    secret: Optional[str] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
) -> str:
    """
    Set proxy for an account. Client is hot-reloaded immediately.
    Args:
        account_id: Session name.
        proxy_type: mtproto, socks5, http.
        host: Proxy host.
        port: Proxy port.
        secret: MTProto secret (hex string).
        username: Auth username (socks5/http).
        password: Auth password (socks5/http).
    """
    if account_id not in MULTI_ACCOUNT_CLIENTS:
        return f"Account '{account_id}' not found."
    cfg = _load_session_config(account_id)
    p: Dict[str, Any] = {"type": proxy_type, "host": host, "port": port}
    if secret:
        p["secret"] = secret
    if username:
        p["username"] = username
    if password:
        p["password"] = password
    cfg["proxy"] = p
    _save_session_config(account_id, cfg)
    _session_configs[account_id] = cfg
    _reload_account_client(account_id)
    return f"Proxy set for '{account_id}': {_proxy_display(p)}. Client reloaded."


@mcp.tool(
    annotations=ToolAnnotations(title="Get Account Proxy", openWorldHint=True, readOnlyHint=True)
)
def get_account_proxy(account_id: str) -> str:
    """Show current proxy for an account."""
    if account_id not in MULTI_ACCOUNT_CLIENTS:
        return f"Account '{account_id}' not found."
    proxy = _resolve_proxy(account_id)
    return _proxy_display(proxy)


@mcp.tool(
    annotations=ToolAnnotations(title="Remove Account Proxy", openWorldHint=True, destructiveHint=True)
)
def remove_account_proxy(account_id: str) -> str:
    """Remove proxy from an account (will connect directly). Client is hot-reloaded."""
    if account_id not in MULTI_ACCOUNT_CLIENTS:
        return f"Account '{account_id}' not found."
    cfg = _load_session_config(account_id)
    cfg.pop("proxy", None)
    _save_session_config(account_id, cfg)
    _session_configs[account_id] = cfg
    _reload_account_client(account_id)
    return f"Proxy removed for '{account_id}'. WARNING: direct connection exposes your IP."


@mcp.tool(
    annotations=ToolAnnotations(title="Set Smooth Mode", openWorldHint=True, destructiveHint=True)
)
def set_smooth_mode(
    enabled: Optional[bool] = None,
    delay: Optional[int] = None,
    between_accounts: Optional[int] = None,
    max_parallel: Optional[int] = None,
) -> str:
    """
    Configure smooth mode (rate limiting between Telegram API calls).
    Args:
        enabled: Enable/disable smooth mode.
        delay: Seconds between requests for one account (default 8).
        between_accounts: Seconds between accounts in mass ops (default 8).
        max_parallel: Max parallel accounts (default 1 = sequential).
    """
    if enabled is not None:
        _smooth_config["enabled"] = enabled
    if delay is not None:
        _smooth_config["delay_between_requests"] = max(0, delay)
    if between_accounts is not None:
        _smooth_config["delay_between_accounts"] = max(0, between_accounts)
    if max_parallel is not None:
        _smooth_config["max_parallel"] = max(1, max_parallel)
    _save_smooth_config()
    return (
        f"Smooth mode: {'ON' if _smooth_config['enabled'] else 'OFF'}\n"
        f"  delay_between_requests: {_smooth_config['delay_between_requests']}s\n"
        f"  delay_between_accounts: {_smooth_config['delay_between_accounts']}s\n"
        f"  max_parallel: {_smooth_config['max_parallel']}"
    )


@mcp.tool(
    annotations=ToolAnnotations(title="Get Smooth Mode", openWorldHint=True, readOnlyHint=True)
)
def get_smooth_mode() -> str:
    """Show current smooth mode configuration."""
    return (
        f"Smooth mode: {'ON' if _smooth_config['enabled'] else 'OFF'}\n"
        f"  delay_between_requests: {_smooth_config['delay_between_requests']}s\n"
        f"  delay_between_accounts: {_smooth_config['delay_between_accounts']}s\n"
        f"  max_parallel: {_smooth_config['max_parallel']}"
    )


@mcp.tool(
    annotations=ToolAnnotations(title="Operator Config", openWorldHint=False, readOnlyHint=True)
)
def operator_get_config() -> str:
    """
    Show shared operator configuration used by the MCP agent and web console.
    """
    try:
        return _json(
            {
                "ok": True,
                "path": str(oc.config_path()),
                "config": oc.load_config(),
            }
        )
    except Exception as e:
        return log_and_format_error("operator_get_config", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Set Operator Config", openWorldHint=False, destructiveHint=True)
)
def operator_set_config(config_json: str, merge: bool = True) -> str:
    """
    Update shared operator configuration from the MCP agent.

    Args:
        config_json: JSON object. Pass only fields to change when merge=True.
        merge: Merge patch into current config, or replace with defaults + JSON.
    """
    try:
        patch = json.loads(config_json)
        if not isinstance(patch, dict):
            raise ValueError("config_json must be a JSON object")
        config = oc.update_config(patch, merge=merge)
        return _json({"ok": True, "path": str(oc.config_path()), "config": config})
    except Exception as e:
        return log_and_format_error("operator_set_config", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Reset Operator Config", openWorldHint=False, destructiveHint=True)
)
def operator_reset_config() -> str:
    """Reset shared operator configuration to safe defaults."""
    try:
        config = oc.reset_config()
        return _json({"ok": True, "path": str(oc.config_path()), "config": config})
    except Exception as e:
        return log_and_format_error("operator_reset_config", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Stat Report Templates", openWorldHint=False, readOnlyHint=True)
)
def stat_report_templates() -> str:
    """
    Show synthetic Telegram statistics report templates and example payloads.

    All rendered outputs include a visible DEMO watermark.
    """
    try:
        return _json({"ok": True, **sr.templates_payload()})
    except Exception as e:
        return log_and_format_error("stat_report_templates", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Render Stat Report", openWorldHint=False, destructiveHint=False)
)
def stat_report_render(
    report_json: str,
    output_dir: Optional[str] = None,
    output_name: Optional[str] = None,
) -> str:
    """
    Render a synthetic Telegram statistics report as HTML and PNG.

    Args:
        report_json: JSON object with template, channel, chart, and metric fields.
        output_dir: Optional local output directory. Defaults to data/stat_reports.
        output_name: Optional file base name without extension.
    """
    try:
        payload = json.loads(report_json)
        if not isinstance(payload, dict):
            raise ValueError("report_json must be a JSON object")
        result = sr.render_stat_report(
            payload,
            output_dir=output_dir,
            output_name=output_name,
        )
        return _json(result)
    except Exception as e:
        return log_and_format_error("stat_report_render", e)


@mcp.tool(
    annotations=ToolAnnotations(title="VPromotions Config", openWorldHint=False, readOnlyHint=True)
)
def vpromotions_config_status() -> str:
    """
    Show VPromotions API configuration status without exposing the API key.
    """
    try:
        return _json({"ok": True, **vp.config_status()})
    except Exception as e:
        return log_and_format_error("vpromotions_config_status", e)


@mcp.tool(
    annotations=ToolAnnotations(title="VPromotions Balance", openWorldHint=True, readOnlyHint=True)
)
async def vpromotions_balance() -> str:
    """
    Read VPromotions account balance.
    """
    try:
        return _json({"ok": True, "balance": await vp.VPromotionsClient().balance()})
    except Exception as e:
        return log_and_format_error("vpromotions_balance", e)


@mcp.tool(
    annotations=ToolAnnotations(title="VPromotions Services", openWorldHint=True, readOnlyHint=True)
)
async def vpromotions_services(
    search: str = "",
    category: str = "",
    service_type: str = "",
    limit: int = 50,
) -> str:
    """
    List and filter VPromotions services.

    Args:
        search: Case-insensitive text filter over name, category, and type.
        category: Optional category substring filter.
        service_type: Optional service type substring filter, e.g. Default, Poll.
        limit: Maximum returned services. Use 0 to return all filtered services.
    """
    try:
        services = await vp.VPromotionsClient().services()
        filtered = vp.filter_services(
            services,
            search=search,
            category=category,
            service_type=service_type,
            limit=max(0, limit),
        )
        return _json(
            {
                "ok": True,
                "total": len(services),
                "returned": len(filtered),
                "filters": {
                    "search": search,
                    "category": category,
                    "service_type": service_type,
                    "limit": limit,
                },
                "services": filtered,
            }
        )
    except Exception as e:
        return log_and_format_error("vpromotions_services", e)


@mcp.tool(
    annotations=ToolAnnotations(title="VPromotions Add Order", openWorldHint=True, destructiveHint=True)
)
async def vpromotions_add_order(
    service: int,
    link: Optional[str] = None,
    quantity: Optional[int] = None,
    runs: Optional[int] = None,
    interval: Optional[int] = None,
    comments: Optional[str] = None,
    username: Optional[str] = None,
    min_quantity: Optional[int] = None,
    max_quantity: Optional[int] = None,
    posts: Optional[int] = None,
    delay: Optional[int] = None,
    expiry: Optional[str] = None,
    answer_number: Optional[int] = None,
    extra_json: Optional[str] = None,
    confirm: bool = False,
) -> str:
    """
    Preview or create a VPromotions order.

    Supported order shapes from the provider docs/screens:
    Default: service, link, quantity, optional runs/interval.
    Package: service, link.
    Custom Comments: service, link, comments separated by newlines.
    Poll: service, link, quantity, answer_number.
    Subscriptions: service, username, min_quantity, max_quantity, posts, delay, expiry.

    Args:
        confirm: When false, only returns the payload preview. Set true only after
            explicit human approval because this can spend account balance.
        extra_json: Optional JSON object for provider-specific fields not modeled above.
    """
    try:
        payload = vp.build_add_order_payload(
            service=service,
            link=link,
            quantity=quantity,
            runs=runs,
            interval=interval,
            comments=comments,
            username=username,
            min_quantity=min_quantity,
            max_quantity=max_quantity,
            posts=posts,
            delay=delay,
            expiry=expiry,
            answer_number=answer_number,
            extra_json=extra_json,
        )
        if not confirm:
            return _json(
                {
                    "ok": True,
                    "preview": True,
                    "action": "add",
                    "payload": payload,
                    "next_step": "Call again with confirm=true only after explicit approval.",
                }
            )
        result = await vp.VPromotionsClient().add_order(
            service=service,
            link=link,
            quantity=quantity,
            runs=runs,
            interval=interval,
            comments=comments,
            username=username,
            min_quantity=min_quantity,
            max_quantity=max_quantity,
            posts=posts,
            delay=delay,
            expiry=expiry,
            answer_number=answer_number,
            extra_json=extra_json,
        )
        return _json({"ok": True, "order": result})
    except Exception as e:
        return log_and_format_error("vpromotions_add_order", e)


@mcp.tool(
    annotations=ToolAnnotations(title="VPromotions Order Status", openWorldHint=True, readOnlyHint=True)
)
async def vpromotions_order_status(
    order_id: Optional[int] = None,
    order_ids: Optional[str] = None,
) -> str:
    """
    Get one or multiple VPromotions order statuses.

    Args:
        order_id: Single order ID.
        order_ids: Comma-separated order IDs for batch status.
    """
    try:
        client = vp.VPromotionsClient()
        if order_ids:
            result = await client.orders_status(order_ids)
            return _json({"ok": True, "orders": result})
        if not order_id:
            raise ValueError("order_id or order_ids is required")
        result = await client.order_status(order_id)
        return _json({"ok": True, "order_id": order_id, "status": result})
    except Exception as e:
        return log_and_format_error("vpromotions_order_status", e)


@mcp.tool(
    annotations=ToolAnnotations(title="VPromotions Create Refill", openWorldHint=True, destructiveHint=True)
)
async def vpromotions_create_refill(order_id: int, confirm: bool = False) -> str:
    """
    Create a refill request for an order.

    Args:
        confirm: When false, returns a preview. Set true only after explicit approval.
    """
    try:
        if not confirm:
            return _json(
                {
                    "ok": True,
                    "preview": True,
                    "action": "refill",
                    "payload": {"order": order_id},
                    "next_step": "Call again with confirm=true only after explicit approval.",
                }
            )
        return _json({"ok": True, "refill": await vp.VPromotionsClient().refill(order_id)})
    except Exception as e:
        return log_and_format_error("vpromotions_create_refill", e)


@mcp.tool(
    annotations=ToolAnnotations(title="VPromotions Refill Status", openWorldHint=True, readOnlyHint=True)
)
async def vpromotions_refill_status(refill_id: str) -> str:
    """
    Get VPromotions refill status.
    """
    try:
        result = await vp.VPromotionsClient().refill_status(refill_id)
        return _json({"ok": True, "refill_id": refill_id, "status": result})
    except Exception as e:
        return log_and_format_error("vpromotions_refill_status", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Maton Gateway Config", openWorldHint=False, readOnlyHint=True)
)
def maton_config_status() -> str:
    """Show Maton gateway readiness without exposing its API key."""
    try:
        return _json({"ok": True, **mt.config_status()})
    except Exception as e:
        return log_and_format_error("maton_config_status", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Maton Connections", openWorldHint=True, readOnlyHint=True)
)
async def maton_connections(
    app: Optional[str] = None, status: Optional[str] = None, limit: int = 100
) -> str:
    """
    List Maton service connections without exposing authorization URLs or credentials.

    Use the returned connection_id for Maton reads and prepared write actions.
    """
    try:
        response = await mt.MatonClient().list_connections(app=app, status=status)
        connections = response.get("connections", [])
        if not isinstance(connections, list):
            raise mt.MatonAPIError("Maton connections response has invalid connections data")
        safe_connections = [mt.summarize_connection(item) for item in connections if isinstance(item, dict)]
        return _json(
            {
                "ok": True,
                "returned": len(safe_connections[: max(0, limit)]),
                "connections": safe_connections[: max(0, limit)],
            }
        )
    except Exception as e:
        return log_and_format_error("maton_connections", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Maton Connection", openWorldHint=True, readOnlyHint=True)
)
async def maton_connection_get(connection_id: str) -> str:
    """Get one Maton connection status without returning its authorization URL."""
    try:
        response = await mt.MatonClient().get_connection(connection_id)
        connection = response.get("connection", response)
        if not isinstance(connection, dict):
            raise mt.MatonAPIError("Maton connection response has invalid connection data")
        return _json({"ok": True, "connection": mt.summarize_connection(connection)})
    except Exception as e:
        return log_and_format_error("maton_connection_get", e, connection_id=connection_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Maton GET Request", openWorldHint=True, readOnlyHint=True)
)
async def maton_get(
    app: str,
    connection_id: str,
    path: str,
    headers_json: Optional[str] = None,
) -> str:
    """
    Run a read-only GET request through an explicitly selected Maton connection.

    path is relative to the selected Maton app, for example drive/v3/files for
    google-drive or v1/users/me for notion. headers_json is optional JSON for
    provider headers such as {"Notion-Version":"2025-09-03"}.
    """
    try:
        headers = mt.parse_json_object(headers_json, "headers_json")
        result = await mt.MatonClient().request(
            method="GET",
            app=app,
            connection_id=connection_id,
            path=path,
            headers=headers,
        )
        return _json({"ok": True, "app": mt.validate_app(app), "connection_id": connection_id, **result})
    except Exception as e:
        return log_and_format_error("maton_get", e, app=app, connection_id=connection_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Maton Prepare Connection", openWorldHint=True, destructiveHint=True)
)
def maton_prepare_connection(app: str, method: str = "OAUTH2") -> str:
    """
    Prepare a Maton connection for a named service.

    This does not create or authorize a connection. The user must explicitly
    confirm the pending action, then open the returned authorization URL.
    """
    try:
        app = mt.validate_app(app)
        method = str(method or "OAUTH2").upper()
        if method not in {"API_KEY", "BASIC", "OAUTH1", "OAUTH2", "MCP"}:
            raise ValueError("unsupported Maton connection method")
        with am.connect() as conn:
            action_id = am.create_pending_action(
                conn,
                action_type="maton_connection_create",
                account_id=f"maton:{app}",
                target_chat=None,
                target_label=f"Maton {app}",
                payload={"app": app, "method": method},
            )
            conn.commit()
        return _json(
            {
                "ok": True,
                "pending_action_id": action_id,
                "action_type": "maton_connection_create",
                "connection": {"app": app, "method": method},
                "next_step": "Call assistant_confirm_action only after the user confirms this service authorization.",
            }
        )
    except Exception as e:
        return log_and_format_error("maton_prepare_connection", e, app=app)


@mcp.tool(
    annotations=ToolAnnotations(title="Maton Prepare Request", openWorldHint=True, destructiveHint=True)
)
def maton_prepare_request(
    app: str,
    connection_id: str,
    method: str,
    path: str,
    summary: str,
    body_json: Optional[str] = None,
    headers_json: Optional[str] = None,
) -> str:
    """
    Prepare a Maton POST, PUT, PATCH, or DELETE request for confirmation.

    The complete app, connection, relative route, headers, body, and expected
    outcome are kept in the pending action. GET must use maton_get instead.
    """
    try:
        app = mt.validate_app(app)
        connection_id = mt.validate_connection_id(connection_id)
        path = mt.validate_route_path(path)
        method = str(method or "").upper()
        if method not in {"POST", "PUT", "PATCH", "DELETE"}:
            raise ValueError("method must be POST, PUT, PATCH, or DELETE; use maton_get for reads")
        summary = str(summary or "").strip()
        if not summary:
            raise ValueError("summary is required so the user can review the expected outcome")
        body = mt.parse_json_object(body_json, "body_json")
        headers = mt.validate_custom_headers(mt.parse_json_object(headers_json, "headers_json"))
        with am.connect() as conn:
            action_id = am.create_pending_action(
                conn,
                action_type="maton_request",
                account_id=f"maton:{connection_id}",
                target_chat=None,
                target_label=f"Maton {app} / {connection_id}",
                payload={
                    "app": app,
                    "connection_id": connection_id,
                    "method": method,
                    "path": path,
                    "summary": summary,
                    "body": body,
                    "headers": headers,
                },
            )
            conn.commit()
        return _json(
            {
                "ok": True,
                "pending_action_id": action_id,
                "action_type": "maton_request",
                "request": {
                    "app": app,
                    "connection_id": connection_id,
                    "method": method,
                    "path": path,
                    "headers": headers,
                    "body": body,
                    "expected_outcome": summary,
                },
                "next_step": "Call assistant_confirm_action only after explicit human approval of this exact request.",
            }
        )
    except Exception as e:
        return log_and_format_error("maton_prepare_request", e, app=app, connection_id=connection_id)


# ---------------------------------------------------------------------------
# End of multi-account block. Proxy pool tools below.
# ---------------------------------------------------------------------------


def _collect_proxy_pool() -> list:
    """Gather unique proxies currently assigned to any account."""
    seen: Dict[str, Dict[str, Any]] = {}
    for name in MULTI_ACCOUNT_CLIENTS:
        p = _resolve_proxy(name)
        if p and p.get("host"):
            key = f"{p.get('type','?')}|{p['host']}|{p.get('port','?')}"
            if key not in seen:
                seen[key] = dict(p)
    dp = _proxies_config.get("default_proxy")
    if dp and dp.get("host"):
        key = f"{dp.get('type','?')}|{dp['host']}|{dp.get('port','?')}"
        if key not in seen:
            seen[key] = dict(dp)
    return list(seen.values())


@mcp.tool(
    annotations=ToolAnnotations(title="Rotate Proxies", openWorldHint=True, destructiveHint=True)
)
def rotate_proxies(
    account_id: Optional[str] = None,
    direction: Optional[str] = "next",
) -> str:
    """
    Rotate proxies for accounts. Each account shifts to the next (or previous)
    proxy in the pool of all currently used proxies.

    - Without account_id: rotates ALL accounts at once.
    - With account_id: rotates only that one account.
    - direction: 'next' (default) or 'prev' — shift direction in the pool.

    The proxy pool is auto-detected from all proxies assigned to accounts.
    After rotation, clients are hot-reloaded (no MCP restart needed).

    Args:
        account_id: Rotate only this account (omit for all).
        direction: 'next' or 'prev' — rotation direction.
    """
    pool = _collect_proxy_pool()
    if len(pool) < 2:
        return f"Need at least 2 distinct proxies in the pool to rotate (found {len(pool)})."

    step = 1 if direction != "prev" else -1
    pool_keys = [f"{p.get('type','?')}|{p['host']}|{p.get('port','?')}" for p in pool]

    targets = [account_id] if account_id else sorted(MULTI_ACCOUNT_CLIENTS.keys())
    rotated = 0

    for name in targets:
        current = _resolve_proxy(name)
        if not current or not current.get("host"):
            continue
        cur_key = f"{current.get('type','?')}|{current['host']}|{current.get('port','?')}"
        if cur_key not in pool_keys:
            continue
        idx = pool_keys.index(cur_key)
        new_idx = (idx + step) % len(pool)
        new_proxy = pool[new_idx]

        cfg = _load_session_config(name)
        cfg["proxy"] = new_proxy
        _save_session_config(name, cfg)
        _session_configs[name] = cfg
        _reload_account_client(name)
        rotated += 1

    return (
        f"Rotated {rotated} account(s) ({direction}).\n"
        f"Proxy pool ({len(pool)}): " + ", ".join(p["host"] + ":" + str(p["port"]) for p in pool)
    )


@mcp.tool(
    annotations=ToolAnnotations(title="Show Proxy Pool", openWorldHint=True, readOnlyHint=True)
)
def show_proxy_pool() -> str:
    """
    Show the pool of distinct proxies currently in use across all accounts.
    This is the pool used by rotate_proxies.
    """
    pool = _collect_proxy_pool()
    if not pool:
        return "No proxies assigned to any account."
    lines = [f"Proxy pool ({len(pool)} unique proxies):", ""]
    for i, p in enumerate(pool):
        lines.append(f"  [{i+1}] {_proxy_display(p)}")

    accts_per_proxy: Dict[str, int] = {}
    for name in MULTI_ACCOUNT_CLIENTS:
        r = _resolve_proxy(name)
        if r and r.get("host"):
            key = f"{r['host']}:{r.get('port','?')}"
            accts_per_proxy[key] = accts_per_proxy.get(key, 0) + 1

    lines.append("")
    lines.append("Accounts per proxy:")
    for k, v in sorted(accts_per_proxy.items(), key=lambda x: -x[1]):
        lines.append(f"  {k}: {v} accounts")

    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(title="Get Chats", openWorldHint=True, readOnlyHint=True))
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def get_chats(page: int = 1, page_size: int = 20, account_id: Optional[str] = None) -> str:
    """
    Get a paginated list of chats.
    Args:
        page: Page number (1-indexed).
        page_size: Number of chats per page.
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        dialogs = await c.get_dialogs()
        start = (page - 1) * page_size
        end = start + page_size
        if start >= len(dialogs):
            return "Page out of range."
        chats = dialogs[start:end]
        lines = []
        for dialog in chats:
            entity = dialog.entity
            chat_id = entity.id
            title = getattr(entity, "title", None) or getattr(entity, "first_name", "Unknown")
            lines.append(f"Chat ID: {chat_id}, Title: {title}")
        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error("get_chats", e)


@mcp.tool(annotations=ToolAnnotations(title="Get Messages", openWorldHint=True, readOnlyHint=True))
@validate_id("chat_id")
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def get_messages(chat_id: Union[int, str], page: int = 1, page_size: int = 20, account_id: Optional[str] = None) -> str:
    """
    Get paginated messages from a specific chat.
    Args:
        chat_id: The ID or username of the chat.
        page: Page number (1-indexed).
        page_size: Number of messages per page.
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        offset = (page - 1) * page_size
        messages = await c.get_messages(entity, limit=page_size, add_offset=offset)
        if not messages:
            return "No messages found for this page."
        lines = []
        for msg in messages:
            sender_name = get_sender_name(msg)
            reply_info = ""
            if msg.reply_to and msg.reply_to.reply_to_msg_id:
                reply_info = f" | reply to {msg.reply_to.reply_to_msg_id}"

            engagement_info = get_engagement_info(msg)

            lines.append(
                f"ID: {msg.id} | {sender_name} | Date: {msg.date}{reply_info}{engagement_info} | Message: {msg.message}"
            )
        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error(
            "get_messages", e, chat_id=chat_id, page=page, page_size=page_size
        )


@mcp.tool(
    annotations=ToolAnnotations(title="Send Message", openWorldHint=True, destructiveHint=True)
)
@validate_id("chat_id")
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def send_message(chat_id: Union[int, str], message: str, account_id: Optional[str] = None) -> str:
    """
    Send a message to a specific chat.
    Args:
        chat_id: The ID or username of the chat.
        message: The message content to send.
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        await _safe_call(c.send_message(entity, message))
        return "Message sent successfully."
    except Exception as e:
        return log_and_format_error("send_message", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Subscribe Public Channel",
        openWorldHint=True,
        destructiveHint=True,
        idempotentHint=True,
    )
)
@validate_id("channel")
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def subscribe_public_channel(channel: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Subscribe (join) to a public channel or supergroup by username or ID.
    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(channel)
        await _safe_call(c(functions.channels.JoinChannelRequest(channel=entity)))
        title = getattr(entity, "title", getattr(entity, "username", "Unknown channel"))
        return f"Subscribed to {title}."
    except telethon.errors.rpcerrorlist.UserAlreadyParticipantError:
        title = getattr(entity, "title", getattr(entity, "username", "this channel"))
        return f"Already subscribed to {title}."
    except telethon.errors.rpcerrorlist.ChannelPrivateError:
        return "Cannot subscribe: this channel is private or requires an invite link."
    except Exception as e:
        return log_and_format_error("subscribe_public_channel", e, channel=channel)


@mcp.tool(
    annotations=ToolAnnotations(title="List Inline Buttons", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def list_inline_buttons(
    chat_id: Union[int, str], message_id: Optional[Union[int, str]] = None, limit: int = 20, account_id: Optional[str] = None
) -> str:
    """
    Inspect inline buttons on a recent message to discover their indices/text/URLs.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        if isinstance(message_id, str):
            if message_id.isdigit():
                message_id = int(message_id)
            else:
                return "message_id must be an integer."

        entity = await c.get_entity(chat_id)
        target_message = None

        if message_id is not None:
            target_message = await c.get_messages(entity, ids=message_id)
            if isinstance(target_message, list):
                target_message = target_message[0] if target_message else None
        else:
            recent_messages = await c.get_messages(entity, limit=limit)
            target_message = next(
                (msg for msg in recent_messages if getattr(msg, "buttons", None)), None
            )

        if not target_message:
            return "No message with inline buttons found."

        buttons_attr = getattr(target_message, "buttons", None)
        if not buttons_attr:
            return f"Message {target_message.id} does not contain inline buttons."

        buttons = [btn for row in buttons_attr for btn in row]
        if not buttons:
            return f"Message {target_message.id} does not contain inline buttons."

        lines = [
            f"Buttons for message {target_message.id} (date {target_message.date}):",
        ]
        for idx, btn in enumerate(buttons):
            raw_button = getattr(btn, "button", None)
            text = getattr(btn, "text", "") or "<no text>"
            url = getattr(raw_button, "url", None) if raw_button else None
            has_callback = bool(getattr(btn, "data", None))
            parts = [f"[{idx}] text='{text}'"]
            parts.append("callback=yes" if has_callback else "callback=no")
            if url:
                parts.append(f"url={url}")
            lines.append(", ".join(parts))

        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error(
            "list_inline_buttons",
            e,
            chat_id=chat_id,
            message_id=message_id,
            limit=limit,
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Press Inline Button", openWorldHint=True, destructiveHint=True
    )
)
@validate_id("chat_id")
async def press_inline_button(
    chat_id: Union[int, str],
    message_id: Optional[Union[int, str]] = None,
    button_text: Optional[str] = None,
    button_index: Optional[int] = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Press an inline button (callback) in a chat message.

    Args:
        chat_id: Chat or bot where the inline keyboard exists.
        message_id: Specific message ID to inspect. If omitted, searches recent messages for one containing buttons.
        button_text: Exact text of the button to press (case-insensitive).
        button_index: Zero-based index among all buttons if you prefer positional access.
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        if button_text is None and button_index is None:
            return "Provide button_text or button_index to choose a button."

        # Normalize message_id if provided as a string
        if isinstance(message_id, str):
            if message_id.isdigit():
                message_id = int(message_id)
            else:
                return "message_id must be an integer."

        if isinstance(button_index, str):
            if button_index.isdigit():
                button_index = int(button_index)
            else:
                return "button_index must be an integer."

        entity = await c.get_entity(chat_id)

        target_message = None
        if message_id is not None:
            target_message = await c.get_messages(entity, ids=message_id)
            if isinstance(target_message, list):
                target_message = target_message[0] if target_message else None
        else:
            recent_messages = await c.get_messages(entity, limit=20)
            target_message = next(
                (msg for msg in recent_messages if getattr(msg, "buttons", None)), None
            )

        if not target_message:
            return "No message with inline buttons found. Specify message_id to target a specific message."

        buttons_attr = getattr(target_message, "buttons", None)
        if not buttons_attr:
            return f"Message {target_message.id} does not contain inline buttons."

        buttons = [btn for row in buttons_attr for btn in row]
        if not buttons:
            return f"Message {target_message.id} does not contain inline buttons."

        target_button = None
        if button_text:
            normalized = button_text.strip().lower()
            target_button = next(
                (
                    btn
                    for btn in buttons
                    if (getattr(btn, "text", "") or "").strip().lower() == normalized
                ),
                None,
            )

        if target_button is None and button_index is not None:
            if button_index < 0 or button_index >= len(buttons):
                return f"button_index out of range. Valid indices: 0-{len(buttons) - 1}."
            target_button = buttons[button_index]

        if not target_button:
            available = ", ".join(
                f"[{idx}] {getattr(btn, 'text', '') or '<no text>'}"
                for idx, btn in enumerate(buttons)
            )
            return f"Button not found. Available buttons: {available}"

        if not getattr(target_button, "data", None):
            raw_button = getattr(target_button, "button", None)
            url = getattr(raw_button, "url", None) if raw_button else None
            if url:
                return f"Selected button opens a URL instead of sending a callback: {url}"
            return "Selected button does not provide callback data to press."

        callback_result = await c(
            functions.messages.GetBotCallbackAnswerRequest(
                peer=entity, msg_id=target_message.id, data=target_button.data
            )
        )

        response_parts = []
        if getattr(callback_result, "message", None):
            response_parts.append(callback_result.message)
        if getattr(callback_result, "alert", None):
            response_parts.append("Telegram displayed an alert to the user.")
        if not response_parts:
            response_parts.append("Button pressed successfully.")

        return " ".join(response_parts)
    except Exception as e:
        return log_and_format_error(
            "press_inline_button",
            e,
            chat_id=chat_id,
            message_id=message_id,
            button_text=button_text,
            button_index=button_index,
        )


@mcp.tool(
    annotations=ToolAnnotations(title="List Contacts", openWorldHint=True, readOnlyHint=True)
)
async def list_contacts(account_id: Optional[str] = None) -> str:
    """
    List all contacts in your Telegram account.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.contacts.GetContactsRequest(hash=0))
        users = result.users
        if not users:
            return "No contacts found."
        lines = []
        for user in users:
            name = f"{getattr(user, 'first_name', '')} {getattr(user, 'last_name', '')}".strip()
            username = getattr(user, "username", "")
            phone = getattr(user, "phone", "")
            contact_info = f"ID: {user.id}, Name: {name}"
            if username:
                contact_info += f", Username: @{username}"
            if phone:
                contact_info += f", Phone: {phone}"
            lines.append(contact_info)
        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error("list_contacts", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Search Contacts", openWorldHint=True, readOnlyHint=True)
)
async def search_contacts(query: str, account_id: Optional[str] = None) -> str:
    """
    Search for contacts by name, username, or phone number using Telethon's SearchRequest.
    Args:
        query: The search term to look for in contact names, usernames, or phone numbers.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.contacts.SearchRequest(q=query, limit=50))
        users = result.users
        if not users:
            return f"No contacts found matching '{query}'."
        lines = []
        for user in users:
            name = f"{getattr(user, 'first_name', '')} {getattr(user, 'last_name', '')}".strip()
            username = getattr(user, "username", "")
            phone = getattr(user, "phone", "")
            contact_info = f"ID: {user.id}, Name: {name}"
            if username:
                contact_info += f", Username: @{username}"
            if phone:
                contact_info += f", Phone: {phone}"
            lines.append(contact_info)
        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error("search_contacts", e, query=query)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Contact Ids", openWorldHint=True, readOnlyHint=True)
)
async def get_contact_ids(account_id: Optional[str] = None) -> str:
    """
    Get all contact IDs in your Telegram account.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.contacts.GetContactIDsRequest(hash=0))
        if not result:
            return "No contact IDs found."
        return "Contact IDs: " + ", ".join(str(cid) for cid in result)
    except Exception as e:
        return log_and_format_error("get_contact_ids", e)


@mcp.tool(
    annotations=ToolAnnotations(title="List Messages", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def list_messages(
    chat_id: Union[int, str],
    limit: int = 20,
    search_query: str = None,
    from_date: str = None,
    to_date: str = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Retrieve messages with optional filters.

    Args:
        chat_id: The ID or username of the chat to get messages from.
        limit: Maximum number of messages to retrieve.
        search_query: Filter messages containing this text.
        from_date: Filter messages starting from this date (format: YYYY-MM-DD).
        to_date: Filter messages until this date (format: YYYY-MM-DD).
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        # Parse date filters if provided
        from_date_obj = None
        to_date_obj = None

        if from_date:
            try:
                from_date_obj = datetime.strptime(from_date, "%Y-%m-%d")
                # Make it timezone aware by adding UTC timezone info
                # Use datetime.timezone.utc for Python 3.9+ or import timezone directly for 3.13+
                try:
                    # For Python 3.9+
                    from_date_obj = from_date_obj.replace(tzinfo=datetime.timezone.utc)
                except AttributeError:
                    # For Python 3.13+
                    from datetime import timezone

                    from_date_obj = from_date_obj.replace(tzinfo=timezone.utc)
            except ValueError:
                return f"Invalid from_date format. Use YYYY-MM-DD."

        if to_date:
            try:
                to_date_obj = datetime.strptime(to_date, "%Y-%m-%d")
                # Set to end of day and make timezone aware
                to_date_obj = to_date_obj + timedelta(days=1, microseconds=-1)
                # Add timezone info
                try:
                    to_date_obj = to_date_obj.replace(tzinfo=datetime.timezone.utc)
                except AttributeError:
                    from datetime import timezone

                    to_date_obj = to_date_obj.replace(tzinfo=timezone.utc)
            except ValueError:
                return f"Invalid to_date format. Use YYYY-MM-DD."

        # Prepare filter parameters
        params = {}
        if search_query:
            # IMPORTANT: Do not combine offset_date with search.
            # Use server-side search alone, then enforce date bounds client-side.
            params["search"] = search_query
            messages = []
            async for msg in c.iter_messages(entity, **params):  # newest -> oldest
                if to_date_obj and msg.date > to_date_obj:
                    continue
                if from_date_obj and msg.date < from_date_obj:
                    break
                messages.append(msg)
                if len(messages) >= limit:
                    break

        else:
            # Use server-side iteration when only date bounds are present
            # (no search) to avoid over-fetching.
            if from_date_obj or to_date_obj:
                messages = []
                if from_date_obj:
                    # Walk forward from start date (oldest -> newest)
                    async for msg in c.iter_messages(
                        entity, offset_date=from_date_obj, reverse=True
                    ):
                        if to_date_obj and msg.date > to_date_obj:
                            break
                        if msg.date < from_date_obj:
                            continue
                        messages.append(msg)
                        if len(messages) >= limit:
                            break
                else:
                    # Only upper bound: walk backward from end bound
                    async for msg in c.iter_messages(
                        # offset_date is exclusive; +1µs makes to_date inclusive
                        entity,
                        offset_date=to_date_obj + timedelta(microseconds=1),
                    ):
                        messages.append(msg)
                        if len(messages) >= limit:
                            break
            else:
                messages = await c.get_messages(entity, limit=limit, **params)

        if not messages:
            return "No messages found matching the criteria."

        lines = []
        for msg in messages:
            sender_name = get_sender_name(msg)
            message_text = msg.message or "[Media/No text]"
            reply_info = ""
            if msg.reply_to and msg.reply_to.reply_to_msg_id:
                reply_info = f" | reply to {msg.reply_to.reply_to_msg_id}"

            engagement_info = get_engagement_info(msg)

            lines.append(
                f"ID: {msg.id} | {sender_name} | Date: {msg.date}{reply_info}{engagement_info} | Message: {message_text}"
            )

        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error("list_messages", e, chat_id=chat_id)


@mcp.tool(annotations=ToolAnnotations(title="List Topics", openWorldHint=True, readOnlyHint=True))
async def list_topics(
    chat_id: int,
    limit: int = 200,
    offset_topic: int = 0,
    search_query: str = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Retrieve forum topics from a supergroup with the forum feature enabled.

    Note for LLM: You can send a message to a selected topic via reply_to_message tool
    by using Topic ID as the message_id parameter.

    Args:
        chat_id: The ID of the forum-enabled chat (supergroup).
        limit: Maximum number of topics to retrieve.
        offset_topic: Topic ID offset for pagination.
        search_query: Optional query to filter topics by title.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        if not isinstance(entity, Channel) or not getattr(entity, "megagroup", False):
            return "The specified chat is not a supergroup."

        if not getattr(entity, "forum", False):
            return "The specified supergroup does not have forum topics enabled."

        result = await c(
            functions.channels.GetForumTopicsRequest(
                channel=entity,
                offset_date=0,
                offset_id=0,
                offset_topic=offset_topic,
                limit=limit,
                q=search_query or None,
            )
        )

        topics = getattr(result, "topics", None) or []
        if not topics:
            return "No topics found for this chat."

        messages_map = {}
        if getattr(result, "messages", None):
            messages_map = {message.id: message for message in result.messages}

        lines = []
        for topic in topics:
            line_parts = [f"Topic ID: {topic.id}"]

            title = getattr(topic, "title", None) or "(no title)"
            line_parts.append(f"Title: {title}")

            total_messages = getattr(topic, "total_messages", None)
            if total_messages is not None:
                line_parts.append(f"Messages: {total_messages}")

            unread_count = getattr(topic, "unread_count", None)
            if unread_count:
                line_parts.append(f"Unread: {unread_count}")

            if getattr(topic, "closed", False):
                line_parts.append("Closed: Yes")

            if getattr(topic, "hidden", False):
                line_parts.append("Hidden: Yes")

            top_message_id = getattr(topic, "top_message", None)
            top_message = messages_map.get(top_message_id)
            if top_message and getattr(top_message, "date", None):
                line_parts.append(f"Last Activity: {top_message.date.isoformat()}")

            lines.append(" | ".join(line_parts))

        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error(
            "list_topics",
            e,
            chat_id=chat_id,
            limit=limit,
            offset_topic=offset_topic,
            search_query=search_query,
        )


@mcp.tool(annotations=ToolAnnotations(title="List Chats", openWorldHint=True, readOnlyHint=True))
async def list_chats(chat_type: str = None, limit: int = 20, account_id: Optional[str] = None) -> str:
    """
    List available chats with metadata.

    Args:
        chat_type: Filter by chat type ('user', 'group', 'channel', or None for all)
        limit: Maximum number of chats to retrieve.
    """
    try:
        c = await _get_client(account_id)
        dialogs = await c.get_dialogs(limit=limit)

        results = []
        for dialog in dialogs:
            entity = dialog.entity

            # Filter by type if requested
            current_type = get_entity_filter_type(entity)

            if chat_type and current_type != chat_type.lower():
                continue

            # Format chat info
            chat_info = f"Chat ID: {entity.id}"

            if hasattr(entity, "title"):
                chat_info += f", Title: {entity.title}"
            elif hasattr(entity, "first_name"):
                name = f"{entity.first_name}"
                if hasattr(entity, "last_name") and entity.last_name:
                    name += f" {entity.last_name}"
                chat_info += f", Name: {name}"

            chat_info += f", Type: {get_entity_type(entity)}"

            if hasattr(entity, "username") and entity.username:
                chat_info += f", Username: @{entity.username}"

            # Add unread count if available
            unread_count = getattr(dialog, "unread_count", 0) or 0
            # Also check unread_mark (manual "mark as unread" flag)
            inner_dialog = getattr(dialog, "dialog", None)
            unread_mark = (
                bool(getattr(inner_dialog, "unread_mark", False)) if inner_dialog else False
            )

            if unread_count > 0:
                chat_info += f", Unread: {unread_count}"
            elif unread_mark:
                chat_info += ", Unread: marked"
            else:
                chat_info += ", No unread messages"

            results.append(chat_info)

        if not results:
            return f"No chats found matching the criteria."

        return "\n".join(results)
    except Exception as e:
        return log_and_format_error("list_chats", e, chat_type=chat_type, limit=limit)


@mcp.tool(annotations=ToolAnnotations(title="Get Chat", openWorldHint=True, readOnlyHint=True))
@validate_id("chat_id")
async def get_chat(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get detailed information about a specific chat.

    Args:
        chat_id: The ID or username of the chat.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        result = []
        result.append(f"ID: {entity.id}")

        is_user = isinstance(entity, User)

        if hasattr(entity, "title"):
            result.append(f"Title: {entity.title}")
            result.append(f"Type: {get_entity_type(entity)}")
            if hasattr(entity, "username") and entity.username:
                result.append(f"Username: @{entity.username}")

            # Fetch participants count reliably
            try:
                participants_count = (await c.get_participants(entity, limit=0)).total
                result.append(f"Participants: {participants_count}")
            except Exception as pe:
                result.append(f"Participants: Error fetching ({pe})")

        elif is_user:
            name = f"{entity.first_name}"
            if entity.last_name:
                name += f" {entity.last_name}"
            result.append(f"Name: {name}")
            result.append(f"Type: {get_entity_type(entity)}")
            if entity.username:
                result.append(f"Username: @{entity.username}")
            if entity.phone:
                result.append(f"Phone: {entity.phone}")
            result.append(f"Bot: {'Yes' if entity.bot else 'No'}")
            result.append(f"Verified: {'Yes' if entity.verified else 'No'}")

        # Get last activity if it's a dialog
        try:
            # Using get_dialogs might be slow if there are many dialogs
            # Alternative: Get entity again via get_dialogs if needed for unread count
            dialog = await c.get_dialogs(limit=1, offset_id=0, offset_peer=entity)
            if dialog:
                dialog = dialog[0]
                result.append(f"Unread Messages: {dialog.unread_count}")
                if dialog.message:
                    last_msg = dialog.message
                    sender_name = "Unknown"
                    if last_msg.sender:
                        sender_name = getattr(last_msg.sender, "first_name", "") or getattr(
                            last_msg.sender, "title", "Unknown"
                        )
                        if hasattr(last_msg.sender, "last_name") and last_msg.sender.last_name:
                            sender_name += f" {last_msg.sender.last_name}"
                    sender_name = sender_name.strip() or "Unknown"
                    result.append(f"Last Message: From {sender_name} at {last_msg.date}")
                    result.append(f"Message: {last_msg.message or '[Media/No text]'}")
        except Exception as diag_ex:
            logger.warning(f"Could not get dialog info for {chat_id}: {diag_ex}")
            pass

        return "\n".join(result)
    except Exception as e:
        return log_and_format_error("get_chat", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Get Direct Chat By Contact", openWorldHint=True, readOnlyHint=True
    )
)
async def get_direct_chat_by_contact(contact_query: str, account_id: Optional[str] = None) -> str:
    """
    Find a direct chat with a specific contact by name, username, or phone.

    Args:
        contact_query: Name, username, or phone number to search for.
    """
    try:
        c = await _get_client(account_id)
        # Fetch all contacts using the correct Telethon method
        result = await c(functions.contacts.GetContactsRequest(hash=0))
        contacts = result.users
        found_contacts = []
        for contact in contacts:
            if not contact:
                continue
            name = (
                f"{getattr(contact, 'first_name', '')} {getattr(contact, 'last_name', '')}".strip()
            )
            username = getattr(contact, "username", "")
            phone = getattr(contact, "phone", "")
            if (
                contact_query.lower() in name.lower()
                or (username and contact_query.lower() in username.lower())
                or (phone and contact_query in phone)
            ):
                found_contacts.append(contact)
        if not found_contacts:
            return f"No contacts found matching '{contact_query}'."
        # If we found contacts, look for direct chats with them
        results = []
        dialogs = await c.get_dialogs()
        for contact in found_contacts:
            contact_name = (
                f"{getattr(contact, 'first_name', '')} {getattr(contact, 'last_name', '')}".strip()
            )
            for dialog in dialogs:
                if isinstance(dialog.entity, User) and dialog.entity.id == contact.id:
                    chat_info = f"Chat ID: {dialog.entity.id}, Contact: {contact_name}"
                    if getattr(contact, "username", ""):
                        chat_info += f", Username: @{contact.username}"
                    if dialog.unread_count:
                        chat_info += f", Unread: {dialog.unread_count}"
                    results.append(chat_info)
                    break
        if not results:
            found_names = ", ".join(
                [f"{c.first_name} {c.last_name}".strip() for c in found_contacts]
            )
            return f"Found contacts: {found_names}, but no direct chats were found with them."
        return "\n".join(results)
    except Exception as e:
        return log_and_format_error("get_direct_chat_by_contact", e, contact_query=contact_query)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Contact Chats", openWorldHint=True, readOnlyHint=True)
)
@validate_id("contact_id")
async def get_contact_chats(contact_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    List all chats involving a specific contact.

    Args:
        contact_id: The ID or username of the contact.
    """
    try:
        c = await _get_client(account_id)
        # Get contact info
        contact = await c.get_entity(contact_id)
        if not isinstance(contact, User):
            return f"ID {contact_id} is not a user/contact."

        contact_name = (
            f"{getattr(contact, 'first_name', '')} {getattr(contact, 'last_name', '')}".strip()
        )

        # Find direct chat
        direct_chat = None
        dialogs = await c.get_dialogs()

        results = []

        # Look for direct chat
        for dialog in dialogs:
            if isinstance(dialog.entity, User) and dialog.entity.id == contact_id:
                chat_info = f"Direct Chat ID: {dialog.entity.id}, Type: Private"
                if dialog.unread_count:
                    chat_info += f", Unread: {dialog.unread_count}"
                results.append(chat_info)
                break

        # Look for common groups/channels
        common_chats = []
        try:
            common = await c.get_common_chats(contact)
            for chat in common:
                chat_type = get_entity_type(chat)
                chat_info = f"Chat ID: {chat.id}, Title: {chat.title}, Type: {chat_type}"
                results.append(chat_info)
        except:
            results.append("Could not retrieve common groups.")

        if not results:
            return f"No chats found with {contact_name} (ID: {contact_id})."

        return f"Chats with {contact_name} (ID: {contact_id}):\n" + "\n".join(results)
    except Exception as e:
        return log_and_format_error("get_contact_chats", e, contact_id=contact_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Get Last Interaction", openWorldHint=True, readOnlyHint=True
    )
)
@validate_id("contact_id")
async def get_last_interaction(contact_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get the most recent message with a contact.

    Args:
        contact_id: The ID or username of the contact.
    """
    try:
        c = await _get_client(account_id)
        # Get contact info
        contact = await c.get_entity(contact_id)
        if not isinstance(contact, User):
            return f"ID {contact_id} is not a user/contact."

        contact_name = (
            f"{getattr(contact, 'first_name', '')} {getattr(contact, 'last_name', '')}".strip()
        )

        # Get the last few messages
        messages = await c.get_messages(contact, limit=5)

        if not messages:
            return f"No messages found with {contact_name} (ID: {contact_id})."

        results = [f"Last interactions with {contact_name} (ID: {contact_id}):"]

        for msg in messages:
            sender = "You" if msg.out else contact_name
            message_text = msg.message or "[Media/No text]"
            results.append(f"Date: {msg.date}, From: {sender}, Message: {message_text}")

        return "\n".join(results)
    except Exception as e:
        return log_and_format_error("get_last_interaction", e, contact_id=contact_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Message Context", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def get_message_context(
    chat_id: Union[int, str], message_id: int, context_size: int = 3,
    account_id: Optional[str] = None,
) -> str:
    """
    Retrieve context around a specific message.

    Args:
        chat_id: The ID or username of the chat.
        message_id: The ID of the central message.
        context_size: Number of messages before and after to include.
    """
    try:
        c = await _get_client(account_id)
        chat = await c.get_entity(chat_id)
        # Get messages around the specified message
        messages_before = await c.get_messages(chat, limit=context_size, max_id=message_id)
        central_message = await c.get_messages(chat, ids=message_id)
        # Fix: get_messages(ids=...) returns a single Message, not a list
        if central_message is not None and not isinstance(central_message, list):
            central_message = [central_message]
        elif central_message is None:
            central_message = []
        messages_after = await c.get_messages(
            chat, limit=context_size, min_id=message_id, reverse=True
        )
        if not central_message:
            return f"Message with ID {message_id} not found in chat {chat_id}."
        # Combine messages in chronological order
        all_messages = list(messages_before) + list(central_message) + list(messages_after)
        all_messages.sort(key=lambda m: m.id)
        results = [f"Context for message {message_id} in chat {chat_id}:"]
        for msg in all_messages:
            sender_name = get_sender_name(msg)
            highlight = " [THIS MESSAGE]" if msg.id == message_id else ""

            # Check if this message is a reply and get the replied message
            reply_content = ""
            if msg.reply_to and msg.reply_to.reply_to_msg_id:
                try:
                    replied_msg = await c.get_messages(chat, ids=msg.reply_to.reply_to_msg_id)
                    if replied_msg:
                        replied_sender = "Unknown"
                        if replied_msg.sender:
                            replied_sender = getattr(
                                replied_msg.sender, "first_name", ""
                            ) or getattr(replied_msg.sender, "title", "Unknown")
                        reply_content = f" | reply to {msg.reply_to.reply_to_msg_id}\n  → Replied message: [{replied_sender}] {replied_msg.message or '[Media/No text]'}"
                except Exception:
                    reply_content = (
                        f" | reply to {msg.reply_to.reply_to_msg_id} (original message not found)"
                    )

            results.append(
                f"ID: {msg.id} | {sender_name} | {msg.date}{highlight}{reply_content}\n{msg.message or '[Media/No text]'}\n"
            )
        return "\n".join(results)
    except Exception as e:
        return log_and_format_error(
            "get_message_context",
            e,
            chat_id=chat_id,
            message_id=message_id,
            context_size=context_size,
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Add Contact", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def add_contact(
    phone: Optional[str] = None,
    first_name: str = "",
    last_name: str = "",
    username: Optional[str] = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Add a new contact to your Telegram account.
    Args:
        phone: The phone number of the contact (with country code). Required if username is not provided.
        first_name: The contact's first name.
        last_name: The contact's last name (optional).
        username: The Telegram username (without @). Use this for adding contacts without phone numbers.

    Note: Either phone or username must be provided. If username is provided, the function will resolve it
    and add the contact using contacts.addContact API (which supports adding contacts without phone numbers).
    """
    try:
        c = await _get_client(account_id)
        # Normalize None to empty string for easier checking
        phone = phone or ""
        username = username or ""

        # Validate that at least one identifier is provided
        if not phone and not username:
            return "Error: Either phone or username must be provided."

        # If username is provided, use it for username-based contact addition
        if username:
            # Remove @ if present
            username_clean = username.lstrip("@")
            if not username_clean:
                return "Error: Username cannot be empty."

            # Resolve username to get user information
            try:
                resolve_result = await c(
                    functions.contacts.ResolveUsernameRequest(username=username_clean)
                )

                # Extract user from the result
                if not resolve_result.users:
                    return f"Error: User with username @{username_clean} not found."

                user = resolve_result.users[0]
                if not isinstance(user, User):
                    return f"Error: Resolved entity is not a user."

                user_id = user.id
                access_hash = user.access_hash

                # Use contacts.addContact to add the contact by user ID
                from telethon.tl.types import InputUser

                result = await c(
                    functions.contacts.AddContactRequest(
                        id=InputUser(user_id=user_id, access_hash=access_hash),
                        first_name=first_name,
                        last_name=last_name,
                        phone="",  # Empty phone for username-based contacts
                    )
                )

                if hasattr(result, "updates") and result.updates:
                    return (
                        f"Contact {first_name} {last_name} (@{username_clean}) added successfully."
                    )
                else:
                    return f"Contact {first_name} {last_name} (@{username_clean}) added successfully (no updates returned)."

            except Exception as resolve_e:
                logger.exception(
                    f"add_contact (username resolve) failed (username={username_clean})"
                )
                return log_and_format_error("add_contact", resolve_e, username=username_clean)

        elif phone:
            # Original phone-based contact addition
            from telethon.tl.types import InputPhoneContact

            result = await c(
                functions.contacts.ImportContactsRequest(
                    contacts=[
                        InputPhoneContact(
                            client_id=0,
                            phone=phone,
                            first_name=first_name,
                            last_name=last_name,
                        )
                    ]
                )
            )
            if result.imported:
                return f"Contact {first_name} {last_name} added successfully."
            else:
                return f"Contact not added. Response: {str(result)}"
        else:
            return "Error: Phone number is required when username is not provided."
    except (ImportError, AttributeError) as type_err:
        # Try alternative approach using raw API (only for phone-based)
        if phone and not username:
            try:
                result = await c(
                    functions.contacts.ImportContactsRequest(
                        contacts=[
                            {
                                "client_id": 0,
                                "phone": phone,
                                "first_name": first_name,
                                "last_name": last_name,
                            }
                        ]
                    )
                )
                if hasattr(result, "imported") and result.imported:
                    return f"Contact {first_name} {last_name} added successfully (alt method)."
                else:
                    return f"Contact not added. Alternative method response: {str(result)}"
            except Exception as alt_e:
                logger.exception(f"add_contact (alt method) failed (phone={phone})")
                return log_and_format_error("add_contact", alt_e, phone=phone)
        else:
            logger.exception(f"add_contact (type error) failed")
            return log_and_format_error("add_contact", type_err)
    except Exception as e:
        logger.exception(f"add_contact failed (phone={phone}, username={username})")
        return log_and_format_error("add_contact", e, phone=phone, username=username)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Delete Contact", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("user_id")
async def delete_contact(user_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Delete a contact by user ID.
    Args:
        user_id: The Telegram user ID or username of the contact to delete.
    """
    try:
        c = await _get_client(account_id)
        user = await c.get_entity(user_id)
        await c(functions.contacts.DeleteContactsRequest(id=[user]))
        return f"Contact with user ID {user_id} deleted."
    except Exception as e:
        return log_and_format_error("delete_contact", e, user_id=user_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Block User", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("user_id")
async def block_user(user_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Block a user by user ID.
    Args:
        user_id: The Telegram user ID or username to block.
    """
    try:
        c = await _get_client(account_id)
        user = await c.get_entity(user_id)
        await c(functions.contacts.BlockRequest(id=user))
        return f"User {user_id} blocked."
    except Exception as e:
        return log_and_format_error("block_user", e, user_id=user_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Unblock User", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("user_id")
async def unblock_user(user_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Unblock a user by user ID.
    Args:
        user_id: The Telegram user ID or username to unblock.
    """
    try:
        c = await _get_client(account_id)
        user = await c.get_entity(user_id)
        await c(functions.contacts.UnblockRequest(id=user))
        return f"User {user_id} unblocked."
    except Exception as e:
        return log_and_format_error("unblock_user", e, user_id=user_id)


@mcp.tool(annotations=ToolAnnotations(title="Get Me", openWorldHint=True, readOnlyHint=True))
async def get_me(account_id: Optional[str] = None) -> str:
    """
    Get your own user information.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        me = await c.get_me()
        return json.dumps(format_entity(me), indent=2)
    except Exception as e:
        return log_and_format_error("get_me", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Create Group", openWorldHint=True, destructiveHint=True)
)
@validate_id("user_ids")
async def create_group(title: str, user_ids: List[Union[int, str]], account_id: Optional[str] = None) -> str:
    """
    Create a new group or supergroup and add users.

    Args:
        title: Title for the new group
        user_ids: List of user IDs or usernames to add to the group
    """
    try:
        c = await _get_client(account_id)
        # Convert user IDs to entities
        users = []
        for user_id in user_ids:
            try:
                user = await c.get_entity(user_id)
                users.append(user)
            except Exception as e:
                logger.error(f"Failed to get entity for user ID {user_id}: {e}")
                return f"Error: Could not find user with ID {user_id}"

        if not users:
            return "Error: No valid users provided"

        # Create the group with the users
        try:
            # Create a new chat with selected users
            result = await c(functions.messages.CreateChatRequest(users=users, title=title))

            # Check what type of response we got
            if hasattr(result, "chats") and result.chats:
                created_chat = result.chats[0]
                return f"Group created with ID: {created_chat.id}"
            elif hasattr(result, "chat") and result.chat:
                return f"Group created with ID: {result.chat.id}"
            elif hasattr(result, "chat_id"):
                return f"Group created with ID: {result.chat_id}"
            else:
                # If we can't determine the chat ID directly from the result
                # Try to find it in recent dialogs
                await asyncio.sleep(1)  # Give Telegram a moment to register the new group
                dialogs = await c.get_dialogs(limit=5)  # Get recent dialogs
                for dialog in dialogs:
                    if dialog.title == title:
                        return f"Group created with ID: {dialog.id}"

                # If we still can't find it, at least return success
                return f"Group created successfully. Please check your recent chats for '{title}'."

        except Exception as create_err:
            if "PEER_FLOOD" in str(create_err):
                return "Error: Cannot create group due to Telegram limits. Try again later."
            else:
                raise  # Let the outer exception handler catch it
    except Exception as e:
        logger.exception(f"create_group failed (title={title}, user_ids={user_ids})")
        return log_and_format_error("create_group", e, title=title, user_ids=user_ids)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Invite To Group", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("group_id", "user_ids")
async def invite_to_group(group_id: Union[int, str], user_ids: List[Union[int, str]], account_id: Optional[str] = None) -> str:
    """
    Invite users to a group or channel.

    Args:
        group_id: The ID or username of the group/channel.
        user_ids: List of user IDs or usernames to invite.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(group_id)
        users_to_add = []

        for user_id in user_ids:
            try:
                user = await c.get_entity(user_id)
                users_to_add.append(user)
            except ValueError as e:
                return f"Error: User with ID {user_id} could not be found. {e}"

        try:
            result = await c(
                functions.channels.InviteToChannelRequest(channel=entity, users=users_to_add)
            )

            invited_count = 0
            if hasattr(result, "users") and result.users:
                invited_count = len(result.users)
            elif hasattr(result, "count"):
                invited_count = result.count

            return f"Successfully invited {invited_count} users to {entity.title}"
        except telethon.errors.rpcerrorlist.UserNotMutualContactError:
            return "Error: Cannot invite users who are not mutual contacts. Please ensure the users are in your contacts and have added you back."
        except telethon.errors.rpcerrorlist.UserPrivacyRestrictedError:
            return (
                "Error: One or more users have privacy settings that prevent you from adding them."
            )
        except Exception as e:
            return log_and_format_error("invite_to_group", e, group_id=group_id, user_ids=user_ids)

    except Exception as e:
        logger.error(
            f"telegram_mcp invite_to_group failed (group_id={group_id}, user_ids={user_ids})",
            exc_info=True,
        )
        return log_and_format_error("invite_to_group", e, group_id=group_id, user_ids=user_ids)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Leave Chat", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def leave_chat(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Leave a group or channel by chat ID.

    Args:
        chat_id: The chat ID or username to leave.
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        # Check the entity type carefully
        if isinstance(entity, Channel):
            # Handle both channels and supergroups (which are also channels in Telegram)
            try:
                await c(functions.channels.LeaveChannelRequest(channel=entity))
                chat_name = getattr(entity, "title", str(chat_id))
                return f"Left channel/supergroup {chat_name} (ID: {chat_id})."
            except Exception as chan_err:
                return log_and_format_error("leave_chat", chan_err, chat_id=chat_id)

        elif isinstance(entity, Chat):
            # Traditional basic groups (not supergroups)
            try:
                # First try with InputPeerUser
                me = await c.get_me(input_peer=True)
                await c(
                    functions.messages.DeleteChatUserRequest(
                        chat_id=entity.id,
                        user_id=me,  # Use the entity ID directly
                    )
                )
                chat_name = getattr(entity, "title", str(chat_id))
                return f"Left basic group {chat_name} (ID: {chat_id})."
            except Exception as chat_err:
                # If the above fails, try the second approach
                logger.warning(
                    f"First leave attempt failed: {chat_err}, trying alternative method"
                )

                try:
                    # Alternative approach - sometimes this works better
                    me_full = await c.get_me()
                    await c(
                        functions.messages.DeleteChatUserRequest(
                            chat_id=entity.id, user_id=me_full.id
                        )
                    )
                    chat_name = getattr(entity, "title", str(chat_id))
                    return f"Left basic group {chat_name} (ID: {chat_id})."
                except Exception as alt_err:
                    return log_and_format_error("leave_chat", alt_err, chat_id=chat_id)
        else:
            # Cannot leave a user chat this way
            entity_type = type(entity).__name__
            return log_and_format_error(
                "leave_chat",
                Exception(
                    f"Cannot leave chat ID {chat_id} of type {entity_type}. This function is for groups and channels only."
                ),
                chat_id=chat_id,
            )

    except Exception as e:
        logger.exception(f"leave_chat failed (chat_id={chat_id})")

        # Provide helpful hint for common errors
        error_str = str(e).lower()
        if "invalid" in error_str and "chat" in error_str:
            return log_and_format_error(
                "leave_chat",
                Exception(
                    f"Error leaving chat: This appears to be a channel/supergroup. Please check the chat ID and try again."
                ),
                chat_id=chat_id,
            )

        return log_and_format_error("leave_chat", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Participants", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def get_participants(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    List all participants in a group or channel.
    Args:
        chat_id: The group or channel ID or username.
    """
    try:
        c = await _get_client(account_id)
        participants = await c.get_participants(chat_id)
        lines = [
            f"ID: {p.id}, Name: {getattr(p, 'first_name', '')} {getattr(p, 'last_name', '')}"
            for p in participants
        ]
        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error("get_participants", e, chat_id=chat_id)


@mcp.tool(annotations=ToolAnnotations(title="Send File", openWorldHint=True, destructiveHint=True))
@validate_id("chat_id")
async def send_file(chat_id: Union[int, str], file_path: str, caption: str = None, account_id: Optional[str] = None) -> str:
    """
    Send a file to a chat.
    Args:
        chat_id: The chat ID or username.
        file_path: Absolute path to the file to send (must exist and be readable).
        caption: Optional caption for the file.
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        if not os.path.isfile(file_path):
            return f"File not found: {file_path}"
        if not os.access(file_path, os.R_OK):
            return f"File is not readable: {file_path}"
        entity = await c.get_entity(chat_id)
        await _safe_call(c.send_file(entity, file_path, caption=caption))
        return f"File sent to chat {chat_id}."
    except Exception as e:
        return log_and_format_error(
            "send_file", e, chat_id=chat_id, file_path=file_path, caption=caption
        )


@mcp.tool(
    annotations=ToolAnnotations(title="Download Media", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def download_media(chat_id: Union[int, str], message_id: int, file_path: str, account_id: Optional[str] = None) -> str:
    """
    Download media from a message in a chat.
    Args:
        chat_id: The chat ID or username.
        message_id: The message ID containing the media.
        file_path: Absolute path to save the downloaded file (must be writable).
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        msg = await c.get_messages(entity, ids=message_id)
        if not msg or not msg.media:
            return "No media found in the specified message."
        # Check if directory is writable
        dir_path = os.path.dirname(file_path) or "."
        if not os.access(dir_path, os.W_OK):
            return f"Directory not writable: {dir_path}"
        await c.download_media(msg, file=file_path)
        if not os.path.isfile(file_path):
            return f"Download failed: file not created at {file_path}"
        return f"Media downloaded to {file_path}."
    except Exception as e:
        return log_and_format_error(
            "download_media",
            e,
            chat_id=chat_id,
            message_id=message_id,
            file_path=file_path,
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Update Profile", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def update_profile(first_name: str = None, last_name: str = None, about: str = None, account_id: Optional[str] = None) -> str:
    """
    Update your profile information (name, bio).
    """
    try:
        c = await _get_client(account_id)
        await c(
            functions.account.UpdateProfileRequest(
                first_name=first_name, last_name=last_name, about=about
            )
        )
        return "Profile updated."
    except Exception as e:
        return log_and_format_error(
            "update_profile", e, first_name=first_name, last_name=last_name, about=about
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Set Profile Photo", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def set_profile_photo(file_path: str, account_id: Optional[str] = None) -> str:
    """
    Set a new profile photo.
    """
    try:
        c = await _get_client(account_id)
        await c(
            functions.photos.UploadProfilePhotoRequest(file=await c.upload_file(file_path))
        )
        return "Profile photo updated."
    except Exception as e:
        return log_and_format_error("set_profile_photo", e, file_path=file_path)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Delete Profile Photo", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def delete_profile_photo(account_id: Optional[str] = None) -> str:
    """
    Delete your current profile photo.
    """
    try:
        c = await _get_client(account_id)
        photos = await c(
            functions.photos.GetUserPhotosRequest(user_id="me", offset=0, max_id=0, limit=1)
        )
        if not photos.photos:
            return "No profile photo to delete."
        await c(functions.photos.DeletePhotosRequest(id=[photos.photos[0].id]))
        return "Profile photo deleted."
    except Exception as e:
        return log_and_format_error("delete_profile_photo", e)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Get Privacy Settings", openWorldHint=True, readOnlyHint=True
    )
)
async def get_privacy_settings(account_id: Optional[str] = None) -> str:
    """
    Get your privacy settings for last seen status.
    """
    try:
        c = await _get_client(account_id)
        # Import needed types directly
        from telethon.tl.types import InputPrivacyKeyStatusTimestamp

        try:
            settings = await c(
                functions.account.GetPrivacyRequest(key=InputPrivacyKeyStatusTimestamp())
            )
            return str(settings)
        except TypeError as e:
            if "TLObject was expected" in str(e):
                return "Error: Privacy settings API call failed due to type mismatch. This is likely a version compatibility issue with Telethon."
            else:
                raise
    except Exception as e:
        logger.exception("get_privacy_settings failed")
        return log_and_format_error("get_privacy_settings", e)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Set Privacy Settings", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("allow_users", "disallow_users")
async def set_privacy_settings(
    key: str,
    allow_users: Optional[List[Union[int, str]]] = None,
    disallow_users: Optional[List[Union[int, str]]] = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Set privacy settings (e.g., last seen, phone, etc.).

    Args:
        key: The privacy setting to modify ('status' for last seen, 'phone', 'profile_photo', etc.)
        allow_users: List of user IDs or usernames to allow
        disallow_users: List of user IDs or usernames to disallow
    """
    try:
        c = await _get_client(account_id)
        # Import needed types
        from telethon.tl.types import (
            InputPrivacyKeyStatusTimestamp,
            InputPrivacyKeyPhoneNumber,
            InputPrivacyKeyProfilePhoto,
            InputPrivacyValueAllowUsers,
            InputPrivacyValueDisallowUsers,
            InputPrivacyValueAllowAll,
            InputPrivacyValueDisallowAll,
        )

        # Map the simplified keys to their corresponding input types
        key_mapping = {
            "status": InputPrivacyKeyStatusTimestamp,
            "phone": InputPrivacyKeyPhoneNumber,
            "profile_photo": InputPrivacyKeyProfilePhoto,
        }

        # Get the appropriate key class
        if key not in key_mapping:
            return f"Error: Unsupported privacy key '{key}'. Supported keys: {', '.join(key_mapping.keys())}"

        privacy_key = key_mapping[key]()

        # Prepare the rules
        rules = []

        # Process allow rules
        if allow_users is None or len(allow_users) == 0:
            # If no specific users to allow, allow everyone by default
            rules.append(InputPrivacyValueAllowAll())
        else:
            # Convert user IDs to InputUser entities
            try:
                allow_entities = []
                for user_id in allow_users:
                    try:
                        user = await c.get_entity(user_id)
                        allow_entities.append(user)
                    except Exception as user_err:
                        logger.warning(f"Could not get entity for user ID {user_id}: {user_err}")

                if allow_entities:
                    rules.append(InputPrivacyValueAllowUsers(users=allow_entities))
            except Exception as allow_err:
                logger.error(f"Error processing allowed users: {allow_err}")
                return log_and_format_error("set_privacy_settings", allow_err, key=key)

        # Process disallow rules
        if disallow_users and len(disallow_users) > 0:
            try:
                disallow_entities = []
                for user_id in disallow_users:
                    try:
                        user = await c.get_entity(user_id)
                        disallow_entities.append(user)
                    except Exception as user_err:
                        logger.warning(f"Could not get entity for user ID {user_id}: {user_err}")

                if disallow_entities:
                    rules.append(InputPrivacyValueDisallowUsers(users=disallow_entities))
            except Exception as disallow_err:
                logger.error(f"Error processing disallowed users: {disallow_err}")
                return log_and_format_error("set_privacy_settings", disallow_err, key=key)

        # Apply the privacy settings
        try:
            result = await c(
                functions.account.SetPrivacyRequest(key=privacy_key, rules=rules)
            )
            return f"Privacy settings for {key} updated successfully."
        except TypeError as type_err:
            if "TLObject was expected" in str(type_err):
                return "Error: Privacy settings API call failed due to type mismatch. This is likely a version compatibility issue with Telethon."
            else:
                raise
    except Exception as e:
        logger.exception(f"set_privacy_settings failed (key={key})")
        return log_and_format_error("set_privacy_settings", e, key=key)


@mcp.tool(
    annotations=ToolAnnotations(title="Import Contacts", openWorldHint=True, destructiveHint=True)
)
async def import_contacts(contacts: list, account_id: Optional[str] = None) -> str:
    """
    Import a list of contacts. Each contact should be a dict with phone, first_name, last_name.
    """
    try:
        c = await _get_client(account_id)
        input_contacts = [
            functions.contacts.InputPhoneContact(
                client_id=i,
                phone=c["phone"],
                first_name=c["first_name"],
                last_name=c.get("last_name", ""),
            )
            for i, c in enumerate(contacts)
        ]
        result = await c(functions.contacts.ImportContactsRequest(contacts=input_contacts))
        return f"Imported {len(result.imported)} contacts."
    except Exception as e:
        return log_and_format_error("import_contacts", e, contacts=contacts)


@mcp.tool(
    annotations=ToolAnnotations(title="Export Contacts", openWorldHint=True, readOnlyHint=True)
)
async def export_contacts(account_id: Optional[str] = None) -> str:
    """
    Export all contacts as a JSON string.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.contacts.GetContactsRequest(hash=0))
        users = result.users
        return json.dumps([format_entity(u) for u in users], indent=2)
    except Exception as e:
        return log_and_format_error("export_contacts", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Blocked Users", openWorldHint=True, readOnlyHint=True)
)
async def get_blocked_users(account_id: Optional[str] = None) -> str:
    """
    Get a list of blocked users.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.contacts.GetBlockedRequest(offset=0, limit=100))
        return json.dumps([format_entity(u) for u in result.users], indent=2)
    except Exception as e:
        return log_and_format_error("get_blocked_users", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Create Channel", openWorldHint=True, destructiveHint=True)
)
async def create_channel(title: str, about: str = "", megagroup: bool = False, account_id: Optional[str] = None) -> str:
    """
    Create a new channel or supergroup.
    """
    try:
        c = await _get_client(account_id)
        result = await c(
            functions.channels.CreateChannelRequest(title=title, about=about, megagroup=megagroup)
        )
        return f"Channel '{title}' created with ID: {result.chats[0].id}"
    except Exception as e:
        return log_and_format_error(
            "create_channel", e, title=title, about=about, megagroup=megagroup
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Edit Chat Title", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def edit_chat_title(chat_id: Union[int, str], title: str, account_id: Optional[str] = None) -> str:
    """
    Edit the title of a chat, group, or channel.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        if isinstance(entity, Channel):
            await c(functions.channels.EditTitleRequest(channel=entity, title=title))
        elif isinstance(entity, Chat):
            await c(functions.messages.EditChatTitleRequest(chat_id=chat_id, title=title))
        else:
            return f"Cannot edit title for this entity type ({type(entity)})."
        return f"Chat {chat_id} title updated to '{title}'."
    except Exception as e:
        logger.exception(f"edit_chat_title failed (chat_id={chat_id}, title='{title}')")
        return log_and_format_error("edit_chat_title", e, chat_id=chat_id, title=title)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Edit Chat Photo", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def edit_chat_photo(chat_id: Union[int, str], file_path: str, account_id: Optional[str] = None) -> str:
    """
    Edit the photo of a chat, group, or channel. Requires a file path to an image.
    """
    try:
        c = await _get_client(account_id)
        if not os.path.isfile(file_path):
            return f"Photo file not found: {file_path}"
        if not os.access(file_path, os.R_OK):
            return f"Photo file not readable: {file_path}"

        entity = await c.get_entity(chat_id)
        uploaded_file = await c.upload_file(file_path)

        if isinstance(entity, Channel):
            # For channels/supergroups, use EditPhotoRequest with InputChatUploadedPhoto
            input_photo = InputChatUploadedPhoto(file=uploaded_file)
            await c(functions.channels.EditPhotoRequest(channel=entity, photo=input_photo))
        elif isinstance(entity, Chat):
            # For basic groups, use EditChatPhotoRequest with InputChatUploadedPhoto
            input_photo = InputChatUploadedPhoto(file=uploaded_file)
            await c(
                functions.messages.EditChatPhotoRequest(chat_id=chat_id, photo=input_photo)
            )
        else:
            return f"Cannot edit photo for this entity type ({type(entity)})."

        return f"Chat {chat_id} photo updated."
    except Exception as e:
        logger.exception(f"edit_chat_photo failed (chat_id={chat_id}, file_path='{file_path}')")
        return log_and_format_error("edit_chat_photo", e, chat_id=chat_id, file_path=file_path)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Delete Chat Photo", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def delete_chat_photo(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Delete the photo of a chat, group, or channel.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        if isinstance(entity, Channel):
            # Use InputChatPhotoEmpty for channels/supergroups
            await c(
                functions.channels.EditPhotoRequest(channel=entity, photo=InputChatPhotoEmpty())
            )
        elif isinstance(entity, Chat):
            # Use None (or InputChatPhotoEmpty) for basic groups
            await c(
                functions.messages.EditChatPhotoRequest(
                    chat_id=chat_id, photo=InputChatPhotoEmpty()
                )
            )
        else:
            return f"Cannot delete photo for this entity type ({type(entity)})."

        return f"Chat {chat_id} photo deleted."
    except Exception as e:
        logger.exception(f"delete_chat_photo failed (chat_id={chat_id})")
        return log_and_format_error("delete_chat_photo", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Promote Admin", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("group_id", "user_id")
async def promote_admin(
    group_id: Union[int, str], user_id: Union[int, str], rights: dict = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Promote a user to admin in a group/channel.

    Args:
        group_id: ID or username of the group/channel
        user_id: User ID or username to promote
        rights: Admin rights to give (optional)
    """
    try:
        c = await _get_client(account_id)
        chat = await c.get_entity(group_id)
        user = await c.get_entity(user_id)

        # Set default admin rights if not provided
        if not rights:
            rights = {
                "change_info": True,
                "post_messages": True,
                "edit_messages": True,
                "delete_messages": True,
                "ban_users": True,
                "invite_users": True,
                "pin_messages": True,
                "add_admins": False,
                "anonymous": False,
                "manage_call": True,
                "other": True,
            }

        admin_rights = ChatAdminRights(
            change_info=rights.get("change_info", True),
            post_messages=rights.get("post_messages", True),
            edit_messages=rights.get("edit_messages", True),
            delete_messages=rights.get("delete_messages", True),
            ban_users=rights.get("ban_users", True),
            invite_users=rights.get("invite_users", True),
            pin_messages=rights.get("pin_messages", True),
            add_admins=rights.get("add_admins", False),
            anonymous=rights.get("anonymous", False),
            manage_call=rights.get("manage_call", True),
            other=rights.get("other", True),
        )

        try:
            result = await c(
                functions.channels.EditAdminRequest(
                    channel=chat, user_id=user, admin_rights=admin_rights, rank="Admin"
                )
            )
            return f"Successfully promoted user {user_id} to admin in {chat.title}"
        except telethon.errors.rpcerrorlist.UserNotMutualContactError:
            return "Error: Cannot promote users who are not mutual contacts. Please ensure the user is in your contacts and has added you back."
        except Exception as e:
            return log_and_format_error("promote_admin", e, group_id=group_id, user_id=user_id)

    except Exception as e:
        logger.error(
            f"telegram_mcp promote_admin failed (group_id={group_id}, user_id={user_id})",
            exc_info=True,
        )
        return log_and_format_error("promote_admin", e, group_id=group_id, user_id=user_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Demote Admin", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("group_id", "user_id")
async def demote_admin(group_id: Union[int, str], user_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Demote a user from admin in a group/channel.

    Args:
        group_id: ID or username of the group/channel
        user_id: User ID or username to demote
    """
    try:
        c = await _get_client(account_id)
        chat = await c.get_entity(group_id)
        user = await c.get_entity(user_id)

        # Create empty admin rights (regular user)
        admin_rights = ChatAdminRights(
            change_info=False,
            post_messages=False,
            edit_messages=False,
            delete_messages=False,
            ban_users=False,
            invite_users=False,
            pin_messages=False,
            add_admins=False,
            anonymous=False,
            manage_call=False,
            other=False,
        )

        try:
            result = await c(
                functions.channels.EditAdminRequest(
                    channel=chat, user_id=user, admin_rights=admin_rights, rank=""
                )
            )
            return f"Successfully demoted user {user_id} from admin in {chat.title}"
        except telethon.errors.rpcerrorlist.UserNotMutualContactError:
            return "Error: Cannot modify admin status of users who are not mutual contacts. Please ensure the user is in your contacts and has added you back."
        except Exception as e:
            return log_and_format_error("demote_admin", e, group_id=group_id, user_id=user_id)

    except Exception as e:
        logger.error(
            f"telegram_mcp demote_admin failed (group_id={group_id}, user_id={user_id})",
            exc_info=True,
        )
        return log_and_format_error("demote_admin", e, group_id=group_id, user_id=user_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Ban User", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id", "user_id")
async def ban_user(chat_id: Union[int, str], user_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Ban a user from a group or channel.

    Args:
        chat_id: ID or username of the group/channel
        user_id: User ID or username to ban
    """
    try:
        c = await _get_client(account_id)
        chat = await c.get_entity(chat_id)
        user = await c.get_entity(user_id)

        # Create banned rights (all restrictions enabled)
        banned_rights = ChatBannedRights(
            until_date=None,  # Ban forever
            view_messages=True,
            send_messages=True,
            send_media=True,
            send_stickers=True,
            send_gifs=True,
            send_games=True,
            send_inline=True,
            embed_links=True,
            send_polls=True,
            change_info=True,
            invite_users=True,
            pin_messages=True,
        )

        try:
            await c(
                functions.channels.EditBannedRequest(
                    channel=chat, participant=user, banned_rights=banned_rights
                )
            )
            return f"User {user_id} banned from chat {chat.title} (ID: {chat_id})."
        except telethon.errors.rpcerrorlist.UserNotMutualContactError:
            return "Error: Cannot ban users who are not mutual contacts. Please ensure the user is in your contacts and has added you back."
        except Exception as e:
            return log_and_format_error("ban_user", e, chat_id=chat_id, user_id=user_id)
    except Exception as e:
        logger.exception(f"ban_user failed (chat_id={chat_id}, user_id={user_id})")
        return log_and_format_error("ban_user", e, chat_id=chat_id, user_id=user_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Unban User", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id", "user_id")
async def unban_user(chat_id: Union[int, str], user_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Unban a user from a group or channel.

    Args:
        chat_id: ID or username of the group/channel
        user_id: User ID or username to unban
    """
    try:
        c = await _get_client(account_id)
        chat = await c.get_entity(chat_id)
        user = await c.get_entity(user_id)

        # Create unbanned rights (no restrictions)
        unbanned_rights = ChatBannedRights(
            until_date=None,
            view_messages=False,
            send_messages=False,
            send_media=False,
            send_stickers=False,
            send_gifs=False,
            send_games=False,
            send_inline=False,
            embed_links=False,
            send_polls=False,
            change_info=False,
            invite_users=False,
            pin_messages=False,
        )

        try:
            await c(
                functions.channels.EditBannedRequest(
                    channel=chat, participant=user, banned_rights=unbanned_rights
                )
            )
            return f"User {user_id} unbanned from chat {chat.title} (ID: {chat_id})."
        except telethon.errors.rpcerrorlist.UserNotMutualContactError:
            return "Error: Cannot modify status of users who are not mutual contacts. Please ensure the user is in your contacts and has added you back."
        except Exception as e:
            return log_and_format_error("unban_user", e, chat_id=chat_id, user_id=user_id)
    except Exception as e:
        logger.exception(f"unban_user failed (chat_id={chat_id}, user_id={user_id})")
        return log_and_format_error("unban_user", e, chat_id=chat_id, user_id=user_id)


@mcp.tool(annotations=ToolAnnotations(title="Get Admins", openWorldHint=True, readOnlyHint=True))
@validate_id("chat_id")
async def get_admins(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get all admins in a group or channel.
    """
    try:
        c = await _get_client(account_id)
        # Fix: Use the correct filter type ChannelParticipantsAdmins
        participants = await c.get_participants(chat_id, filter=ChannelParticipantsAdmins())
        lines = [
            f"ID: {p.id}, Name: {getattr(p, 'first_name', '')} {getattr(p, 'last_name', '')}".strip()
            for p in participants
        ]
        return "\n".join(lines) if lines else "No admins found."
    except Exception as e:
        logger.exception(f"get_admins failed (chat_id={chat_id})")
        return log_and_format_error("get_admins", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Banned Users", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def get_banned_users(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get all banned users in a group or channel.
    """
    try:
        c = await _get_client(account_id)
        # Fix: Use the correct filter type ChannelParticipantsKicked
        participants = await c.get_participants(
            chat_id, filter=ChannelParticipantsKicked(q="")
        )
        lines = [
            f"ID: {p.id}, Name: {getattr(p, 'first_name', '')} {getattr(p, 'last_name', '')}".strip()
            for p in participants
        ]
        return "\n".join(lines) if lines else "No banned users found."
    except Exception as e:
        logger.exception(f"get_banned_users failed (chat_id={chat_id})")
        return log_and_format_error("get_banned_users", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Invite Link", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def get_invite_link(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get the invite link for a group or channel.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        # Try using ExportChatInviteRequest first
        try:
            from telethon.tl import functions

            result = await c(functions.messages.ExportChatInviteRequest(peer=entity))
            return result.link
        except AttributeError:
            # If the function doesn't exist in the current Telethon version
            logger.warning("ExportChatInviteRequest not available, using alternative method")
        except Exception as e1:
            # If that fails, log and try alternative approach
            logger.warning(f"ExportChatInviteRequest failed: {e1}")

        # Alternative approach using client.export_chat_invite_link
        try:
            invite_link = await c.export_chat_invite_link(entity)
            return invite_link
        except Exception as e2:
            logger.warning(f"export_chat_invite_link failed: {e2}")

        # Last resort: Try directly fetching chat info
        try:
            if isinstance(entity, (Chat, Channel)):
                full_chat = await c(functions.messages.GetFullChatRequest(chat_id=entity.id))
                if hasattr(full_chat, "full_chat") and hasattr(full_chat.full_chat, "invite_link"):
                    return full_chat.full_chat.invite_link or "No invite link available."
        except Exception as e3:
            logger.warning(f"GetFullChatRequest failed: {e3}")

        return "Could not retrieve invite link for this chat."
    except Exception as e:
        logger.exception(f"get_invite_link failed (chat_id={chat_id})")
        return log_and_format_error("get_invite_link", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Join Chat By Link", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def join_chat_by_link(link: str, account_id: Optional[str] = None) -> str:
    """
    Join a chat by invite link.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        # Extract the hash from the invite link
        if "/" in link:
            hash_part = link.split("/")[-1]
            if hash_part.startswith("+"):
                hash_part = hash_part[1:]  # Remove the '+' if present
        else:
            hash_part = link

        # Try checking the invite before joining
        try:
            # Try to check invite info first (will often fail if not a member)
            invite_info = await c(functions.messages.CheckChatInviteRequest(hash=hash_part))
            if hasattr(invite_info, "chat") and invite_info.chat:
                # If we got chat info, we're already a member
                chat_title = getattr(invite_info.chat, "title", "Unknown Chat")
                return f"You are already a member of this chat: {chat_title}"
        except Exception:
            # This often fails if not a member - just continue
            pass

        # Join the chat using the hash
        result = await c(functions.messages.ImportChatInviteRequest(hash=hash_part))
        if result and hasattr(result, "chats") and result.chats:
            chat_title = getattr(result.chats[0], "title", "Unknown Chat")
            return f"Successfully joined chat: {chat_title}"
        return f"Joined chat via invite hash."
    except Exception as e:
        err_str = str(e).lower()
        if "expired" in err_str:
            return "The invite hash has expired and is no longer valid."
        elif "invalid" in err_str:
            return "The invite hash is invalid or malformed."
        elif "already" in err_str and "participant" in err_str:
            return "You are already a member of this chat."
        logger.exception(f"join_chat_by_link failed (link={link})")
        return f"Error joining chat: {e}"


@mcp.tool(
    annotations=ToolAnnotations(title="Export Chat Invite", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def export_chat_invite(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Export a chat invite link.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        # Try using ExportChatInviteRequest first
        try:
            from telethon.tl import functions

            result = await c(functions.messages.ExportChatInviteRequest(peer=entity))
            return result.link
        except AttributeError:
            # If the function doesn't exist in the current Telethon version
            logger.warning("ExportChatInviteRequest not available, using alternative method")
        except Exception as e1:
            # If that fails, log and try alternative approach
            logger.warning(f"ExportChatInviteRequest failed: {e1}")

        # Alternative approach using client.export_chat_invite_link
        try:
            invite_link = await c.export_chat_invite_link(entity)
            return invite_link
        except Exception as e2:
            logger.warning(f"export_chat_invite_link failed: {e2}")
            return log_and_format_error("export_chat_invite", e2, chat_id=chat_id)

    except Exception as e:
        logger.exception(f"export_chat_invite failed (chat_id={chat_id})")
        return log_and_format_error("export_chat_invite", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Import Chat Invite", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def import_chat_invite(hash: str, account_id: Optional[str] = None) -> str:
    """
    Import a chat invite by hash.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        # Remove any prefixes like '+' if present
        if hash.startswith("+"):
            hash = hash[1:]

        # Try checking the invite before joining
        try:
            from telethon.errors import (
                InviteHashExpiredError,
                InviteHashInvalidError,
                UserAlreadyParticipantError,
                ChatAdminRequiredError,
                UsersTooMuchError,
            )

            # Try to check invite info first (will often fail if not a member)
            invite_info = await c(functions.messages.CheckChatInviteRequest(hash=hash))
            if hasattr(invite_info, "chat") and invite_info.chat:
                # If we got chat info, we're already a member
                chat_title = getattr(invite_info.chat, "title", "Unknown Chat")
                return f"You are already a member of this chat: {chat_title}"
        except Exception as check_err:
            # This often fails if not a member - just continue
            pass

        # Join the chat using the hash
        try:
            result = await c(functions.messages.ImportChatInviteRequest(hash=hash))
            if result and hasattr(result, "chats") and result.chats:
                chat_title = getattr(result.chats[0], "title", "Unknown Chat")
                return f"Successfully joined chat: {chat_title}"
            return f"Joined chat via invite hash."
        except Exception as join_err:
            err_str = str(join_err).lower()
            if "expired" in err_str:
                return "The invite hash has expired and is no longer valid."
            elif "invalid" in err_str:
                return "The invite hash is invalid or malformed."
            elif "already" in err_str and "participant" in err_str:
                return "You are already a member of this chat."
            elif "admin" in err_str:
                return "Cannot join this chat - requires admin approval."
            elif "too much" in err_str or "too many" in err_str:
                return "Cannot join this chat - it has reached maximum number of participants."
            else:
                raise  # Re-raise to be caught by the outer exception handler

    except Exception as e:
        logger.exception(f"import_chat_invite failed (hash={hash})")
        return log_and_format_error("import_chat_invite", e, hash=hash)


@mcp.tool(
    annotations=ToolAnnotations(title="Send Voice", openWorldHint=True, destructiveHint=True)
)
@validate_id("chat_id")
async def send_voice(chat_id: Union[int, str], file_path: str, account_id: Optional[str] = None) -> str:
    """
    Send a voice message to a chat. File must be an OGG/OPUS voice note.

    Args:
        chat_id: The chat ID or username.
        file_path: Absolute path to the OGG/OPUS file.
    """
    try:
        c = await _get_client(account_id)
        if not os.path.isfile(file_path):
            return f"File not found: {file_path}"
        if not os.access(file_path, os.R_OK):
            return f"File is not readable: {file_path}"

        mime, _ = mimetypes.guess_type(file_path)
        if not (
            mime
            and (
                mime == "audio/ogg"
                or file_path.lower().endswith(".ogg")
                or file_path.lower().endswith(".opus")
            )
        ):
            return "Voice file must be .ogg or .opus format."

        entity = await c.get_entity(chat_id)
        await c.send_file(entity, file_path, voice_note=True)
        return f"Voice message sent to chat {chat_id}."
    except Exception as e:
        return log_and_format_error("send_voice", e, chat_id=chat_id, file_path=file_path)


@mcp.tool(
    annotations=ToolAnnotations(title="Forward Message", openWorldHint=True, destructiveHint=True)
)
@validate_id("from_chat_id", "to_chat_id")
async def forward_message(
    from_chat_id: Union[int, str], message_id: int, to_chat_id: Union[int, str], account_id: Optional[str] = None
) -> str:
    """
    Forward a message from one chat to another.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        from_entity = await c.get_entity(from_chat_id)
        to_entity = await c.get_entity(to_chat_id)
        await c.forward_messages(to_entity, message_id, from_entity)
        return f"Message {message_id} forwarded from {from_chat_id} to {to_chat_id}."
    except Exception as e:
        return log_and_format_error(
            "forward_message",
            e,
            from_chat_id=from_chat_id,
            message_id=message_id,
            to_chat_id=to_chat_id,
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Edit Message", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def edit_message(chat_id: Union[int, str], message_id: int, new_text: str, account_id: Optional[str] = None) -> str:
    """
    Edit a message you sent.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        await c.edit_message(entity, message_id, new_text)
        return f"Message {message_id} edited."
    except Exception as e:
        return log_and_format_error(
            "edit_message", e, chat_id=chat_id, message_id=message_id, new_text=new_text
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Delete Message", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def delete_message(chat_id: Union[int, str], message_id: int, account_id: Optional[str] = None) -> str:
    """
    Delete a message by ID.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        await c.delete_messages(entity, message_id)
        return f"Message {message_id} deleted."
    except Exception as e:
        return log_and_format_error("delete_message", e, chat_id=chat_id, message_id=message_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Pin Message", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def pin_message(chat_id: Union[int, str], message_id: int, account_id: Optional[str] = None) -> str:
    """
    Pin a message in a chat.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        await c.pin_message(entity, message_id)
        return f"Message {message_id} pinned in chat {chat_id}."
    except Exception as e:
        return log_and_format_error("pin_message", e, chat_id=chat_id, message_id=message_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Unpin Message", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def unpin_message(chat_id: Union[int, str], message_id: int, account_id: Optional[str] = None) -> str:
    """
    Unpin a message in a chat.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        await c.unpin_message(entity, message_id)
        return f"Message {message_id} unpinned in chat {chat_id}."
    except Exception as e:
        return log_and_format_error("unpin_message", e, chat_id=chat_id, message_id=message_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Mark As Read", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def mark_as_read(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Mark all messages as read in a chat.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        await c.send_read_acknowledge(entity)
        return f"Marked all messages as read in chat {chat_id}."
    except Exception as e:
        return log_and_format_error("mark_as_read", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Reply To Message", openWorldHint=True, destructiveHint=True)
)
@validate_id("chat_id")
async def reply_to_message(chat_id: Union[int, str], message_id: int, text: str, account_id: Optional[str] = None) -> str:
    """
    Reply to a specific message in a chat.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        await _safe_call(c.send_message(entity, text, reply_to=message_id))
        return f"Replied to message {message_id} in chat {chat_id}."
    except Exception as e:
        return log_and_format_error(
            "reply_to_message", e, chat_id=chat_id, message_id=message_id, text=text
        )


@mcp.tool(
    annotations=ToolAnnotations(title="Get Media Info", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def get_media_info(chat_id: Union[int, str], message_id: int, account_id: Optional[str] = None) -> str:
    """
    Get info about media in a message.

    Args:
        chat_id: The chat ID or username.
        message_id: The message ID.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        msg = await c.get_messages(entity, ids=message_id)

        if not msg or not msg.media:
            return "No media found in the specified message."

        return str(msg.media)
    except Exception as e:
        return log_and_format_error("get_media_info", e, chat_id=chat_id, message_id=message_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Search Public Chats", openWorldHint=True, readOnlyHint=True)
)
async def search_public_chats(query: str, account_id: Optional[str] = None) -> str:
    """
    Search for public chats, channels, or bots by username or title.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.contacts.SearchRequest(q=query, limit=20))
        return json.dumps([format_entity(u) for u in result.users], indent=2)
    except Exception as e:
        return log_and_format_error("search_public_chats", e, query=query)


@mcp.tool(
    annotations=ToolAnnotations(title="Search Messages", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def search_messages(chat_id: Union[int, str], query: str, limit: int = 20, account_id: Optional[str] = None) -> str:
    """
    Search for messages in a chat by text.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        messages = await c.get_messages(entity, limit=limit, search=query)

        lines = []
        for msg in messages:
            sender_name = get_sender_name(msg)
            reply_info = ""
            if msg.reply_to and msg.reply_to.reply_to_msg_id:
                reply_info = f" | reply to {msg.reply_to.reply_to_msg_id}"
            lines.append(
                f"ID: {msg.id} | {sender_name} | Date: {msg.date}{reply_info} | Message: {msg.message}"
            )
        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error(
            "search_messages", e, chat_id=chat_id, query=query, limit=limit
        )


@mcp.tool(
    annotations=ToolAnnotations(title="Resolve Username", openWorldHint=True, readOnlyHint=True)
)
async def resolve_username(username: str, account_id: Optional[str] = None) -> str:
    """
    Resolve a username to a user or chat ID.

    Args:
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.contacts.ResolveUsernameRequest(username=username))
        return str(result)
    except Exception as e:
        return log_and_format_error("resolve_username", e, username=username)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Mute Chat", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def mute_chat(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Mute notifications for a chat.
    """
    try:
        c = await _get_client(account_id)
        from telethon.tl.types import InputPeerNotifySettings

        peer = await c.get_entity(chat_id)
        await c(
            functions.account.UpdateNotifySettingsRequest(
                peer=peer, settings=InputPeerNotifySettings(mute_until=2**31 - 1)
            )
        )
        return f"Chat {chat_id} muted."
    except (ImportError, AttributeError) as type_err:
        try:
            # Alternative approach directly using raw API
            peer = await c.get_input_entity(chat_id)
            await c(
                functions.account.UpdateNotifySettingsRequest(
                    peer=peer,
                    settings={
                        "mute_until": 2**31 - 1,  # Far future
                        "show_previews": False,
                        "silent": True,
                    },
                )
            )
            return f"Chat {chat_id} muted (using alternative method)."
        except Exception as alt_e:
            logger.exception(f"mute_chat (alt method) failed (chat_id={chat_id})")
            return log_and_format_error("mute_chat", alt_e, chat_id=chat_id)
    except Exception as e:
        logger.exception(f"mute_chat failed (chat_id={chat_id})")
        return log_and_format_error("mute_chat", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Unmute Chat", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def unmute_chat(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Unmute notifications for a chat.
    """
    try:
        c = await _get_client(account_id)
        from telethon.tl.types import InputPeerNotifySettings

        peer = await c.get_entity(chat_id)
        await c(
            functions.account.UpdateNotifySettingsRequest(
                peer=peer, settings=InputPeerNotifySettings(mute_until=0)
            )
        )
        return f"Chat {chat_id} unmuted."
    except (ImportError, AttributeError) as type_err:
        try:
            # Alternative approach directly using raw API
            peer = await c.get_input_entity(chat_id)
            await c(
                functions.account.UpdateNotifySettingsRequest(
                    peer=peer,
                    settings={
                        "mute_until": 0,  # Unmute (current time)
                        "show_previews": True,
                        "silent": False,
                    },
                )
            )
            return f"Chat {chat_id} unmuted (using alternative method)."
        except Exception as alt_e:
            logger.exception(f"unmute_chat (alt method) failed (chat_id={chat_id})")
            return log_and_format_error("unmute_chat", alt_e, chat_id=chat_id)
    except Exception as e:
        logger.exception(f"unmute_chat failed (chat_id={chat_id})")
        return log_and_format_error("unmute_chat", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Archive Chat", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def archive_chat(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Archive a chat.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        peer = utils.get_input_peer(entity)
        await c(
            functions.folders.EditPeerFoldersRequest(
                folder_peers=[types.InputFolderPeer(peer=peer, folder_id=1)]
            )
        )
        return f"Chat {chat_id} archived."
    except Exception as e:
        return log_and_format_error("archive_chat", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Unarchive Chat", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def unarchive_chat(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Unarchive a chat.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        peer = utils.get_input_peer(entity)
        await c(
            functions.folders.EditPeerFoldersRequest(
                folder_peers=[types.InputFolderPeer(peer=peer, folder_id=0)]
            )
        )
        return f"Chat {chat_id} unarchived."
    except Exception as e:
        return log_and_format_error("unarchive_chat", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Sticker Sets", openWorldHint=True, readOnlyHint=True)
)
async def get_sticker_sets(account_id: Optional[str] = None) -> str:
    """
    Get all sticker sets.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.messages.GetAllStickersRequest(hash=0))
        return json.dumps([s.title for s in result.sets], indent=2)
    except Exception as e:
        return log_and_format_error("get_sticker_sets", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Send Sticker", openWorldHint=True, destructiveHint=True)
)
@validate_id("chat_id")
async def send_sticker(chat_id: Union[int, str], file_path: str, account_id: Optional[str] = None) -> str:
    """
    Send a sticker to a chat. File must be a valid .webp sticker file.

    Args:
        chat_id: The chat ID or username.
        file_path: Absolute path to the .webp sticker file.
    """
    try:
        c = await _get_client(account_id)
        if not os.path.isfile(file_path):
            return f"Sticker file not found: {file_path}"
        if not os.access(file_path, os.R_OK):
            return f"Sticker file is not readable: {file_path}"
        if not file_path.lower().endswith(".webp"):
            return "Sticker file must be a .webp file."

        entity = await c.get_entity(chat_id)
        await c.send_file(entity, file_path, force_document=False)
        return f"Sticker sent to chat {chat_id}."
    except Exception as e:
        return log_and_format_error("send_sticker", e, chat_id=chat_id, file_path=file_path)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Gif Search", openWorldHint=True, readOnlyHint=True)
)
async def get_gif_search(query: str, limit: int = 10, account_id: Optional[str] = None) -> str:
    """
    Search for GIFs by query. Returns a list of Telegram document IDs (not file paths).

    Args:
        query: Search term for GIFs.
        limit: Max number of GIFs to return.
    """
    try:
        c = await _get_client(account_id)
        # Try approach 1: SearchGifsRequest
        try:
            result = await c(
                functions.messages.SearchGifsRequest(q=query, offset_id=0, limit=limit)
            )
            if not result.gifs:
                return "[]"
            return json.dumps(
                [g.document.id for g in result.gifs], indent=2, default=json_serializer
            )
        except (AttributeError, ImportError):
            # Fallback approach: Use SearchRequest with GIF filter
            try:
                from telethon.tl.types import InputMessagesFilterGif

                result = await c(
                    functions.messages.SearchRequest(
                        peer="gif",
                        q=query,
                        filter=InputMessagesFilterGif(),
                        min_date=None,
                        max_date=None,
                        offset_id=0,
                        add_offset=0,
                        limit=limit,
                        max_id=0,
                        min_id=0,
                        hash=0,
                    )
                )
                if not result or not hasattr(result, "messages") or not result.messages:
                    return "[]"
                # Extract document IDs from any messages with media
                gif_ids = []
                for msg in result.messages:
                    if hasattr(msg, "media") and msg.media and hasattr(msg.media, "document"):
                        gif_ids.append(msg.media.document.id)
                return json.dumps(gif_ids, default=json_serializer)
            except Exception as inner_e:
                # Last resort: Try to fetch from a public bot
                return f"Could not search GIFs using available methods: {inner_e}"
    except Exception as e:
        logger.exception(f"get_gif_search failed (query={query}, limit={limit})")
        return log_and_format_error("get_gif_search", e, query=query, limit=limit)


@mcp.tool(annotations=ToolAnnotations(title="Send Gif", openWorldHint=True, destructiveHint=True))
@validate_id("chat_id")
async def send_gif(chat_id: Union[int, str], gif_id: int, account_id: Optional[str] = None) -> str:
    """
    Send a GIF to a chat by Telegram GIF document ID (not a file path).

    Args:
        chat_id: The chat ID or username.
        gif_id: Telegram document ID for the GIF (from get_gif_search).
    """
    try:
        c = await _get_client(account_id)
        if not isinstance(gif_id, int):
            return "gif_id must be a Telegram document ID (integer), not a file path. Use get_gif_search to find IDs."
        entity = await c.get_entity(chat_id)
        await c.send_file(entity, gif_id)
        return f"GIF sent to chat {chat_id}."
    except Exception as e:
        return log_and_format_error("send_gif", e, chat_id=chat_id, gif_id=gif_id)


@mcp.tool(annotations=ToolAnnotations(title="Get Bot Info", openWorldHint=True, readOnlyHint=True))
async def get_bot_info(bot_username: str, account_id: Optional[str] = None) -> str:
    """
    Get information about a bot by username.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(bot_username)
        if not entity:
            return f"Bot with username {bot_username} not found."

        result = await c(functions.users.GetFullUserRequest(id=entity))

        # Create a more structured, serializable response
        if hasattr(result, "to_dict"):
            # Use custom serializer to handle non-serializable types
            return json.dumps(result.to_dict(), indent=2, default=json_serializer)
        else:
            # Fallback if to_dict is not available
            info = {
                "bot_info": {
                    "id": entity.id,
                    "username": entity.username,
                    "first_name": entity.first_name,
                    "last_name": getattr(entity, "last_name", ""),
                    "is_bot": getattr(entity, "bot", False),
                    "verified": getattr(entity, "verified", False),
                }
            }
            if hasattr(result, "full_user") and hasattr(result.full_user, "about"):
                info["bot_info"]["about"] = result.full_user.about
            return json.dumps(info, indent=2)
    except Exception as e:
        logger.exception(f"get_bot_info failed (bot_username={bot_username})")
        return log_and_format_error("get_bot_info", e, bot_username=bot_username)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Set Bot Commands", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def set_bot_commands(bot_username: str, commands: list, account_id: Optional[str] = None) -> str:
    """
    Set bot commands for a bot you own.
    Note: This function can only be used if the Telegram client is a bot account.
    Regular user accounts cannot set bot commands.

    Args:
        bot_username: The username of the bot to set commands for.
        commands: List of command dictionaries with 'command' and 'description' keys.
    """
    try:
        c = await _get_client(account_id)
        # First check if the current client is a bot
        me = await c.get_me()
        if not getattr(me, "bot", False):
            return "Error: This function can only be used by bot accounts. Your current Telegram account is a regular user account, not a bot."

        # Import required types
        from telethon.tl.types import BotCommand, BotCommandScopeDefault
        from telethon.tl.functions.bots import SetBotCommandsRequest

        # Create BotCommand objects from the command dictionaries
        bot_commands = [
            BotCommand(command=c["command"], description=c["description"]) for c in commands
        ]

        # Get the bot entity
        bot = await c.get_entity(bot_username)

        # Set the commands with proper scope
        await c(
            SetBotCommandsRequest(
                scope=BotCommandScopeDefault(),
                lang_code="en",  # Default language code
                commands=bot_commands,
            )
        )

        return f"Bot commands set for {bot_username}."
    except ImportError as ie:
        logger.exception(f"set_bot_commands failed - ImportError: {ie}")
        return log_and_format_error("set_bot_commands", ie)
    except Exception as e:
        logger.exception(f"set_bot_commands failed (bot_username={bot_username})")
        return log_and_format_error("set_bot_commands", e, bot_username=bot_username)


@mcp.tool(annotations=ToolAnnotations(title="Get History", openWorldHint=True, readOnlyHint=True))
@validate_id("chat_id")
async def get_history(chat_id: Union[int, str], limit: int = 100, account_id: Optional[str] = None) -> str:
    """
    Get full chat history (up to limit).
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        messages = await c.get_messages(entity, limit=limit)

        lines = []
        for msg in messages:
            sender_name = get_sender_name(msg)
            reply_info = ""
            if msg.reply_to and msg.reply_to.reply_to_msg_id:
                reply_info = f" | reply to {msg.reply_to.reply_to_msg_id}"
            lines.append(
                f"ID: {msg.id} | {sender_name} | Date: {msg.date}{reply_info} | Message: {msg.message}"
            )
        return "\n".join(lines)
    except Exception as e:
        return log_and_format_error("get_history", e, chat_id=chat_id, limit=limit)


@mcp.tool(
    annotations=ToolAnnotations(title="Get User Photos", openWorldHint=True, readOnlyHint=True)
)
@validate_id("user_id")
async def get_user_photos(user_id: Union[int, str], limit: int = 10, account_id: Optional[str] = None) -> str:
    """
    Get profile photos of a user.
    """
    try:
        c = await _get_client(account_id)
        user = await c.get_entity(user_id)
        photos = await c(
            functions.photos.GetUserPhotosRequest(user_id=user, offset=0, max_id=0, limit=limit)
        )
        return json.dumps([p.id for p in photos.photos], indent=2)
    except Exception as e:
        return log_and_format_error("get_user_photos", e, user_id=user_id, limit=limit)


@mcp.tool(
    annotations=ToolAnnotations(title="Get User Status", openWorldHint=True, readOnlyHint=True)
)
@validate_id("user_id")
async def get_user_status(user_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get the online status of a user.
    """
    try:
        c = await _get_client(account_id)
        user = await c.get_entity(user_id)
        return str(user.status)
    except Exception as e:
        return log_and_format_error("get_user_status", e, user_id=user_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Recent Actions", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def get_recent_actions(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get recent admin actions (admin log) in a group or channel.
    """
    try:
        c = await _get_client(account_id)
        result = await c(
            functions.channels.GetAdminLogRequest(
                channel=chat_id,
                q="",
                events_filter=None,
                admins=[],
                max_id=0,
                min_id=0,
                limit=20,
            )
        )

        if not result or not result.events:
            return "No recent admin actions found."

        # Use the custom serializer to handle datetime objects
        return json.dumps([e.to_dict() for e in result.events], indent=2, default=json_serializer)
    except Exception as e:
        logger.exception(f"get_recent_actions failed (chat_id={chat_id})")
        return log_and_format_error("get_recent_actions", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Get Pinned Messages", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def get_pinned_messages(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Get all pinned messages in a chat.
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        # Use correct filter based on Telethon version
        try:
            # Try newer Telethon approach
            from telethon.tl.types import InputMessagesFilterPinned

            messages = await c.get_messages(entity, filter=InputMessagesFilterPinned())
        except (ImportError, AttributeError):
            # Fallback - try without filter and manually filter pinned
            all_messages = await c.get_messages(entity, limit=50)
            messages = [m for m in all_messages if getattr(m, "pinned", False)]

        if not messages:
            return "No pinned messages found in this chat."

        lines = []
        for msg in messages:
            sender_name = get_sender_name(msg)
            reply_info = ""
            if msg.reply_to and msg.reply_to.reply_to_msg_id:
                reply_info = f" | reply to {msg.reply_to.reply_to_msg_id}"
            lines.append(
                f"ID: {msg.id} | {sender_name} | Date: {msg.date}{reply_info} | Message: {msg.message or '[Media/No text]'}"
            )

        return "\n".join(lines)
    except Exception as e:
        logger.exception(f"get_pinned_messages failed (chat_id={chat_id})")
        return log_and_format_error("get_pinned_messages", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Create Poll", openWorldHint=True, destructiveHint=True)
)
async def create_poll(
    chat_id: int,
    question: str,
    options: list,
    multiple_choice: bool = False,
    quiz_mode: bool = False,
    public_votes: bool = True,
    close_date: str = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Create a poll in a chat using Telegram's native poll feature.

    Args:
        chat_id: The ID of the chat to send the poll to
        question: The poll question
        options: List of answer options (2-10 options)
        multiple_choice: Whether users can select multiple answers
        quiz_mode: Whether this is a quiz (has correct answer)
        public_votes: Whether votes are public
        close_date: Optional close date in ISO format (YYYY-MM-DD HH:MM:SS)
    """
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)

        # Validate options
        if len(options) < 2:
            return "Error: Poll must have at least 2 options."
        if len(options) > 10:
            return "Error: Poll can have at most 10 options."

        # Parse close date if provided
        close_date_obj = None
        if close_date:
            try:
                close_date_obj = datetime.fromisoformat(close_date.replace("Z", "+00:00"))
            except ValueError:
                return f"Invalid close_date format. Use YYYY-MM-DD HH:MM:SS format."

        # Create the poll using InputMediaPoll with SendMediaRequest
        from telethon.tl.types import InputMediaPoll, Poll, PollAnswer, TextWithEntities
        import random

        poll = Poll(
            id=random.randint(0, 2**63 - 1),
            question=TextWithEntities(text=question, entities=[]),
            answers=[
                PollAnswer(text=TextWithEntities(text=option, entities=[]), option=bytes([i]))
                for i, option in enumerate(options)
            ],
            multiple_choice=multiple_choice,
            quiz=quiz_mode,
            public_voters=public_votes,
            close_date=close_date_obj,
        )

        result = await c(
            functions.messages.SendMediaRequest(
                peer=entity,
                media=InputMediaPoll(poll=poll),
                message="",
                random_id=random.randint(0, 2**63 - 1),
            )
        )

        return f"Poll created successfully in chat {chat_id}."
    except Exception as e:
        logger.exception(f"create_poll failed (chat_id={chat_id}, question='{question}')")
        return log_and_format_error(
            "create_poll", e, chat_id=chat_id, question=question, options=options
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Send Reaction", openWorldHint=True, destructiveHint=False, idempotentHint=True
    )
)
@validate_id("chat_id")
async def send_reaction(
    chat_id: Union[int, str],
    message_id: int,
    emoji: str,
    big: bool = False,
    account_id: Optional[str] = None,
) -> str:
    """
    Send a reaction to a message.

    Args:
        chat_id: The chat ID or username
        message_id: The message ID to react to
        emoji: The emoji to react with (e.g., "👍", "❤️", "🔥", "😂", "😮", "😢", "🎉", "💩", "👎")
        big: Whether to show a big animation for the reaction (default: False)
    """
    try:
        c = await _get_client(account_id)
        from telethon.tl.types import ReactionEmoji

        peer = await c.get_input_entity(chat_id)
        await c(
            functions.messages.SendReactionRequest(
                peer=peer,
                msg_id=message_id,
                big=big,
                reaction=[ReactionEmoji(emoticon=emoji)],
            )
        )
        return f"Reaction '{emoji}' sent to message {message_id} in chat {chat_id}."
    except Exception as e:
        logger.exception(
            f"send_reaction failed (chat_id={chat_id}, message_id={message_id}, emoji={emoji})"
        )
        return log_and_format_error(
            "send_reaction", e, chat_id=chat_id, message_id=message_id, emoji=emoji
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Remove Reaction", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def remove_reaction(
    chat_id: Union[int, str],
    message_id: int,
    account_id: Optional[str] = None,
) -> str:
    """
    Remove your reaction from a message.

    Args:
        chat_id: The chat ID or username
        message_id: The message ID to remove reaction from
    """
    try:
        c = await _get_client(account_id)
        peer = await c.get_input_entity(chat_id)
        await c(
            functions.messages.SendReactionRequest(
                peer=peer,
                msg_id=message_id,
                reaction=[],  # Empty list removes reaction
            )
        )
        return f"Reaction removed from message {message_id} in chat {chat_id}."
    except Exception as e:
        logger.exception(f"remove_reaction failed (chat_id={chat_id}, message_id={message_id})")
        return log_and_format_error("remove_reaction", e, chat_id=chat_id, message_id=message_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Get Message Reactions", openWorldHint=True, readOnlyHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def get_message_reactions(
    chat_id: Union[int, str],
    message_id: int,
    limit: int = 50,
    account_id: Optional[str] = None,
) -> str:
    """
    Get the list of reactions on a message.

    Args:
        chat_id: The chat ID or username
        message_id: The message ID to get reactions from
        limit: Maximum number of users to return per reaction (default: 50)
    """
    try:
        c = await _get_client(account_id)
        from telethon.tl.types import ReactionEmoji, ReactionCustomEmoji

        peer = await c.get_input_entity(chat_id)

        result = await c(
            functions.messages.GetMessageReactionsListRequest(
                peer=peer,
                id=message_id,
                limit=limit,
            )
        )

        if not result.reactions:
            return f"No reactions on message {message_id} in chat {chat_id}."

        reactions_data = []
        for reaction in result.reactions:
            user_id = reaction.peer_id.user_id if hasattr(reaction.peer_id, "user_id") else None
            emoji = None
            if isinstance(reaction.reaction, ReactionEmoji):
                emoji = reaction.reaction.emoticon
            elif isinstance(reaction.reaction, ReactionCustomEmoji):
                emoji = f"custom:{reaction.reaction.document_id}"

            reactions_data.append(
                {
                    "user_id": user_id,
                    "emoji": emoji,
                    "date": reaction.date.isoformat() if reaction.date else None,
                }
            )

        return json.dumps(
            {
                "message_id": message_id,
                "chat_id": str(chat_id),
                "reactions": reactions_data,
                "count": len(reactions_data),
            },
            indent=2,
            default=json_serializer,
        )
    except Exception as e:
        logger.exception(
            f"get_message_reactions failed (chat_id={chat_id}, message_id={message_id})"
        )
        return log_and_format_error(
            "get_message_reactions", e, chat_id=chat_id, message_id=message_id
        )


# ============================================================================
# DRAFT MANAGEMENT TOOLS
# ============================================================================


@mcp.tool(
    annotations=ToolAnnotations(
        title="Save Draft", openWorldHint=True, destructiveHint=False, idempotentHint=True
    )
)
@validate_id("chat_id")
async def save_draft(
    chat_id: Union[int, str],
    message: str,
    reply_to_msg_id: Optional[int] = None,
    no_webpage: bool = False,
    account_id: Optional[str] = None,
) -> str:
    """
    Save a draft message to a chat or channel. The draft will appear in the Telegram
    app's input field when you open that chat, allowing you to review and send it manually.

    Args:
        chat_id: The chat ID or username/channel to save the draft to
        message: The draft message text
        reply_to_msg_id: Optional message ID to reply to
        no_webpage: If True, disable link preview in the draft
    """
    try:
        c = await _get_client(account_id)
        peer = await c.get_input_entity(chat_id)

        # Build reply_to parameter if provided
        reply_to = None
        if reply_to_msg_id:
            from telethon.tl.types import InputReplyToMessage

            reply_to = InputReplyToMessage(reply_to_msg_id=reply_to_msg_id)

        await c(
            functions.messages.SaveDraftRequest(
                peer=peer,
                message=message,
                no_webpage=no_webpage,
                reply_to=reply_to,
            )
        )

        return f"Draft saved to chat {chat_id}. Open the chat in Telegram to see and send it."
    except Exception as e:
        logger.exception(f"save_draft failed (chat_id={chat_id})")
        return log_and_format_error("save_draft", e, chat_id=chat_id)


@mcp.tool(annotations=ToolAnnotations(title="Get Drafts", openWorldHint=True, readOnlyHint=True))
async def get_drafts(account_id: Optional[str] = None) -> str:
    """
    Get all draft messages across all chats.
    Returns a list of drafts with their chat info and message content.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.messages.GetAllDraftsRequest())

        # The result contains updates with draft info
        drafts_info = []

        # GetAllDraftsRequest returns Updates object with updates array
        if hasattr(result, "updates"):
            for update in result.updates:
                if hasattr(update, "draft") and update.draft:
                    draft = update.draft
                    peer_id = None

                    # Extract peer ID based on type
                    if hasattr(update, "peer"):
                        peer = update.peer
                        if hasattr(peer, "user_id"):
                            peer_id = peer.user_id
                        elif hasattr(peer, "chat_id"):
                            peer_id = -peer.chat_id
                        elif hasattr(peer, "channel_id"):
                            peer_id = -1000000000000 - peer.channel_id

                    draft_data = {
                        "peer_id": peer_id,
                        "message": getattr(draft, "message", ""),
                        "date": (
                            draft.date.isoformat()
                            if hasattr(draft, "date") and draft.date
                            else None
                        ),
                        "no_webpage": getattr(draft, "no_webpage", False),
                        "reply_to_msg_id": (
                            draft.reply_to.reply_to_msg_id
                            if hasattr(draft, "reply_to") and draft.reply_to
                            else None
                        ),
                    }
                    drafts_info.append(draft_data)

        if not drafts_info:
            return "No drafts found."

        return json.dumps(
            {"drafts": drafts_info, "count": len(drafts_info)}, indent=2, default=json_serializer
        )
    except Exception as e:
        logger.exception("get_drafts failed")
        return log_and_format_error("get_drafts", e)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Clear Draft", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def clear_draft(chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Clear/delete a draft from a specific chat.

    Args:
        chat_id: The chat ID or username to clear the draft from
    """
    try:
        c = await _get_client(account_id)
        peer = await c.get_input_entity(chat_id)

        # Saving an empty message clears the draft
        await c(
            functions.messages.SaveDraftRequest(
                peer=peer,
                message="",
            )
        )

        return f"Draft cleared from chat {chat_id}."
    except Exception as e:
        logger.exception(f"clear_draft failed (chat_id={chat_id})")
        return log_and_format_error("clear_draft", e, chat_id=chat_id)


# ============================================================================
# FOLDER MANAGEMENT TOOLS
# ============================================================================


@mcp.tool(annotations=ToolAnnotations(title="List Folders", openWorldHint=True, readOnlyHint=True))
async def list_folders(account_id: Optional[str] = None) -> str:
    """
    Get all dialog folders (filters) with their IDs, names, and emoji.
    Returns a list of folders that can be used with other folder tools.
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.messages.GetDialogFiltersRequest())

        folders = []
        for f in result.filters:
            # Skip system default folder
            if isinstance(f, DialogFilterDefault):
                continue

            if isinstance(f, DialogFilter):
                # Handle title which can be str or TextWithEntities
                title = f.title
                if isinstance(title, TextWithEntities):
                    title = title.text
                folder_data = {
                    "id": f.id,
                    "title": title,
                    "emoticon": getattr(f, "emoticon", None),
                    "contacts": getattr(f, "contacts", False),
                    "non_contacts": getattr(f, "non_contacts", False),
                    "groups": getattr(f, "groups", False),
                    "broadcasts": getattr(f, "broadcasts", False),
                    "bots": getattr(f, "bots", False),
                    "exclude_muted": getattr(f, "exclude_muted", False),
                    "exclude_read": getattr(f, "exclude_read", False),
                    "exclude_archived": getattr(f, "exclude_archived", False),
                    "included_peers_count": len(getattr(f, "include_peers", [])),
                    "excluded_peers_count": len(getattr(f, "exclude_peers", [])),
                    "pinned_peers_count": len(getattr(f, "pinned_peers", [])),
                }
                folders.append(folder_data)

        if not folders:
            return "No folders found. Create one with create_folder tool."

        return json.dumps(
            {"folders": folders, "count": len(folders)}, indent=2, default=json_serializer
        )
    except Exception as e:
        logger.exception("list_folders failed")
        return log_and_format_error("list_folders", e, ErrorCategory.FOLDER)


@mcp.tool(annotations=ToolAnnotations(title="Get Folder", openWorldHint=True, readOnlyHint=True))
async def get_folder(folder_id: int, account_id: Optional[str] = None) -> str:
    """
    Get detailed information about a specific folder including all included chats.

    Args:
        folder_id: The folder ID (get from list_folders)
    """
    try:
        c = await _get_client(account_id)
        result = await c(functions.messages.GetDialogFiltersRequest())

        target_folder = None
        for f in result.filters:
            if isinstance(f, DialogFilter) and f.id == folder_id:
                target_folder = f
                break

        if not target_folder:
            return (
                f"Folder with ID {folder_id} not found. Use list_folders to see available folders."
            )

        # Resolve included peers to readable names
        included_chats = []
        for peer in getattr(target_folder, "include_peers", []):
            try:
                entity = await c.get_entity(peer)
                chat_info = {
                    "id": entity.id,
                    "name": getattr(entity, "title", None)
                    or getattr(entity, "first_name", "Unknown"),
                    "type": get_entity_type(entity),
                }
                if hasattr(entity, "username") and entity.username:
                    chat_info["username"] = entity.username
                included_chats.append(chat_info)
            except Exception:
                included_chats.append({"id": str(peer), "name": "Unknown", "type": "Unknown"})

        # Resolve excluded peers
        excluded_chats = []
        for peer in getattr(target_folder, "exclude_peers", []):
            try:
                entity = await c.get_entity(peer)
                chat_info = {
                    "id": entity.id,
                    "name": getattr(entity, "title", None)
                    or getattr(entity, "first_name", "Unknown"),
                    "type": get_entity_type(entity),
                }
                excluded_chats.append(chat_info)
            except Exception:
                excluded_chats.append({"id": str(peer), "name": "Unknown", "type": "Unknown"})

        # Resolve pinned peers
        pinned_chats = []
        for peer in getattr(target_folder, "pinned_peers", []):
            try:
                entity = await c.get_entity(peer)
                chat_info = {
                    "id": entity.id,
                    "name": getattr(entity, "title", None)
                    or getattr(entity, "first_name", "Unknown"),
                    "type": get_entity_type(entity),
                }
                pinned_chats.append(chat_info)
            except Exception:
                pinned_chats.append({"id": str(peer), "name": "Unknown", "type": "Unknown"})

        # Handle title which can be str or TextWithEntities
        title = target_folder.title
        if isinstance(title, TextWithEntities):
            title = title.text

        folder_data = {
            "id": target_folder.id,
            "title": title,
            "emoticon": getattr(target_folder, "emoticon", None),
            "filters": {
                "contacts": getattr(target_folder, "contacts", False),
                "non_contacts": getattr(target_folder, "non_contacts", False),
                "groups": getattr(target_folder, "groups", False),
                "broadcasts": getattr(target_folder, "broadcasts", False),
                "bots": getattr(target_folder, "bots", False),
                "exclude_muted": getattr(target_folder, "exclude_muted", False),
                "exclude_read": getattr(target_folder, "exclude_read", False),
                "exclude_archived": getattr(target_folder, "exclude_archived", False),
            },
            "included_chats": included_chats,
            "excluded_chats": excluded_chats,
            "pinned_chats": pinned_chats,
        }

        return json.dumps(folder_data, indent=2, default=json_serializer)
    except Exception as e:
        logger.exception(f"get_folder failed (folder_id={folder_id})")
        return log_and_format_error("get_folder", e, ErrorCategory.FOLDER, folder_id=folder_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Create Folder", openWorldHint=True, destructiveHint=True, idempotentHint=False
    )
)
async def create_folder(
    title: str,
    emoticon: Optional[str] = None,
    chat_ids: Optional[List[Union[int, str]]] = None,
    contacts: bool = False,
    non_contacts: bool = False,
    groups: bool = False,
    broadcasts: bool = False,
    bots: bool = False,
    exclude_muted: bool = False,
    exclude_read: bool = False,
    exclude_archived: bool = True,
    account_id: Optional[str] = None,
) -> str:
    """
    Create a new dialog folder.

    Args:
        title: Folder name (required)
        emoticon: Folder emoji (optional, e.g., "📁", "🏠", "💼")
        chat_ids: List of chat IDs or usernames to include (optional)
        contacts: Include all contacts
        non_contacts: Include all non-contacts
        groups: Include all groups
        broadcasts: Include all channels
        bots: Include all bots
        exclude_muted: Exclude muted chats
        exclude_read: Exclude read chats
        exclude_archived: Exclude archived chats (default True)
    """
    try:
        c = await _get_client(account_id)
        # Get existing folders to check count and find next ID
        result = await c(functions.messages.GetDialogFiltersRequest())

        existing_ids = set()
        folder_count = 0
        for f in result.filters:
            if isinstance(f, DialogFilter):
                existing_ids.add(f.id)
                folder_count += 1

        # Telegram limit: max 10 custom folders
        if folder_count >= 10:
            return "Cannot create folder: Telegram limit is 10 folders. Delete one first."

        # Find next available ID (IDs 0 and 1 are reserved for system)
        new_id = 2
        while new_id in existing_ids:
            new_id += 1

        # Resolve chat_ids to input peers
        include_peers = []
        if chat_ids:
            for chat_id in chat_ids:
                try:
                    peer = await c.get_input_entity(chat_id)
                    include_peers.append(peer)
                except Exception as e:
                    return f"Failed to resolve chat '{chat_id}': {str(e)}"

        # Create the folder (title must be TextWithEntities)
        title_obj = TextWithEntities(text=title, entities=[])
        new_filter = DialogFilter(
            id=new_id,
            title=title_obj,
            emoticon=emoticon,
            pinned_peers=[],
            include_peers=include_peers,
            exclude_peers=[],
            contacts=contacts,
            non_contacts=non_contacts,
            groups=groups,
            broadcasts=broadcasts,
            bots=bots,
            exclude_muted=exclude_muted,
            exclude_read=exclude_read,
            exclude_archived=exclude_archived,
        )

        await c(functions.messages.UpdateDialogFilterRequest(id=new_id, filter=new_filter))

        return json.dumps(
            {
                "success": True,
                "folder_id": new_id,
                "title": title,
                "emoticon": emoticon,
                "included_chats_count": len(include_peers),
            },
            indent=2,
        )
    except Exception as e:
        logger.exception(f"create_folder failed (title={title})")
        return log_and_format_error("create_folder", e, ErrorCategory.FOLDER, title=title)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Add Chat to Folder", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
@validate_id("chat_id")
async def add_chat_to_folder(
    folder_id: int, chat_id: Union[int, str], pinned: bool = False,
    account_id: Optional[str] = None,
) -> str:
    """
    Add a chat to an existing folder.

    Args:
        folder_id: The folder ID (get from list_folders)
        chat_id: Chat ID or username to add
        pinned: Pin the chat in this folder (default False)
    """
    try:
        c = await _get_client(account_id)
        # Get the folder
        result = await c(functions.messages.GetDialogFiltersRequest())

        target_folder = None
        for f in result.filters:
            if isinstance(f, DialogFilter) and f.id == folder_id:
                target_folder = f
                break

        if not target_folder:
            return (
                f"Folder with ID {folder_id} not found. Use list_folders to see available folders."
            )

        # Resolve chat to input peer
        try:
            peer = await c.get_input_entity(chat_id)
        except Exception as e:
            return f"Failed to resolve chat '{chat_id}': {str(e)}"

        # Check if already included (idempotent)
        include_peers = list(getattr(target_folder, "include_peers", []))
        pinned_peers = list(getattr(target_folder, "pinned_peers", []))

        # Get peer ID for comparison
        peer_id = utils.get_peer_id(peer)
        already_included = any(utils.get_peer_id(p) == peer_id for p in include_peers)
        already_pinned = any(utils.get_peer_id(p) == peer_id for p in pinned_peers)

        if already_included and (not pinned or already_pinned):
            return f"Chat {chat_id} is already in folder {folder_id}."

        # Add to appropriate list
        if not already_included:
            include_peers.append(peer)
        if pinned and not already_pinned:
            pinned_peers.append(peer)

        # Update the folder (keep all original attributes)
        updated_filter = DialogFilter(
            id=target_folder.id,
            title=target_folder.title,
            emoticon=getattr(target_folder, "emoticon", None),
            pinned_peers=pinned_peers,
            include_peers=include_peers,
            exclude_peers=list(getattr(target_folder, "exclude_peers", [])),
            contacts=getattr(target_folder, "contacts", False),
            non_contacts=getattr(target_folder, "non_contacts", False),
            groups=getattr(target_folder, "groups", False),
            broadcasts=getattr(target_folder, "broadcasts", False),
            bots=getattr(target_folder, "bots", False),
            exclude_muted=getattr(target_folder, "exclude_muted", False),
            exclude_read=getattr(target_folder, "exclude_read", False),
            exclude_archived=getattr(target_folder, "exclude_archived", False),
            title_noanimate=getattr(target_folder, "title_noanimate", None),
            color=getattr(target_folder, "color", None),
        )

        await c(
            functions.messages.UpdateDialogFilterRequest(id=folder_id, filter=updated_filter)
        )

        return (
            f"Chat {chat_id} added to folder {folder_id}" + (" (pinned)" if pinned else "") + "."
        )
    except Exception as e:
        logger.exception(f"add_chat_to_folder failed (folder_id={folder_id}, chat_id={chat_id})")
        return log_and_format_error(
            "add_chat_to_folder", e, ErrorCategory.FOLDER, folder_id=folder_id, chat_id=chat_id
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Remove Chat from Folder",
        openWorldHint=True,
        destructiveHint=True,
        idempotentHint=True,
    )
)
@validate_id("chat_id")
async def remove_chat_from_folder(folder_id: int, chat_id: Union[int, str], account_id: Optional[str] = None) -> str:
    """
    Remove a chat from a folder.

    Args:
        folder_id: The folder ID (get from list_folders)
        chat_id: Chat ID or username to remove
    """
    try:
        c = await _get_client(account_id)
        # Get the folder
        result = await c(functions.messages.GetDialogFiltersRequest())

        target_folder = None
        for f in result.filters:
            if isinstance(f, DialogFilter) and f.id == folder_id:
                target_folder = f
                break

        if not target_folder:
            return (
                f"Folder with ID {folder_id} not found. Use list_folders to see available folders."
            )

        # Resolve chat to get peer ID
        try:
            peer = await c.get_input_entity(chat_id)
            peer_id = utils.get_peer_id(peer)
        except Exception as e:
            return f"Failed to resolve chat '{chat_id}': {str(e)}"

        # Filter out the peer from both include and pinned lists
        include_peers = [
            p
            for p in getattr(target_folder, "include_peers", [])
            if utils.get_peer_id(p) != peer_id
        ]
        pinned_peers = [
            p
            for p in getattr(target_folder, "pinned_peers", [])
            if utils.get_peer_id(p) != peer_id
        ]

        original_include_count = len(getattr(target_folder, "include_peers", []))
        original_pinned_count = len(getattr(target_folder, "pinned_peers", []))

        # Check if anything was removed (idempotent)
        if (
            len(include_peers) == original_include_count
            and len(pinned_peers) == original_pinned_count
        ):
            return f"Chat {chat_id} was not in folder {folder_id}."

        # Update the folder (keep all original attributes)
        updated_filter = DialogFilter(
            id=target_folder.id,
            title=target_folder.title,
            emoticon=getattr(target_folder, "emoticon", None),
            pinned_peers=pinned_peers,
            include_peers=include_peers,
            exclude_peers=list(getattr(target_folder, "exclude_peers", [])),
            contacts=getattr(target_folder, "contacts", False),
            non_contacts=getattr(target_folder, "non_contacts", False),
            groups=getattr(target_folder, "groups", False),
            broadcasts=getattr(target_folder, "broadcasts", False),
            bots=getattr(target_folder, "bots", False),
            exclude_muted=getattr(target_folder, "exclude_muted", False),
            exclude_read=getattr(target_folder, "exclude_read", False),
            exclude_archived=getattr(target_folder, "exclude_archived", False),
            title_noanimate=getattr(target_folder, "title_noanimate", None),
            color=getattr(target_folder, "color", None),
        )

        await c(
            functions.messages.UpdateDialogFilterRequest(id=folder_id, filter=updated_filter)
        )

        return f"Chat {chat_id} removed from folder {folder_id}."
    except Exception as e:
        logger.exception(
            f"remove_chat_from_folder failed (folder_id={folder_id}, chat_id={chat_id})"
        )
        return log_and_format_error(
            "remove_chat_from_folder",
            e,
            ErrorCategory.FOLDER,
            folder_id=folder_id,
            chat_id=chat_id,
        )


@mcp.tool(
    annotations=ToolAnnotations(
        title="Delete Folder", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def delete_folder(folder_id: int, account_id: Optional[str] = None) -> str:
    """
    Delete a folder. Chats in the folder are preserved, only the folder is removed.

    Args:
        folder_id: The folder ID to delete (get from list_folders)
    """
    try:
        c = await _get_client(account_id)
        # System folders (id < 2) cannot be deleted
        if folder_id < 2:
            return f"Cannot delete system folder (ID {folder_id}). Only custom folders can be deleted."

        # Check if folder exists
        result = await c(functions.messages.GetDialogFiltersRequest())

        folder_exists = False
        folder_title = None
        for f in result.filters:
            if isinstance(f, DialogFilter) and f.id == folder_id:
                folder_exists = True
                # Handle title which can be str or TextWithEntities
                title = f.title
                if isinstance(title, TextWithEntities):
                    title = title.text
                folder_title = title
                break

        if not folder_exists:
            return f"Folder with ID {folder_id} not found (may already be deleted)."

        # Delete by passing None as filter
        await c(functions.messages.UpdateDialogFilterRequest(id=folder_id, filter=None))

        return f"Folder '{folder_title}' (ID {folder_id}) deleted. Chats are preserved."
    except Exception as e:
        logger.exception(f"delete_folder failed (folder_id={folder_id})")
        return log_and_format_error("delete_folder", e, ErrorCategory.FOLDER, folder_id=folder_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Reorder Folders", openWorldHint=True, destructiveHint=True, idempotentHint=True
    )
)
async def reorder_folders(folder_ids: List[int], account_id: Optional[str] = None) -> str:
    """
    Change the order of folders in the folder list.

    Args:
        folder_ids: List of folder IDs in the desired order
    """
    try:
        c = await _get_client(account_id)
        # Get existing folders to validate
        result = await c(functions.messages.GetDialogFiltersRequest())

        existing_ids = set()
        for f in result.filters:
            if isinstance(f, DialogFilter):
                existing_ids.add(f.id)

        # Validate all provided IDs exist
        for fid in folder_ids:
            if fid not in existing_ids:
                return f"Folder ID {fid} not found. Use list_folders to see available folders."

        # Validate all existing folders are included
        if set(folder_ids) != existing_ids:
            missing = existing_ids - set(folder_ids)
            return f"All folder IDs must be included. Missing: {missing}"

        # Reorder
        await c(functions.messages.UpdateDialogFiltersOrderRequest(order=folder_ids))

        return f"Folders reordered: {folder_ids}"
    except Exception as e:
        logger.exception(f"reorder_folders failed (folder_ids={folder_ids})")
        return log_and_format_error(
            "reorder_folders", e, ErrorCategory.FOLDER, folder_ids=folder_ids
        )


# ---------------------------------------------------------------------------
#  Neurocommenting: channel discussion discovery + auto-comment on posts
# ---------------------------------------------------------------------------

_TG_LINK_RE = re.compile(
    r"(?:https?://)?t\.me/(?:c/(\d+)/(\d+)|(\w+)/(\d+))"
)


def _parse_tg_link(link: str) -> Optional[Dict[str, Any]]:
    """Parse a t.me link into chat_id and message_id.
    Returns {'chat_id': int|str, 'msg_id': int, 'is_private': bool} or None."""
    m = _TG_LINK_RE.search(link)
    if not m:
        return None
    if m.group(1):
        return {"chat_id": int(m.group(1)), "msg_id": int(m.group(2)), "is_private": True}
    return {"chat_id": m.group(3), "msg_id": int(m.group(4)), "is_private": False}


async def _resolve_channel_and_post(
    c: TelegramClient, channel: Union[int, str], post_id: Optional[int]
) -> Dict[str, Any]:
    """Resolve channel entity and post_id.
    Handles the case where the user gives a discussion-group link instead of
    the channel link: detects that the entity is a megagroup (not broadcast),
    walks up to the linked broadcast channel, and finds the real channel post_id
    via GetDiscussionMessageRequest reverse lookup."""
    result: Dict[str, Any] = {"steps": []}

    if isinstance(channel, str):
        parsed = _parse_tg_link(channel)
        if parsed:
            raw_id = parsed["chat_id"]
            if isinstance(raw_id, int):
                channel = int(f"-100{raw_id}")
            else:
                channel = raw_id
            if post_id is None:
                post_id = parsed["msg_id"]
            result["steps"].append(f"Parsed link: chat={channel}, msg={post_id}")

    entity = await c.get_entity(channel)

    if not isinstance(entity, Channel):
        result["error"] = f"Entity is not a channel/supergroup (type: {get_entity_type(entity)})."
        return result

    is_broadcast = getattr(entity, "broadcast", False)
    is_megagroup = getattr(entity, "megagroup", False)

    if is_broadcast:
        result["channel"] = entity
        result["channel_post_id"] = post_id
        return result

    if is_megagroup:
        result["steps"].append(
            f"'{getattr(entity, 'title', '')}' is a discussion group, not a channel. Looking up the parent channel..."
        )
        full = await c(functions.channels.GetFullChannelRequest(channel=entity))
        parent_id = getattr(full.full_chat, "linked_chat_id", None)
        if not parent_id:
            result["error"] = "This group has no linked broadcast channel."
            return result

        parent = next((ch for ch in full.chats if ch.id == parent_id), None)
        if not parent:
            parent = await c.get_entity(int(f"-100{parent_id}"))

        result["steps"].append(
            f"Found parent channel: '{getattr(parent, 'title', '')}' (ID: {parent.id})"
        )

        if post_id:
            try:
                disc_msg = await c(functions.messages.GetDiscussionMessageRequest(
                    peer=parent, msg_id=post_id
                ))
                if disc_msg and disc_msg.messages:
                    result["steps"].append(
                        f"Discussion msg_id {post_id} in group → maps to channel post #{post_id} (via GetDiscussionMessage)"
                    )
            except Exception:
                pass

            channel_msgs = await c.get_messages(parent, limit=50)
            mapped_post_id = None
            for cm in channel_msgs:
                if not cm:
                    continue
                try:
                    disc = await c(functions.messages.GetDiscussionMessageRequest(
                        peer=parent, msg_id=cm.id
                    ))
                    if disc and disc.messages:
                        for dm in disc.messages:
                            if dm.id == post_id:
                                mapped_post_id = cm.id
                                break
                    if mapped_post_id:
                        break
                except Exception:
                    continue

            if mapped_post_id:
                result["steps"].append(
                    f"Mapped discussion msg #{post_id} → channel post #{mapped_post_id}"
                )
                post_id = mapped_post_id
            else:
                result["steps"].append(
                    f"Could not map discussion msg #{post_id} to a channel post. "
                    f"Will try using it as channel post_id directly."
                )

        result["channel"] = parent
        result["channel_post_id"] = post_id
        return result

    result["error"] = f"Entity type not supported: {get_entity_type(entity)}"
    return result


@mcp.tool(
    annotations=ToolAnnotations(
        title="Get Discussion Chat", openWorldHint=True, readOnlyHint=True
    )
)
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def get_discussion_chat(
    channel: str, account_id: Optional[str] = None
) -> str:
    """
    Get the linked discussion group (comment chat) for a broadcast channel.

    Args:
        channel: Channel ID, @username, or t.me link (e.g. @channel, https://t.me/c/123456/78).
        account_id: Session name from list_accounts. Omit for default account.
    """
    try:
        c = await _get_client(account_id)

        ch_id: Union[int, str] = channel
        parsed = _parse_tg_link(channel)
        if parsed:
            raw = parsed["chat_id"]
            ch_id = int(f"-100{raw}") if isinstance(raw, int) else raw

        entity = await c.get_entity(ch_id)

        if isinstance(entity, Channel) and getattr(entity, "megagroup", False):
            full = await c(functions.channels.GetFullChannelRequest(channel=entity))
            parent_id = getattr(full.full_chat, "linked_chat_id", None)
            if parent_id:
                parent = next((ch for ch in full.chats if ch.id == parent_id), None)
                if not parent:
                    parent = await c.get_entity(int(f"-100{parent_id}"))
                entity = parent

        if not isinstance(entity, Channel) or not getattr(entity, "broadcast", False):
            return f"Entity is not a broadcast channel (type: {get_entity_type(entity)})."

        full = await c(functions.channels.GetFullChannelRequest(channel=entity))
        linked_id = getattr(full.full_chat, "linked_chat_id", None)

        if not linked_id:
            return f"Channel '{getattr(entity, 'title', '')}' (ID: {entity.id}) has no discussion group."

        linked_entity = next((ch for ch in full.chats if ch.id == linked_id), None)
        if not linked_entity:
            try:
                linked_entity = await c.get_entity(int(f"-100{linked_id}"))
            except Exception:
                return f"Discussion group ID: {linked_id}. Channel: {getattr(entity, 'title', '')} ({entity.id})."

        title = getattr(linked_entity, "title", "Unknown")
        username = getattr(linked_entity, "username", None)
        ustr = f"@{username}" if username else "private"

        return (
            f"Channel: {getattr(entity, 'title', '')} (ID: {entity.id})\n"
            f"Discussion group: {title} (ID: {linked_id}, {ustr})\n"
            f"Use comment_on_post to leave comments on posts."
        )
    except Exception as e:
        return log_and_format_error("get_discussion_chat", e, channel=channel)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Comment on Channel Post",
        openWorldHint=True,
        destructiveHint=True,
    )
)
@tool_timeout(60)
async def comment_on_post(
    channel: str,
    comment: str,
    post_id: Optional[int] = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Leave a comment on a channel post. Subscribes to the channel and joins the
    discussion group automatically if needed.

    Accepts ANY t.me link — both channel links (t.me/c/CHANNEL_ID/POST)
    and discussion-group links (t.me/c/GROUP_ID/MSG). The tool automatically
    resolves the correct channel and post.

    Args:
        channel: Channel/group ID, @username, or ANY t.me link to a post.
        comment: The comment text to post.
        post_id: Post ID in the CHANNEL (not discussion group). Usually auto-detected from link.
        account_id: Session name from list_accounts. Omit for default account.
    """
    steps: list[str] = []
    resolved_post_id = post_id
    try:
        c = await _get_client(account_id)

        res = await _resolve_channel_and_post(c, channel, post_id)
        steps.extend(res.get("steps", []))

        if "error" in res:
            steps.append(f"Error: {res['error']}")
            return "\n".join(steps)

        entity = res["channel"]
        resolved_post_id = res.get("channel_post_id")
        ch_title = getattr(entity, "title", str(channel))

        # --- subscribe to channel ---
        try:
            await _safe_call(c(functions.channels.JoinChannelRequest(channel=entity)))
            steps.append(f"Subscribed to channel '{ch_title}'")
        except telethon.errors.rpcerrorlist.UserAlreadyParticipantError:
            steps.append(f"Already subscribed to '{ch_title}'")
        except Exception as join_err:
            steps.append(f"Channel subscribe note: {join_err}")

        # --- get discussion group ---
        full = await c(functions.channels.GetFullChannelRequest(channel=entity))
        linked_id = getattr(full.full_chat, "linked_chat_id", None)
        if not linked_id:
            steps.append("Channel has no linked discussion group — cannot comment.")
            return "\n".join(steps)

        discussion = next((ch for ch in full.chats if ch.id == linked_id), None)
        if not discussion:
            try:
                discussion = await c.get_entity(int(f"-100{linked_id}"))
            except Exception:
                steps.append(f"Cannot access discussion group (ID: {linked_id}).")
                return "\n".join(steps)

        disc_title = getattr(discussion, "title", str(linked_id))

        # --- join discussion group ---
        try:
            await _safe_call(c(functions.channels.JoinChannelRequest(channel=discussion)))
            steps.append(f"Joined discussion '{disc_title}'")
        except telethon.errors.rpcerrorlist.UserAlreadyParticipantError:
            steps.append(f"Already in '{disc_title}'")
        except Exception as dj_err:
            steps.append(f"Discussion join note: {dj_err}")

        # --- resolve target post in channel ---
        if resolved_post_id:
            target_msg = await c.get_messages(entity, ids=resolved_post_id)
            if isinstance(target_msg, list):
                target_msg = target_msg[0] if target_msg else None
            if not target_msg:
                steps.append(f"Post #{resolved_post_id} not found in channel '{ch_title}'.")
                return "\n".join(steps)
        else:
            msgs = await c.get_messages(entity, limit=5)
            target_msg = next((m for m in msgs if m and m.message), None)
            if not target_msg:
                steps.append("No recent text posts found in channel.")
                return "\n".join(steps)

        resolved_post_id = target_msg.id
        preview = (target_msg.message or "")[:80]
        steps.append(f"Target: channel post #{resolved_post_id}: \"{preview}{'…' if len(target_msg.message or '') > 80 else ''}\"")

        # --- send comment via channel entity with comment_to (Telethon routes it to discussion) ---
        await _safe_call(c.send_message(entity, comment, comment_to=resolved_post_id))
        steps.append(f"Comment posted: \"{comment}\"")

        return "\n".join(steps)

    except Exception as e:
        steps.append(f"Error: {e!s}")
        logger.exception(f"comment_on_post failed (channel={channel}, post_id={resolved_post_id})")
        return "\n".join(steps)


# ---------------------------------------------------------------------------
#  Post view boosting: multi-account view increment
# ---------------------------------------------------------------------------

def _chunked(items: List[str], size: int) -> List[List[str]]:
    size = max(1, int(size))
    return [items[i:i + size] for i in range(0, len(items), size)]


async def _view_posts_from_account(aid: str, peer: Union[int, str], ids: List[int]) -> tuple:
    if aid in _failed_accounts:
        return aid, False, "skipped (failed)"
    try:
        c = await _get_client(aid)
        if not c.is_connected():
            await c.connect()
        await _safe_call(
            c(
                functions.messages.GetMessagesViewsRequest(
                    peer=peer,
                    id=ids,
                    increment=True,
                )
            )
        )
        return aid, True, "+1 view OK"
    except Exception as e:
        return aid, False, f"error - {str(e)[:80]}"


@mcp.tool(
    annotations=ToolAnnotations(title="View Posts", openWorldHint=True, destructiveHint=True)
)
@tool_timeout(120)
async def view_posts(
    channel: str,
    post_ids: str,
    account_ids: Optional[str] = None,
) -> str:
    """
    Increment view counters on channel posts using multiple accounts.
    Each account adds roughly one view per post.

    Args:
        channel: Channel username (@channel), t.me link, or numeric ID.
        post_ids: Comma-separated post IDs (e.g. "123,124,125") or a single ID.
        account_ids: Comma-separated account IDs to use (default: all available accounts).
    """
    ids = [int(x.strip()) for x in post_ids.split(",") if x.strip().isdigit()]
    if not ids:
        return "Error: no valid post IDs provided. Pass comma-separated integers."

    parsed = _parse_tg_link(channel) if isinstance(channel, str) else None
    if parsed:
        raw = parsed["chat_id"]
        peer = int(f"-100{raw}") if isinstance(raw, int) else raw
    else:
        peer = channel

    if account_ids:
        targets = [a.strip() for a in account_ids.split(",") if a.strip()]
    else:
        targets = sorted(MULTI_ACCOUNT_CLIENTS.keys())

    if not targets:
        return "No accounts available. Add accounts first."

    delay = _smooth_config.get("delay_between_accounts", 8)
    max_parallel = max(1, int(_smooth_config.get("max_parallel", 1) or 1))
    results = []
    success_count = 0
    fail_count = 0

    batches = _chunked(targets, max_parallel)
    for i, batch in enumerate(batches):
        batch_results = await asyncio.gather(
            *[_view_posts_from_account(aid, peer, ids) for aid in batch]
        )
        for aid, ok, detail in batch_results:
            if ok:
                success_count += 1
            else:
                fail_count += 1
            results.append(f"  {aid}: {detail}")

        if i < len(batches) - 1 and _smooth_config.get("enabled", True) and delay > 0:
            await asyncio.sleep(delay)

    header = (
        f"View boost for {len(ids)} post(s) in '{channel}':\n"
        f"Accounts used: {len(targets)}, success: {success_count}, failed: {fail_count}\n"
        f"Estimated views added: ~{success_count}\n"
    )
    return header + "\n".join(results)


@mcp.tool(
    annotations=ToolAnnotations(title="View Posts Quick", openWorldHint=True, destructiveHint=True)
)
@tool_timeout(60)
async def view_posts_quick(
    channel: str,
    count: int = 10,
    account_ids: Optional[str] = None,
) -> str:
    """
    View the latest N posts in a channel to boost their view counters.
    Fetches the last `count` posts, then views them from multiple accounts.
    Args:
        channel: Channel username (@channel), t.me link, or numeric ID.
        count: Number of latest posts to view (default 10, max 100).
        account_ids: Comma-separated account IDs to use (default: all available).
    """
    count = max(1, min(count, 100))

    parsed = _parse_tg_link(channel) if isinstance(channel, str) else None
    if parsed:
        raw = parsed["chat_id"]
        peer = int(f"-100{raw}") if isinstance(raw, int) else raw
    else:
        peer = channel

    if account_ids:
        targets = [a.strip() for a in account_ids.split(",") if a.strip()]
    else:
        targets = sorted(MULTI_ACCOUNT_CLIENTS.keys())

    if not targets:
        return "No accounts available."

    first_ok = None
    for aid in targets:
        if aid not in _failed_accounts:
            try:
                first_ok = await _get_client(aid)
                break
            except Exception:
                continue
    if not first_ok:
        return "No working account to fetch posts."

    try:
        if not first_ok.is_connected():
            await first_ok.connect()
        msgs = await first_ok.get_messages(peer, limit=count)
    except Exception as e:
        return f"Error fetching posts: {e}"

    if not msgs:
        return "No posts found in channel."

    ids = [m.id for m in msgs if m.id]
    if not ids:
        return "No valid post IDs found."

    delay = _smooth_config.get("delay_between_accounts", 8)
    success_count = 0
    fail_count = 0
    details = []

    for i, aid in enumerate(targets):
        if aid in _failed_accounts:
            fail_count += 1
            continue
        try:
            c = await _get_client(aid)
            if not c.is_connected():
                await c.connect()
            await c(functions.messages.GetMessagesViewsRequest(
                peer=peer,
                id=ids,
                increment=True,
            ))
            success_count += 1
        except Exception as e:
            details.append(f"  {aid}: {str(e)[:60]}")
            fail_count += 1

        if i < len(targets) - 1 and delay > 0:
            await asyncio.sleep(delay)

    result = (
        f"Viewed {len(ids)} latest posts in '{channel}':\n"
        f"Post IDs: {', '.join(str(x) for x in ids[:20])}{'...' if len(ids) > 20 else ''}\n"
        f"Accounts: {len(targets)}, success: {success_count}, failed: {fail_count}\n"
        f"Estimated views added per post: ~{success_count}"
    )
    if details:
        result += "\n\nErrors:\n" + "\n".join(details)
    return result


# ---------------------------------------------------------------------------
# Assistant-style memory tools.
#
# These tools intentionally do not embed a second Telegram bot or an LLM agent.
# MCP clients such as Claude/OpenClou/Hermes remain the agent layer; this server
# provides local memory, search, context, and confirmable Telegram actions.
# ---------------------------------------------------------------------------

def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


def _row_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _entity_arg(value: Union[int, str]) -> Union[int, str]:
    if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
        return int(value)
    return value


async def _validate_custom_emoji_access(c: TelegramClient, post: pf.FormattedPost) -> None:
    if not post.custom_emojis:
        return
    me = await c.get_me()
    if not getattr(me, "premium", False):
        raise ValueError("Telegram Premium is required to publish custom premium emojis")


def _validated_media_path(media_path: Optional[str]) -> Optional[str]:
    if media_path is None:
        return None
    normalized = os.path.realpath(os.path.abspath(os.path.expanduser(str(media_path))))
    if not os.path.isfile(normalized):
        raise ValueError(f"media file was not found: {normalized}")
    if not os.access(normalized, os.R_OK):
        raise ValueError(f"media file is not readable: {normalized}")
    return normalized


def _media_preview(media_path: Optional[str], force_document: bool) -> Optional[Dict[str, Any]]:
    if not media_path:
        return None
    mime_type, _ = mimetypes.guess_type(media_path)
    return {
        "path": media_path,
        "mime_type": mime_type,
        "as_document": bool(force_document),
    }


async def _send_pending_rich_post(
    c: TelegramClient, entity: Any, payload: Dict[str, Any]
) -> tuple[Any, str]:
    if not payload.get("rich_post"):
        sent = await _safe_call(
            c.send_message(
                entity,
                payload["message"],
                reply_to=payload.get("reply_to_msg_id"),
            )
        )
        return sent, payload["message"]

    media_path = _validated_media_path(payload.get("media_path"))
    max_length = pf.MAX_CAPTION_UTF16_LENGTH if media_path else pf.MAX_MESSAGE_UTF16_LENGTH
    post = pf.parse_post(
        payload["message"], payload.get("format_mode", "plain"), max_utf16_length=max_length
    )
    await _validate_custom_emoji_access(c, post)
    if media_path:
        send_kwargs: Dict[str, Any] = {
            "caption": post.text,
            "reply_to": payload.get("reply_to_msg_id"),
            "formatting_entities": post.entities,
            "silent": bool(payload.get("silent", False)),
            "force_document": bool(payload.get("force_document", False)),
        }
        send_as = payload.get("send_as")
        if send_as:
            send_kwargs["send_as"] = await c.get_input_entity(_entity_arg(send_as))
        sent = await _safe_call(c.send_file(entity, media_path, **send_kwargs))
        return sent, post.text

    send_kwargs: Dict[str, Any] = {
        "reply_to": payload.get("reply_to_msg_id"),
        "formatting_entities": post.entities,
        "link_preview": bool(payload.get("link_preview", True)),
        "silent": bool(payload.get("silent", False)),
    }
    send_as = payload.get("send_as")
    if send_as:
        send_kwargs["send_as"] = await c.get_input_entity(_entity_arg(send_as))
    sent = await _safe_call(c.send_message(entity, post.text, **send_kwargs))
    return sent, post.text


async def _get_assistant_client_and_account(
    account_id: Optional[str] = None,
) -> tuple[TelegramClient, str]:
    c = await _get_client(account_id)
    if account_id:
        return c, am.account_key(account_id)
    if c is client:
        return c, am.DEFAULT_ACCOUNT_KEY
    for aid, candidate in MULTI_ACCOUNT_CLIENTS.items():
        if candidate is c:
            return c, aid
    return c, am.DEFAULT_ACCOUNT_KEY


def _chat_payload(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "peer_id": row["peer_id"],
        "kind": row["peer_kind"],
        "title": row["title"],
        "username": row["username"],
        "is_archived": bool(row["is_archived"]),
        "is_news_source": bool(row["is_news_source"]),
        "last_message_id": row["last_message_id"],
        "last_synced_at": row["last_synced_at"],
    }


def _message_payload(row: sqlite3.Row) -> Dict[str, Any]:
    body = row["transcript"] or row["text"] or row["extracted_text"] or ""
    return {
        "peer_id": row["peer_id"],
        "chat_title": row["chat_title"] if "chat_title" in row.keys() else None,
        "message_id": row["message_id"],
        "sender_id": row["sender_id"],
        "sender_name": row["sender_name"],
        "is_outgoing": bool(row["is_outgoing"]),
        "date": row["date"],
        "kind": row["kind"],
        "text": body,
    }


async def _assistant_sync_messages_for_entity(
    c: TelegramClient,
    conn: sqlite3.Connection,
    account_key: str,
    entity: Any,
    *,
    limit: int,
) -> int:
    limit = max(1, min(int(limit), 1000))
    pid = am.peer_id(entity)
    am.upsert_chat(
        conn,
        account_id=account_key,
        peer_id=pid,
        peer_kind=am.peer_kind(entity),
        title=am.display_name(entity),
        username=getattr(entity, "username", None),
    )
    messages = await c.get_messages(entity, limit=limit)
    count = 0
    for msg in messages:
        if not getattr(msg, "id", None):
            continue
        sender_name = get_sender_name(msg)
        extra = {
            "views": getattr(msg, "views", None),
            "forwards": getattr(msg, "forwards", None),
            "reply_to": getattr(getattr(msg, "reply_to", None), "reply_to_msg_id", None),
        }
        am.upsert_message(
            conn,
            account_id=account_key,
            peer_id=pid,
            message_id=msg.id,
            sender_id=getattr(msg, "sender_id", None),
            sender_name=sender_name if sender_name != "Unknown" else None,
            is_outgoing=bool(getattr(msg, "out", False)),
            date=getattr(msg, "date", None),
            kind=am.message_kind(msg),
            text=am.message_text(msg),
            extra=extra,
        )
        count += 1
    return count


async def _assistant_resolve_chat(
    c: TelegramClient,
    conn: sqlite3.Connection,
    account_key: str,
    chat_id: Union[int, str],
) -> tuple[Any, str, str]:
    entity = await c.get_entity(_entity_arg(chat_id))
    pid = am.peer_id(entity)
    title = am.display_name(entity)
    am.upsert_chat(
        conn,
        account_id=account_key,
        peer_id=pid,
        peer_kind=am.peer_kind(entity),
        title=title,
        username=getattr(entity, "username", None),
    )
    return entity, pid, title


def _content_call_account(account_id: Optional[str]) -> Optional[str]:
    key = cw.account_key(account_id)
    return None if key == cw.DEFAULT_ACCOUNT_KEY else key


def _content_entity_arg(value: Union[int, str]) -> Union[int, str]:
    if isinstance(value, str):
        parsed = _parse_tg_link(value)
        if parsed:
            raw = parsed["chat_id"]
            return int(f"-100{raw}") if isinstance(raw, int) else raw
        text = value.strip()
        match = re.search(r"(?:https?://)?t\.me/([A-Za-z0-9_]{5,})(?:/)?$", text)
        if match:
            return match.group(1)
    return _entity_arg(value)


def _content_default_research_account() -> str:
    default_account = oc.load_config().get("default_account_id", cw.DEFAULT_ACCOUNT_KEY)
    with cw.connect() as conn:
        return cw.get_config(conn, default_account_id=default_account)["research_account_id"]


def _content_default_target() -> Optional[Dict[str, Any]]:
    with cw.connect() as conn:
        targets = cw.list_channels(conn, kind="target", enabled_only=True, limit=2)
    return targets[0] if len(targets) == 1 else None


@mcp.tool(
    annotations=ToolAnnotations(
        title="Content Workflow Config",
        openWorldHint=False,
        readOnlyHint=False,
    )
)
def content_workflow_config(
    research_account_id: Optional[str] = None,
    similarity_threshold: Optional[float] = None,
) -> str:
    """
    Show or update content workflow settings.

    Args:
        research_account_id: Main account used to read selected source channels.
        similarity_threshold: Duplicate guard threshold, 0.5..1.0. Default is 0.84.
    """
    try:
        default_account = oc.load_config().get("default_account_id", cw.DEFAULT_ACCOUNT_KEY)
        with cw.connect() as conn:
            if research_account_id is not None or similarity_threshold is not None:
                cw.set_config(
                    conn,
                    research_account_id=research_account_id,
                    similarity_threshold=similarity_threshold,
                )
                conn.commit()
            config = cw.get_config(conn, default_account_id=default_account)
            stats = cw.stats(conn)
        return _json({"ok": True, "config": config, "stats": stats})
    except Exception as e:
        return log_and_format_error("content_workflow_config", e)


async def _content_upsert_channel(
    *,
    kind: str,
    chat_id: Union[int, str],
    account_id: Optional[str],
    title: Optional[str],
    enabled: bool,
    notes: Optional[str],
) -> Dict[str, Any]:
    c, account_key = await _get_assistant_client_and_account(_content_call_account(account_id))
    entity = await c.get_entity(_content_entity_arg(chat_id))
    peer = am.peer_id(entity)
    label = title or am.display_name(entity)
    with cw.connect() as conn:
        channel = cw.upsert_channel(
            conn,
            kind=kind,
            account_id=account_key,
            chat_id=peer,
            peer_id=peer,
            title=label,
            username=getattr(entity, "username", None),
            enabled=enabled,
            notes=notes,
        )
        conn.commit()
    return channel


@mcp.tool(
    annotations=ToolAnnotations(title="Content Add Source", openWorldHint=True, readOnlyHint=False)
)
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def content_add_source(
    chat_id: Union[int, str],
    account_id: Optional[str] = None,
    title: Optional[str] = None,
    enabled: bool = True,
    notes: Optional[str] = None,
) -> str:
    """
    Register a Telegram channel/chat as research source.

    If account_id is omitted, the configured research account is used.
    """
    try:
        account = account_id or _content_default_research_account()
        channel = await _content_upsert_channel(
            kind="source",
            chat_id=chat_id,
            account_id=account,
            title=title,
            enabled=enabled,
            notes=notes,
        )
        return _json({"ok": True, "source": channel})
    except Exception as e:
        return log_and_format_error("content_add_source", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Add Target", openWorldHint=True, readOnlyHint=False)
)
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def content_add_target(
    chat_id: Union[int, str],
    account_id: Optional[str] = None,
    title: Optional[str] = None,
    enabled: bool = True,
    notes: Optional[str] = None,
) -> str:
    """
    Register a Telegram channel/chat as a publishing target.
    """
    try:
        default_account = oc.load_config().get("default_account_id", cw.DEFAULT_ACCOUNT_KEY)
        channel = await _content_upsert_channel(
            kind="target",
            chat_id=chat_id,
            account_id=account_id or default_account,
            title=title,
            enabled=enabled,
            notes=notes,
        )
        return _json({"ok": True, "target": channel})
    except Exception as e:
        return log_and_format_error("content_add_target", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Content List Channels", openWorldHint=False, readOnlyHint=True)
)
def content_list_channels(
    kind: Optional[str] = None,
    enabled_only: bool = False,
    limit: int = 100,
) -> str:
    """
    List configured content source/target channels.
    """
    try:
        with cw.connect() as conn:
            channels = cw.list_channels(
                conn,
                kind=kind,
                enabled_only=enabled_only,
                limit=limit,
            )
        return _json({"ok": True, "channels": channels})
    except Exception as e:
        return log_and_format_error("content_list_channels", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Set Channel Enabled", openWorldHint=False, readOnlyHint=False)
)
def content_set_channel_enabled(
    kind: str,
    chat_id: Union[int, str],
    enabled: bool,
    account_id: Optional[str] = None,
) -> str:
    """
    Enable or disable a configured source/target channel.
    """
    try:
        with cw.connect() as conn:
            account = account_id
            if account is None:
                existing = [
                    channel
                    for channel in cw.list_channels(conn, kind=kind, enabled_only=False, limit=500)
                    if str(chat_id)
                    in {
                        str(channel.get("chat_id")),
                        str(channel.get("peer_id")),
                        str(channel.get("title")),
                        str(channel.get("username")),
                    }
                ]
                account = existing[0]["account_id"] if existing else cw.DEFAULT_ACCOUNT_KEY
            channel = cw.set_channel_enabled(
                conn,
                kind=kind,
                chat_id=chat_id,
                account_id=account,
                enabled=enabled,
            )
            conn.commit()
        return _json({"ok": bool(channel), "channel": channel})
    except Exception as e:
        return log_and_format_error("content_set_channel_enabled", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Sync Sources", openWorldHint=True, readOnlyHint=False)
)
@tool_timeout(120)
async def content_sync_sources(
    limit_per_source: int = 20,
    source_chat_id: Optional[Union[int, str]] = None,
) -> str:
    """
    Pull recent posts from enabled research sources into the content DB.

    The configured source account is used per channel. Text posts are stored
    as source material for later rewriting.
    """
    try:
        limit_per_source = max(1, min(int(limit_per_source), 200))
        source_filter = str(source_chat_id).strip().lstrip("@") if source_chat_id is not None else None
        with cw.connect() as conn:
            channels = cw.list_channels(conn, kind="source", enabled_only=True, limit=500)
        if source_filter:
            channels = [
                channel
                for channel in channels
                if source_filter
                in {
                    str(channel.get("chat_id")).strip().lstrip("@"),
                    str(channel.get("peer_id")).strip().lstrip("@"),
                    str(channel.get("title")).strip().lstrip("@"),
                    str(channel.get("username")).strip().lstrip("@"),
                }
            ]
        results = []
        total_stored = 0
        for channel in channels:
            stored = 0
            c, account_key = await _get_assistant_client_and_account(
                _content_call_account(channel.get("account_id"))
            )
            entity = await c.get_entity(_content_entity_arg(channel["peer_id"] or channel["chat_id"]))
            peer = am.peer_id(entity)
            title = am.display_name(entity)
            messages = await c.get_messages(entity, limit=limit_per_source)
            with cw.connect() as conn:
                cw.upsert_channel(
                    conn,
                    kind="source",
                    account_id=account_key,
                    chat_id=peer,
                    peer_id=peer,
                    title=title,
                    username=getattr(entity, "username", None),
                    enabled=True,
                )
                for msg in messages:
                    text = am.message_text(msg)
                    if not text or not str(text).strip():
                        continue
                    cw.store_post(
                        conn,
                        role="source",
                        status="synced",
                        account_id=account_key,
                        chat_id=peer,
                        peer_id=peer,
                        chat_title=title,
                        message_id=getattr(msg, "id", None),
                        message_date=getattr(msg, "date", None),
                        text=text,
                        meta={
                            "views": getattr(msg, "views", None),
                            "forwards": getattr(msg, "forwards", None),
                        },
                    )
                    stored += 1
                conn.commit()
            total_stored += stored
            results.append(
                {
                    "source": {"peer_id": peer, "title": title, "account_id": account_key},
                    "stored_text_posts": stored,
                }
            )
        return _json(
            {
                "ok": True,
                "sources": len(channels),
                "stored_text_posts": total_stored,
                "results": results,
            }
        )
    except Exception as e:
        return log_and_format_error("content_sync_sources", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Research Context", openWorldHint=False, readOnlyHint=True)
)
def content_research_context(
    limit: int = 20,
    unused_only: bool = False,
    source_chat_id: Optional[Union[int, str]] = None,
) -> str:
    """
    Return stored source posts and recent own drafts/published posts for an MCP agent.
    """
    try:
        default_account = oc.load_config().get("default_account_id", cw.DEFAULT_ACCOUNT_KEY)
        with cw.connect() as conn:
            config = cw.get_config(conn, default_account_id=default_account)
            sources = cw.list_channels(conn, kind="source", enabled_only=True, limit=200)
            targets = cw.list_channels(conn, kind="target", enabled_only=True, limit=200)
            source_posts = cw.research_posts(
                conn,
                limit=limit,
                unused_only=unused_only,
                source_chat_id=source_chat_id,
            )
            recent_history = cw.list_posts(conn, role="published", limit=20, include_text=False)
            drafts = cw.list_posts(conn, role="draft", limit=20, include_text=False)
        return _json(
            {
                "ok": True,
                "config": config,
                "sources": sources,
                "targets": targets,
                "source_posts": source_posts,
                "recent_published": recent_history,
                "recent_drafts": drafts,
                "agent_instruction": (
                    "Use source_posts as research material, write a transformed draft, "
                    "then call content_create_draft to run duplicate checks."
                ),
            }
        )
    except Exception as e:
        return log_and_format_error("content_research_context", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Similarity Check", openWorldHint=False, readOnlyHint=True)
)
def content_similarity_check(
    text: str,
    threshold: Optional[float] = None,
    roles: Optional[str] = None,
    limit: int = 10,
    format_mode: str = "plain",
) -> str:
    """
    Check whether text is identical or strongly similar to stored content.

    Args:
        roles: Optional comma-separated roles: source,draft,published.
        format_mode: plain, html, or markdown. Formatting is excluded from similarity scoring.
    """
    try:
        post = pf.parse_post(text, format_mode)
        role_list = [role.strip() for role in roles.split(",")] if roles else None
        with cw.connect() as conn:
            matches = cw.find_similar_posts(
                conn,
                post.text,
                threshold=threshold,
                roles=role_list,
                limit=limit,
            )
            config = cw.get_config(conn)
        return _json(
            {
                "ok": True,
                "blocked": bool(matches),
                "threshold": threshold or config["similarity_threshold"],
                "matches": matches,
                "formatting": pf.preview(post),
            }
        )
    except Exception as e:
        return log_and_format_error("content_similarity_check", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Create Draft", openWorldHint=False, readOnlyHint=False)
)
def content_create_draft(
    text: str,
    target_chat_id: Optional[Union[int, str]] = None,
    target_account_id: Optional[str] = None,
    source_post_id: Optional[int] = None,
    threshold: Optional[float] = None,
    allow_similar: bool = False,
    format_mode: str = "plain",
    media_path: Optional[str] = None,
    force_document: bool = False,
) -> str:
    """
    Store a draft only after checking it against source/draft/published history.

    If one enabled target exists and target_chat_id is omitted, it is used.
    format_mode supports plain, html, and markdown. HTML supports Telegram
    formatting plus premium emoji tags such as <tg-emoji emoji-id="123">🔥</tg-emoji>.
    """
    try:
        normalized_media_path = _validated_media_path(media_path)
        max_length = pf.MAX_CAPTION_UTF16_LENGTH if normalized_media_path else pf.MAX_MESSAGE_UTF16_LENGTH
        post = pf.parse_post(text, format_mode, max_utf16_length=max_length)
        target_title = None
        target = None
        if target_chat_id is None:
            target = _content_default_target()
            if target:
                target_chat_id = target["chat_id"]
                target_account_id = target_account_id or target["account_id"]
                target_title = target["title"]
        with cw.connect() as conn:
            result = cw.create_draft(
                conn,
                text=post.text,
                target_chat_id=target_chat_id,
                target_account_id=target_account_id,
                target_title=target_title,
                source_post_id=source_post_id,
                threshold=threshold,
                allow_similar=allow_similar,
                meta={
                    "auto_target": bool(target),
                    "format_mode": post.mode,
                    "formatted_text": post.source if post.mode != "plain" else None,
                    "custom_emojis": post.custom_emojis,
                    "media_path": normalized_media_path,
                    "force_document": bool(force_document),
                },
            )
            conn.commit()
        result["formatting"] = pf.preview(post)
        result["media"] = _media_preview(normalized_media_path, force_document)
        return _json(result)
    except Exception as e:
        return log_and_format_error("content_create_draft", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Prepare Publish", openWorldHint=True, destructiveHint=False)
)
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def content_prepare_publish(
    draft_id: int,
    target_chat_id: Optional[Union[int, str]] = None,
    target_account_id: Optional[str] = None,
    reply_to_msg_id: Optional[int] = None,
    format_mode: Optional[str] = None,
    silent: bool = False,
    link_preview: bool = True,
    send_as: Optional[Union[int, str]] = None,
    media_path: Optional[str] = None,
    force_document: Optional[bool] = None,
) -> str:
    """
    Convert a stored content draft into a pending Telegram send action.

    This does not send anything. Use assistant_confirm_action only after human approval.
    """
    try:
        with cw.connect() as content_conn:
            draft = cw.get_post(content_conn, draft_id)
            if not draft:
                raise ValueError(f"draft {draft_id} not found")
            if draft["role"] != "draft":
                raise ValueError(f"post {draft_id} is not a draft")
            draft_meta = draft.get("meta") or {}
            chosen_format = format_mode or draft_meta.get("format_mode", "plain")
            formatted_source = draft_meta.get("formatted_text") or draft["text"]
            chosen_media_path = _validated_media_path(media_path or draft_meta.get("media_path"))
            chosen_force_document = (
                bool(force_document)
                if force_document is not None
                else bool(draft_meta.get("force_document", False))
            )
            max_length = (
                pf.MAX_CAPTION_UTF16_LENGTH if chosen_media_path else pf.MAX_MESSAGE_UTF16_LENGTH
            )
            post = pf.parse_post(formatted_source, chosen_format, max_utf16_length=max_length)
            target_chat = target_chat_id or draft.get("chat_id")
            target_account = target_account_id or draft.get("account_id")
            if not target_chat:
                target = _content_default_target()
                if target:
                    target_chat = target["chat_id"]
                    target_account = target_account or target["account_id"]
            if not target_chat:
                raise ValueError("target_chat_id is required when the draft has no target")

        c, account_key = await _get_assistant_client_and_account(_content_call_account(target_account))
        await _validate_custom_emoji_access(c, post)
        with am.connect() as conn:
            _, peer, title = await _assistant_resolve_chat(c, conn, account_key, target_chat)
            action_id = am.create_pending_action(
                conn,
                action_type="send_message",
                account_id=account_key,
                target_chat=peer,
                target_label=title,
                payload={
                    "chat_id": peer,
                    "message": post.source,
                    "reply_to_msg_id": reply_to_msg_id,
                    "content_draft_id": int(draft_id),
                    "rich_post": True,
                    "format_mode": post.mode,
                    "silent": bool(silent),
                    "link_preview": bool(link_preview),
                    "send_as": send_as,
                    "media_path": chosen_media_path,
                    "force_document": chosen_force_document,
                },
            )
            conn.commit()
        with cw.connect() as content_conn:
            cw.set_post_status(content_conn, draft_id, "pending")
            content_conn.commit()
        return _json(
            {
                "ok": True,
                "pending_action_id": action_id,
                "draft_id": draft_id,
                "target": {"peer_id": peer, "title": title, "account_id": account_key},
                "formatting": pf.preview(post),
                "delivery": {
                    "silent": bool(silent),
                    "link_preview": bool(link_preview),
                    "send_as": send_as,
                },
                "media": _media_preview(chosen_media_path, chosen_force_document),
                "next_step": f"Call assistant_confirm_action(action_id={action_id}) only after explicit approval.",
            }
        )
    except Exception as e:
        return log_and_format_error("content_prepare_publish", e, draft_id=draft_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Post Formatting Help", openWorldHint=False, readOnlyHint=True)
)
def post_formatting_help() -> str:
    """Show supported Telegram post formatting and premium emoji syntax."""
    return _json(
        {
            "ok": True,
            "format_modes": ["plain", "html", "markdown"],
            "html_examples": {
                "bold": "<b>Important</b>",
                "italic": "<i>Context</i>",
                "underline": "<u>Highlight</u>",
                "strike": "<s>Old</s>",
                "quote": "<blockquote>Quoted text</blockquote>",
                "link": '<a href="https://example.com">Open link</a>',
                "premium_emoji": '<tg-emoji emoji-id="123456789">🔥</tg-emoji>',
            },
            "rules": [
                "A premium emoji tag must wrap its fallback emoji only.",
                "Use post_extract_custom_emojis on an existing message to obtain document_id values.",
                "Premium emojis require a Telegram Premium account for personal-session publishing.",
                "Use post_preview before post_prepare_send or content_prepare_publish.",
                "Pass media_path for a photo or document with a formatted caption (1024 UTF-16 characters maximum).",
                "Images are photos by default; use force_document=true only to preserve the original file.",
            ],
        }
    )


@mcp.tool(
    annotations=ToolAnnotations(title="Post Preview", openWorldHint=False, readOnlyHint=True)
)
def post_preview(text: str, format_mode: str = "html") -> str:
    """Parse and validate a Telegram post without creating a pending action or sending it."""
    try:
        return _json({"ok": True, "preview": pf.preview(pf.parse_post(text, format_mode))})
    except Exception as e:
        return log_and_format_error("post_preview", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Post Extract Custom Emojis", openWorldHint=True, readOnlyHint=True)
)
@validate_id("chat_id")
async def post_extract_custom_emojis(
    chat_id: Union[int, str], message_id: int, account_id: Optional[str] = None
) -> str:
    """Extract reusable premium custom-emoji document IDs from an existing Telegram message."""
    try:
        c = await _get_client(account_id)
        entity = await c.get_entity(chat_id)
        message = await c.get_messages(entity, ids=int(message_id))
        if not message:
            raise ValueError(f"message {message_id} was not found")
        return _json(
            {
                "ok": True,
                "chat_id": str(chat_id),
                "message_id": int(message_id),
                "custom_emojis": pf.custom_emojis_from_message(message),
            }
        )
    except Exception as e:
        return log_and_format_error("post_extract_custom_emojis", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Post Prepare Send", openWorldHint=True, destructiveHint=False)
)
@validate_id("chat_id")
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def post_prepare_send(
    chat_id: Union[int, str],
    text: str,
    format_mode: str = "html",
    account_id: Optional[str] = None,
    reply_to_msg_id: Optional[int] = None,
    silent: bool = False,
    link_preview: bool = True,
    send_as: Optional[Union[int, str]] = None,
    media_path: Optional[str] = None,
    force_document: bool = False,
) -> str:
    """
    Create a formatted Telegram post pending action.

    Supports HTML or Markdown formatting, link-preview control, silent delivery,
    and <tg-emoji emoji-id="...">fallback emoji</tg-emoji> premium emoji tags.
    This does not send anything; confirm through assistant_confirm_action.
    """
    try:
        normalized_media_path = _validated_media_path(media_path)
        max_length = pf.MAX_CAPTION_UTF16_LENGTH if normalized_media_path else pf.MAX_MESSAGE_UTF16_LENGTH
        post = pf.parse_post(text, format_mode, max_utf16_length=max_length)
        c, account_key = await _get_assistant_client_and_account(account_id)
        await _validate_custom_emoji_access(c, post)
        with am.connect() as conn:
            _, peer, title = await _assistant_resolve_chat(c, conn, account_key, chat_id)
            action_id = am.create_pending_action(
                conn,
                action_type="send_message",
                account_id=account_key,
                target_chat=peer,
                target_label=title,
                payload={
                    "chat_id": peer,
                    "message": post.source,
                    "reply_to_msg_id": reply_to_msg_id,
                    "rich_post": True,
                    "format_mode": post.mode,
                    "silent": bool(silent),
                    "link_preview": bool(link_preview),
                    "send_as": send_as,
                    "media_path": normalized_media_path,
                    "force_document": bool(force_document),
                },
            )
            conn.commit()
        return _json(
            {
                "ok": True,
                "pending_action_id": action_id,
                "target": {"peer_id": peer, "title": title, "account_id": account_key},
                "preview": pf.preview(post),
                "delivery": {
                    "silent": bool(silent),
                    "link_preview": bool(link_preview),
                    "send_as": send_as,
                },
                "media": _media_preview(normalized_media_path, force_document),
                "next_step": f"Call assistant_confirm_action(action_id={action_id}) only after explicit approval.",
            }
        )
    except Exception as e:
        return log_and_format_error("post_prepare_send", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Posts", openWorldHint=False, readOnlyHint=True)
)
def content_posts(
    role: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
    include_text: bool = False,
) -> str:
    """
    List stored source posts, drafts, or published history.
    """
    try:
        with cw.connect() as conn:
            posts = cw.list_posts(
                conn,
                role=role,
                status=status,
                limit=limit,
                include_text=include_text,
            )
            stats = cw.stats(conn)
        return _json({"ok": True, "posts": posts, "stats": stats})
    except Exception as e:
        return log_and_format_error("content_posts", e)


@mcp.tool(
    annotations=ToolAnnotations(title="Content Import History", openWorldHint=False, readOnlyHint=False)
)
def content_import_history(
    posts_json: str,
    default_role: str = "published",
    default_account_id: Optional[str] = None,
) -> str:
    """
    Import old posts into the duplicate-check database.

    posts_json must be a JSON array of objects with at least a text field.
    """
    try:
        posts = json.loads(posts_json)
        if not isinstance(posts, list):
            raise ValueError("posts_json must be a JSON array")
        with cw.connect() as conn:
            imported = cw.import_history(
                conn,
                posts,
                default_role=default_role,
                default_account_id=default_account_id,
            )
            conn.commit()
        return _json({"ok": True, "imported": len(imported), "posts": imported})
    except Exception as e:
        return log_and_format_error("content_import_history", e)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Assistant Sync Memory",
        openWorldHint=True,
        readOnlyHint=False,
    )
)
@tool_timeout(120)
async def assistant_sync_memory(
    chat_limit: int = 100,
    messages_per_chat: int = 0,
    include_archived: bool = False,
    account_id: Optional[str] = None,
) -> str:
    """
    Build local assistant memory from Telegram dialogs.

    This stores chat metadata in TELEGRAM_MCP_ASSISTANT_DB. If
    messages_per_chat > 0, it also prefetches recent messages for each dialog.
    No LLM and no control bot are involved; MCP clients use this cache for fast
    search, summaries, catchup, reminders, and news contexts.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        chat_limit = max(1, min(int(chat_limit), 500))
        messages_per_chat = max(0, min(int(messages_per_chat), 300))
        synced_chats = 0
        synced_messages = 0
        skipped_archived = 0
        with am.connect() as conn:
            dialogs = await c.get_dialogs(limit=chat_limit)
            for dialog in dialogs:
                entity = dialog.entity
                if not include_archived and am.dialog_is_archived(dialog):
                    skipped_archived += 1
                    continue
                last_msg = getattr(dialog, "message", None)
                am.upsert_chat(
                    conn,
                    account_id=account_key,
                    peer_id=am.peer_id(entity),
                    peer_kind=am.peer_kind(entity),
                    title=am.display_name(entity),
                    username=getattr(entity, "username", None),
                    is_archived=am.dialog_is_archived(dialog),
                    last_message_id=getattr(last_msg, "id", None),
                )
                synced_chats += 1
                if messages_per_chat:
                    synced_messages += await _assistant_sync_messages_for_entity(
                        c, conn, account_key, entity, limit=messages_per_chat
                    )
            conn.commit()
        return _json(
            {
                "ok": True,
                "account_id": account_key,
                "synced_chats": synced_chats,
                "synced_messages": synced_messages,
                "skipped_archived": skipped_archived,
                "database": am.DB_PATH,
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_sync_memory", e, account_id=account_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Assistant Sync Chat",
        openWorldHint=True,
        readOnlyHint=False,
    )
)
@validate_id("chat_id")
@tool_timeout(90)
async def assistant_sync_chat(
    chat_id: Union[int, str],
    limit: int = 200,
    account_id: Optional[str] = None,
) -> str:
    """
    Prefetch recent messages from one chat into the local assistant memory.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        with am.connect() as conn:
            entity, pid, title = await _assistant_resolve_chat(c, conn, account_key, chat_id)
            count = await _assistant_sync_messages_for_entity(
                c, conn, account_key, entity, limit=limit
            )
            conn.commit()
        return _json(
            {
                "ok": True,
                "account_id": account_key,
                "peer_id": pid,
                "title": title,
                "synced_messages": count,
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_sync_chat", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Assistant Memory Search",
        openWorldHint=False,
        readOnlyHint=True,
    )
)
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def assistant_search_memory(
    query: str,
    chat_id: Optional[Union[int, str]] = None,
    limit: int = 50,
    account_id: Optional[str] = None,
) -> str:
    """
    Search the local SQLite/FTS memory. Run assistant_sync_memory or
    assistant_sync_chat first to fill the cache.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        peer = None
        with am.connect() as conn:
            if chat_id is not None:
                try:
                    _, peer, _ = await _assistant_resolve_chat(c, conn, account_key, chat_id)
                except Exception:
                    peer = str(chat_id)
            rows = am.search_messages(conn, account_key, query, peer_id=peer, limit=limit)
        return _json(
            {
                "ok": True,
                "account_id": account_key,
                "query": query,
                "chat_id": peer,
                "hits": [
                    {
                        **_message_payload(row),
                        "snippet": row["snippet"] if "snippet" in row.keys() else None,
                    }
                    for row in rows
                ],
                "agent_hint": "Use hits as source material; if context is too thin, call assistant_sync_chat on the relevant peer_id.",
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_search_memory", e, query=query)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Assistant Chat Context",
        openWorldHint=True,
        readOnlyHint=True,
    )
)
@validate_id("chat_id")
@tool_timeout(90)
async def assistant_get_chat_context(
    chat_id: Union[int, str],
    limit: int = 80,
    mode: str = "summary",
    sync_latest: bool = True,
    account_id: Optional[str] = None,
) -> str:
    """
    Return compact chat context for an external agent to summarize, catch up,
    extract tasks, or draft a reply. mode: summary | catchup | draft | tasks | style.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        with am.connect() as conn:
            entity, peer, title = await _assistant_resolve_chat(c, conn, account_key, chat_id)
            if sync_latest:
                await _assistant_sync_messages_for_entity(c, conn, account_key, entity, limit=limit)
                conn.commit()
            rows = am.recent_messages(conn, account_key, peer, limit=limit)
            chat = am.get_chat(conn, account_key, peer)
        prompts = {
            "summary": "Summarize the chat: main points, open questions, agreements, tone. Do not invent facts.",
            "catchup": "Explain where the conversation stopped, what awaits my answer, and draft a concise reply if appropriate.",
            "draft": "Draft a reply in my name using only the context. If key facts are missing, ask one short clarification.",
            "tasks": "Extract explicit commitments/tasks only. Mark direction as mine/theirs and include deadlines only if present.",
            "style": "Infer a brief style profile from my outgoing messages: tone, length, greetings, emoji, directness.",
        }
        mode_key = (mode or "summary").lower()
        return _json(
            {
                "ok": True,
                "account_id": account_key,
                "mode": mode_key,
                "chat": _chat_payload(chat) if chat else {"peer_id": peer, "title": title},
                "messages": [_message_payload(row) for row in rows],
                "agent_instruction": prompts.get(mode_key, prompts["summary"]),
                "safety": "For visible Telegram actions, prepare a pending action first and call assistant_confirm_action only after user approval.",
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_get_chat_context", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Assistant Prepare Send",
        openWorldHint=True,
        destructiveHint=False,
    )
)
@validate_id("chat_id")
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def assistant_prepare_send(
    chat_id: Union[int, str],
    message: str,
    reply_to_msg_id: Optional[int] = None,
    account_id: Optional[str] = None,
    format_mode: str = "plain",
    silent: bool = False,
    link_preview: bool = True,
    send_as: Optional[Union[int, str]] = None,
    media_path: Optional[str] = None,
    force_document: bool = False,
) -> str:
    """
    Create a pending send action with optional Telegram HTML or Markdown formatting.

    This does not send anything. Use assistant_confirm_action(action_id) after
    human approval. Premium custom emojis require a Premium personal account.
    """
    try:
        normalized_media_path = _validated_media_path(media_path)
        max_length = pf.MAX_CAPTION_UTF16_LENGTH if normalized_media_path else pf.MAX_MESSAGE_UTF16_LENGTH
        post = pf.parse_post(message, format_mode, max_utf16_length=max_length)
        c, account_key = await _get_assistant_client_and_account(account_id)
        await _validate_custom_emoji_access(c, post)
        with am.connect() as conn:
            _, peer, title = await _assistant_resolve_chat(c, conn, account_key, chat_id)
            action_id = am.create_pending_action(
                conn,
                action_type="send_message",
                account_id=account_key,
                target_chat=peer,
                target_label=title,
                payload={
                    "chat_id": peer,
                    "message": post.source,
                    "reply_to_msg_id": reply_to_msg_id,
                    "rich_post": True,
                    "format_mode": post.mode,
                    "silent": bool(silent),
                    "link_preview": bool(link_preview),
                    "send_as": send_as,
                    "media_path": normalized_media_path,
                    "force_document": bool(force_document),
                },
            )
            conn.commit()
        return _json(
            {
                "ok": True,
                "pending_action_id": action_id,
                "action_type": "send_message",
                "target": {"peer_id": peer, "title": title},
                "preview": pf.preview(post),
                "delivery": {
                    "silent": bool(silent),
                    "link_preview": bool(link_preview),
                    "send_as": send_as,
                },
                "media": _media_preview(normalized_media_path, force_document),
                "next_step": f"Call assistant_confirm_action(action_id={action_id}) only after explicit approval.",
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_prepare_send", e, chat_id=chat_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Assistant Confirm Action",
        openWorldHint=True,
        destructiveHint=True,
    )
)
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def assistant_confirm_action(action_id: int) -> str:
    """
    Execute a pending Telegram or Maton action after explicit approval.
    """
    try:
        with am.connect() as conn:
            action = am.get_pending_action(conn, action_id)
            if action is None:
                return f"Pending action {action_id} not found."
            if action["status"] != "pending":
                return f"Pending action {action_id} is already {action['status']}."
            payload = json.loads(action["payload_json"])
            account_id = action["account_id"]
            action_type = action["action_type"]

        if action_type == "maton_connection_create":
            result = await mt.MatonClient().create_connection(
                app=payload["app"], method=payload.get("method", "OAUTH2")
            )
            connection = result.get("connection", result)
            if not isinstance(connection, dict):
                raise mt.MatonAPIError("Maton create connection returned invalid connection data")
            with am.connect() as conn:
                am.resolve_pending_action(conn, action_id, "sent")
                conn.commit()
            return _json(
                {
                    "ok": True,
                    "action_id": action_id,
                    "status": "sent",
                    "connection": mt.summarize_connection(
                        connection, include_authorization_url=True
                    ),
                    "next_step": "Open authorization_url in a browser and complete the provider consent flow.",
                }
            )

        if action_type == "maton_request":
            result = await mt.MatonClient().request(
                method=payload["method"],
                app=payload["app"],
                connection_id=payload["connection_id"],
                path=payload["path"],
                body=payload.get("body"),
                headers=payload.get("headers"),
            )
            with am.connect() as conn:
                am.resolve_pending_action(conn, action_id, "sent")
                conn.commit()
            return _json(
                {
                    "ok": True,
                    "action_id": action_id,
                    "status": "sent",
                    "request": {
                        "app": payload["app"],
                        "connection_id": payload["connection_id"],
                        "method": payload["method"],
                        "path": payload["path"],
                        "expected_outcome": payload.get("summary"),
                    },
                    "response": result,
                }
            )

        if action_type != "send_message":
            return f"Unsupported pending action type: {action_type}"
        c, _ = await _get_assistant_client_and_account(
            None if account_id == am.DEFAULT_ACCOUNT_KEY else account_id
        )

        entity = await c.get_entity(_entity_arg(payload["chat_id"]))
        sent, sent_text = await _send_pending_rich_post(c, entity, payload)
        with am.connect() as conn:
            peer = am.peer_id(entity)
            am.resolve_pending_action(conn, action_id, "sent")
            am.upsert_chat(
                conn,
                account_id=account_id,
                peer_id=peer,
                peer_kind=am.peer_kind(entity),
                title=am.display_name(entity),
                username=getattr(entity, "username", None),
                last_message_id=getattr(sent, "id", None),
            )
            am.upsert_message(
                conn,
                account_id=account_id,
                peer_id=peer,
                message_id=sent.id,
                sender_id=getattr(sent, "sender_id", None),
                sender_name="me",
                is_outgoing=True,
                date=getattr(sent, "date", None),
                kind=am.message_kind(sent),
                text=am.message_text(sent) or sent_text,
            )
            conn.commit()
        content_publish = None
        if payload.get("content_draft_id"):
            try:
                with cw.connect() as content_conn:
                    content_publish = cw.mark_draft_published(
                        content_conn,
                        draft_id=int(payload["content_draft_id"]),
                        account_id=account_id,
                        chat_id=peer,
                        chat_title=am.display_name(entity),
                        message_id=getattr(sent, "id", None),
                        message_date=getattr(sent, "date", None),
                    )
                    content_conn.commit()
            except Exception as content_error:
                logger.exception(
                    "content draft publish marker failed "
                    f"(action_id={action_id}, draft_id={payload.get('content_draft_id')}): "
                    f"{content_error}"
                )
        return _json(
            {
                "ok": True,
                "action_id": action_id,
                "status": "sent",
                "message_id": sent.id,
                "content_published": content_publish,
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_confirm_action", e, action_id=action_id)


@mcp.tool(
    annotations=ToolAnnotations(
        title="Assistant Cancel Action",
        openWorldHint=False,
        destructiveHint=False,
    )
)
async def assistant_cancel_action(action_id: int) -> str:
    """
    Cancel a pending assistant action.
    """
    try:
        with am.connect() as conn:
            action = am.get_pending_action(conn, action_id)
            if action is None:
                return f"Pending action {action_id} not found."
            am.resolve_pending_action(conn, action_id, "cancelled")
            conn.commit()
        return _json({"ok": True, "action_id": action_id, "status": "cancelled"})
    except Exception as e:
        return log_and_format_error("assistant_cancel_action", e, action_id=action_id)


@mcp.tool(
    annotations=ToolAnnotations(title="Assistant Pending Actions", openWorldHint=False, readOnlyHint=True)
)
async def assistant_list_pending_actions(account_id: Optional[str] = None) -> str:
    """
    List pending visible actions waiting for confirmation.
    """
    try:
        key = am.account_key(account_id) if account_id else None
        with am.connect() as conn:
            rows = am.list_pending_actions(conn, key)
        return _json({"ok": True, "pending": [_row_dict(row) for row in rows]})
    except Exception as e:
        return log_and_format_error("assistant_list_pending_actions", e)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Add Todo", openWorldHint=False, readOnlyHint=False))
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def assistant_add_todo(
    text: str,
    chat_id: Optional[Union[int, str]] = None,
    direction: str = "mine",
    deadline_at: Optional[str] = None,
    message_id: Optional[int] = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Store a task/commitment extracted by the external agent.
    deadline_at should be ISO-8601 when known.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        peer = None
        title = None
        with am.connect() as conn:
            if chat_id is not None:
                _, peer, title = await _assistant_resolve_chat(c, conn, account_key, chat_id)
            todo_id = am.add_todo(
                conn,
                account_id=account_key,
                peer_id=peer,
                peer_name=title,
                message_id=message_id,
                direction=direction,
                text=text,
                deadline_at=deadline_at,
            )
            conn.commit()
        return _json({"ok": True, "todo_id": todo_id})
    except Exception as e:
        return log_and_format_error("assistant_add_todo", e, chat_id=chat_id)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Todos", openWorldHint=False, readOnlyHint=True))
async def assistant_list_todos(
    status: str = "open",
    direction: Optional[str] = None,
    limit: int = 100,
    account_id: Optional[str] = None,
) -> str:
    """
    List stored tasks/commitments.
    """
    try:
        key = am.account_key(account_id)
        with am.connect() as conn:
            rows = am.list_todos(conn, key, status=status, direction=direction, limit=limit)
        return _json({"ok": True, "todos": [_row_dict(row) for row in rows]})
    except Exception as e:
        return log_and_format_error("assistant_list_todos", e)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Update Todo", openWorldHint=False, readOnlyHint=False))
async def assistant_update_todo(todo_id: int, status: str = "done") -> str:
    """
    Mark a todo as done, cancelled, open, or another local status.
    """
    try:
        with am.connect() as conn:
            ok = am.update_todo_status(conn, todo_id, status)
            conn.commit()
        return _json({"ok": ok, "todo_id": todo_id, "status": status})
    except Exception as e:
        return log_and_format_error("assistant_update_todo", e, todo_id=todo_id)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Add Reminder", openWorldHint=False, readOnlyHint=False))
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def assistant_add_reminder(
    text: str,
    remind_at: str,
    chat_id: Optional[Union[int, str]] = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Store a reminder. remind_at should be ISO-8601; scheduling/notification can
    be handled by the external agent or by polling assistant_list_reminders.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        peer = None
        title = None
        with am.connect() as conn:
            if chat_id is not None:
                _, peer, title = await _assistant_resolve_chat(c, conn, account_key, chat_id)
            reminder_id = am.add_reminder(
                conn,
                account_id=account_key,
                peer_id=peer,
                peer_name=title,
                text=text,
                remind_at=remind_at,
            )
            conn.commit()
        return _json({"ok": True, "reminder_id": reminder_id})
    except Exception as e:
        return log_and_format_error("assistant_add_reminder", e)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Reminders", openWorldHint=False, readOnlyHint=True))
async def assistant_list_reminders(
    status: str = "open",
    limit: int = 100,
    account_id: Optional[str] = None,
) -> str:
    """
    List reminders. External agents can poll this to notify the user.
    """
    try:
        key = am.account_key(account_id)
        with am.connect() as conn:
            rows = am.list_reminders(conn, key, status=status, limit=limit)
        return _json({"ok": True, "reminders": [_row_dict(row) for row in rows]})
    except Exception as e:
        return log_and_format_error("assistant_list_reminders", e)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Update Reminder", openWorldHint=False, readOnlyHint=False))
async def assistant_update_reminder(reminder_id: int, status: str = "done") -> str:
    """
    Mark a reminder as done, cancelled, open, or another local status.
    """
    try:
        with am.connect() as conn:
            ok = am.update_reminder_status(conn, reminder_id, status)
            conn.commit()
        return _json({"ok": ok, "reminder_id": reminder_id, "status": status})
    except Exception as e:
        return log_and_format_error("assistant_update_reminder", e, reminder_id=reminder_id)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Daily Digest Context", openWorldHint=False, readOnlyHint=True))
async def assistant_daily_digest_context(hours: int = 14, account_id: Optional[str] = None) -> str:
    """
    Return source data for an external agent to write a morning digest:
    unanswered incoming chats, hot todos, and upcoming reminders.
    """
    try:
        key = am.account_key(account_id)
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=max(1, min(int(hours), 168)))).isoformat()
        with am.connect() as conn:
            waiting_rows = conn.execute(
                """
                SELECT m.*, c.title AS chat_title
                FROM assistant_messages m
                LEFT JOIN assistant_chats c
                  ON c.account_id=m.account_id AND c.peer_id=m.peer_id
                WHERE m.account_id=?
                  AND m.is_outgoing=0
                  AND COALESCE(m.date, '') >= ?
                  AND NOT EXISTS (
                    SELECT 1 FROM assistant_messages mine
                    WHERE mine.account_id=m.account_id
                      AND mine.peer_id=m.peer_id
                      AND mine.is_outgoing=1
                      AND COALESCE(mine.date, '') > COALESCE(m.date, '')
                  )
                ORDER BY m.date DESC
                LIMIT 80
                """,
                (key, cutoff),
            ).fetchall()
            todos = am.list_todos(conn, key, status="open", limit=100)
            reminders = am.list_reminders(conn, key, status="open", limit=100)
        return _json(
            {
                "ok": True,
                "account_id": key,
                "window_hours": hours,
                "waiting_for_reply": [_message_payload(row) for row in waiting_rows],
                "open_todos": [_row_dict(row) for row in todos],
                "open_reminders": [_row_dict(row) for row in reminders],
                "agent_instruction": "Write a concise digest. Use only these source items; mention uncertainty when context is incomplete.",
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_daily_digest_context", e)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Mark News Source", openWorldHint=True, readOnlyHint=False))
@validate_id("chat_id")
@tool_timeout(TOOL_OPERATION_TIMEOUT)
async def assistant_mark_news_source(
    chat_id: Union[int, str],
    enabled: bool = True,
    account_id: Optional[str] = None,
) -> str:
    """
    Mark a channel/chat as a news source for assistant_news_digest_context.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        with am.connect() as conn:
            _, peer, title = await _assistant_resolve_chat(c, conn, account_key, chat_id)
            ok = am.set_news_source(conn, account_key, peer, enabled)
            conn.commit()
        return _json({"ok": ok, "peer_id": peer, "title": title, "is_news_source": enabled})
    except Exception as e:
        return log_and_format_error("assistant_mark_news_source", e, chat_id=chat_id)


@mcp.tool(annotations=ToolAnnotations(title="Assistant News Topics", openWorldHint=False, readOnlyHint=False))
async def assistant_news_topics(
    action: str = "list",
    topic: Optional[str] = None,
    topic_id: Optional[int] = None,
    hours: int = 24,
    enabled: Optional[bool] = None,
    account_id: Optional[str] = None,
) -> str:
    """
    Manage local news topics. action: list | add | toggle | enable | disable | delete.
    """
    try:
        key = am.account_key(account_id)
        action = (action or "list").lower()
        with am.connect() as conn:
            result: Dict[str, Any] = {"ok": True, "action": action}
            if action == "add":
                if not topic:
                    return "topic is required for action=add"
                result["topic_id"] = am.add_news_topic(conn, key, topic, hours=hours)
            elif action in {"toggle", "enable", "disable"}:
                if topic_id is None:
                    return "topic_id is required for this action"
                desired = enabled
                if action == "enable":
                    desired = True
                elif action == "disable":
                    desired = False
                result["updated"] = am.update_news_topic(conn, topic_id, desired)
            elif action == "delete":
                if topic_id is None:
                    return "topic_id is required for action=delete"
                result["deleted"] = am.delete_news_topic(conn, topic_id)
            topics = am.list_news_topics(conn, key)
            conn.commit()
        result["topics"] = [_row_dict(row) for row in topics]
        return _json(result)
    except Exception as e:
        return log_and_format_error("assistant_news_topics", e)


@mcp.tool(annotations=ToolAnnotations(title="Assistant News Digest Context", openWorldHint=True, readOnlyHint=True))
@tool_timeout(120)
async def assistant_news_digest_context(
    topic: str,
    hours: int = 24,
    per_channel_limit: int = 80,
    top_k: int = 20,
    only_marked_sources: bool = True,
    account_id: Optional[str] = None,
) -> str:
    """
    Gather recent posts from marked Telegram channels and return source context
    for an external agent to write a news digest. No embeddings/LLM are run here.
    """
    try:
        c, account_key = await _get_assistant_client_and_account(account_id)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, min(int(hours), 720)))
        per_channel_limit = max(1, min(int(per_channel_limit), 300))
        top_k = max(1, min(int(top_k), 100))
        with am.connect() as conn:
            channels = am.list_chats(
                conn,
                account_key,
                peer_kind_filter="channel",
                only_news_sources=only_marked_sources,
                limit=300,
            )
            if only_marked_sources and not channels:
                channels = am.list_chats(conn, account_key, peer_kind_filter="channel", limit=300)

        posts: List[Dict[str, Any]] = []
        for channel in channels:
            try:
                entity = await c.get_entity(_entity_arg(channel["peer_id"]))
                async for msg in c.iter_messages(entity, limit=per_channel_limit):
                    msg_date = getattr(msg, "date", None)
                    if msg_date and msg_date.tzinfo is None:
                        msg_date = msg_date.replace(tzinfo=timezone.utc)
                    if msg_date and msg_date < cutoff:
                        break
                    text = am.message_text(msg)
                    if not text or len(text) < 20:
                        continue
                    score = am.keyword_score(text, topic)
                    posts.append(
                        {
                            "score": score,
                            "channel": channel["title"],
                            "username": channel["username"],
                            "peer_id": channel["peer_id"],
                            "message_id": msg.id,
                            "date": am.normalize_datetime(msg_date),
                            "link": (
                                f"https://t.me/{channel['username']}/{msg.id}"
                                if channel["username"]
                                else None
                            ),
                            "text": text[:1800],
                        }
                    )
            except Exception as channel_error:
                posts.append(
                    {
                        "score": -1,
                        "channel": channel["title"],
                        "peer_id": channel["peer_id"],
                        "error": str(channel_error),
                    }
                )
        ranked = sorted(
            [p for p in posts if "text" in p],
            key=lambda p: (p["score"], p.get("date") or ""),
            reverse=True,
        )[:top_k]
        errors = [p for p in posts if "error" in p]
        return _json(
            {
                "ok": True,
                "account_id": account_key,
                "topic": topic,
                "window_hours": hours,
                "channels_considered": len(channels),
                "posts": ranked,
                "errors": errors[:20],
                "agent_instruction": "Write a factual digest from posts only. Cite channel/link when present and call out disagreements or weak evidence.",
            }
        )
    except Exception as e:
        return log_and_format_error("assistant_news_digest_context", e, topic=topic)


@mcp.tool(annotations=ToolAnnotations(title="Assistant Memory Stats", openWorldHint=False, readOnlyHint=True))
async def assistant_memory_stats(account_id: Optional[str] = None) -> str:
    """
    Show local assistant memory counters and settings.
    """
    try:
        key = am.account_key(account_id)
        with am.connect() as conn:
            counts = {
                "chats": conn.execute(
                    "SELECT COUNT(*) FROM assistant_chats WHERE account_id=?", (key,)
                ).fetchone()[0],
                "messages": conn.execute(
                    "SELECT COUNT(*) FROM assistant_messages WHERE account_id=?", (key,)
                ).fetchone()[0],
                "pending_actions": conn.execute(
                    "SELECT COUNT(*) FROM assistant_pending_actions WHERE account_id=? AND status='pending'",
                    (key,),
                ).fetchone()[0],
                "open_todos": conn.execute(
                    "SELECT COUNT(*) FROM assistant_todos WHERE account_id=? AND status='open'",
                    (key,),
                ).fetchone()[0],
                "open_reminders": conn.execute(
                    "SELECT COUNT(*) FROM assistant_reminders WHERE account_id=? AND status='open'",
                    (key,),
                ).fetchone()[0],
                "news_sources": conn.execute(
                    "SELECT COUNT(*) FROM assistant_chats WHERE account_id=? AND is_news_source=1",
                    (key,),
                ).fetchone()[0],
            }
            settings = am.get_settings(conn, key)
        return _json({"ok": True, "account_id": key, "database": am.DB_PATH, "counts": counts, "settings": settings})
    except Exception as e:
        return log_and_format_error("assistant_memory_stats", e)


async def _main() -> None:
    try:
        print("Starting Telegram client...", file=sys.stderr)
        if not TELEGRAM_CONFIGURED:
            print(
                "WARNING: TELEGRAM_API_ID/TELEGRAM_API_HASH are not configured. "
                "Telegram account tools will remain unavailable.",
                file=sys.stderr,
            )
        else:
            try:
                await client.connect()
                if await client.is_user_authorized():
                    print("Default client authorized.", file=sys.stderr)
                else:
                    print(
                        "WARNING: Default session not authorized. "
                        f"Multi-account sessions from {SESSION_DIR} will still work.",
                        file=sys.stderr,
                    )
            except Exception as conn_err:
                print(
                    f"WARNING: Default client connect failed: {conn_err}. "
                    f"Multi-account sessions from {SESSION_DIR} will still work.",
                    file=sys.stderr,
                )

        print(
            f"Running MCP server ({MCP_TRANSPORT}"
            + (f" on {MCP_HOST}:{MCP_PORT}" if MCP_TRANSPORT != "stdio" else "")
            + ")...",
            file=sys.stderr,
        )
        if MCP_TRANSPORT == "stdio":
            await mcp.run_stdio_async()
        elif MCP_TRANSPORT == "streamable-http":
            await mcp.run_streamable_http_async()
        elif MCP_TRANSPORT == "sse":
            await mcp.run_sse_async()
        else:
            raise ValueError(
                "TELEGRAM_MCP_TRANSPORT must be stdio, streamable-http, or sse"
            )
    except Exception as e:
        print(f"Error starting MCP server: {e}", file=sys.stderr)
        if isinstance(e, sqlite3.OperationalError) and "database is locked" in str(e):
            print(
                "Database lock detected. Please ensure no other instances are running.",
                file=sys.stderr,
            )
        sys.exit(1)


def main() -> None:
    nest_asyncio.apply()
    asyncio.run(_main())


if __name__ == "__main__":
    main()
