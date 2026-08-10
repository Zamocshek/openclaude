import json
import os
import asyncio


os.environ.setdefault("TELEGRAM_API_ID", "12345")
os.environ.setdefault("TELEGRAM_API_HASH", "dummy_hash")

from main import (
    content_channel_post_brief,
    content_channel_profiles,
    content_create_draft,
    content_quality_review,
    content_prepare_publish_batch,
)
import content_workflow as cw


def test_profiles_tool_returns_bundled_network():
    result = json.loads(content_channel_profiles())

    assert result["ok"] is True
    assert result["returned"] == 14
    assert all(item["publishing_enabled"] for item in result["channels"])
    assert result["format_policy"]["telegram_utf16_limit"] == 4096

    administrative = json.loads(content_channel_profiles(include_disabled=True))
    assert administrative["returned"] == 15
    assert any(
        item["id"] == "mogwarts-looksmaxxing-library"
        and item["publishing_enabled"] is False
        for item in administrative["channels"]
    )


def test_brief_tool_returns_long_channel_specific_guidance():
    result = json.loads(
        content_channel_post_brief(
            "@r7training",
            requested_format="long",
            objective="Explain a complete training progression.",
        )
    )

    assert result["ok"] is True
    assert result["channel"]["id"] == "r7-training-library"
    assert result["description"]["source"] == "inferred_description"
    assert result["format"]["selected_guidance"]["target_chars"] == 2800
    assert result["format"]["hard_limit_utf16"] == 4096


def test_brief_tool_returns_structured_error_for_unknown_target():
    result = json.loads(content_channel_post_brief("@channel_not_in_registry"))

    assert result["ok"] is False
    assert result["error_type"] == "channel_profile_error"


def test_quality_tool_and_draft_gate_block_cross_channel_content(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    text = (
        "Бизнес-модель начинается с цены, маркетинга и воронки продаж. "
        "Сначала посчитайте маржу, затем рекламный бюджет и окупаемость. "
        "После этого оптимизируйте продажи и повторные покупки клиента."
    )

    review = json.loads(content_quality_review("@r7training", text))
    draft = json.loads(content_create_draft(text, target_chat_id="@r7training"))

    assert review["ok"] is True
    assert review["blocked"] is True
    assert draft["ok"] is False
    assert draft["block_reason"] == "channel_quality"


def test_channel_specific_draft_stores_quality_receipt(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    text = (
        "Программа тренировок связывает упражнения, технику и прогрессию. "
        "Записывайте рабочие подходы и повторы, чтобы видеть реальную нагрузку. "
        "Повышайте вес только после стабильного выполнения плана.\n\n"
        "Так тренировочный журнал превращает усилия в измеримый результат."
    )

    result = json.loads(content_create_draft(text, target_chat_id="@r7training"))

    assert result["ok"] is True
    assert result["draft"]["meta"]["quality_review"]["passed"] is True


def test_channel_draft_stores_external_source_reference(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    with cw.connect() as conn:
        cw.upsert_channel(
            conn,
            kind="source",
            account_id="research",
            chat_id="-100321",
            peer_id="-100321",
            title="Training donor",
            username="training_donor",
        )
        cw.store_post(
            conn,
            role="source",
            account_id="research",
            chat_id="-100321",
            peer_id="-100321",
            message_id=123,
            text="Донорский материал о тренировочной дисциплине.",
        )
        conn.commit()
    text = (
        "Программа тренировок связывает упражнения, технику и прогрессию. "
        "Записывайте рабочие подходы и повторы, чтобы видеть реальную нагрузку. "
        "Повышайте вес только после стабильного выполнения плана.\n\n"
        "Так тренировочный журнал превращает усилия в измеримый результат."
    )

    result = json.loads(
        content_create_draft(
            text,
            target_chat_id="@r7training",
            source_reference="@training_donor/123",
        )
    )

    assert result["ok"] is True
    assert result["draft"]["meta"]["source_reference"] == "@training_donor/123"


def test_prepare_batch_keeps_missing_draft_as_item_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))

    result = json.loads(
        asyncio.run(content_prepare_publish_batch('[{"draft_id": 999999}]'))
    )

    assert result["ok"] is False
    assert result["failed"] == 1
    assert result["items"][0]["error_type"] == "not_found"
