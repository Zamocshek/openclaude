from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from cua_desktop_pool.models import DesktopInfo
from cua_desktop_pool.pool import DesktopPool
from cua_desktop_pool.settings import Settings


class Recorder:
    def __init__(self):
        self.calls: list[tuple] = []

    def __getattr__(self, name):
        async def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))

        return record


class Clipboard:
    def __init__(self):
        self.value = ""

    async def get(self):
        return self.value

    async def set(self, value):
        self.value = value


class Files:
    async def read_text(self, path):
        return f"contents:{path}"

    async def write_text(self, path, content):
        return None

    async def list(self, path):
        return [SimpleNamespace(name="a.txt", path=f"{path}/a.txt", is_dir=False, size=3)]


class Sandbox:
    def __init__(self):
        self.mouse = Recorder()
        self.keyboard = Recorder()
        self.clipboard = Clipboard()
        self.files = Files()
        self.shell = self

    async def screenshot(self, *, format, quality):
        return f"{format}:{quality}".encode()

    async def get_dimensions(self):
        return 1024, 768

    async def run(self, command, *, timeout, background):
        return SimpleNamespace(stdout=command, stderr="", returncode=0)


class Backend:
    def __init__(self):
        self.sandbox = Sandbox()
        self.destroyed: list[str] = []

    async def create(self, name):
        return DesktopInfo(name=name, container_name=f"cua-pool-{name}", status="running")

    async def list(self):
        return [DesktopInfo(name="desk", container_name="cua-pool-desk", status="running")]

    async def info(self, name):
        return DesktopInfo(
            name=name,
            container_name=f"cua-pool-{name}",
            status="running",
            view_url="http://127.0.0.1:1234/vnc.html",
        )

    @asynccontextmanager
    async def session(self, name):
        yield self.sandbox

    async def suspend(self, name):
        return DesktopInfo(name=name, container_name=f"cua-pool-{name}", status="suspended")

    async def resume(self, name):
        return DesktopInfo(name=name, container_name=f"cua-pool-{name}", status="running")

    async def destroy(self, name):
        self.destroyed.append(name)

    async def doctor(self):
        return {"docker": "ok"}


def configured():
    return Settings(
        image="test:local",
        prefix="cua-pool-",
        max_desktops=2,
        cpus=1.0,
        memory_mb=1024,
        ready_timeout=10,
        max_output_chars=1000,
        root=Path.cwd(),
    )


@pytest.mark.asyncio
async def test_action_batch_and_required_verification_hint():
    backend = Backend()
    pool = DesktopPool(backend=backend, settings=configured())
    result = await pool.act(
        "desk",
        [
            {"type": "click", "x": 50, "y": 60},
            {"type": "type", "text": "hello"},
            {"type": "keypress", "keys": ["enter"]},
        ],
    )
    assert result["count"] == 3
    assert "desktop_observe" in result["next"]
    assert backend.sandbox.mouse.calls[0][0] == "click"
    assert backend.sandbox.keyboard.calls[0][0] == "type"


@pytest.mark.asyncio
async def test_invalid_coordinate_is_rejected():
    pool = DesktopPool(backend=Backend(), settings=configured())
    with pytest.raises(ValueError, match="x must be between"):
        await pool.act("desk", [{"type": "click", "x": 1024, "y": 1}])


@pytest.mark.asyncio
async def test_shell_and_observe():
    pool = DesktopPool(backend=Backend(), settings=configured())
    assert (await pool.shell("desk", "echo ok"))["stdout"] == "echo ok"
    assert await pool.observe("desk", format="jpeg", quality=80) == b"jpeg:80"


@pytest.mark.asyncio
async def test_destroy_requires_explicit_confirmation():
    backend = Backend()
    pool = DesktopPool(backend=backend, settings=configured())
    with pytest.raises(ValueError, match="confirm=true"):
        await pool.destroy("desk")
    assert backend.destroyed == []
    assert await pool.destroy("desk", confirm=True) == {"destroyed": "desk"}
    assert backend.destroyed == ["desk"]


@pytest.mark.asyncio
async def test_same_desktop_calls_are_serialized():
    pool = DesktopPool(backend=Backend(), settings=configured())
    active = 0
    maximum = 0

    async def guarded(_sandbox, _kind, _action, _width, _height):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.01)
        active -= 1

    pool._run_action = guarded
    await asyncio.gather(
        pool.act("desk", [{"type": "wait", "seconds": 0}]),
        pool.act("desk", [{"type": "wait", "seconds": 0}]),
    )
    assert maximum == 1
