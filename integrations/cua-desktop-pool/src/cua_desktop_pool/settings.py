from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


def project_root() -> Path:
    configured = os.getenv("CUA_POOL_PROJECT_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[2]


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass(frozen=True)
class Settings:
    image: str
    prefix: str
    max_desktops: int
    cpus: float
    memory_mb: int
    ready_timeout: int
    max_output_chars: int
    root: Path
    docker_network: str | None = None
    view_host: str = "127.0.0.1"

    @classmethod
    def from_env(cls) -> Settings:
        prefix = os.getenv("CUA_POOL_PREFIX", "cua-pool-").strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*-", prefix):
            raise ValueError("CUA_POOL_PREFIX must contain lowercase letters, digits and dashes")
        docker_network = os.getenv("CUA_POOL_DOCKER_NETWORK", "").strip() or None
        if docker_network and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", docker_network):
            raise ValueError("CUA_POOL_DOCKER_NETWORK contains unsupported characters")
        view_host = os.getenv("CUA_POOL_VIEW_HOST", "127.0.0.1").strip()
        if not view_host or any(character in view_host for character in "/\\ "):
            raise ValueError("CUA_POOL_VIEW_HOST must be a hostname or IP address")
        return cls(
            image=os.getenv("CUA_POOL_IMAGE", "cua-desktop-pool-xfce:local"),
            prefix=prefix,
            max_desktops=_env_int("CUA_POOL_MAX_DESKTOPS", 2, 1, 32),
            cpus=_env_float("CUA_POOL_CPUS", 2.0, 0.25, 64.0),
            memory_mb=_env_int("CUA_POOL_MEMORY_MB", 3072, 512, 131072),
            ready_timeout=_env_int("CUA_POOL_READY_TIMEOUT", 120, 10, 900),
            max_output_chars=_env_int("CUA_POOL_MAX_OUTPUT_CHARS", 30000, 1000, 200000),
            root=project_root(),
            docker_network=docker_network,
            view_host=view_host,
        )

    def normalize_name(self, value: str) -> tuple[str, str]:
        raw = value.strip().lower()
        if raw.startswith(self.prefix):
            raw = raw[len(self.prefix) :]
        alias = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")
        if not alias:
            raise ValueError("Desktop name must contain a letter or digit")
        if len(alias) > 48:
            raise ValueError("Desktop name is too long (maximum 48 normalized characters)")
        return alias, f"{self.prefix}{alias}"
