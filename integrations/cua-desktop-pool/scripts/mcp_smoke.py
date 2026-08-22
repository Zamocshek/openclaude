from __future__ import annotations

import asyncio

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters, stdio_client

from cua_desktop_pool.connectors import mcp_executable
from cua_desktop_pool.settings import project_root


async def main() -> None:
    root = project_root()
    parameters = StdioServerParameters(
        command=str(mcp_executable(root)),
        cwd=root,
        env={"CUA_POOL_PROJECT_ROOT": str(root)},
    )
    async with Client(stdio_client(parameters), mode="legacy") as client:
        result = await client.list_tools()
    names = [tool.name for tool in result.tools]
    if len(names) != 13 or "desktop_observe" not in names:
        raise RuntimeError(f"Unexpected MCP tool list: {names}")
    print({"transport": "stdio", "tools": len(names), "status": "ok"})


if __name__ == "__main__":
    asyncio.run(main())
