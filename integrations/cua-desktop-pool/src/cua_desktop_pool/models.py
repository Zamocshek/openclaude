from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class DesktopInfo:
    name: str
    container_name: str
    status: str
    api_port: int | None = None
    vnc_port: int | None = None
    view_url: str | None = None
    image: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

@dataclass(frozen=True)
class ShellResult:
    stdout: str
    stderr: str
    returncode: int
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
