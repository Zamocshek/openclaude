"""Telegram post parsing, preview data, and custom emoji validation."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping

from telethon import helpers, types
from telethon.extensions import html, markdown

MAX_MESSAGE_UTF16_LENGTH = 4096
MAX_CAPTION_UTF16_LENGTH = 1024
FORMAT_MODES = {"plain", "html", "markdown"}
CUSTOM_EMOJI_TAG_RE = re.compile(
    r"<tg-emoji\s+emoji-id=(?P<quote>['\"])(?P<id>\d+)(?P=quote)\s*>"
    r"(?P<fallback>.*?)</tg-emoji\s*>",
    re.IGNORECASE | re.DOTALL,
)
CUSTOM_EMOJI_LINK_RE = re.compile(
    r'<a href="tg://emoji\?id=(?P<id>\d+)">(?P<fallback>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)


@dataclass(frozen=True)
class FormattedPost:
    source: str
    mode: str
    text: str
    entities: List[Any]
    custom_emojis: List[Dict[str, Any]]


def _normalize_mode(mode: str) -> str:
    normalized = str(mode or "plain").strip().lower()
    if normalized not in FORMAT_MODES:
        raise ValueError("format_mode must be plain, html, or markdown")
    return normalized


def _entity_text(text: str, entity: Any) -> str:
    surrogate_text = helpers.add_surrogate(text)
    start = int(entity.offset)
    end = start + int(entity.length)
    return helpers.del_surrogate(surrogate_text[start:end])


def _looks_like_emoji(text: str) -> bool:
    if not text or text != text.strip() or any(char.isspace() for char in text):
        return False
    return any(
        0x1F000 <= ord(char) <= 0x1FAFF
        or 0x2600 <= ord(char) <= 0x27BF
        or ord(char)
        in {0x00A9, 0x00AE, 0x203C, 0x2049, 0x2122, 0x2139, 0x3030, 0x303D, 0x3297, 0x3299}
        for char in text
    )


def _custom_emoji_details(text: str, entities: List[Any]) -> List[Dict[str, Any]]:
    details: List[Dict[str, Any]] = []
    for entity in entities:
        if not isinstance(entity, types.MessageEntityCustomEmoji):
            continue
        fallback = _entity_text(text, entity)
        if not _looks_like_emoji(fallback):
            raise ValueError(
                "each <tg-emoji> must wrap its fallback emoji only, for example "
                '<tg-emoji emoji-id="123">🔥</tg-emoji>'
            )
        details.append(
            {
                "document_id": int(entity.document_id),
                "fallback": fallback,
                "offset": int(entity.offset),
                "length": int(entity.length),
            }
        )
    return details


def _parse_html(source: str) -> tuple[str, List[Any]]:
    """Parse Telegram custom emoji on Telethon versions that omit tg-emoji."""

    converted = CUSTOM_EMOJI_TAG_RE.sub(
        lambda match: (
            f'<a href="tg://emoji?id={match.group("id")}">'
            f'{match.group("fallback")}</a>'
        ),
        source,
    )
    if re.search(r"<\s*/?\s*tg-emoji\b", converted, re.IGNORECASE):
        raise ValueError(
            'invalid <tg-emoji>; expected <tg-emoji emoji-id="123">🔥</tg-emoji>'
        )

    text, parsed_entities = html.parse(converted)
    entities: List[Any] = []
    for entity in parsed_entities:
        if (
            isinstance(entity, types.MessageEntityTextUrl)
            and str(entity.url).startswith("tg://emoji?id=")
        ):
            document_id = str(entity.url).removeprefix("tg://emoji?id=")
            if not document_id.isdigit():
                raise ValueError("tg-emoji emoji-id must be a positive integer")
            entities.append(
                types.MessageEntityCustomEmoji(
                    offset=entity.offset,
                    length=entity.length,
                    document_id=int(document_id),
                )
            )
        else:
            entities.append(entity)
    return text, entities


def _unparse_html(text: str, entities: List[Any]) -> str:
    compatible_entities: List[Any] = []
    for entity in entities:
        if isinstance(entity, types.MessageEntityCustomEmoji):
            compatible_entities.append(
                types.MessageEntityTextUrl(
                    offset=entity.offset,
                    length=entity.length,
                    url=f"tg://emoji?id={int(entity.document_id)}",
                )
            )
        else:
            compatible_entities.append(entity)
    rendered = html.unparse(text, compatible_entities)
    return CUSTOM_EMOJI_LINK_RE.sub(
        lambda match: (
            f'<tg-emoji emoji-id="{match.group("id")}">'
            f'{match.group("fallback")}</tg-emoji>'
        ),
        rendered,
    )


def _entity_kind(entity: Any) -> str:
    name = type(entity).__name__.removeprefix("MessageEntity")
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def entity_details(text: str, entities: List[Any]) -> List[Dict[str, Any]]:
    """Return a JSON-safe description of Telegram's UTF-16 entities."""

    details: List[Dict[str, Any]] = []
    for entity in entities:
        item: Dict[str, Any] = {
            "kind": _entity_kind(entity),
            "offset": int(entity.offset),
            "length": int(entity.length),
            "text": _entity_text(text, entity),
        }
        if isinstance(entity, types.MessageEntityTextUrl):
            item["target"] = str(entity.url)
        elif isinstance(entity, types.MessageEntityMentionName):
            item["target"] = f"tg://user?id={int(entity.user_id)}"
        elif isinstance(entity, types.MessageEntityCustomEmoji):
            item["target"] = f"tg://emoji?id={int(entity.document_id)}"
        elif isinstance(entity, types.MessageEntityUrl):
            item["target"] = item["text"]
        elif isinstance(entity, types.MessageEntityEmail):
            item["target"] = f"mailto:{item['text']}"
        elif isinstance(entity, types.MessageEntityPhone):
            item["target"] = f"tel:{item['text']}"
        item["semantic"] = bool(item.get("target"))
        item["hidden_target"] = isinstance(
            entity,
            (
                types.MessageEntityTextUrl,
                types.MessageEntityMentionName,
                types.MessageEntityCustomEmoji,
            ),
        )
        details.append(item)
    return details


def formatting_snapshot(text: str, entities: List[Any]) -> Dict[str, Any]:
    """Create a portable representation that can recreate a Telegram message."""

    entity_list = list(entities or [])
    details = entity_details(text, entity_list)
    return {
        "format_mode": "html" if entity_list else "plain",
        "formatted_text": _unparse_html(text, entity_list) if entity_list else text,
        "entity_count": len(entity_list),
        "entities": details,
        "has_hidden_targets": any(item["hidden_target"] for item in details),
        "custom_emojis": _custom_emoji_details(text, entity_list),
    }


def formatting_from_message(message: Any) -> Dict[str, Any]:
    """Capture text plus every formatting entity from a Telethon message."""

    text = getattr(message, "message", None) or getattr(message, "text", None) or ""
    return formatting_snapshot(text, list(getattr(message, "entities", None) or []))


def missing_source_formatting(
    source_text: str,
    source_formatting: Mapping[str, Any],
    candidate: FormattedPost,
) -> List[Dict[str, Any]]:
    """Find source entities that a derived post silently converted to plain text.

    For an exact copy every entity is part of the document contract. For edited
    text only semantic hidden targets (text links, user links, custom emoji) are
    required when their visible label remains in the candidate.
    """

    source_entities = source_formatting.get("entities")
    if not isinstance(source_entities, list) or not source_entities:
        return []
    candidate_entities = entity_details(candidate.text, candidate.entities)
    exact_text = str(source_text or "").strip() == candidate.text.strip()
    missing: List[Dict[str, Any]] = []

    for raw in source_entities:
        if not isinstance(raw, dict):
            continue
        label = str(raw.get("text") or "")
        target = str(raw.get("target") or "")
        if not exact_text:
            if not raw.get("hidden_target") or not label or label not in candidate.text:
                continue

        def matches(item: Dict[str, Any]) -> bool:
            if target:
                return item.get("target") == target and item.get("text") == label
            return item.get("kind") == raw.get("kind") and item.get("text") == label

        if not any(matches(item) for item in candidate_entities):
            missing.append(
                {
                    "kind": raw.get("kind"),
                    "text": label,
                    "target": target or None,
                    "reason": "telegram_entity_was_lost",
                }
            )
    return missing


def parse_post(
    source: str,
    format_mode: str = "plain",
    max_utf16_length: int = MAX_MESSAGE_UTF16_LENGTH,
) -> FormattedPost:
    if max_utf16_length < 1:
        raise ValueError("max_utf16_length must be positive")
    mode = _normalize_mode(format_mode)
    source = str(source or "")
    if not source.strip():
        raise ValueError("post text is required")
    if mode == "html":
        text, entities = _parse_html(source)
    elif mode == "markdown":
        text, entities = markdown.parse(source)
    else:
        text, entities = source, []
    if not text or not text.strip():
        raise ValueError("post text is empty after formatting")
    if len(helpers.add_surrogate(text)) > max_utf16_length:
        raise ValueError(f"post exceeds Telegram's {max_utf16_length}-character limit")
    return FormattedPost(
        source=source,
        mode=mode,
        text=text,
        entities=list(entities),
        custom_emojis=_custom_emoji_details(text, list(entities)),
    )


def preview(post: FormattedPost) -> Dict[str, Any]:
    return {
        "format_mode": post.mode,
        "text": post.text,
        "utf16_length": len(helpers.add_surrogate(post.text)),
        "entities": len(post.entities),
        "custom_emojis": post.custom_emojis,
        "html_preview": _unparse_html(post.text, post.entities),
    }


def custom_emojis_from_message(message: Any) -> List[Dict[str, Any]]:
    text = getattr(message, "message", None) or ""
    entities = list(getattr(message, "entities", None) or [])
    return _custom_emoji_details(text, entities)
