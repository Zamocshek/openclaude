import json

import pytest

import channel_profiles as cp


def test_bundled_registry_has_all_channels_and_valid_length_modes():
    registry = cp.load_profiles()
    assert len(registry["channels"]) == 15
    assert set(registry["format_policy"]["modes"]) == {"short", "standard", "long"}
    assert registry["format_policy"]["modes"]["long"]["max_chars"] < 4096


@pytest.mark.parametrize(
    "reference",
    ["@slivmartin", "https://t.me/slivmartin", "1683331639", "-1001683331639"],
)
def test_profile_lookup_accepts_all_reference_forms(reference):
    profile = cp.find_profile(reference)
    assert profile["id"] == "martin-self-development"


def test_placeholder_description_is_explicit_and_override_wins():
    brief = cp.build_post_brief(
        "@sleepyrobot0",
        requested_format="long",
        description_override="Confirmed by the owner for this request.",
    )
    assert brief["description_status"] == "placeholder"
    assert brief["description"] == {
        "text": "Confirmed by the owner for this request.",
        "source": "request_override",
    }
    assert brief["format"]["selected_guidance"]["target_chars"] == 2800


def test_disabled_channel_is_explicit_in_its_brief():
    brief = cp.build_post_brief("@slivmogwarts")

    assert brief["publishing_enabled"] is False
    assert "blocked" in brief["operational_note"].lower()


def test_auto_format_does_not_force_a_single_length():
    brief = cp.build_post_brief("@r7training")
    assert brief["format"]["requested"] == "auto"
    assert brief["format"]["selected_guidance"] is None
    assert "long" in brief["format"]["preferred"]


def test_registry_rejects_duplicate_channel_reference(tmp_path):
    registry = cp.load_profiles()
    registry["channels"][1]["references"].append(
        registry["channels"][0]["references"][0]
    )
    path = tmp_path / "profiles.json"
    path.write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(cp.ChannelProfileError, match="belongs to both"):
        cp.load_profiles(path)


def test_quality_review_accepts_channel_specific_post():
    text = (
        "Программа тренировок должна связывать упражнения, технику и прогрессию. "
        "Записывайте рабочие подходы и повторы, повышайте нагрузку только после "
        "стабильного выполнения.\n\n"
        "Так отслеживание превращает набор упражнений в измеримый тренировочный план."
    )

    review = cp.review_post("@r7training", text)

    assert review["passed"] is True
    assert review["score"] >= 70
    assert len(review["topic_matches"]) >= 3
    assert review["format"]["utf16_units"] <= 4096


def test_quality_review_blocks_wrong_topic_and_mojibake():
    wrong_topic = (
        "Бизнес-модель начинается с цены, маркетинга и воронки продаж. "
        "Сначала посчитайте маржу, затем рекламный бюджет и окупаемость. "
        "После этого оптимизируйте продажи и повторные покупки клиента."
    )
    corrupted = (
        "РџСЂРѕРіСЂР°РјРјР° тренировок должна включать технику и прогрессию. "
        "Текст намеренно содержит поврежденную кодировку для проверки блокировки. "
        "Повторы и подходы здесь указаны только как тестовые маркеры качества."
    )

    wrong_review = cp.review_post("@r7training", wrong_topic)
    corrupted_review = cp.review_post("@r7training", corrupted)

    assert wrong_review["passed"] is False
    assert wrong_review["score"] < 70
    assert any("channel profile" in item for item in wrong_review["blockers"])
    assert corrupted_review["passed"] is False
    assert corrupted_review["mojibake_markers"]


def test_low_confidence_profile_warns_without_impossible_score_ceiling():
    text = (
        "Иногда память сохраняет не сам фильм, а человека рядом, свет в зале и "
        "ощущение того периода. Спустя годы мы возвращаемся к старой истории и "
        "не понимаем, понравился ли нам сюжет или собственная жизнь вокруг него.\n\n"
        "Поэтому ностальгию полезно разбирать на части: что было в самой вещи, "
        "а что мы принесли из прошлого. Такой разбор не обесценивает воспоминание, "
        "но помогает увидеть, по чему именно мы скучаем и что можем вернуть сейчас. "
        "Не обязательно повторять прошлое целиком. Иногда достаточно восстановить "
        "одно состояние: внимание, спокойствие или близость с людьми."
    )

    review = cp.review_post("@sleepyrobot0", text)

    assert review["passed"] is True
    assert review["score"] >= 70
    assert review["profile_confidence"] == "low"
    assert any("fit is unproven" in item for item in review["warnings"])


def test_registry_requires_topic_keywords(tmp_path):
    registry = cp.load_profiles()
    registry["channels"][0].pop("topic_keywords")
    path = tmp_path / "profiles.json"
    path.write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(cp.ChannelProfileError, match="requires topic_keywords"):
        cp.load_profiles(path)
