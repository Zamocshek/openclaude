"""Local content workflow storage and duplicate checks.

The MCP client remains the writing brain. This module keeps durable source
material, drafts, published history, and similarity guards in SQLite.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from runtime_config import get_content_db_path

DEFAULT_ACCOUNT_KEY = "default"
DEFAULT_SIMILARITY_THRESHOLD = 0.84
DEFAULT_RECENT_WINDOW = 2000
CHANNEL_KINDS = {"source", "target"}
POST_ROLES = {"source", "draft", "published"}
SETTING_RESEARCH_ACCOUNT = "research_account_id"
SETTING_SIMILARITY_THRESHOLD = "similarity_threshold"
CAMPAIGN_STATUSES = {"planned", "prepared", "partially_sent", "sent", "verified", "failed"}
CAMPAIGN_ITEM_STATUSES = {"planned", "pending", "sent", "verified", "failed"}


def account_key(account_id: Optional[str]) -> str:
    text = str(account_id or DEFAULT_ACCOUNT_KEY).strip()
    return text or DEFAULT_ACCOUNT_KEY


def db_path() -> str:
    return str(get_content_db_path())


def connect(path: Optional[str] = None) -> sqlite3.Connection:
    database = path or db_path()
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(database, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _init_db(conn)
    return conn


def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS content_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS content_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK (kind IN ('source', 'target')),
            account_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            peer_id TEXT,
            title TEXT NOT NULL,
            username TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (kind, account_id, chat_id)
        );

        CREATE INDEX IF NOT EXISTS ix_content_channels_kind_enabled
            ON content_channels (kind, enabled, account_id);

        CREATE TABLE IF NOT EXISTS content_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL CHECK (role IN ('source', 'draft', 'published')),
            status TEXT NOT NULL DEFAULT 'stored',
            account_id TEXT NOT NULL,
            chat_id TEXT,
            peer_id TEXT,
            chat_title TEXT,
            message_id INTEGER,
            message_date TEXT,
            text TEXT NOT NULL,
            normalized_text TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            source_post_id INTEGER,
            meta_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (role, account_id, chat_id, message_id)
        );

        CREATE INDEX IF NOT EXISTS ix_content_posts_role_created
            ON content_posts (role, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_content_posts_chat_message
            ON content_posts (account_id, chat_id, message_id);
        CREATE INDEX IF NOT EXISTS ix_content_posts_fingerprint
            ON content_posts (fingerprint);

        CREATE TABLE IF NOT EXISTS content_campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'planned',
            account_id TEXT NOT NULL,
            required_targets_json TEXT NOT NULL,
            excluded_targets_json TEXT NOT NULL,
            requested_format TEXT NOT NULL,
            min_chars INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS content_campaign_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER NOT NULL REFERENCES content_campaigns(id) ON DELETE CASCADE,
            target_profile_id TEXT NOT NULL,
            target_reference TEXT NOT NULL,
            draft_id INTEGER REFERENCES content_posts(id),
            status TEXT NOT NULL DEFAULT 'planned',
            action_id INTEGER,
            expected_peer_id TEXT,
            actual_peer_id TEXT,
            message_id INTEGER,
            verification_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (campaign_id, target_profile_id),
            UNIQUE (campaign_id, draft_id)
        );

        CREATE INDEX IF NOT EXISTS ix_content_campaign_items_status
            ON content_campaign_items (campaign_id, status);
        """)
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
    return text or None


def row_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def normalize_text(text: str) -> str:
    text = str(text or "").lower()
    text = re.sub(r"https?://\S+|t\.me/\S+", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[@#]\w+", " ", text, flags=re.UNICODE)
    text = re.sub(r"[^\w\s]+", " ", text, flags=re.UNICODE)
    text = re.sub(r"\s+", " ", text, flags=re.UNICODE)
    return text.strip()


def token_set(text: str) -> set[str]:
    return set(re.findall(r"(?u)\b\w{3,}\b", normalize_text(text)))


def fingerprint_text(text: str) -> str:
    normalized = normalize_text(text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]


def similarity_score(left: str, right: str) -> float:
    left_norm = normalize_text(left)
    right_norm = normalize_text(right)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm == right_norm:
        return 1.0
    sequence = difflib.SequenceMatcher(None, left_norm, right_norm).ratio()
    left_tokens = token_set(left_norm)
    right_tokens = token_set(right_norm)
    if not left_tokens or not right_tokens:
        return sequence
    intersection = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens)
    jaccard = intersection / union if union else 0.0
    overlap = intersection / min(len(left_tokens), len(right_tokens))
    return max(
        sequence, jaccard, overlap if min(len(left_tokens), len(right_tokens)) >= 4 else 0.0
    )


def _validate_kind(kind: str) -> str:
    value = str(kind or "").strip().lower()
    if value not in CHANNEL_KINDS:
        raise ValueError(f"kind must be one of: {', '.join(sorted(CHANNEL_KINDS))}")
    return value


def _validate_role(role: str) -> str:
    value = str(role or "").strip().lower()
    if value not in POST_ROLES:
        raise ValueError(f"role must be one of: {', '.join(sorted(POST_ROLES))}")
    return value


def _json_dumps(value: Optional[Dict[str, Any]]) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _json_loads(value: Optional[str]) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except Exception:
        return value


def _post_payload(row: sqlite3.Row, *, include_text: bool = True) -> Dict[str, Any]:
    data = row_dict(row)
    data["meta"] = _json_loads(data.pop("meta_json", None))
    if not include_text:
        data["text_preview"] = preview_text(data.pop("text", ""))
    return data


def preview_text(text: str, limit: int = 220) -> str:
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(clean) <= limit:
        return clean
    return clean[: limit - 1].rstrip() + "..."


def set_setting(conn: sqlite3.Connection, key: str, value: Any) -> None:
    now = now_iso()
    conn.execute(
        """
        INSERT INTO content_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        """,
        (key, json.dumps(value, ensure_ascii=False), now),
    )


def get_setting(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    row = conn.execute("SELECT value_json FROM content_settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    return _json_loads(row["value_json"])


def set_config(
    conn: sqlite3.Connection,
    *,
    research_account_id: Optional[str] = None,
    similarity_threshold: Optional[float] = None,
) -> Dict[str, Any]:
    if research_account_id is not None:
        set_setting(conn, SETTING_RESEARCH_ACCOUNT, account_key(research_account_id))
    if similarity_threshold is not None:
        threshold = max(0.5, min(1.0, float(similarity_threshold)))
        set_setting(conn, SETTING_SIMILARITY_THRESHOLD, threshold)
    return get_config(conn)


def get_config(
    conn: sqlite3.Connection, *, default_account_id: str = DEFAULT_ACCOUNT_KEY
) -> Dict[str, Any]:
    return {
        "database": db_path(),
        "research_account_id": get_setting(
            conn, SETTING_RESEARCH_ACCOUNT, account_key(default_account_id)
        ),
        "similarity_threshold": float(
            get_setting(conn, SETTING_SIMILARITY_THRESHOLD, DEFAULT_SIMILARITY_THRESHOLD)
        ),
    }


def upsert_channel(
    conn: sqlite3.Connection,
    *,
    kind: str,
    account_id: Optional[str],
    chat_id: Any,
    title: Optional[str] = None,
    peer_id: Optional[Any] = None,
    username: Optional[str] = None,
    enabled: bool = True,
    notes: Optional[str] = None,
) -> Dict[str, Any]:
    channel_kind = _validate_kind(kind)
    account = account_key(account_id)
    chat = str(chat_id).strip()
    if not chat:
        raise ValueError("chat_id is required")
    label = str(title or chat).strip()[:500] or chat
    peer = str(peer_id).strip() if peer_id is not None else None
    now = now_iso()
    conn.execute(
        """
        INSERT INTO content_channels (
            kind, account_id, chat_id, peer_id, title, username, enabled,
            notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, account_id, chat_id) DO UPDATE SET
            peer_id = COALESCE(excluded.peer_id, content_channels.peer_id),
            title = excluded.title,
            username = COALESCE(excluded.username, content_channels.username),
            enabled = excluded.enabled,
            notes = COALESCE(excluded.notes, content_channels.notes),
            updated_at = excluded.updated_at
        """,
        (
            channel_kind,
            account,
            chat,
            peer,
            label,
            username,
            1 if enabled else 0,
            notes,
            now,
            now,
        ),
    )
    row = conn.execute(
        """
        SELECT * FROM content_channels
        WHERE kind = ? AND account_id = ? AND chat_id = ?
        """,
        (channel_kind, account, chat),
    ).fetchone()
    return row_dict(row)


def list_channels(
    conn: sqlite3.Connection,
    *,
    kind: Optional[str] = None,
    enabled_only: bool = False,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []
    if kind:
        clauses.append("kind = ?")
        params.append(_validate_kind(kind))
    if enabled_only:
        clauses.append("enabled = 1")
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    rows = conn.execute(
        f"""
        SELECT * FROM content_channels
        {where}
        ORDER BY kind, title COLLATE NOCASE
        LIMIT ?
        """,
        (*params, max(1, min(int(limit), 500))),
    ).fetchall()
    return [row_dict(row) for row in rows]


def set_channel_enabled(
    conn: sqlite3.Connection,
    *,
    kind: str,
    chat_id: Any,
    account_id: Optional[str],
    enabled: bool,
) -> Optional[Dict[str, Any]]:
    channel_kind = _validate_kind(kind)
    account = account_key(account_id)
    conn.execute(
        """
        UPDATE content_channels
        SET enabled = ?, updated_at = ?
        WHERE kind = ? AND account_id = ? AND chat_id = ?
        """,
        (1 if enabled else 0, now_iso(), channel_kind, account, str(chat_id)),
    )
    row = conn.execute(
        """
        SELECT * FROM content_channels
        WHERE kind = ? AND account_id = ? AND chat_id = ?
        """,
        (channel_kind, account, str(chat_id)),
    ).fetchone()
    return row_dict(row) if row else None


def store_post(
    conn: sqlite3.Connection,
    *,
    role: str,
    account_id: Optional[str],
    text: str,
    chat_id: Optional[Any] = None,
    peer_id: Optional[Any] = None,
    chat_title: Optional[str] = None,
    message_id: Optional[int] = None,
    message_date: Optional[Any] = None,
    source_post_id: Optional[int] = None,
    status: str = "stored",
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    post_role = _validate_role(role)
    body = str(text or "").strip()
    if not body:
        raise ValueError("text is required")
    account = account_key(account_id)
    chat = str(chat_id).strip() if chat_id is not None else None
    peer = str(peer_id).strip() if peer_id is not None else None
    normalized = normalize_text(body)
    fingerprint = fingerprint_text(body)
    now = now_iso()
    conn.execute(
        """
        INSERT INTO content_posts (
            role, status, account_id, chat_id, peer_id, chat_title, message_id, message_date,
            text, normalized_text, fingerprint, source_post_id, meta_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(role, account_id, chat_id, message_id) DO UPDATE SET
            status = excluded.status,
            peer_id = COALESCE(excluded.peer_id, content_posts.peer_id),
            chat_title = COALESCE(excluded.chat_title, content_posts.chat_title),
            message_date = COALESCE(excluded.message_date, content_posts.message_date),
            text = excluded.text,
            normalized_text = excluded.normalized_text,
            fingerprint = excluded.fingerprint,
            source_post_id = COALESCE(excluded.source_post_id, content_posts.source_post_id),
            meta_json = COALESCE(excluded.meta_json, content_posts.meta_json),
            updated_at = excluded.updated_at
        """,
        (
            post_role,
            status,
            account,
            chat,
            peer,
            chat_title,
            message_id,
            normalize_datetime(message_date),
            body,
            normalized,
            fingerprint,
            source_post_id,
            _json_dumps(meta),
            now,
            now,
        ),
    )
    if message_id is not None and chat is not None:
        row = conn.execute(
            """
            SELECT * FROM content_posts
            WHERE role = ? AND account_id = ? AND chat_id = ? AND message_id = ?
            """,
            (post_role, account, chat, int(message_id)),
        ).fetchone()
    else:
        row = conn.execute("SELECT * FROM content_posts WHERE id = last_insert_rowid()").fetchone()
    return _post_payload(row)


def get_post(conn: sqlite3.Connection, post_id: int) -> Optional[Dict[str, Any]]:
    row = conn.execute("SELECT * FROM content_posts WHERE id = ?", (int(post_id),)).fetchone()
    return _post_payload(row) if row else None


def _source_reference_parts(reference: str) -> Optional[tuple[str, int]]:
    text = str(reference or "").strip().split("?", 1)[0].split("#", 1)[0].rstrip("/")
    text = re.sub(r"^(?:https?://)?(?:www\.)?t\.me/", "", text, flags=re.IGNORECASE)
    parts = [part for part in text.split("/") if part]
    if len(parts) >= 3 and parts[-3].lower() == "c" and parts[-2].isdigit() and parts[-1].isdigit():
        return f"-100{parts[-2]}", int(parts[-1])
    if len(parts) >= 2 and parts[-1].isdigit():
        return parts[-2].lstrip("@"), int(parts[-1])
    return None


def find_source_post_by_reference(
    conn: sqlite3.Connection, reference: str
) -> Optional[Dict[str, Any]]:
    """Resolve ``@channel/123`` and public/private t.me post links."""

    parsed = _source_reference_parts(reference)
    if parsed is None:
        return None
    requested_chat, message_id = parsed
    requested = requested_chat.lower().lstrip("@")
    rows = conn.execute(
        """
        SELECT * FROM content_posts
        WHERE role = 'source' AND message_id = ?
        ORDER BY updated_at DESC, id DESC
        """,
        (message_id,),
    ).fetchall()
    for row in rows:
        aliases = {
            str(row["chat_id"] or "").lower().lstrip("@"),
            str(row["peer_id"] or "").lower().lstrip("@"),
        }
        channel_rows = conn.execute(
            """
            SELECT chat_id, peer_id, username FROM content_channels
            WHERE kind = 'source' AND account_id = ?
              AND (chat_id IN (?, ?) OR peer_id IN (?, ?))
            """,
            (
                row["account_id"],
                row["chat_id"],
                row["peer_id"],
                row["chat_id"],
                row["peer_id"],
            ),
        ).fetchall()
        for channel in channel_rows:
            aliases.update(
                str(value or "").lower().lstrip("@")
                for value in (channel["chat_id"], channel["peer_id"], channel["username"])
            )
        expanded = set(aliases)
        expanded.update(alias.removeprefix("-100") for alias in aliases if alias.startswith("-100"))
        if requested in expanded:
            return _post_payload(row)
    return None


def list_posts(
    conn: sqlite3.Connection,
    *,
    role: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
    include_text: bool = False,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []
    if role:
        clauses.append("role = ?")
        params.append(_validate_role(role))
    if status:
        clauses.append("status = ?")
        params.append(str(status))
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    rows = conn.execute(
        f"""
        SELECT * FROM content_posts
        {where}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        (*params, max(1, min(int(limit), 500))),
    ).fetchall()
    return [_post_payload(row, include_text=include_text) for row in rows]


def _role_clause(roles: Optional[Sequence[str]]) -> tuple[str, List[Any]]:
    if not roles:
        return "", []
    clean = [_validate_role(role) for role in roles]
    placeholders = ",".join("?" for _ in clean)
    return f"AND role IN ({placeholders})", clean


def find_similar_posts(
    conn: sqlite3.Connection,
    text: str,
    *,
    threshold: Optional[float] = None,
    limit: int = 10,
    roles: Optional[Sequence[str]] = None,
    exclude_post_id: Optional[int] = None,
    recent_window: int = DEFAULT_RECENT_WINDOW,
) -> List[Dict[str, Any]]:
    body = str(text or "").strip()
    if not body:
        return []
    threshold_value = float(
        threshold
        if threshold is not None
        else get_setting(conn, SETTING_SIMILARITY_THRESHOLD, DEFAULT_SIMILARITY_THRESHOLD)
    )
    role_sql, role_params = _role_clause(roles)
    exclude_sql = "AND id != ?" if exclude_post_id else ""
    params: List[Any] = [*role_params]
    if exclude_post_id:
        params.append(int(exclude_post_id))
    params.append(max(1, min(int(recent_window), 10000)))
    rows = conn.execute(
        f"""
        SELECT * FROM content_posts
        WHERE text != ''
        {role_sql}
        {exclude_sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    matches = []
    incoming_fp = fingerprint_text(body)
    for row in rows:
        score = 1.0 if row["fingerprint"] == incoming_fp else similarity_score(body, row["text"])
        if score >= threshold_value:
            item = _post_payload(row, include_text=False)
            item["similarity"] = round(score, 4)
            matches.append(item)
    matches.sort(key=lambda item: item["similarity"], reverse=True)
    return matches[: max(1, min(int(limit), 100))]


def create_draft(
    conn: sqlite3.Connection,
    *,
    text: str,
    target_chat_id: Optional[Any] = None,
    target_account_id: Optional[str] = None,
    target_title: Optional[str] = None,
    source_post_id: Optional[int] = None,
    threshold: Optional[float] = None,
    allow_similar: bool = False,
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    threshold_value = float(
        threshold
        if threshold is not None
        else get_setting(conn, SETTING_SIMILARITY_THRESHOLD, DEFAULT_SIMILARITY_THRESHOLD)
    )
    similar = find_similar_posts(conn, text, threshold=threshold_value, limit=10)
    if similar and not allow_similar:
        return {
            "ok": False,
            "blocked": True,
            "threshold": threshold_value,
            "similar": similar,
            "message": (
                "Draft is too similar to stored content. " "Rewrite it or set allow_similar=true."
            ),
        }
    draft = store_post(
        conn,
        role="draft",
        status="draft",
        account_id=target_account_id,
        chat_id=target_chat_id,
        chat_title=target_title,
        text=text,
        source_post_id=source_post_id,
        meta={**(meta or {}), "similar": similar, "threshold": threshold_value},
    )
    return {
        "ok": True,
        "blocked": False,
        "threshold": threshold_value,
        "similar": similar,
        "draft": draft,
    }


def set_post_status(
    conn: sqlite3.Connection, post_id: int, status: str
) -> Optional[Dict[str, Any]]:
    conn.execute(
        "UPDATE content_posts SET status = ?, updated_at = ? WHERE id = ?",
        (str(status), now_iso(), int(post_id)),
    )
    return get_post(conn, post_id)


def create_campaign(
    conn: sqlite3.Connection,
    *,
    name: str,
    account_id: Optional[str],
    required_targets: Sequence[Dict[str, Any]],
    excluded_targets: Sequence[Dict[str, Any]],
    requested_format: str,
    min_chars: int,
) -> Dict[str, Any]:
    """Persist an exact, fail-closed publication contract before any send."""
    required = [dict(item) for item in required_targets]
    excluded = [dict(item) for item in excluded_targets]
    if not required:
        raise ValueError("campaign requires at least one target")
    required_ids = [str(item.get("profile_id") or "").strip() for item in required]
    excluded_ids = {str(item.get("profile_id") or "").strip() for item in excluded}
    if any(not item for item in required_ids):
        raise ValueError("every campaign target requires profile_id")
    if len(required_ids) != len(set(required_ids)):
        raise ValueError("campaign targets must be unique")
    overlap = sorted(set(required_ids) & excluded_ids)
    if overlap:
        raise ValueError(f"campaign target is also excluded: {', '.join(overlap)}")
    now = now_iso()
    cursor = conn.execute(
        """
        INSERT INTO content_campaigns
            (name, status, account_id, required_targets_json,
             excluded_targets_json, requested_format, min_chars, created_at, updated_at)
        VALUES (?, 'planned', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(name or "").strip() or f"campaign-{now}",
            account_key(account_id),
            json.dumps(required, ensure_ascii=False, sort_keys=True),
            json.dumps(excluded, ensure_ascii=False, sort_keys=True),
            str(requested_format or "standard").strip().lower(),
            max(1, int(min_chars)),
            now,
            now,
        ),
    )
    campaign_id = int(cursor.lastrowid)
    for target in required:
        conn.execute(
            """
            INSERT INTO content_campaign_items
                (campaign_id, target_profile_id, target_reference, status,
                 created_at, updated_at)
            VALUES (?, ?, ?, 'planned', ?, ?)
            """,
            (
                campaign_id,
                str(target["profile_id"]),
                str(target.get("reference") or target["profile_id"]),
                now,
                now,
            ),
        )
    return get_campaign(conn, campaign_id) or {}


def get_campaign(conn: sqlite3.Connection, campaign_id: int) -> Optional[Dict[str, Any]]:
    row = conn.execute(
        "SELECT * FROM content_campaigns WHERE id = ?", (int(campaign_id),)
    ).fetchone()
    if row is None:
        return None
    campaign = row_dict(row)
    campaign["required_targets"] = _json_loads(campaign.pop("required_targets_json")) or []
    campaign["excluded_targets"] = _json_loads(campaign.pop("excluded_targets_json")) or []
    items = conn.execute(
        """
        SELECT * FROM content_campaign_items
        WHERE campaign_id = ? ORDER BY id
        """,
        (int(campaign_id),),
    ).fetchall()
    campaign["items"] = []
    for item_row in items:
        item = row_dict(item_row)
        item["verification"] = _json_loads(item.pop("verification_json"))
        campaign["items"].append(item)
    return campaign


def assign_campaign_item(
    conn: sqlite3.Connection,
    *,
    campaign_id: int,
    target_profile_id: str,
    draft_id: int,
    action_id: int,
    expected_peer_id: Optional[Any],
) -> None:
    now = now_iso()
    cursor = conn.execute(
        """
        UPDATE content_campaign_items
        SET draft_id = ?, action_id = ?, expected_peer_id = ?, status = 'pending',
            updated_at = ?
        WHERE campaign_id = ? AND target_profile_id = ? AND status = 'planned'
        """,
        (
            int(draft_id),
            int(action_id),
            str(expected_peer_id) if expected_peer_id is not None else None,
            now,
            int(campaign_id),
            str(target_profile_id),
        ),
    )
    if cursor.rowcount != 1:
        raise ValueError(
            f"campaign {campaign_id} target {target_profile_id} is not available for assignment"
        )
    _refresh_campaign_status(conn, campaign_id)


def record_campaign_delivery(
    conn: sqlite3.Connection,
    *,
    campaign_id: int,
    draft_id: int,
    action_id: int,
    actual_peer_id: Any,
    message_id: int,
    verification: Dict[str, Any],
) -> Dict[str, Any]:
    verified = bool(verification.get("verified"))
    status = "verified" if verified else "sent"
    now = now_iso()
    cursor = conn.execute(
        """
        UPDATE content_campaign_items
        SET status = ?, action_id = ?, actual_peer_id = ?, message_id = ?,
            verification_json = ?, updated_at = ?
        WHERE campaign_id = ? AND draft_id = ?
        """,
        (
            status,
            int(action_id),
            str(actual_peer_id),
            int(message_id),
            json.dumps(verification, ensure_ascii=False, sort_keys=True),
            now,
            int(campaign_id),
            int(draft_id),
        ),
    )
    if cursor.rowcount != 1:
        raise ValueError(
            f"campaign {campaign_id} has no item for draft {draft_id}"
        )
    _refresh_campaign_status(conn, campaign_id)
    return get_campaign(conn, campaign_id) or {}


def _refresh_campaign_status(conn: sqlite3.Connection, campaign_id: int) -> str:
    rows = conn.execute(
        "SELECT status FROM content_campaign_items WHERE campaign_id = ?",
        (int(campaign_id),),
    ).fetchall()
    statuses = [str(row["status"]) for row in rows]
    if not statuses:
        status = "failed"
    elif all(item == "verified" for item in statuses):
        status = "verified"
    elif all(item in {"sent", "verified"} for item in statuses):
        status = "sent"
    elif any(item in {"sent", "verified"} for item in statuses):
        status = "partially_sent"
    elif all(item == "pending" for item in statuses):
        status = "prepared"
    else:
        status = "planned"
    conn.execute(
        "UPDATE content_campaigns SET status = ?, updated_at = ? WHERE id = ?",
        (status, now_iso(), int(campaign_id)),
    )
    return status


def mark_draft_published(
    conn: sqlite3.Connection,
    *,
    draft_id: int,
    account_id: Optional[str],
    chat_id: Any,
    chat_title: Optional[str],
    message_id: Optional[int],
    message_date: Optional[Any] = None,
) -> Dict[str, Any]:
    draft = get_post(conn, draft_id)
    if not draft:
        raise ValueError(f"draft {draft_id} not found")
    draft_meta = draft.get("meta") if isinstance(draft.get("meta"), dict) else {}
    published = store_post(
        conn,
        role="published",
        status="published",
        account_id=account_id,
        chat_id=chat_id,
        chat_title=chat_title or draft.get("chat_title"),
        message_id=message_id,
        message_date=message_date,
        text=draft["text"],
        source_post_id=draft.get("source_post_id"),
        meta={
            "draft_id": draft_id,
            "published_from": "content_workflow",
            "format_mode": draft_meta.get("format_mode"),
            "formatted_text": draft_meta.get("formatted_text"),
            "source_reference": draft_meta.get("source_reference"),
            "source_formatting_guard": draft_meta.get("source_formatting_guard"),
        },
    )
    set_post_status(conn, draft_id, "published")
    return published


def research_posts(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
    unused_only: bool = False,
    source_chat_id: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    clauses = ["role = 'source'"]
    params: List[Any] = []
    if source_chat_id is not None:
        clauses.append("chat_id = ?")
        params.append(str(source_chat_id))
    if unused_only:
        clauses.append("""
            NOT EXISTS (
                SELECT 1 FROM content_posts AS drafts
                WHERE drafts.source_post_id = content_posts.id
            )
            """)
    where = " AND ".join(clauses)
    rows = conn.execute(
        f"""
        SELECT * FROM content_posts
        WHERE {where}
        ORDER BY COALESCE(message_date, created_at) DESC, id DESC
        LIMIT ?
        """,
        (*params, max(1, min(int(limit), 200))),
    ).fetchall()
    return [_post_payload(row, include_text=True) for row in rows]


def stats(conn: sqlite3.Connection) -> Dict[str, Any]:
    rows = conn.execute("""
        SELECT role, status, COUNT(*) AS count
        FROM content_posts
        GROUP BY role, status
        ORDER BY role, status
        """).fetchall()
    channel_rows = conn.execute("""
        SELECT kind, enabled, COUNT(*) AS count
        FROM content_channels
        GROUP BY kind, enabled
        ORDER BY kind, enabled
        """).fetchall()
    return {
        "database": db_path(),
        "posts": [row_dict(row) for row in rows],
        "channels": [row_dict(row) for row in channel_rows],
    }


def import_history(
    conn: sqlite3.Connection,
    posts: Iterable[Dict[str, Any]],
    *,
    default_role: str = "published",
    default_account_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    imported = []
    for item in posts:
        imported.append(
            store_post(
                conn,
                role=str(item.get("role") or default_role),
                status=str(item.get("status") or "imported"),
                account_id=item.get("account_id") or default_account_id,
                chat_id=item.get("chat_id"),
                peer_id=item.get("peer_id"),
                chat_title=item.get("chat_title") or item.get("title"),
                message_id=item.get("message_id"),
                message_date=item.get("message_date") or item.get("date"),
                text=str(item.get("text") or ""),
                source_post_id=item.get("source_post_id"),
                meta=item.get("meta") if isinstance(item.get("meta"), dict) else None,
            )
        )
    return imported
