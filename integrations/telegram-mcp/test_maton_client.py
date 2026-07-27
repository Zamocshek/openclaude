import httpx
import pytest

from maton_client import (
    MatonClient,
    MatonConfig,
    MatonError,
    summarize_connection,
    validate_custom_headers,
    validate_route_path,
)


def test_config_rejects_non_maton_host(monkeypatch):
    monkeypatch.setenv("MATON_API_URL", "https://example.com")
    with pytest.raises(MatonError):
        MatonConfig.from_env()


def test_route_and_headers_reject_escape_hatches():
    with pytest.raises(ValueError):
        validate_route_path("https://example.com/path")
    with pytest.raises(ValueError):
        validate_route_path("v1/../users")
    with pytest.raises(ValueError):
        validate_route_path("v1/%2e%2e/users")
    with pytest.raises(ValueError):
        validate_custom_headers({"Authorization": "wrong"})


@pytest.mark.asyncio
async def test_list_connections_uses_bearer_auth_without_exposing_it():
    def handler(request):
        assert request.url.host == "api.maton.ai"
        assert request.url.path == "/connections"
        assert request.headers["Authorization"] == "Bearer test-key"
        return httpx.Response(
            200, json={"connections": [{"connection_id": "conn_1", "app": "notion"}]}
        )

    client = MatonClient(MatonConfig(api_key="test-key"), transport=httpx.MockTransport(handler))
    result = await client.list_connections(app="notion", status="active")
    assert result["connections"][0]["app"] == "notion"


@pytest.mark.asyncio
async def test_route_request_pins_app_and_connection():
    def handler(request):
        assert request.url.path == "/google-drive/drive/v3/files"
        assert request.headers["Maton-Connection"] == "conn_1"
        assert request.headers["X-Test"] == "yes"
        return httpx.Response(200, json={"files": []})

    client = MatonClient(MatonConfig(api_key="test-key"), transport=httpx.MockTransport(handler))
    result = await client.request(
        method="GET",
        app="google-drive",
        path="drive/v3/files",
        connection_id="conn_1",
        headers={"X-Test": "yes"},
    )
    assert result == {"status_code": 200, "data": {"files": []}}


def test_connection_summary_hides_authorization_url_by_default():
    connection = {
        "connection_id": "conn_1",
        "url": "https://connect.maton.ai/?session_token=secret",
        "metadata": {"email": "private@example.com"},
    }
    summary = summarize_connection(connection)
    assert summary["authorization_url_available"] is True
    assert summary["metadata_available"] is True
    assert "url" not in summary
    assert "secret" not in str(summary)
    assert "private@example.com" not in str(summary)
