"""
SQLite database for duplicate post detection and content tracking.
Stores original donor posts and translated outputs to prevent repeats.
"""

import sqlite3
import hashlib
import difflib
import os
from datetime import datetime, timezone
from pathlib import Path

# Порог "почти повтора": тексты со сходством выше этого считаются одним
# и тем же постом (напр. отличающиеся только «ё/е», запятой, падежом).
SIMILARITY_THRESHOLD = 0.85

DB_PATH = os.getenv(
    "NOVA_CONTENT_PIPELINE_DB",
    str(Path(__file__).resolve().with_name("posts.db")),
)


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS donor_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            donor_channel TEXT NOT NULL,
            donor_message_id INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            original_text TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            UNIQUE(donor_channel, donor_message_id)
        );

        CREATE TABLE IF NOT EXISTS translated_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            donor_post_id INTEGER REFERENCES donor_posts(id),
            translated_text TEXT NOT NULL,
            translation_hash TEXT NOT NULL,
            style TEXT NOT NULL DEFAULT 'cis',
            status TEXT NOT NULL DEFAULT 'draft',
            target_channel TEXT,
            created_at TEXT NOT NULL,
            published_at TEXT,
            published_msg_id INTEGER,
            UNIQUE(translation_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_donor_hash ON donor_posts(content_hash);
        CREATE INDEX IF NOT EXISTS idx_translation_hash ON translated_posts(translation_hash);
        CREATE INDEX IF NOT EXISTS idx_donor_channel ON donor_posts(donor_channel);
    """)
    conn.commit()
    conn.close()


def hash_text(text: str) -> str:
    """Normalize and hash text for duplicate detection."""
    normalized = text.strip().lower()
    # remove extra whitespace
    normalized = " ".join(normalized.split())
    return hashlib.sha256(normalized.encode()).hexdigest()


def _normalized(text: str) -> str:
    return " ".join(text.strip().lower().split())


def text_similarity(a: str, b: str) -> float:
    """Co-occurrence similarity (0..1) of two texts после нормализации."""
    return difflib.SequenceMatcher(None, _normalized(a), _normalized(b)).ratio()


def donor_post_exists(donor_channel: str, donor_message_id: int) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM donor_posts WHERE donor_channel=? AND donor_message_id=?",
        (donor_channel, donor_message_id),
    ).fetchone()
    conn.close()
    return row is not None


def save_donor_post(donor_channel: str, donor_message_id: int, original_text: str) -> int | None:
    if donor_post_exists(donor_channel, donor_message_id):
        return None
    conn = get_conn()
    content_hash = hash_text(original_text)
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO donor_posts (donor_channel, donor_message_id, content_hash, original_text, fetched_at) VALUES (?,?,?,?,?)",
        (donor_channel, donor_message_id, content_hash, original_text, now),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def is_duplicate(text: str) -> bool:
    """Check if a translation already exists."""
    conn = get_conn()
    h = hash_text(text)
    row = conn.execute(
        "SELECT 1 FROM translated_posts WHERE translation_hash=?",
        (h,),
    ).fetchone()
    conn.close()
    return row is not None


def is_similar_to_original(text: str, threshold: float = 0.8) -> bool:
    """Quick check: is this text too similar to any stored original?"""
    conn = get_conn()
    h = hash_text(text)
    # exact hash match
    row = conn.execute(
        "SELECT 1 FROM donor_posts WHERE content_hash=? OR id IN (SELECT donor_post_id FROM translated_posts WHERE translation_hash=?)",
        (h, h),
    ).fetchone()
    conn.close()
    return row is not None


def save_translation(donor_post_id: int, translated_text: str, style: str = "cis") -> int | None:
    if is_duplicate(translated_text):
        return None
    conn = get_conn()
    translation_hash = hash_text(translated_text)
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO translated_posts (donor_post_id, translated_text, translation_hash, style, status, created_at) VALUES (?,?,?,?,?,?)",
        (donor_post_id, translated_text, translation_hash, style, "draft", now),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def list_drafts(limit: int = 20) -> list:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM translated_posts WHERE status='draft' ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def mark_published(translation_id: int, target_channel: str, published_msg_id: int):
    """Legacy local mirror only; managed Telegram MCP owns publication truth."""
    if int(published_msg_id) <= 0:
        raise ValueError(
            "DELIVERY GUARD: a positive Telegram message_id is required. "
            "Use the managed Telegram MCP campaign workflow and its readback receipt."
        )
    conn = get_conn()
    row = conn.execute(
        "SELECT status, target_channel FROM translated_posts WHERE id=?",
        (translation_id,),
    ).fetchone()
    if row is None:
        conn.close()
        raise ValueError(
            f"UNIQUENESS GUARD: перевод #{translation_id} не найден в базе."
        )
    if row["status"] == "published":
        conn.close()
        raise ValueError(
            f"UNIQUENESS GUARD: перевод #{translation_id} уже опубликован "
            f"в «{row['target_channel']}». 1 пост = 1 канал. Повторное "
            f"использование того же поста в другой канал — ЗАПРЕЩЕНО. "
            f"Бери пост из другой волны (prepare-batch / verify-wave)."
        )
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE translated_posts SET status='published', target_channel=?, published_at=?, published_msg_id=? WHERE id=?",
        (target_channel, now, published_msg_id, translation_id),
    )
    conn.commit()
    conn.close()


def allocate_wave(channels: list[str], min_chars: int = 700) -> dict[str, dict]:
    """Batch-publish uniqueness guard.

    HARD RULE (закреплено на всех уровнях): 1 канал = 1 УНИКАЛЬНЫЙ пост.
    Распределяет по каналам разные черновики, отклоняя не только точные
    повторы (одинаковый hash), но и ПОЧТИ-ПОВТОРЫ — тексты, совпадающие
    по смыслу на SIMILARITY_THRESHOLD и выше (например, отличающиеся
    только «ё/е» или запятой). Никогда не выдаёт один черновик в два
    канала и не берёт уже опубликованные посты.

    Raises RuntimeError, если уникальных черновиков меньше, чем каналов —
    волна БЛОКИРУЕТСЯ, пока не будут переведены новые посты.
    """
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM translated_posts WHERE status='draft' ORDER BY created_at ASC"
    ).fetchall()
    conn.close()

    allocation: dict[str, dict] = {}
    for channel in channels:
        picked = None
        for d in rows:
            d = dict(d)
            if len(" ".join(d["translated_text"].split())) < int(min_chars):
                continue
            if any(
                p["translation_hash"] == d["translation_hash"]
                for p in allocation.values()
            ):
                continue  # точный повтор
            if any(
                text_similarity(p["translated_text"], d["translated_text"])
                >= SIMILARITY_THRESHOLD
                for p in allocation.values()
            ):
                continue  # почти-повтор (тот же пост по смыслу)
            picked = d
            break
        if picked is None:
            raise RuntimeError(
                f"UNIQUENESS GUARD: не хватает различных черновиков — "
                f"нужно {len(channels)} каналов, отобрано уникальных: "
                f"{len(allocation)}. "
                f"Сначала синхронизируй доноров и переведи больше постов. "
                f"НЕЛЬЗЯ публиковать одинаковый пост (или почти одинаковый) "
                f"в несколько каналов."
            )
        allocation[channel] = picked
    return allocation


def verify_wave_uniqueness() -> list[dict]:
    """Post-publish audit: точные И почти-повторы, ушедшие в >1 канал."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, target_channel, translation_hash, published_at, translated_text "
        "FROM translated_posts "
        "WHERE status='published' AND target_channel IS NOT NULL "
        "ORDER BY published_at ASC"
    ).fetchall()
    conn.close()
    published = [dict(r) for r in rows]

    duplicates: list[dict] = []

    # 1) точные повторы (same hash ушёл в два канала и больше)
    by_hash: dict[str, list[dict]] = {}
    for r in published:
        by_hash.setdefault(r["translation_hash"], []).append(r)
    for h, group in by_hash.items():
        if len(group) > 1:
            duplicates.append(
                {
                    "reason": "exact",
                    "hash": h,
                    "items": group,
                    "sent_to_count": len(group),
                }
            )

    # 2) почти-повторы (разный hash, но текст совпадает >= SIMILARITY_THRESHOLD)
    n = len(published)
    for i in range(n):
        for j in range(i + 1, n):
            if published[i]["translation_hash"] == published[j]["translation_hash"]:
                continue
            sim = text_similarity(
                published[i]["translated_text"], published[j]["translated_text"]
            )
            if sim >= SIMILARITY_THRESHOLD:
                duplicates.append(
                    {
                        "reason": "similar",
                        "similarity": round(sim, 3),
                        "items": [published[i], published[j]],
                    }
                )

    return duplicates


def get_stats() -> dict:
    conn = get_conn()
    total_donor = conn.execute("SELECT COUNT(*) FROM donor_posts").fetchone()[0]
    total_drafts = conn.execute(
        "SELECT COUNT(*) FROM translated_posts WHERE status='draft'"
    ).fetchone()[0]
    total_published = conn.execute(
        "SELECT COUNT(*) FROM translated_posts WHERE status='published'"
    ).fetchone()[0]
    by_donor = conn.execute(
        "SELECT donor_channel, COUNT(*) as c FROM donor_posts GROUP BY donor_channel ORDER BY c DESC"
    ).fetchall()
    conn.close()
    return {
        "total_donor_posts": total_donor,
        "total_drafts": total_drafts,
        "total_published": total_published,
        "by_donor": [dict(r) for r in by_donor],
    }


# Initialize on import
init_db()
