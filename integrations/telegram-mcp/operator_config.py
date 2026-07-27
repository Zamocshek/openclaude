"""Persistent operator/admin configuration shared by MCP tools and the web UI."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Dict

from runtime_config import get_session_dir

CONFIG_FILENAME = "operator_config.json"
SAFE_ACCOUNT_RE = re.compile(r"^[A-Za-z0-9_.@+-]{1,120}$")

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": 1,
    "default_account_id": "default",
    "web": {
        "default_dialog_limit": 30,
        "default_sync_messages_per_dialog": 0,
        "enable_session_import": True,
        "enable_manual_reply": True,
        "require_send_confirm": True,
        "show_sensitive_account_fields": False,
    },
    "agent": {
        "memory_search_limit": 50,
        "context_limit": 80,
        "digest_hours": 24,
        "preferred_model": "",
        "notes": "",
        "system_hint": (
            "Use MCP tools as the control layer. Keep Telegram sends visible "
            "and confirmed unless the user explicitly approves the action."
        ),
    },
    "limits": {
        "max_upload_mb": 32,
        "max_dialog_limit": 100,
        "max_sync_messages_per_dialog": 50,
        "max_manual_send_chars": 4000,
        "connect_timeout_sec": 20,
        "request_timeout_sec": 15,
    },
    "features": {
        "web_account_admin": True,
        "web_dialog_view": True,
        "web_dialog_sync": True,
        "mcp_config_tools": True,
    },
    "account_labels": {},
    "custom": {},
}


def config_path() -> Path:
    path = get_session_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path / CONFIG_FILENAME


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def _as_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except Exception:
        number = default
    return max(minimum, min(maximum, number))


def _as_str(value: Any, default: str = "", max_len: int = 4000) -> str:
    text = str(value if value is not None else default)
    return text[:max_len]


def _account_id(value: Any) -> str:
    text = str(value or "default").strip() or "default"
    if text == "default":
        return text
    if SAFE_ACCOUNT_RE.fullmatch(text):
        return text
    return "default"


def validate_config(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _deep_merge(DEFAULT_CONFIG, config if isinstance(config, dict) else {})
    cfg["version"] = 1
    cfg["default_account_id"] = _account_id(cfg.get("default_account_id"))

    limits = cfg["limits"]
    limits["max_upload_mb"] = _as_int(limits.get("max_upload_mb"), 32, 1, 256)
    limits["max_dialog_limit"] = _as_int(limits.get("max_dialog_limit"), 100, 1, 500)
    limits["max_sync_messages_per_dialog"] = _as_int(
        limits.get("max_sync_messages_per_dialog"), 50, 0, 500
    )
    limits["max_manual_send_chars"] = _as_int(limits.get("max_manual_send_chars"), 4000, 1, 20000)
    limits["connect_timeout_sec"] = _as_int(limits.get("connect_timeout_sec"), 20, 3, 120)
    limits["request_timeout_sec"] = _as_int(limits.get("request_timeout_sec"), 15, 3, 120)

    web = cfg["web"]
    web["default_dialog_limit"] = _as_int(
        web.get("default_dialog_limit"), 30, 1, limits["max_dialog_limit"]
    )
    web["default_sync_messages_per_dialog"] = _as_int(
        web.get("default_sync_messages_per_dialog"),
        0,
        0,
        limits["max_sync_messages_per_dialog"],
    )
    for key in (
        "enable_session_import",
        "enable_manual_reply",
        "require_send_confirm",
        "show_sensitive_account_fields",
    ):
        web[key] = _as_bool(web.get(key), DEFAULT_CONFIG["web"][key])

    agent = cfg["agent"]
    agent["memory_search_limit"] = _as_int(agent.get("memory_search_limit"), 50, 1, 500)
    agent["context_limit"] = _as_int(agent.get("context_limit"), 80, 1, 500)
    agent["digest_hours"] = _as_int(agent.get("digest_hours"), 24, 1, 720)
    agent["preferred_model"] = _as_str(agent.get("preferred_model"), "", 120)
    agent["notes"] = _as_str(agent.get("notes"), "", 8000)
    agent["system_hint"] = _as_str(
        agent.get("system_hint"), DEFAULT_CONFIG["agent"]["system_hint"], 4000
    )

    features = cfg["features"]
    for key in (
        "web_account_admin",
        "web_dialog_view",
        "web_dialog_sync",
        "mcp_config_tools",
    ):
        features[key] = _as_bool(features.get(key), DEFAULT_CONFIG["features"][key])

    if not isinstance(cfg.get("account_labels"), dict):
        cfg["account_labels"] = {}
    if not isinstance(cfg.get("custom"), dict):
        cfg["custom"] = {}
    return cfg


def load_config() -> Dict[str, Any]:
    path = config_path()
    if not path.exists():
        return validate_config({})
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except Exception:
        loaded = {}
    return validate_config(loaded if isinstance(loaded, dict) else {})


def save_config(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = validate_config(config)
    path = config_path()
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(cfg, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    tmp_path.replace(path)
    return cfg


def update_config(patch: Dict[str, Any], *, merge: bool = True) -> Dict[str, Any]:
    if not isinstance(patch, dict):
        raise ValueError("config patch must be a JSON object")
    base = load_config() if merge else {}
    return save_config(_deep_merge(base, patch))


def reset_config() -> Dict[str, Any]:
    return save_config(DEFAULT_CONFIG)


def max_upload_bytes() -> int:
    return load_config()["limits"]["max_upload_mb"] * 1024 * 1024


def limit(name: str) -> int:
    return int(load_config()["limits"][name])


def feature(name: str) -> bool:
    return bool(load_config()["features"][name])


def web_flag(name: str) -> bool:
    return bool(load_config()["web"][name])
