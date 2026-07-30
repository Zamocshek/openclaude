from pathlib import Path

import account_admin as aa


def test_purge_account_session_files_preserves_memory_and_operator_config(
    tmp_path: Path,
    monkeypatch,
):
    monkeypatch.setattr(aa, "get_session_dir", lambda: tmp_path)
    removable = {
        "account.session",
        "account.session-journal",
        "account.session-wal",
        "account.json",
        "orphan.json",
        "proxies.json",
    }
    preserved = {
        "smooth.json",
        "operator_config.json",
        "assistant_memory.sqlite3",
        "assistant_memory.sqlite3-wal",
        "content_workflow.sqlite3",
    }
    for name in removable | preserved:
        (tmp_path / name).write_text("test", encoding="utf-8")

    deleted = aa.purge_account_session_files()

    assert set(deleted) == removable
    assert all(not (tmp_path / name).exists() for name in removable)
    assert all((tmp_path / name).exists() for name in preserved)
