from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

from .backend import CuaDockerBackend
from .models import ShellResult
from .settings import Settings


class DesktopPool:
    def __init__(self, backend: Any | None = None, settings: Settings | None = None):
        self.settings = settings or Settings.from_env()
        self.backend = backend or CuaDockerBackend(self.settings)
        self._locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._create_lock = asyncio.Lock()

    def _lock(self, name: str) -> asyncio.Lock:
        alias, _ = self.settings.normalize_name(name)
        return self._locks[alias]

    async def create(self, name: str) -> dict[str, Any]:
        async with self._create_lock:
            return (await self.backend.create(name)).to_dict()

    async def list(self) -> list[dict[str, Any]]:
        return [item.to_dict() for item in await self.backend.list()]

    async def view(self, name: str) -> dict[str, Any]:
        return (await self.backend.info(name)).to_dict()

    async def observe(self, name: str, *, format: str = "png", quality: int = 90) -> bytes:
        if format not in {"png", "jpeg"}:
            raise ValueError("format must be png or jpeg")
        if not 1 <= quality <= 95:
            raise ValueError("quality must be between 1 and 95")
        async with self._lock(name):
            async with self.backend.session(name) as sandbox:
                return await sandbox.screenshot(format=format, quality=quality)

    async def dimensions(self, name: str) -> dict[str, int]:
        async with self._lock(name):
            async with self.backend.session(name) as sandbox:
                width, height = await sandbox.get_dimensions()
        return {"width": width, "height": height}

    async def shell(
        self,
        name: str,
        command: str,
        *,
        timeout: int = 30,
        background: bool = False,
    ) -> dict[str, Any]:
        if not command.strip():
            raise ValueError("command must not be empty")
        if len(command) > 10000:
            raise ValueError("command is too long")
        if not 1 <= timeout <= 600:
            raise ValueError("timeout must be between 1 and 600 seconds")
        async with self._lock(name):
            async with self.backend.session(name) as sandbox:
                result = await sandbox.shell.run(command, timeout=timeout, background=background)
        stdout, stdout_cut = self._truncate(result.stdout)
        stderr, stderr_cut = self._truncate(result.stderr)
        return ShellResult(
            stdout=stdout,
            stderr=stderr,
            returncode=result.returncode,
            truncated=stdout_cut or stderr_cut,
        ).to_dict()

    async def act(self, name: str, actions: list[dict[str, Any]]) -> dict[str, Any]:
        if not actions:
            raise ValueError("actions must not be empty")
        if len(actions) > 25:
            raise ValueError("at most 25 actions are allowed per batch")

        completed: list[str] = []
        async with self._lock(name):
            async with self.backend.session(name) as sandbox:
                width, height = await sandbox.get_dimensions()
                for index, action in enumerate(actions):
                    kind = str(action.get("type", "")).strip().lower()
                    await self._run_action(sandbox, kind, action, width, height)
                    completed.append(f"{index}:{kind}")
        return {
            "desktop": self.settings.normalize_name(name)[0],
            "completed": completed,
            "count": len(completed),
            "next": "Call desktop_observe and verify the visible result.",
        }

    async def clipboard(
        self, name: str, operation: str, text: str | None = None
    ) -> dict[str, Any]:
        operation = operation.lower().strip()
        async with self._lock(name):
            async with self.backend.session(name) as sandbox:
                if operation == "get":
                    return {"text": await sandbox.clipboard.get()}
                if operation == "set":
                    if text is None:
                        raise ValueError("text is required for clipboard set")
                    if len(text) > 50000:
                        raise ValueError("clipboard text is too long")
                    await sandbox.clipboard.set(text)
                    return {"ok": True, "characters": len(text)}
        raise ValueError("operation must be get or set")

    async def file(
        self,
        name: str,
        operation: str,
        path: str,
        content: str | None = None,
    ) -> dict[str, Any]:
        operation = operation.lower().strip()
        if not path.strip() or len(path) > 4096:
            raise ValueError("path is required and must be shorter than 4096 characters")
        async with self._lock(name):
            async with self.backend.session(name) as sandbox:
                if operation == "read_text":
                    value = await sandbox.files.read_text(path)
                    value, cut = self._truncate(value)
                    return {"content": value, "truncated": cut}
                if operation == "write_text":
                    if content is None:
                        raise ValueError("content is required for write_text")
                    if len(content) > 200000:
                        raise ValueError("content is too large")
                    await sandbox.files.write_text(path, content)
                    return {"ok": True, "characters": len(content)}
                if operation == "list":
                    entries = await sandbox.files.list(path)
                    return {
                        "entries": [
                            {
                                "name": entry.name,
                                "path": entry.path,
                                "is_dir": entry.is_dir,
                                "size": entry.size,
                            }
                            for entry in entries[:500]
                        ],
                        "truncated": len(entries) > 500,
                    }
        raise ValueError("operation must be read_text, write_text or list")

    async def suspend(self, name: str) -> dict[str, Any]:
        async with self._lock(name):
            return (await self.backend.suspend(name)).to_dict()

    async def resume(self, name: str) -> dict[str, Any]:
        async with self._lock(name):
            return (await self.backend.resume(name)).to_dict()

    async def destroy(self, name: str, *, confirm: bool = False) -> dict[str, Any]:
        if not confirm:
            raise ValueError("Refusing to destroy without confirm=true")
        alias, _ = self.settings.normalize_name(name)
        async with self._lock(alias):
            await self.backend.destroy(alias)
        self._locks.pop(alias, None)
        return {"destroyed": alias}

    async def doctor(self) -> dict[str, Any]:
        return await self.backend.doctor()

    async def _run_action(
        self,
        sandbox: Any,
        kind: str,
        action: dict[str, Any],
        width: int,
        height: int,
    ) -> None:
        if kind in {"click", "right_click", "double_click", "move"}:
            x, y = self._coordinates(action, width, height)
            if kind == "click":
                await sandbox.mouse.click(x, y, button=str(action.get("button", "left")))
            elif kind == "right_click":
                await sandbox.mouse.right_click(x, y)
            elif kind == "double_click":
                await sandbox.mouse.double_click(x, y)
            else:
                await sandbox.mouse.move(x, y)
            return
        if kind == "scroll":
            x, y = self._coordinates(action, width, height)
            scroll_x = self._bounded_int(action.get("scroll_x", 0), "scroll_x", -50, 50)
            scroll_y = self._bounded_int(action.get("scroll_y", 3), "scroll_y", -50, 50)
            await sandbox.mouse.scroll(x, y, scroll_x=scroll_x, scroll_y=scroll_y)
            return
        if kind == "drag":
            start_x = self._bounded_int(action.get("start_x"), "start_x", 0, width - 1)
            start_y = self._bounded_int(action.get("start_y"), "start_y", 0, height - 1)
            end_x = self._bounded_int(action.get("end_x"), "end_x", 0, width - 1)
            end_y = self._bounded_int(action.get("end_y"), "end_y", 0, height - 1)
            await sandbox.mouse.drag(start_x, start_y, end_x, end_y)
            return
        if kind == "type":
            text = str(action.get("text", ""))
            if not text or len(text) > 10000:
                raise ValueError("type action requires 1-10000 characters")
            await sandbox.keyboard.type(text)
            return
        if kind == "keypress":
            keys = action.get("keys")
            if isinstance(keys, str):
                keys = [keys]
            if not isinstance(keys, list) or not keys or len(keys) > 8:
                raise ValueError("keypress keys must be a non-empty list with at most 8 items")
            normalized_keys = [str(key).strip().lower() for key in keys]
            if any(not key for key in normalized_keys):
                raise ValueError("keypress keys must not contain empty values")
            await sandbox.keyboard.keypress(normalized_keys)
            return
        if kind == "wait":
            seconds = action.get("seconds", 1)
            if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
                raise ValueError("wait seconds must be a number")
            if not 0 <= float(seconds) <= 30:
                raise ValueError("wait seconds must be between 0 and 30")
            await asyncio.sleep(float(seconds))
            return
        raise ValueError(
            f"Unsupported action {kind!r}. Use click, right_click, double_click, move, "
            "scroll, drag, type, keypress or wait."
        )

    @staticmethod
    def _bounded_int(value: Any, field: str, minimum: int, maximum: int) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{field} must be an integer")
        if not minimum <= value <= maximum:
            raise ValueError(f"{field} must be between {minimum} and {maximum}")
        return value

    def _coordinates(
        self, action: dict[str, Any], width: int, height: int
    ) -> tuple[int, int]:
        return (
            self._bounded_int(action.get("x"), "x", 0, width - 1),
            self._bounded_int(action.get("y"), "y", 0, height - 1),
        )

    def _truncate(self, value: str) -> tuple[str, bool]:
        limit = self.settings.max_output_chars
        if len(value) <= limit:
            return value, False
        half = max(1, limit // 2)
        return f"{value[:half]}\n... <truncated> ...\n{value[-half:]}", True
