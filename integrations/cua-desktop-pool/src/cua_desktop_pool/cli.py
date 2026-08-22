from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Any

from .connectors import CLIENTS, apply_client, write_configs
from .pool import DesktopPool
from .settings import Settings, project_root


def _print(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cua-desktop-pool",
        description="Manage parallel local Cua Docker desktops.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("doctor", help="Check Docker and the wrapper image")
    sub.add_parser("list", help="List owned desktops")

    create = sub.add_parser("create", help="Create a desktop")
    create.add_argument("name")

    view = sub.add_parser("view", help="Show desktop status and noVNC URL")
    view.add_argument("name")
    view.add_argument("--open", action="store_true", dest="open_viewer")

    shell = sub.add_parser("shell", help="Run a command inside a desktop")
    shell.add_argument("name")
    shell.add_argument("shell_command")
    shell.add_argument("--timeout", type=int, default=30)
    shell.add_argument("--background", action="store_true")

    screenshot = sub.add_parser("screenshot", help="Capture the desktop screen")
    screenshot.add_argument("name")
    screenshot.add_argument("--out", type=Path, required=True)
    screenshot.add_argument("--format", choices=("png", "jpeg"), default="png")
    screenshot.add_argument("--quality", type=int, default=90)

    for command, help_text in (
        ("suspend", "Pause a desktop"),
        ("resume", "Resume a desktop"),
    ):
        item = sub.add_parser(command, help=help_text)
        item.add_argument("name")

    destroy = sub.add_parser("destroy", help="Permanently delete a desktop")
    destroy.add_argument("name")
    destroy.add_argument("--yes", action="store_true")

    build = sub.add_parser("build-image", help="Build the fixed local XFCE image")
    build.add_argument("--pull", action="store_true")

    connect = sub.add_parser("connect", help="Generate or apply MCP client config")
    connect.add_argument("--client", choices=("all", *CLIENTS), default="all")
    connect.add_argument("--apply", action="store_true")

    return parser


async def _run_async(args: argparse.Namespace) -> int:
    pool = DesktopPool()
    if args.command == "doctor":
        _print(await pool.doctor())
    elif args.command == "list":
        _print(await pool.list())
    elif args.command == "create":
        _print(await pool.create(args.name))
    elif args.command == "view":
        value = await pool.view(args.name)
        _print(value)
        if args.open_viewer and value.get("view_url"):
            webbrowser.open(str(value["view_url"]))
    elif args.command == "shell":
        _print(
            await pool.shell(
                args.name,
                args.shell_command,
                timeout=args.timeout,
                background=args.background,
            )
        )
    elif args.command == "screenshot":
        data = await pool.observe(args.name, format=args.format, quality=args.quality)
        destination = args.out.expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        _print({"saved": str(destination), "bytes": len(data)})
    elif args.command == "suspend":
        _print(await pool.suspend(args.name))
    elif args.command == "resume":
        _print(await pool.resume(args.name))
    elif args.command == "destroy":
        _print(await pool.destroy(args.name, confirm=args.yes))
    else:
        raise RuntimeError(f"Unexpected async command: {args.command}")
    return 0


def _build_image(args: argparse.Namespace) -> int:
    root = project_root()
    settings = Settings.from_env()
    command = [
        "docker",
        "build",
        "--tag",
        settings.image,
        "--file",
        str(root / "docker" / "Dockerfile"),
    ]
    if args.pull:
        command.append("--pull")
    command.append(str(root))
    print(
        "Building the local lean Cua XFCE image. The first build installs GUI packages.",
        file=sys.stderr,
    )
    return subprocess.run(command, cwd=root, shell=False, check=False).returncode


def _connect(args: argparse.Namespace) -> int:
    root = project_root()
    output = root / "integrations" / "generated"
    paths = write_configs(output, root)
    result: dict[str, Any] = {"generated": [str(path) for path in paths]}
    if args.apply:
        if args.client == "all":
            raise ValueError("--apply requires one explicit client")
        result["applied"] = apply_client(args.client, root)
        if result["applied"]["returncode"] != 0:
            _print(result)
            return int(result["applied"]["returncode"])
    elif args.client != "all":
        selected = [path for path in paths if path.name.startswith(args.client)]
        result["selected"] = [str(path) for path in selected]
    _print(result)
    return 0


def main() -> None:
    os.environ.setdefault("CUA_POOL_PROJECT_ROOT", str(project_root()))
    args = _parser().parse_args()
    try:
        if args.command == "build-image":
            code = _build_image(args)
        elif args.command == "connect":
            code = _connect(args)
        else:
            code = asyncio.run(_run_async(args))
    except (FileNotFoundError, RuntimeError, ValueError, TimeoutError) as error:
        print(f"error: {error}", file=sys.stderr)
        code = 1
    raise SystemExit(code)


if __name__ == "__main__":
    main()
