import json
from pathlib import Path

from cua_desktop_pool.connectors import generated_configs, write_configs


def fake_install(root: Path) -> Path:
    executable = root / ".venv" / "Scripts" / "cua-desktop-pool-mcp.exe"
    executable.parent.mkdir(parents=True)
    executable.touch()
    return executable.resolve()


def test_generate_all_supported_client_shapes(tmp_path):
    executable = fake_install(tmp_path)
    configs = generated_configs(tmp_path)
    assert len(configs) == 7
    generic = json.loads(configs["generic.mcp.json"])
    assert generic["mcpServers"]["cua_desktops"]["command"] == str(executable)
    assert "[mcp_servers.cua_desktops]" in configs["codex.toml"]
    assert '"supportsParallelToolCalls": true' in configs["openclaw.json"]
    assert '"mcp"' in configs["opencode-v1.jsonc"]
    assert '"servers"' in configs["opencode-v2.jsonc"]


def test_write_configs(tmp_path):
    fake_install(tmp_path)
    output = tmp_path / "generated"
    paths = write_configs(output, tmp_path)
    assert len(paths) == 7
    assert all(path.is_file() for path in paths)
