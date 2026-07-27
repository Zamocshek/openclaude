import assistant_memory as am


def test_assistant_memory_smoke(tmp_path):
    old_session_dir = am.SESSION_DIR
    old_db_path = am.DB_PATH
    am.SESSION_DIR = str(tmp_path)
    am.DB_PATH = str(tmp_path / "assistant_memory.sqlite3")
    try:
        with am.connect() as conn:
            am.upsert_chat(
                conn,
                account_id="test",
                peer_id="peer-1",
                peer_kind="user",
                title="Test Chat",
            )
            am.upsert_message(
                conn,
                account_id="test",
                peer_id="peer-1",
                message_id=10,
                sender_id="20",
                sender_name="Tester",
                is_outgoing=False,
                date="2026-06-10T00:00:00+00:00",
                kind="text",
                text="telegram helper memory search",
            )
            action_id = am.create_pending_action(
                conn,
                action_type="send_message",
                account_id="test",
                target_chat="peer-1",
                target_label="Test Chat",
                payload={"message": "ok"},
            )
            todo_id = am.add_todo(conn, account_id="test", text="finish memory test")
            reminder_id = am.add_reminder(
                conn,
                account_id="test",
                text="memory reminder",
                remind_at="2026-06-11T09:00:00+00:00",
            )
            conn.commit()

            hits = am.search_messages(conn, "test", "telegram helper")
            pending = am.get_pending_action(conn, action_id)
            todos = am.list_todos(conn, "test")
            reminders = am.list_reminders(conn, "test")

        assert len(hits) == 1
        assert pending["id"] == action_id
        assert todos[0]["id"] == todo_id
        assert reminders[0]["id"] == reminder_id
    finally:
        am.SESSION_DIR = old_session_dir
        am.DB_PATH = old_db_path
