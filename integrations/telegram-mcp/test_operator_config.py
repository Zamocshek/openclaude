import operator_config as oc


def test_operator_config_clamps_and_persists(tmp_path, monkeypatch):
    session_dir = tmp_path / "session"
    monkeypatch.setenv("TELEGRAM_MCP_SESSION_DIR", str(session_dir))

    config = oc.update_config(
        {
            "default_account_id": "bad account id",
            "limits": {
                "max_dialog_limit": 5,
                "max_sync_messages_per_dialog": 3,
                "max_manual_send_chars": 999999,
            },
            "web": {
                "default_dialog_limit": 999,
                "default_sync_messages_per_dialog": 999,
            },
            "agent": {"notes": "operator notes"},
        },
        merge=False,
    )

    assert config["default_account_id"] == "default"
    assert config["limits"]["max_dialog_limit"] == 5
    assert config["limits"]["max_sync_messages_per_dialog"] == 3
    assert config["limits"]["max_manual_send_chars"] == 20000
    assert config["web"]["default_dialog_limit"] == 5
    assert config["web"]["default_sync_messages_per_dialog"] == 3
    assert config["agent"]["notes"] == "operator notes"
    assert oc.config_path().exists()

    loaded = oc.load_config()
    assert loaded["web"]["default_dialog_limit"] == 5


def test_operator_config_reset(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_SESSION_DIR", str(tmp_path / "session"))
    oc.update_config({"web": {"default_dialog_limit": 7}}, merge=True)

    reset = oc.reset_config()

    assert reset["web"]["default_dialog_limit"] == oc.DEFAULT_CONFIG["web"]["default_dialog_limit"]
