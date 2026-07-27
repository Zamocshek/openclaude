import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from telethon import utils

from runtime_config import get_assistant_db_path, get_session_dir


DEFAULT_ACCOUNT_KEY = "default"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_DIR = str(get_session_dir())
DB_PATH = str(get_assistant_db_path())


def account_key(account_id: Optional[str]) -> str:
    return str(account_id or DEFAULT_ACCOUNT_KEY)


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _init_db(conn)
    return conn


def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS assistant_chats (
            account_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            peer_kind TEXT NOT NULL,
            title TEXT NOT NULL,
            username TEXT,
            is_archived INTEGER NOT NULL DEFAULT 0,
            is_news_source INTEGER NOT NULL DEFAULT 0,
            last_message_id INTEGER,
            last_synced_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (account_id, peer_id)
        );

        CREATE TABLE IF NOT EXISTS assistant_messages (
            account_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            sender_id TEXT,
            sender_name TEXT,
            is_outgoing INTEGER NOT NULL DEFAULT 0,
            date TEXT,
            kind TEXT NOT NULL DEFAULT 'text',
            text TEXT,
            transcript TEXT,
            extracted_text TEXT,
            extra_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (account_id, peer_id, message_id)
        );

        CREATE INDEX IF NOT EXISTS ix_assistant_messages_chat_date
            ON assistant_messages (account_id, peer_id, date);
        CREATE INDEX IF NOT EXISTS ix_assistant_messages_account_date
            ON assistant_messages (account_id, date);

        CREATE TABLE IF NOT EXISTS assistant_pending_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            account_id TEXT NOT NULL,
            target_chat TEXT,
            target_label TEXT,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS assistant_todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            peer_id TEXT,
            peer_name TEXT,
            message_id INTEGER,
            direction TEXT NOT NULL DEFAULT 'mine',
            text TEXT NOT NULL,
            deadline_at TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assistant_reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            peer_id TEXT,
            peer_name TEXT,
            text TEXT NOT NULL,
            remind_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assistant_news_topics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            hours INTEGER NOT NULL DEFAULT 24,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assistant_settings (
            account_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (account_id, key)
        );
        """
    )
    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS assistant_messages_fts
            USING fts5(content, account_id UNINDEXED, peer_id UNINDEXED, message_id UNINDEXED)
            """
        )
    except sqlite3.OperationalError:
        # Some Python/SQLite builds omit FTS5. Search falls back to LIKE.
        pass
    conn.commit()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_datetime(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()
    text = str(value).strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()
    except Exception:
        return text


def peer_id(entity: Any) -> str:
    try:
        return str(utils.get_peer_id(entity))
    except Exception:
        return str(getattr(entity, "id", entity))


def peer_kind(entity: Any) -> str:
    if getattr(entity, "bot", False):
        return "bot"
    if getattr(entity, "broadcast", False):
        return "channel"
    if getattr(entity, "megagroup", False):
        return "group"
    name = type(entity).__name__.lower()
    if "user" in name:
        return "user"
    if "chat" in name or "channel" in name:
        return "group"
    return "unknown"


def display_name(entity: Any) -> str:
    title = getattr(entity, "title", None)
    if title:
        return str(title)
    parts = [
        getattr(entity, "first_name", None) or "",
        getattr(entity, "last_name", None) or "",
    ]
    name = " ".join(p for p in parts if p).strip()
    if name:
        return name
    username = getattr(entity, "username", None)
    if username:
        return f"@{username}"
    return str(getattr(entity, "id", "Unknown"))


def dialog_is_archived(dialog: Any) -> bool:
    if getattr(dialog, "archived", False):
        return True
    return getattr(dialog, "folder_id", None) == 1


def message_kind(message: Any) -> str:
    if getattr(message, "voice", None):
        return "voice"
    if getattr(message, "audio", None):
        return "audio"
    if getattr(message, "document", None):
        return "document"
    if getattr(message, "photo", None):
        return "photo"
    if getattr(message, "media", None):
        return "media"
    return "text"


def message_text(message: Any) -> str:
    return (getattr(message, "message", None) or getattr(message, "text", None) or "").strip()


def upsert_chat(
    conn: sqlite3.Connection,
    *,
    account_id: str,
    peer_id: str,
    peer_kind: str,
    title: str,
    username: Optional[str] = None,
    is_archived: bool = False,
    last_message_id: Optional[int] = None,
) -> None:
    now = now_iso()
    conn.execute(
        """
        INSERT INTO assistant_chats (
            account_id, peer_id, peer_kind, title, username, is_archived,
            last_message_id, last_synced_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, peer_id) DO UPDATE SET
            peer_kind=excluded.peer_kind,
            title=excluded.title,
            username=excluded.username,
            is_archived=excluded.is_archived,
            last_message_id=COALESCE(excluded.last_message_id, assistant_chats.last_message_id),
            last_synced_at=excluded.last_synced_at,
            updated_at=excluded.updated_at
        """,
        (
            account_id,
            peer_id,
            peer_kind,
            title,
            username,
            1 if is_archived else 0,
            last_message_id,
            now,
            now,
        ),
    )


def upsert_message(
    conn: sqlite3.Connection,
    *,
    account_id: str,
    peer_id: str,
    message_id: int,
    sender_id: Optional[Any],
    sender_name: Optional[str],
    is_outgoing: bool,
    date: Any,
    kind: str,
    text: Optional[str],
    transcript: Optional[str] = None,
    extracted_text: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    now = now_iso()
    text = text or ""
    transcript = transcript or None
    extracted_text = extracted_text or None
    conn.execute(
        """
        INSERT INTO assistant_messages (
            account_id, peer_id, message_id, sender_id, sender_name, is_outgoing,
            date, kind, text, transcript, extracted_text, extra_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, peer_id, message_id) DO UPDATE SET
            sender_id=excluded.sender_id,
            sender_name=excluded.sender_name,
            is_outgoing=excluded.is_outgoing,
            date=excluded.date,
            kind=excluded.kind,
            text=excluded.text,
            transcript=COALESCE(excluded.transcript, assistant_messages.transcript),
            extracted_text=COALESCE(excluded.extracted_text, assistant_messages.extracted_text),
            extra_json=excluded.extra_json,
            updated_at=excluded.updated_at
        """,
        (
            account_id,
            peer_id,
            int(message_id),
            str(sender_id) if sender_id is not None else None,
            sender_name,
            1 if is_outgoing else 0,
            normalize_datetime(date),
            kind,
            text,
            transcript,
            extracted_text,
            json.dumps(extra or {}, ensure_ascii=False),
            now,
            now,
        ),
    )
    content = " ".join(x for x in (text, transcript, extracted_text) if x).strip()
    try:
        conn.execute(
            "DELETE FROM assistant_messages_fts WHERE account_id=? AND peer_id=? AND message_id=?",
            (account_id, peer_id, int(message_id)),
        )
        if content:
            conn.execute(
                """
                INSERT INTO assistant_messages_fts(content, account_id, peer_id, message_id)
                VALUES (?, ?, ?, ?)
                """,
                (content, account_id, peer_id, int(message_id)),
            )
    except sqlite3.OperationalError:
        pass


def get_chat(conn: sqlite3.Connection, account_id: str, peer_id: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM assistant_chats WHERE account_id=? AND peer_id=?",
        (account_id, str(peer_id)),
    ).fetchone()


def list_chats(
    conn: sqlite3.Connection,
    account_id: str,
    *,
    peer_kind_filter: Optional[str] = None,
    only_news_sources: bool = False,
    limit: int = 100,
) -> List[sqlite3.Row]:
    sql = "SELECT * FROM assistant_chats WHERE account_id=?"
    params: List[Any] = [account_id]
    if peer_kind_filter:
        sql += " AND peer_kind=?"
        params.append(peer_kind_filter)
    if only_news_sources:
        sql += " AND is_news_source=1"
    sql += " ORDER BY updated_at DESC LIMIT ?"
    params.append(max(1, min(int(limit), 1000)))
    return list(conn.execute(sql, params).fetchall())


def recent_messages(
    conn: sqlite3.Connection,
    account_id: str,
    peer_id: str,
    *,
    limit: int = 80,
) -> List[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT m.*, c.title AS chat_title
        FROM assistant_messages m
        LEFT JOIN assistant_chats c
          ON c.account_id=m.account_id AND c.peer_id=m.peer_id
        WHERE m.account_id=? AND m.peer_id=?
        ORDER BY m.date DESC, m.message_id DESC
        LIMIT ?
        """,
        (account_id, str(peer_id), max(1, min(int(limit), 1000))),
    ).fetchall()
    return list(reversed(rows))


def _fts_query(query: str) -> str:
    parts = []
    for raw in query.split():
        clean = "".join(ch for ch in raw if ch.isalnum() or ch in "_-")
        if len(clean) >= 2:
            parts.append(clean + "*")
    return " OR ".join(parts)


def search_messages(
    conn: sqlite3.Connection,
    account_id: str,
    query: str,
    *,
    peer_id: Optional[str] = None,
    limit: int = 50,
) -> List[sqlite3.Row]:
    limit = max(1, min(int(limit), 200))
    fts_q = _fts_query(query)
    if fts_q:
        try:
            sql = """
                SELECT m.*, c.title AS chat_title,
                       snippet(assistant_messages_fts, 0, '', '', '...', 18) AS snippet,
                       bm25(assistant_messages_fts) AS rank
                FROM assistant_messages_fts f
                JOIN assistant_messages m
                  ON m.account_id=f.account_id
                 AND m.peer_id=f.peer_id
                 AND m.message_id=f.message_id
                LEFT JOIN assistant_chats c
                  ON c.account_id=m.account_id AND c.peer_id=m.peer_id
                WHERE assistant_messages_fts MATCH ?
                  AND m.account_id=?
            """
            params: List[Any] = [fts_q, account_id]
            if peer_id is not None:
                sql += " AND m.peer_id=?"
                params.append(str(peer_id))
            sql += " ORDER BY rank LIMIT ?"
            params.append(limit)
            return list(conn.execute(sql, params).fetchall())
        except sqlite3.OperationalError:
            pass

    like = f"%{query.lower()}%"
    sql = """
        SELECT m.*, c.title AS chat_title,
               COALESCE(m.text, m.transcript, m.extracted_text, '') AS snippet,
               0.0 AS rank
        FROM assistant_messages m
        LEFT JOIN assistant_chats c
          ON c.account_id=m.account_id AND c.peer_id=m.peer_id
        WHERE m.account_id=?
          AND lower(COALESCE(m.text, '') || ' ' || COALESCE(m.transcript, '') || ' ' || COALESCE(m.extracted_text, '')) LIKE ?
    """
    params = [account_id, like]
    if peer_id is not None:
        sql += " AND m.peer_id=?"
        params.append(str(peer_id))
    sql += " ORDER BY m.date DESC LIMIT ?"
    params.append(limit)
    return list(conn.execute(sql, params).fetchall())


def create_pending_action(
    conn: sqlite3.Connection,
    *,
    action_type: str,
    account_id: str,
    target_chat: Optional[str],
    target_label: Optional[str],
    payload: Dict[str, Any],
) -> int:
    cur = conn.execute(
        """
        INSERT INTO assistant_pending_actions
            (action_type, account_id, target_chat, target_label, payload_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
        """,
        (
            action_type,
            account_id,
            str(target_chat) if target_chat is not None else None,
            target_label,
            json.dumps(payload, ensure_ascii=False),
            now_iso(),
        ),
    )
    return int(cur.lastrowid)


def get_pending_action(conn: sqlite3.Connection, action_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM assistant_pending_actions WHERE id=?",
        (int(action_id),),
    ).fetchone()


def list_pending_actions(conn: sqlite3.Connection, account_id: Optional[str] = None) -> List[sqlite3.Row]:
    if account_id:
        return list(
            conn.execute(
                """
                SELECT * FROM assistant_pending_actions
                WHERE account_id=? AND status='pending'
                ORDER BY created_at DESC
                """,
                (account_id,),
            ).fetchall()
        )
    return list(
        conn.execute(
            """
            SELECT * FROM assistant_pending_actions
            WHERE status='pending'
            ORDER BY created_at DESC
            """
        ).fetchall()
    )


def resolve_pending_action(conn: sqlite3.Connection, action_id: int, status: str) -> None:
    conn.execute(
        """
        UPDATE assistant_pending_actions
        SET status=?, resolved_at=?
        WHERE id=?
        """,
        (status, now_iso(), int(action_id)),
    )


def add_todo(
    conn: sqlite3.Connection,
    *,
    account_id: str,
    text: str,
    peer_id: Optional[str] = None,
    peer_name: Optional[str] = None,
    message_id: Optional[int] = None,
    direction: str = "mine",
    deadline_at: Optional[str] = None,
) -> int:
    if direction not in {"mine", "theirs"}:
        direction = "mine"
    now = now_iso()
    cur = conn.execute(
        """
        INSERT INTO assistant_todos
            (account_id, peer_id, peer_name, message_id, direction, text, deadline_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
        """,
        (
            account_id,
            str(peer_id) if peer_id is not None else None,
            peer_name,
            int(message_id) if message_id is not None else None,
            direction,
            text.strip(),
            normalize_datetime(deadline_at),
            now,
            now,
        ),
    )
    return int(cur.lastrowid)


def list_todos(
    conn: sqlite3.Connection,
    account_id: str,
    *,
    status: str = "open",
    direction: Optional[str] = None,
    limit: int = 100,
) -> List[sqlite3.Row]:
    sql = "SELECT * FROM assistant_todos WHERE account_id=?"
    params: List[Any] = [account_id]
    if status != "all":
        sql += " AND status=?"
        params.append(status)
    if direction:
        sql += " AND direction=?"
        params.append(direction)
    sql += " ORDER BY deadline_at IS NULL, deadline_at ASC, created_at DESC LIMIT ?"
    params.append(max(1, min(int(limit), 500)))
    return list(conn.execute(sql, params).fetchall())


def update_todo_status(conn: sqlite3.Connection, todo_id: int, status: str) -> bool:
    cur = conn.execute(
        "UPDATE assistant_todos SET status=?, updated_at=? WHERE id=?",
        (status, now_iso(), int(todo_id)),
    )
    return cur.rowcount > 0


def add_reminder(
    conn: sqlite3.Connection,
    *,
    account_id: str,
    text: str,
    remind_at: str,
    peer_id: Optional[str] = None,
    peer_name: Optional[str] = None,
) -> int:
    now = now_iso()
    cur = conn.execute(
        """
        INSERT INTO assistant_reminders
            (account_id, peer_id, peer_name, text, remind_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
        """,
        (
            account_id,
            str(peer_id) if peer_id is not None else None,
            peer_name,
            text.strip(),
            normalize_datetime(remind_at) or str(remind_at),
            now,
            now,
        ),
    )
    return int(cur.lastrowid)


def list_reminders(
    conn: sqlite3.Connection,
    account_id: str,
    *,
    status: str = "open",
    limit: int = 100,
) -> List[sqlite3.Row]:
    sql = "SELECT * FROM assistant_reminders WHERE account_id=?"
    params: List[Any] = [account_id]
    if status != "all":
        sql += " AND status=?"
        params.append(status)
    sql += " ORDER BY remind_at ASC LIMIT ?"
    params.append(max(1, min(int(limit), 500)))
    return list(conn.execute(sql, params).fetchall())


def update_reminder_status(conn: sqlite3.Connection, reminder_id: int, status: str) -> bool:
    cur = conn.execute(
        "UPDATE assistant_reminders SET status=?, updated_at=? WHERE id=?",
        (status, now_iso(), int(reminder_id)),
    )
    return cur.rowcount > 0


def set_news_source(conn: sqlite3.Connection, account_id: str, peer_id: str, enabled: bool) -> bool:
    cur = conn.execute(
        """
        UPDATE assistant_chats
        SET is_news_source=?, updated_at=?
        WHERE account_id=? AND peer_id=?
        """,
        (1 if enabled else 0, now_iso(), account_id, str(peer_id)),
    )
    return cur.rowcount > 0


def add_news_topic(conn: sqlite3.Connection, account_id: str, topic: str, hours: int = 24) -> int:
    cur = conn.execute(
        """
        INSERT INTO assistant_news_topics (account_id, topic, hours, enabled, created_at)
        VALUES (?, ?, ?, 1, ?)
        """,
        (account_id, topic.strip(), int(hours), now_iso()),
    )
    return int(cur.lastrowid)


def list_news_topics(
    conn: sqlite3.Connection,
    account_id: str,
    *,
    only_enabled: bool = False,
) -> List[sqlite3.Row]:
    sql = "SELECT * FROM assistant_news_topics WHERE account_id=?"
    params: List[Any] = [account_id]
    if only_enabled:
        sql += " AND enabled=1"
    sql += " ORDER BY created_at ASC"
    return list(conn.execute(sql, params).fetchall())


def update_news_topic(conn: sqlite3.Connection, topic_id: int, enabled: Optional[bool] = None) -> bool:
    if enabled is None:
        cur = conn.execute(
            "UPDATE assistant_news_topics SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?",
            (int(topic_id),),
        )
    else:
        cur = conn.execute(
            "UPDATE assistant_news_topics SET enabled=? WHERE id=?",
            (1 if enabled else 0, int(topic_id)),
        )
    return cur.rowcount > 0


def delete_news_topic(conn: sqlite3.Connection, topic_id: int) -> bool:
    cur = conn.execute("DELETE FROM assistant_news_topics WHERE id=?", (int(topic_id),))
    return cur.rowcount > 0


def set_setting(conn: sqlite3.Connection, account_id: str, key: str, value: Any) -> None:
    conn.execute(
        """
        INSERT INTO assistant_settings (account_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, key) DO UPDATE SET
            value=excluded.value,
            updated_at=excluded.updated_at
        """,
        (account_id, key.strip(), json.dumps(value, ensure_ascii=False), now_iso()),
    )


def get_settings(conn: sqlite3.Connection, account_id: str) -> Dict[str, Any]:
    rows = conn.execute(
        "SELECT key, value FROM assistant_settings WHERE account_id=? ORDER BY key",
        (account_id,),
    ).fetchall()
    out: Dict[str, Any] = {}
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value"])
        except Exception:
            out[row["key"]] = row["value"]
    return out


def format_message_rows(rows: Iterable[sqlite3.Row]) -> str:
    lines = []
    for row in rows:
        who = "me" if row["is_outgoing"] else (row["sender_name"] or row["sender_id"] or "unknown")
        body = row["transcript"] or row["text"] or row["extracted_text"] or f"[{row['kind']}]"
        lines.append(
            f"[{row['date'] or '?'}] chat={row['chat_title'] or row['peer_id']} "
            f"msg={row['message_id']} {who}: {body}"
        )
    return "\n".join(lines)


def keyword_score(text: str, query: str) -> int:
    text_l = text.lower()
    score = 0
    for part in re.findall(r"[\w-]{2,}", query.lower(), flags=re.UNICODE):
        if part in text_l:
            score += 1
    return score
