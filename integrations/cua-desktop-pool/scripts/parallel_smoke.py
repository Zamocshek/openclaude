from __future__ import annotations

import asyncio
import os
import time

from cua_desktop_pool.pool import DesktopPool


async def main() -> None:
    suffix = os.getpid()
    names = [f"parallel-a-{suffix}", f"parallel-b-{suffix}"]
    pool = DesktopPool()
    created: list[str] = []
    try:
        for name in names:
            await pool.create(name)
            created.append(name)
        started = time.perf_counter()
        results = await asyncio.gather(
            *(pool.shell(name, f"sleep 2; printf '{name}'") for name in names)
        )
        elapsed = time.perf_counter() - started
        outputs = [result["stdout"] for result in results]
        if outputs != names or elapsed >= 5:
            raise RuntimeError(f"Parallel check failed: elapsed={elapsed:.2f}, outputs={outputs}")
        print({"desktops": names, "elapsed_seconds": round(elapsed, 2), "status": "ok"})
    finally:
        await asyncio.gather(
            *(pool.destroy(name, confirm=True) for name in created),
            return_exceptions=True,
        )


if __name__ == "__main__":
    asyncio.run(main())
