import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


APP_DIR = Path(__file__).resolve().parent
PROJECT_MARKERS = ("pyproject.toml", ".env.example", "README.md")


def get_config_dir() -> Path:
    raw = os.getenv("TELEGRAM_MCP_CONFIG_DIR")
    if raw:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        return path.resolve()
    if any((APP_DIR / marker).exists() for marker in PROJECT_MARKERS):
        return APP_DIR
    return Path.cwd().resolve()


load_dotenv(get_config_dir() / ".env")


def _path_from_env(name: str, default: Path) -> Path:
    raw = os.getenv(name)
    if not raw:
        return default.resolve()
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = get_config_dir() / path
    return path.resolve()


def get_data_dir() -> Path:
    return _path_from_env("TELEGRAM_MCP_DATA_DIR", get_config_dir() / "data")


def get_session_dir() -> Path:
    return _path_from_env("TELEGRAM_MCP_SESSION_DIR", get_data_dir() / "session")


def get_log_file() -> Path:
    return _path_from_env("TELEGRAM_MCP_LOG_FILE", get_data_dir() / "logs" / "mcp_errors.log")


def get_assistant_db_path() -> Path:
    return _path_from_env(
        "TELEGRAM_MCP_ASSISTANT_DB",
        get_session_dir() / "assistant_memory.sqlite3",
    )


def get_content_db_path() -> Path:
    return _path_from_env(
        "TELEGRAM_MCP_CONTENT_DB",
        get_session_dir() / "content_workflow.sqlite3",
    )


def get_default_session_name(raw_name: Optional[str] = None) -> str:
    raw = (raw_name or os.getenv("TELEGRAM_SESSION_NAME") or "telegram_session").strip()
    path = Path(raw).expanduser()
    if path.is_absolute():
        return str(path)
    if path.parent == Path("."):
        return str((get_session_dir() / path.name).resolve())
    return str((get_config_dir() / path).resolve())


def ensure_runtime_dirs() -> None:
    get_data_dir().mkdir(parents=True, exist_ok=True)
    get_session_dir().mkdir(parents=True, exist_ok=True)
    get_log_file().parent.mkdir(parents=True, exist_ok=True)
    get_assistant_db_path().parent.mkdir(parents=True, exist_ok=True)
    get_content_db_path().parent.mkdir(parents=True, exist_ok=True)
