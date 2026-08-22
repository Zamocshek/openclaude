from __future__ import annotations

import os
from typing import Any, Literal

from mcp.server.mcpserver import Image, MCPServer

from .pool import DesktopPool

INSTRUCTIONS = """
Manage independent local Linux GUI desktops. Start with desktop_doctor and
desktop_list. Reuse a named desktop when possible. For GUI work, always follow
observe -> one small action batch -> observe and verify. Coordinates are pixels
inside the current screenshot. Different desktop names may run concurrently;
calls targeting the same desktop are serialized. Never destroy a desktop unless
the user asked for cleanup, and pass confirm=true only after checking its name.
Use desktop_shell for deterministic setup and desktop_act only for visible GUI.
""".strip()

mcp = MCPServer("cua-desktop-pool", instructions=INSTRUCTIONS)
pool = DesktopPool()


@mcp.tool(name="desktop_doctor")
async def desktop_doctor() -> dict[str, Any]:
    """Check Docker, wrapper image, limits, and active desktop count."""
    return await pool.doctor()


@mcp.tool(name="desktop_create")
async def desktop_create(name: str) -> dict[str, Any]:
    """Create one persistent isolated desktop and wait until it is ready."""
    return await pool.create(name)


@mcp.tool(name="desktop_list")
async def desktop_list() -> list[dict[str, Any]]:
    """List desktops owned by this pool, including status and viewer URLs."""
    return await pool.list()


@mcp.tool(name="desktop_view")
async def desktop_view(name: str) -> dict[str, Any]:
    """Return status, ports, and the local noVNC URL for a desktop."""
    return await pool.view(name)


@mcp.tool(name="desktop_observe")
async def desktop_observe(
    name: str,
    image_format: Literal["png", "jpeg"] = "png",
    quality: int = 90,
) -> Image:
    """Capture the current desktop screen. Observe again after every action batch."""
    data = await pool.observe(name, format=image_format, quality=quality)
    return Image(data=data, format=image_format)


@mcp.tool(name="desktop_dimensions")
async def desktop_dimensions(name: str) -> dict[str, int]:
    """Return current screen width and height in pixels."""
    return await pool.dimensions(name)


@mcp.tool(name="desktop_act")
async def desktop_act(name: str, actions: list[dict[str, Any]]) -> dict[str, Any]:
    """Run up to 25 mouse/keyboard/wait actions atomically on one desktop.

    Action shapes:
    - {"type":"click|right_click|double_click|move", "x":10, "y":20}
    - {"type":"scroll", "x":10, "y":20, "scroll_y":3, "scroll_x":0}
    - {"type":"drag", "start_x":1, "start_y":2, "end_x":3, "end_y":4}
    - {"type":"type", "text":"hello"}
    - {"type":"keypress", "keys":["ctrl","l"]}
    - {"type":"wait", "seconds":1}
    """
    return await pool.act(name, actions)


@mcp.tool(name="desktop_shell")
async def desktop_shell(
    name: str,
    command: str,
    timeout: int = 30,
    background: bool = False,
) -> dict[str, Any]:
    """Run a shell command inside a desktop with bounded output and timeout."""
    return await pool.shell(name, command, timeout=timeout, background=background)


@mcp.tool(name="desktop_clipboard")
async def desktop_clipboard(
    name: str,
    operation: Literal["get", "set"],
    text: str | None = None,
) -> dict[str, Any]:
    """Read or replace the isolated desktop clipboard."""
    return await pool.clipboard(name, operation, text)


@mcp.tool(name="desktop_file")
async def desktop_file(
    name: str,
    operation: Literal["read_text", "write_text", "list"],
    path: str,
    content: str | None = None,
) -> dict[str, Any]:
    """Read, write, or list files inside one desktop."""
    return await pool.file(name, operation, path, content)


@mcp.tool(name="desktop_suspend")
async def desktop_suspend(name: str) -> dict[str, Any]:
    """Pause a desktop container while preserving its state."""
    return await pool.suspend(name)


@mcp.tool(name="desktop_resume")
async def desktop_resume(name: str) -> dict[str, Any]:
    """Resume a previously suspended desktop."""
    return await pool.resume(name)


@mcp.tool(name="desktop_destroy")
async def desktop_destroy(name: str, confirm: bool = False) -> dict[str, Any]:
    """Permanently delete one pool desktop. Requires confirm=true."""
    return await pool.destroy(name, confirm=confirm)


def main() -> None:
    transport = os.getenv("CUA_POOL_MCP_TRANSPORT", "stdio").strip().lower()
    if transport == "stdio":
        mcp.run(transport="stdio")
        return
    if transport != "streamable-http":
        raise ValueError("CUA_POOL_MCP_TRANSPORT must be stdio or streamable-http")
    mcp.run(
        transport="streamable-http",
        host=os.getenv("CUA_POOL_MCP_HOST", "127.0.0.1"),
        port=int(os.getenv("CUA_POOL_MCP_PORT", "8767")),
        streamable_http_path=os.getenv("CUA_POOL_MCP_PATH", "/mcp"),
        stateless_http=True,
        json_response=True,
    )


if __name__ == "__main__":
    main()
