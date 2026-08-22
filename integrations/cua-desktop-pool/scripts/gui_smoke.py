from __future__ import annotations

import asyncio
import os
from pathlib import Path

import httpx

from cua_desktop_pool.pool import DesktopPool
from cua_desktop_pool.settings import project_root


async def main() -> None:
    name = f"gui-smoke-{os.getpid()}"
    screenshot = Path(project_root()) / "screenshots" / "gui-smoke.png"
    pool = DesktopPool()
    created = await pool.create(name)
    try:
        view_url = created["view_url"]
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(view_url)
            response.raise_for_status()
        await pool.act(
            name,
            [
                {"type": "click", "x": 568, "y": 875},
                {"type": "wait", "seconds": 2},
                {"type": "type", "text": "echo GUI_INPUT_OK"},
                {"type": "keypress", "keys": ["enter"]},
                {"type": "wait", "seconds": 1},
            ],
        )
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        screenshot.write_bytes(await pool.observe(name))
        print({"desktop": name, "viewer": "ok", "screenshot": str(screenshot)})
    finally:
        await pool.destroy(name, confirm=True)


if __name__ == "__main__":
    asyncio.run(main())
