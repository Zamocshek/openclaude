#!/usr/bin/env python3
"""
Content Pipeline CLI — donor sync, translation management, duplicate guard.

Usage:
  python pipeline.py sync              # Sync new posts from all donor channels
  python pipeline.py sync --dry-run    # Preview without saving
  python pipeline.py drafts            # List pending drafts
  python pipeline.py pending           # List donor posts not yet translated
  python pipeline.py stats             # Show pipeline statistics
  python pipeline.py translate ID      # Output translation prompt for a donor post
  python pipeline.py publish ID CH     # Mark draft as published in channel
  python pipeline.py import TEXT       # Import a custom/original post (bypass donors)
  python pipeline.py prepare-batch     # Assign a UNIQUE post to each channel (wave guard)
  python pipeline.py verify-wave       # Verify no post was repeated across channels

The actual fetching and translation is done via Telegram MCP in the AI session.
This script manages the local DB state.
"""

import argparse
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from db import (
    init_db, save_donor_post, donor_post_exists,
    save_translation, is_duplicate, is_similar_to_original,
    list_drafts, get_stats, get_conn,
    allocate_wave, verify_wave_uniqueness,
)
from config import (
    DONORS,
    SKIP_PATTERNS,
    MIN_POST_LENGTH,
    STYLE_GUIDE,
    TARGET_CHANNELS,
    DISABLED_TARGET_CHANNELS,
)
from datetime import datetime, timezone


def should_skip(text: str) -> bool:
    """Check if post should be skipped (promo, too short)."""
    if not text or len(text.strip()) < MIN_POST_LENGTH:
        return True
    for pattern in SKIP_PATTERNS:
        if pattern.lower() in text.lower():
            return True
    return False


def cmd_sync(args):
    """Show instructions for syncing — actual fetch done via MCP."""
    print("=" * 60)
    print("DONOR SYNC — fetch via Telegram MCP get_history")
    print("=" * 60)
    for donor in DONORS:
        username = donor["username"]
        print(f"\n  {donor['name']} (@{username})")
        print(f"  → MCP call: get_history(chat_id='{username}', limit=10, account_id='18544421149')")
    print("\nAfter fetching, use: python pipeline.py import-donor DONOR_USERNAME 'TEXT' MSG_ID")
    print("=" * 60)


def cmd_import_donor(args):
    """Import a single donor post into the database."""
    donor_username = args.donor
    text = args.text.strip()
    msg_id = int(args.msg_id)

    if should_skip(text):
        print(f"SKIPPED (promo/too short): {text[:80]}...")
        return

    row_id = save_donor_post(donor_username, msg_id, text)
    if row_id is None:
        print(f"DUPLICATE: @{donor_username}/{msg_id} already in DB")
    else:
        print(f"SAVED: @{donor_username}/{msg_id} → donor_post #{row_id}")


def cmd_pending(args):
    """List donor posts not yet translated."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT d.id, d.donor_channel, d.donor_message_id, d.original_text, d.fetched_at
        FROM donor_posts d
        LEFT JOIN translated_posts t ON t.donor_post_id = d.id
        WHERE t.id IS NULL
        ORDER BY d.fetched_at DESC
    """).fetchall()
    conn.close()

    if not rows:
        print("No pending posts — all donor content has translations.")
        return

    print(f"{len(rows)} pending posts:\n")
    for r in rows:
        text_preview = r["original_text"][:100].replace("\n", " ")
        print(f"  #{r['id']} [{r['donor_channel']}] msg:{r['donor_message_id']}")
        print(f"     {text_preview}...\n")


def cmd_translate_prompt(args):
    """Output a translation prompt for an AI to process."""
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM donor_posts WHERE id=?",
        (args.id,),
    ).fetchone()
    conn.close()

    if not row:
        print(f"Donor post #{args.id} not found.")
        return

    print("=" * 60)
    print(f"DONOR POST #{row['id']} — @{row['donor_channel']}")
    print("=" * 60)
    print()
    print("ORIGINAL (EN):")
    print("-" * 40)
    print(row["original_text"])
    print("-" * 40)
    print()
    print("STYLE GUIDE (apply when translating):")
    print(STYLE_GUIDE)
    print()
    print("Translate the above into Russian (CIS street style).")
    print("After translation, save with:")
    print(f"  python pipeline.py save-translation {row['id']} 'TRANSLATED TEXT'")


def cmd_save_translation(args):
    """Save a translated post as draft."""
    donor_id = int(args.donor_id)
    text = args.text.strip()

    if len(text) < 30:
        print("ERROR: Translation too short (<30 chars). Not saving.")
        return

    if is_duplicate(text):
        print("DUPLICATE: This exact translation already exists.")
        return

    row_id = save_translation(donor_id, text)
    if row_id is None:
        print("ERROR: Failed to save translation (duplicate?).")
    else:
        print(f"SAVED: Translation #{row_id} → status: draft")


def cmd_drafts(args):
    """List all draft translations ready for publishing."""
    drafts = list_drafts(args.limit or 20)
    if not drafts:
        print("No drafts waiting.")
        return

    print(f"{len(drafts)} drafts:\n")
    for d in drafts:
        preview = d["translated_text"][:120].replace("\n", " ")
        print(f"  #{d['id']} [{d['style']}] {d['created_at'][:16]}")
        print(f"     {preview}...\n")


def cmd_publish(args):
    """Refuse to turn local metadata into an external delivery claim."""
    raise SystemExit(
        "BLOCKED: local pipeline.py cannot prove Telegram delivery. "
        "Use content_campaign_plan -> content_prepare_publish_batch -> "
        "assistant_confirm_action -> content_campaign_status. The managed "
        "Telegram MCP records action_id, peer_id, message_id, and readback proof."
    )


def cmd_prepare_batch(args):
    """Assign a UNIQUE post to each channel before a wave (uniqueness guard)."""
    channels = (
        [c.strip() for c in args.channels.split(",") if c.strip()]
        if args.channels
        else TARGET_CHANNELS
    )
    excluded = {
        c.strip().casefold()
        for c in (args.exclude or "").split(",")
        if c.strip()
    }
    channels = [channel for channel in channels if channel.casefold() not in excluded]
    disabled = [channel for channel in channels if channel in DISABLED_TARGET_CHANNELS]
    if disabled:
        print(
            "BLOCKED: disabled target(s): " + ", ".join(disabled),
            file=sys.stderr,
        )
        return
    if not channels:
        print("BLOCKED: campaign target list is empty.", file=sys.stderr)
        return
    try:
        allocation = allocate_wave(channels, min_chars=args.min_chars)
    except RuntimeError as e:
        print(f"BLOCKED: {e}", file=sys.stderr)
        return

    print(f"=== WAVE BUDGET: {len(allocation)} каналов = {len(allocation)} УНИКАЛЬНЫХ постов ===")
    for channel, draft in allocation.items():
        preview = draft["translated_text"][:70].replace("\n", " ")
        print(f"  «{channel}» ← draft #{draft['id']}: {preview}…")
    print()
    print("Это только редакторский план, не доказательство отправки.")
    print("Создай точный allowlist/exclusion manifest через content_campaign_plan,")
    print("публикуй управляемыми Telegram MCP tools и проверь content_campaign_status.")


def cmd_verify_wave(args):
    """Check: no post (exact or near-identical) went to more than one channel."""
    flagged = verify_wave_uniqueness()
    if not flagged:
        print("OK: ни один пост не повторён между каналами — волна уникальна.")
        return
    print("НАРУШЕНИЕ УНИКАЛЬНОСТИ:")
    for f in flagged:
        if f["reason"] == "exact":
            where = ", ".join(f"#{p['id']}→{p['target_channel']}" for p in f["items"])
            print(
                f"  ПОЛНЫЙ ПОВТОР (hash {f['hash'][:12]}): "
                f"{f['sent_to_count']} каналов — {where}"
            )
        else:
            a, b = f["items"]
            print(
                f"  ПОЧТИ-ПОВТОР ({f['similarity']:.0%} сходство): "
                f"#{a['id']}→{a['target_channel']} и #{b['id']}→{b['target_channel']}"
            )
        print("  → один пост = один канал. Переделай пост либо смени канал в волне.")


def cmd_stats(args):
    """Show pipeline statistics."""
    stats = get_stats()
    print("=" * 40)
    print("PIPELINE STATS")
    print("=" * 40)
    print(f"  Donor posts imported:  {stats['total_donor_posts']}")
    print(f"  Drafts waiting:        {stats['total_drafts']}")
    print(f"  Published:             {stats['total_published']}")
    print()
    print("  By donor:")
    for d in stats["by_donor"]:
        print(f"    @{d['donor_channel']}: {d['c']} posts")
    print("=" * 40)


def cmd_import_original(args):
    """Import a custom/original post (not from donors)."""
    text = args.text.strip()
    if len(text) < 30:
        print("ERROR: Post too short.")
        return

    if is_duplicate(text):
        print("DUPLICATE: This content already exists.")
        return

    # Save as a synthetic donor post
    now = datetime.now(timezone.utc).isoformat()
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO donor_posts (donor_channel, donor_message_id, content_hash, original_text, fetched_at) VALUES (?,?,?,?,?)",
        ("original", 0, __import__("hashlib").sha256(text.strip().lower().encode()).hexdigest(), text, now),
    )
    donor_id = cur.lastrowid
    conn.commit()

    # Auto-save as translation too (since it's already in target language)
    save_translation(donor_id, text, style="original")
    conn.close()
    print(f"SAVED: Original post → donor #{donor_id}, ready as draft.")


def main():
    parser = argparse.ArgumentParser(description="Content Pipeline CLI")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("sync", help="Show donor sync instructions")

    p_import = sub.add_parser("import-donor", help="Import a donor post")
    p_import.add_argument("donor", help="Donor username")
    p_import.add_argument("text", help="Post text")
    p_import.add_argument("msg_id", help="Message ID")

    sub.add_parser("pending", help="List untranslated donor posts")

    p_trans = sub.add_parser("translate", help="Generate translation prompt")
    p_trans.add_argument("id", type=int, help="Donor post ID")

    p_save = sub.add_parser("save-translation", help="Save translated text")
    p_save.add_argument("donor_id", type=int)
    p_save.add_argument("text", help="Translated text")

    p_drafts = sub.add_parser("drafts", help="List drafts")
    p_drafts.add_argument("--limit", type=int, default=20)

    p_pub = sub.add_parser(
        "publish",
        help="Deprecated: fail closed and direct publication to managed Telegram MCP",
    )
    p_pub.add_argument("id", type=int, help="Translation ID")
    p_pub.add_argument("channel", help="Target channel name")
    p_pub.add_argument("msg_id", nargs="?", help="Published message ID")

    p_orig = sub.add_parser("import-original", help="Import original post")
    p_orig.add_argument("text", help="Post text (already in Russian)")

    p_batch = sub.add_parser(
        "prepare-batch",
        help="Assign a UNIQUE post to each channel before a wave",
    )
    p_batch.add_argument(
        "--channels",
        help="Comma-separated allowlist (default: all enabled channels)",
    )
    p_batch.add_argument(
        "--exclude",
        default="",
        help="Comma-separated request-specific exclusions",
    )
    p_batch.add_argument(
        "--min-chars",
        type=int,
        default=700,
        help="Minimum developed post length for this editorial wave",
    )

    sub.add_parser("verify-wave", help="Verify no post repeated across channels")

    sub.add_parser("stats", help="Show statistics")

    args = parser.parse_args()

    if args.command == "sync":
        cmd_sync(args)
    elif args.command == "import-donor":
        cmd_import_donor(args)
    elif args.command == "pending":
        cmd_pending(args)
    elif args.command == "translate":
        cmd_translate_prompt(args)
    elif args.command == "save-translation":
        cmd_save_translation(args)
    elif args.command == "drafts":
        cmd_drafts(args)
    elif args.command == "publish":
        cmd_publish(args)
    elif args.command == "stats":
        cmd_stats(args)
    elif args.command == "import-original":
        cmd_import_original(args)
    elif args.command == "prepare-batch":
        cmd_prepare_batch(args)
    elif args.command == "verify-wave":
        cmd_verify_wave(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    init_db()
    main()
