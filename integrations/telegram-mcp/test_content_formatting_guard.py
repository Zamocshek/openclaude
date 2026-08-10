import asyncio
import json
import os
from types import SimpleNamespace

from telethon import types


os.environ.setdefault("TELEGRAM_API_ID", "12345")
os.environ.setdefault("TELEGRAM_API_HASH", "dummy_hash")

import content_workflow as cw
import main
import post_formatting as pf


def _store_rich_source(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    formatting = pf.formatting_snapshot(
        "Read docs",
        [types.MessageEntityTextUrl(0, 4, "https://example.com/docs")],
    )
    with cw.connect() as conn:
        source = cw.store_post(
            conn,
            role="source",
            status="captured",
            account_id="research",
            chat_id="-100123",
            peer_id="-100123",
            message_id=7,
            text="Read docs",
            meta={"telegram_formatting": formatting},
        )
        conn.commit()
    return source


def test_exact_source_text_inherits_telegram_entities(tmp_path, monkeypatch):
    source = _store_rich_source(tmp_path, monkeypatch)

    result = json.loads(
        main.content_create_draft(
            "Read docs",
            source_post_id=source["id"],
            allow_similar=True,
        )
    )

    assert result["ok"] is True
    assert result["draft"]["meta"]["format_mode"] == "html"
    assert result["draft"]["meta"]["source_formatting_guard"]["inherited"] is True
    assert result["formatting"]["entities"] == 1


def test_edited_plain_draft_is_blocked_when_hidden_link_label_remains(tmp_path, monkeypatch):
    source = _store_rich_source(tmp_path, monkeypatch)

    result = json.loads(
        main.content_create_draft(
            "Read a different guide",
            source_post_id=source["id"],
            allow_similar=True,
        )
    )

    assert result["ok"] is False
    assert result["block_reason"] == "source_formatting_loss"
    assert result["missing_entities"][0]["target"] == "https://example.com/docs"


def test_edited_html_draft_can_preserve_hidden_link(tmp_path, monkeypatch):
    source = _store_rich_source(tmp_path, monkeypatch)

    result = json.loads(
        main.content_create_draft(
            '<a href="https://example.com/docs">Read</a> a different guide',
            source_post_id=source["id"],
            allow_similar=True,
            format_mode="html",
        )
    )

    assert result["ok"] is True
    assert result["draft"]["meta"]["source_formatting_guard"]["passed"] is True


def test_external_source_reference_must_be_captured_before_drafting(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))

    result = json.loads(
        main.content_create_draft("Text", source_reference="@missing_source/99")
    )

    assert result["ok"] is False
    assert result["block_reason"] == "source_not_captured"


def test_plain_draft_recovers_when_model_omits_source_post_id(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    formatting = pf.formatting_snapshot(
        "Linked catalog",
        [types.MessageEntityTextUrl(0, 14, "https://example.com/catalog")],
    )
    with cw.connect() as conn:
        source = cw.store_post(
            conn,
            role="source",
            account_id="research",
            chat_id="-100777",
            message_id=17,
            text="Linked catalog",
            meta={"telegram_formatting": formatting},
        )
        conn.commit()

    result = json.loads(
        main.content_create_draft(
            "Linked catalog update",
            allow_similar=True,
            allow_formatting_loss=True,
        )
    )

    assert result["ok"] is False
    assert result["block_reason"] == "source_formatting_requires_provenance"
    assert result["source_candidates"][0]["source_post_id"] == source["id"]

    preserved = json.loads(
        main.content_create_draft(
            '<a href="https://example.com/catalog">Linked catalog</a> update',
            allow_similar=True,
            format_mode="html",
        )
    )
    assert preserved["ok"] is True


def test_publish_preflight_blocks_legacy_plain_draft_with_lost_entities(tmp_path, monkeypatch):
    source = _store_rich_source(tmp_path, monkeypatch)
    with cw.connect() as conn:
        draft = cw.create_draft(
            conn,
            text="Read docs",
            target_chat_id="@target",
            target_account_id="publisher",
            source_post_id=source["id"],
            allow_similar=True,
            meta={"format_mode": "plain"},
        )["draft"]
        conn.commit()

    result = json.loads(asyncio.run(main.content_prepare_publish(draft["id"])))

    assert result["ok"] is False
    assert result["block_reason"] == "source_formatting_loss"


def test_capture_source_post_stores_portable_formatting(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    entity = SimpleNamespace(username="donor")
    message = SimpleNamespace(
        id=11,
        message="Open catalog",
        text="Open catalog",
        entities=[types.MessageEntityTextUrl(0, 4, "https://example.com/catalog")],
        date=None,
        views=10,
        forwards=2,
    )

    class FakeClient:
        async def get_entity(self, _chat_id):
            return entity

        async def get_messages(self, _entity, ids):
            assert ids == 11
            return message

    async def get_client(_account_id=None):
        return FakeClient(), "research"

    monkeypatch.setattr(main, "_get_assistant_client_and_account", get_client)
    monkeypatch.setattr(main.am, "peer_id", lambda _entity: "-100555")
    monkeypatch.setattr(main.am, "display_name", lambda _entity: "Donor")

    result = json.loads(
        asyncio.run(main.content_capture_source_post("@donor", 11, "research"))
    )

    assert result["ok"] is True
    assert result["source_reference"] == "@donor/11"
    formatting = result["source_post"]["meta"]["telegram_formatting"]
    assert formatting["entity_count"] == 1
    assert formatting["entities"][0]["target"] == "https://example.com/catalog"
