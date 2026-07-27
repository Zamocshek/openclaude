import runtime_config


def test_default_runtime_paths_are_project_local(monkeypatch):
    monkeypatch.delenv("TELEGRAM_MCP_CONFIG_DIR", raising=False)
    monkeypatch.delenv("TELEGRAM_MCP_DATA_DIR", raising=False)
    monkeypatch.delenv("TELEGRAM_MCP_SESSION_DIR", raising=False)
    monkeypatch.delenv("TELEGRAM_MCP_LOG_FILE", raising=False)
    monkeypatch.delenv("TELEGRAM_MCP_ASSISTANT_DB", raising=False)
    monkeypatch.delenv("TELEGRAM_MCP_CONTENT_DB", raising=False)

    config_dir = runtime_config.get_config_dir()
    assert runtime_config.get_data_dir() == (config_dir / "data").resolve()
    assert runtime_config.get_session_dir() == (config_dir / "data" / "session").resolve()
    assert (
        runtime_config.get_log_file()
        == (config_dir / "data" / "logs" / "mcp_errors.log").resolve()
    )
    assert (
        runtime_config.get_assistant_db_path()
        == (config_dir / "data" / "session" / "assistant_memory.sqlite3").resolve()
    )
    assert (
        runtime_config.get_content_db_path()
        == (config_dir / "data" / "session" / "content_workflow.sqlite3").resolve()
    )


def test_relative_runtime_paths_resolve_from_config_dir(monkeypatch):
    monkeypatch.delenv("TELEGRAM_MCP_CONFIG_DIR", raising=False)
    monkeypatch.setenv("TELEGRAM_MCP_DATA_DIR", "custom-data")
    monkeypatch.setenv("TELEGRAM_MCP_SESSION_DIR", "custom-session")
    monkeypatch.setenv("TELEGRAM_MCP_LOG_FILE", "custom-logs/app.log")
    monkeypatch.setenv("TELEGRAM_MCP_ASSISTANT_DB", "custom-db/memory.sqlite3")
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", "custom-db/content.sqlite3")

    config_dir = runtime_config.get_config_dir()
    assert runtime_config.get_data_dir() == (config_dir / "custom-data").resolve()
    assert runtime_config.get_session_dir() == (config_dir / "custom-session").resolve()
    assert runtime_config.get_log_file() == (config_dir / "custom-logs" / "app.log").resolve()
    assert (
        runtime_config.get_assistant_db_path()
        == (config_dir / "custom-db" / "memory.sqlite3").resolve()
    )
    assert (
        runtime_config.get_content_db_path()
        == (config_dir / "custom-db" / "content.sqlite3").resolve()
    )


def test_config_dir_can_be_overridden(monkeypatch, tmp_path):
    monkeypatch.setenv("TELEGRAM_MCP_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("TELEGRAM_MCP_DATA_DIR", raising=False)
    monkeypatch.setenv("TELEGRAM_MCP_LOG_FILE", "logs/app.log")

    assert runtime_config.get_config_dir() == tmp_path.resolve()
    assert runtime_config.get_data_dir() == (tmp_path / "data").resolve()
    assert runtime_config.get_log_file() == (tmp_path / "logs" / "app.log").resolve()


def test_config_dir_falls_back_to_cwd_for_installed_package(monkeypatch, tmp_path):
    fake_site_package = tmp_path / "site-packages"
    fake_site_package.mkdir()
    deploy_dir = tmp_path / "deploy"
    deploy_dir.mkdir()

    monkeypatch.delenv("TELEGRAM_MCP_CONFIG_DIR", raising=False)
    monkeypatch.setattr(runtime_config, "APP_DIR", fake_site_package)
    monkeypatch.chdir(deploy_dir)

    assert runtime_config.get_config_dir() == deploy_dir.resolve()
    assert runtime_config.get_data_dir() == (deploy_dir / "data").resolve()


def test_default_telegram_session_name_uses_session_dir(monkeypatch):
    monkeypatch.delenv("TELEGRAM_MCP_CONFIG_DIR", raising=False)
    monkeypatch.setenv("TELEGRAM_MCP_SESSION_DIR", "sessions")
    monkeypatch.setenv("TELEGRAM_SESSION_NAME", "telegram_session")

    config_dir = runtime_config.get_config_dir()
    assert runtime_config.get_default_session_name() == str(
        (config_dir / "sessions" / "telegram_session").resolve()
    )


def test_explicit_telegram_session_paths_are_preserved(monkeypatch):
    explicit = runtime_config.APP_DIR / "legacy" / "telegram_session"
    monkeypatch.setenv("TELEGRAM_SESSION_NAME", str(explicit))

    assert runtime_config.get_default_session_name() == str(explicit.resolve())
    assert runtime_config.get_default_session_name("custom/path/session") == str(
        (runtime_config.get_config_dir() / "custom" / "path" / "session").resolve()
    )
