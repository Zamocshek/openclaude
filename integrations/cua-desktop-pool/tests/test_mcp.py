import pytest
from mcp.client import Client

from cua_desktop_pool.mcp_server import mcp

EXPECTED_TOOLS = {
    "desktop_doctor",
    "desktop_create",
    "desktop_list",
    "desktop_view",
    "desktop_observe",
    "desktop_dimensions",
    "desktop_act",
    "desktop_shell",
    "desktop_clipboard",
    "desktop_file",
    "desktop_suspend",
    "desktop_resume",
    "desktop_destroy",
}


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_mcp_lists_tools_in_modern_and_legacy_modes(mode):
    async with Client(mcp, mode=mode) as client:
        result = await client.list_tools()
    assert {tool.name for tool in result.tools} == EXPECTED_TOOLS
    observe = next(tool for tool in result.tools if tool.name == "desktop_observe")
    assert observe.input_schema["properties"]["name"]["type"] == "string"
