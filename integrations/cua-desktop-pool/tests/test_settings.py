from pathlib import Path

import pytest

from cua_desktop_pool.settings import Settings


def settings(**overrides):
    values = {
        "image": "test:local",
        "prefix": "cua-pool-",
        "max_desktops": 2,
        "cpus": 1.0,
        "memory_mb": 1024,
        "ready_timeout": 10,
        "max_output_chars": 1000,
        "root": Path.cwd(),
    }
    values.update(overrides)
    return Settings(**values)


def test_normalize_name_is_stable():
    configured = settings()
    assert configured.normalize_name("  Research #1 ") == (
        "research-1",
        "cua-pool-research-1",
    )
    assert configured.normalize_name("cua-pool-research-1") == (
        "research-1",
        "cua-pool-research-1",
    )


def test_container_network_enables_internal_control_endpoint():
    configured = settings(docker_network="nova-cua", view_host="localhost")
    assert configured.docker_network == "nova-cua"
    assert configured.view_host == "localhost"


@pytest.mark.parametrize("value", ["", "---", "!!!"])
def test_normalize_name_rejects_empty_alias(value):
    with pytest.raises(ValueError):
        settings().normalize_name(value)
