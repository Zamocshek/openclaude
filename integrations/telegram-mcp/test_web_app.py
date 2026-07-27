from fastapi.testclient import TestClient
import pytest

import assistant_memory as am
import web_app


@pytest.fixture()
def isolated_client(tmp_path, monkeypatch):
    old_session_dir = am.SESSION_DIR
    old_db_path = am.DB_PATH
    data_dir = tmp_path / "data"
    session_dir = data_dir / "session"
    db_path = session_dir / "assistant_memory.sqlite3"

    monkeypatch.setenv("TELEGRAM_MCP_DATA_DIR", str(data_dir))
    monkeypatch.setenv("TELEGRAM_MCP_SESSION_DIR", str(session_dir))
    monkeypatch.setenv("TELEGRAM_MCP_ASSISTANT_DB", str(db_path))
    monkeypatch.setenv("TELEGRAM_MCP_LOG_FILE", str(data_dir / "logs" / "mcp_errors.log"))
    monkeypatch.delenv("TELEGRAM_MCP_WEB_TOKEN", raising=False)

    session_dir.mkdir(parents=True, exist_ok=True)
    am.SESSION_DIR = str(session_dir)
    am.DB_PATH = str(db_path)
    try:
        yield TestClient(web_app.app), db_path
    finally:
        am.SESSION_DIR = old_session_dir
        am.DB_PATH = old_db_path


def test_web_status_uses_runtime_paths(isolated_client):
    client, db_path = isolated_client
    response = client.get("/api/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["paths"]["assistant_db"] == str(db_path)
    assert payload["accounts"] == []
    assert "memory" in payload


def test_web_api_rejects_invalid_payloads(isolated_client):
    client, _ = isolated_client
    assert client.get("/api/search", params={"q": "   "}).status_code == 400
    assert client.post("/api/todos", json={}).status_code == 400
    assert client.post("/api/todos", json={"text": "  "}).status_code == 400
    assert client.post("/api/reminders", json={"text": "x"}).status_code == 400
    assert client.post("/api/reminders", json={"text": "x", "remind_at": ""}).status_code == 400


def test_web_auth_reads_current_env_token(isolated_client, monkeypatch):
    client, _ = isolated_client
    monkeypatch.setenv("TELEGRAM_MCP_WEB_TOKEN", "secret-token")
    assert client.get("/api/status").status_code == 401
    response = client.get("/api/status", headers={"Authorization": "Bearer secret-token"})
    assert response.status_code == 200
    assert client.get("/api/status", params={"token": "secret-token"}).status_code == 200


def test_admin_import_lists_session_files(isolated_client):
    client, _ = isolated_client
    response = client.post(
        "/api/admin/accounts/import",
        files=[
            ("files", ("work.session", b"not sqlite", "application/octet-stream")),
            ("files", ("work.json", b'{"app_id": 1, "app_hash": "hash"}', "application/json")),
        ],
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert {item["file"]["name"] for item in payload["imported"]} == {"work.session", "work.json"}

    accounts = client.get("/api/admin/accounts").json()["accounts"]
    assert accounts[0]["account_id"] == "work"
    assert accounts[0]["config"]["name"] == "work.json"
    assert "session sqlite error" in accounts[0]["health"]

    duplicate = client.post(
        "/api/admin/accounts/import",
        files=[("files", ("work.session", b"again", "application/octet-stream"))],
    )
    assert duplicate.status_code == 409

    overwritten = client.post(
        "/api/admin/accounts/import",
        data={"overwrite": "true"},
        files=[("files", ("work.session", b"again", "application/octet-stream"))],
    )
    assert overwritten.status_code == 200


def test_admin_import_rejects_invalid_session_names(isolated_client):
    client, _ = isolated_client
    response = client.post(
        "/api/admin/accounts/import",
        files=[("files", ("bad name.session", b"x", "application/octet-stream"))],
    )
    assert response.status_code == 400


def test_admin_config_api_controls_web_features(isolated_client):
    client, _ = isolated_client

    response = client.post(
        "/api/admin/config",
        json={
            "config": {
                "default_account_id": "work",
                "web": {
                    "default_dialog_limit": 12,
                    "enable_session_import": False,
                },
            },
            "merge": True,
        },
    )
    assert response.status_code == 200
    config = response.json()["config"]
    assert config["default_account_id"] == "work"
    assert config["web"]["default_dialog_limit"] == 12
    assert config["web"]["enable_session_import"] is False

    blocked = client.post(
        "/api/admin/accounts/import",
        files=[("files", ("blocked.session", b"x", "application/octet-stream"))],
    )
    assert blocked.status_code == 403

    reset = client.post("/api/admin/config/reset")
    assert reset.status_code == 200
    assert reset.json()["config"]["web"]["enable_session_import"] is True


def test_stat_report_api_renders_files(isolated_client):
    client, _ = isolated_client

    templates = client.get("/api/stat-reports/templates")
    assert templates.status_code == 200
    assert templates.json()["watermark"] == "DEMO"

    response = client.post(
        "/api/stat-reports/render",
        json={
            "report": {
                "template": "tgstat_post",
                "output_name": "web_stat_post_demo",
                "channel": {"title": "Demo channel"},
            }
        },
    )
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["watermark"] == "DEMO"
    assert result["png_path"].endswith(".png")
    assert result["html_path"].endswith(".html")


def test_index_html_escapes_dynamic_rendered_values(isolated_client):
    client, _ = isolated_client
    html = client.get("/").text
    assert "const esc =" in html
    assert "${t.text}" not in html
    assert "${r.text}" not in html
    assert "${h.snippet || h.text || ''}" not in html
    assert "${a.account_id}" not in html
    assert "${p.target_label || p.target_chat}" not in html
