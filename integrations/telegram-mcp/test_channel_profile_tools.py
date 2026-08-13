import json
import os
import asyncio


os.environ.setdefault("TELEGRAM_API_ID", "12345")
os.environ.setdefault("TELEGRAM_API_HASH", "dummy_hash")

from main import (
    assistant_confirm_action,
    content_channel_post_brief,
    content_channel_profiles,
    content_campaign_plan,
    content_campaign_status,
    content_create_draft,
    content_quality_review,
    content_prepare_publish_batch,
)
import assistant_memory as am
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


def test_disabled_channel_is_blocked_before_draft_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    text = (
        "Внешность меняется через систему: уход, стиль, лицо и ежедневную рутину. "
        "Looksmax-план связывает измерения, grooming и последовательные действия. "
        "Каждый этап фиксируется, чтобы образ менялся по фактам, а не по настроению."
    )

    result = json.loads(content_create_draft(text, target_chat_id="@slivmogwarts"))

    assert result["ok"] is False
    assert result["block_reason"] == "channel_disabled"
    with cw.connect() as conn:
        assert cw.list_posts(conn, role="draft") == []


def test_campaign_contract_blocks_short_draft_before_any_action(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    text = (
        "Программа тренировок связывает упражнения, технику и прогрессию. "
        "Записывай каждый подход и повтор, чтобы видеть нагрузку. "
        "Вес растёт только после стабильного выполнения плана. "
        "Если техника ломается, нагрузка остаётся прежней ещё на неделю. "
        "Так журнал отделяет реальный прогресс от случайного удачного подхода."
    )
    draft = json.loads(
        content_create_draft(
            text,
            target_chat_id="@r7training",
            requested_format="auto",
        )
    )["draft"]
    campaign = json.loads(
        content_campaign_plan(
            "regression",
            '["@r7training"]',
            '["@slivmogwarts"]',
            requested_format="standard",
        )
    )["campaign"]

    result = json.loads(
        asyncio.run(
            content_prepare_publish_batch(
                json.dumps(
                    [{"draft_id": draft["id"], "target_chat_id": "@r7training"}]
                ),
                campaign_id=campaign["id"],
            )
        )
    )

    assert result["ok"] is False
    assert result["block_reason"] == "batch_preflight_failed"
    assert result["prepared"] == 0
    assert "too short" in json.dumps(result["errors"])
    status = json.loads(content_campaign_status(campaign["id"]))
    assert status["campaign"]["status"] == "planned"


def test_managed_multi_channel_batch_requires_campaign_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    base = (
        "Программа тренировок строится вокруг техники, упражнений и прогрессии. "
        "Рабочие подходы и повторы записываются после каждой тренировки. "
        "Тренировочный журнал показывает реальную нагрузку и следующий шаг. "
    )
    first = json.loads(
        content_create_draft(base + "Первый цикл начинается с контроля техники.", target_chat_id="@r7training")
    )["draft"]
    second = json.loads(
        content_create_draft(
            (
                "Биохакинг начинается не с списка банок, а с физиологии и измерений. "
                "Сон, питание и восстановление проверяются по журналу самочувствия. "
                "Любой протокол меняется только после анализа данных и исследований."
            ),
            target_chat_id="@bmchnka",
        )
    )["draft"]

    result = json.loads(
        asyncio.run(
            content_prepare_publish_batch(
                json.dumps(
                    [
                        {"draft_id": first["id"], "target_chat_id": "@r7training"},
                        {"draft_id": second["id"], "target_chat_id": "@bmchnka"},
                    ]
                )
            )
        )
    )

    assert result["ok"] is False
    assert result["block_reason"] == "batch_preflight_failed"
    assert result["prepared"] == 0
    assert any("campaign" in item.get("error", "") for item in result["errors"])


def test_campaign_batch_must_match_exact_allowlist(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(tmp_path / "content.sqlite3"))
    draft = json.loads(
        content_create_draft(
            (
                "Биохакинг начинается с физиологии, измерений и проверки данных. "
                "Сон, питание, восстановление и анализы образуют единую систему. "
                "Протокол меняется только после наблюдения за результатами, а не по обещаниям. "
                "Так исследования превращаются в проверяемую практику и понятный следующий шаг."
            ),
            target_chat_id="@bmchnka",
        )
    )["draft"]
    campaign = json.loads(
        content_campaign_plan(
            "exact-target-regression",
            '["@r7training"]',
            requested_format="standard",
            min_chars=100,
        )
    )["campaign"]

    result = json.loads(
        asyncio.run(
            content_prepare_publish_batch(
                json.dumps(
                    [{"draft_id": draft["id"], "target_chat_id": "@bmchnka"}]
                ),
                campaign_id=campaign["id"],
            )
        )
    )

    assert result["ok"] is False
    assert result["block_reason"] == "batch_preflight_failed"
    assert result["prepared"] == 0
    assert any(
        item.get("error") == "batch targets do not exactly match the campaign allowlist"
        for item in result["errors"]
    )


def test_confirm_rechecks_disabled_channel_for_stale_action(tmp_path):
    old_db_path = am.DB_PATH
    am.DB_PATH = str(tmp_path / "assistant.sqlite3")
    try:
        with am.connect() as conn:
            action_id = am.create_pending_action(
                conn,
                action_type="send_message",
                account_id="publisher",
                target_chat="@slivmogwarts",
                target_label="Disabled target",
                payload={
                    "chat_id": "@slivmogwarts",
                    "message": "This stale action must never reach Telegram.",
                },
            )
            conn.commit()

        result = asyncio.run(assistant_confirm_action(action_id))

        with am.connect() as conn:
            action = am.get_pending_action(conn, action_id)
        assert "disabled" in result.lower()
        assert action["status"] == "failed"
        assert json.loads(action["error_json"])["delivery_state"] == "not_sent"
    finally:
        am.DB_PATH = old_db_path
