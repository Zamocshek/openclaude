from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .settings import project_root

SERVER_NAME = "cua_desktops"
CLIENTS = (
    "generic",
    "cursor",
    "claude",
    "codex",
    "openclaw",
    "opencode-v1",
    "opencode-v2",
)


def mcp_executable(root: Path | None = None) -> Path:
    root = root or project_root()
    candidate = root / ".venv" / "Scripts" / "cua-desktop-pool-mcp.exe"
    if candidate.is_file():
        return candidate.resolve()
    found = shutil.which("cua-desktop-pool-mcp")
    if found:
        return Path(found).resolve()
    raise FileNotFoundError("MCP entrypoint is missing. Run `uv sync --python 3.11` first.")


def generated_configs(root: Path | None = None) -> dict[str, str]:
    root = (root or project_root()).resolve()
    executable = mcp_executable(root)
    command = str(executable)
    cwd = str(root)
    stdio = {
        "mcpServers": {
            SERVER_NAME: {
                "type": "stdio",
                "command": command,
                "args": [],
                "env": {"CUA_POOL_PROJECT_ROOT": cwd},
            }
        }
    }
    opencode_v1 = {
        "mcp": {
            SERVER_NAME: {
                "type": "local",
                "command": [command],
                "enabled": True,
                "environment": {"CUA_POOL_PROJECT_ROOT": cwd},
                "timeout": 600000,
            }
        }
    }
    opencode_v2 = {
        "mcp": {
            "servers": {
                SERVER_NAME: {
                    "type": "local",
                    "command": [command],
                    "cwd": cwd,
                    "codemode": False,
                }
            }
        }
    }
    openclaw = {
        "mcp": {
            "servers": {
                SERVER_NAME: {
                    "command": command,
                    "args": [],
                    "cwd": cwd,
                    "supportsParallelToolCalls": True,
                }
            }
        }
    }
    codex = "\n".join(
        [
            f"[mcp_servers.{SERVER_NAME}]",
            f"command = {json.dumps(command)}",
            "args = []",
            f"cwd = {json.dumps(cwd)}",
            'env = { CUA_POOL_PROJECT_ROOT = ' + json.dumps(cwd) + " }",
            "startup_timeout_sec = 60",
            "tool_timeout_sec = 600",
            'default_tools_approval_mode = "writes"',
            "",
        ]
    )
    return {
        "generic.mcp.json": json.dumps(stdio, ensure_ascii=False, indent=2) + "\n",
        "cursor.mcp.json": json.dumps(stdio, ensure_ascii=False, indent=2) + "\n",
        "claude.mcp.json": json.dumps(stdio, ensure_ascii=False, indent=2) + "\n",
        "codex.toml": codex,
        "openclaw.json": json.dumps(openclaw, ensure_ascii=False, indent=2) + "\n",
        "opencode-v1.jsonc": json.dumps(opencode_v1, ensure_ascii=False, indent=2) + "\n",
        "opencode-v2.jsonc": json.dumps(opencode_v2, ensure_ascii=False, indent=2) + "\n",
    }


def write_configs(output: Path, root: Path | None = None) -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for filename, content in generated_configs(root).items():
        path = output / filename
        path.write_text(content, encoding="utf-8")
        written.append(path)
    return written


def apply_command(client: str, root: Path | None = None) -> list[str]:
    root = (root or project_root()).resolve()
    executable = str(mcp_executable(root))
    commands = {
        "codex": ["codex", "mcp", "add", SERVER_NAME, "--", executable],
        "claude": [
            "claude",
            "mcp",
            "add",
            "--transport",
            "stdio",
            "--scope",
            "user",
            SERVER_NAME,
            "--",
            executable,
        ],
        "openclaw": [
            "openclaw",
            "mcp",
            "add",
            SERVER_NAME,
            "--command",
            executable,
            "--cwd",
            str(root),
        ],
        "opencode-v2": ["opencode2", "mcp", "add", SERVER_NAME, "--", executable],
    }
    if client not in commands:
        raise ValueError(
            f"Automatic apply is unavailable for {client!r}; use the generated config file."
        )
    return commands[client]


def apply_client(client: str, root: Path | None = None) -> dict[str, Any]:
    args = apply_command(client, root)
    binary = shutil.which(args[0])
    if not binary:
        raise FileNotFoundError(f"{args[0]!r} is not installed or not on PATH")
    args[0] = binary
    result = subprocess.run(args, capture_output=True, text=True, shell=False, timeout=60)
    return {
        "client": client,
        "command": args,
        "returncode": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }
