import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional


DEFAULT_PATH = Path(__file__).with_name("channel_profiles.json")
PUBLIC_LINK_RE = re.compile(r"^(?:https?://)?(?:www\.)?t\.me/([A-Za-z0-9_]+)", re.I)
INVITE_LINK_RE = re.compile(
    r"^(?:https?://)?(?:www\.)?t\.me/(?:joinchat/|\+)([A-Za-z0-9_-]+)", re.I
)
TAG_RE = re.compile(r"<[^>]+>")
WHITESPACE_RE = re.compile(r"\s+")
MOJIBAKE_MARKERS = ("\ufffd", "Рџ", "Рњ", "РЎ", "Рё", "СЃ", "С‚", "вЂ", "Гњ")
GENERIC_PHRASES = (
    "в современном мире",
    "важно понимать",
    "давайте разберемся",
    "это не просто",
    "в заключение",
    "путь к успеху",
    "секрет прост",
)


class ChannelProfileError(Exception):
    pass


def _path() -> Path:
    configured = os.getenv("TELEGRAM_MCP_CHANNEL_PROFILES", "").strip()
    return Path(configured).expanduser() if configured else DEFAULT_PATH


def _reference_keys(value: Any) -> List[str]:
    text = str(value or "").strip()
    if not text:
        return []
    keys = {text.casefold()}
    if text.startswith("@"):
        keys.add(text[1:].casefold())
    invite = INVITE_LINK_RE.match(text)
    if invite:
        keys.add(f"invite:{invite.group(1).casefold()}")
    public = PUBLIC_LINK_RE.match(text)
    if public and not invite:
        keys.add(public.group(1).casefold())
        keys.add(f"@{public.group(1).casefold()}")
    try:
        numeric = int(text)
    except ValueError:
        numeric = None
    if numeric is not None:
        keys.add(str(numeric))
        if numeric > 0:
            keys.add(str(-1000000000000 - numeric))
        elif numeric <= -1000000000000:
            keys.add(str(abs(numeric + 1000000000000)))
    return sorted(keys)


def validate_profiles(data: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ChannelProfileError("channel profile registry must use version 1")
    policy = data.get("format_policy")
    channels = data.get("channels")
    if not isinstance(policy, dict) or not isinstance(channels, list):
        raise ChannelProfileError("format_policy and channels are required")
    modes = policy.get("modes")
    if not isinstance(modes, dict) or set(modes) != {"short", "standard", "long"}:
        raise ChannelProfileError("format modes must be short, standard, and long")
    hard_limit = int(policy.get("telegram_utf16_limit", 0))
    if hard_limit != 4096:
        raise ChannelProfileError("Telegram text limit must be 4096 UTF-16 units")
    for name, mode in modes.items():
        if not isinstance(mode, dict):
            raise ChannelProfileError(f"format mode {name} must be an object")
        minimum = int(mode.get("min_chars", -1))
        target = int(mode.get("target_chars", -1))
        maximum = int(mode.get("max_chars", -1))
        if not (0 <= minimum <= target <= maximum <= hard_limit):
            raise ChannelProfileError(f"invalid length range for {name}")
    seen_ids = set()
    seen_refs: Dict[str, str] = {}
    for profile in channels:
        if not isinstance(profile, dict):
            raise ChannelProfileError("each channel profile must be an object")
        profile_id = str(profile.get("id", "")).strip()
        if not profile_id or profile_id in seen_ids:
            raise ChannelProfileError(f"invalid or duplicate channel id: {profile_id}")
        seen_ids.add(profile_id)
        references = profile.get("references")
        if not isinstance(references, list) or not references:
            raise ChannelProfileError(f"channel {profile_id} requires references")
        for reference in references:
            for key in _reference_keys(reference):
                owner = seen_refs.get(key)
                if owner and owner != profile_id:
                    raise ChannelProfileError(
                        f"reference {reference} belongs to both {owner} and {profile_id}"
                    )
                seen_refs[key] = profile_id
        preferred = profile.get("preferred_formats", [])
        if not preferred or any(item not in modes for item in preferred):
            raise ChannelProfileError(f"channel {profile_id} has invalid preferred_formats")
        status = profile.get("description_status")
        if status not in {"placeholder", "confirmed"}:
            raise ChannelProfileError(f"channel {profile_id} has invalid description_status")
        if not isinstance(profile.get("publishing_enabled", True), bool):
            raise ChannelProfileError(f"channel {profile_id} has invalid publishing_enabled")
        if status == "confirmed" and not str(profile.get("description") or "").strip():
            raise ChannelProfileError(f"channel {profile_id} requires a description")
        topic_keywords = profile.get("topic_keywords")
        if not isinstance(topic_keywords, list) or not any(
            str(item).strip() for item in topic_keywords
        ):
            raise ChannelProfileError(f"channel {profile_id} requires topic_keywords")
    return data


def load_profiles(path: Optional[Path] = None) -> Dict[str, Any]:
    source = path or _path()
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ChannelProfileError(f"channel profile registry not found: {source}") from exc
    except json.JSONDecodeError as exc:
        raise ChannelProfileError(f"invalid channel profile JSON: {exc}") from exc
    return validate_profiles(data)


def find_profile(reference: Any, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    registry = data or load_profiles()
    requested = set(_reference_keys(reference))
    for profile in registry["channels"]:
        available = {
            key
            for item in profile["references"]
            for key in _reference_keys(item)
        }
        if requested & available:
            return profile
    raise ChannelProfileError(f"no channel profile matches {reference}")


def effective_description(
    profile: Dict[str, Any], request_override: Optional[str] = None
) -> Dict[str, str]:
    override = str(request_override or "").strip()
    confirmed = str(profile.get("description") or "").strip()
    inferred = str(profile.get("inferred_description") or "").strip()
    if override:
        return {"text": override, "source": "request_override"}
    if profile.get("description_status") == "confirmed" and confirmed:
        return {"text": confirmed, "source": "confirmed_description"}
    if inferred:
        return {"text": inferred, "source": "inferred_description"}
    return {"text": str(profile.get("name", "")), "source": "channel_name"}


def build_post_brief(
    reference: Any,
    requested_format: str = "auto",
    objective: Optional[str] = None,
    description_override: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    registry = data or load_profiles()
    profile = find_profile(reference, registry)
    mode = str(requested_format or "auto").strip().lower()
    modes = registry["format_policy"]["modes"]
    if mode not in {"auto", *modes.keys()}:
        raise ChannelProfileError("requested_format must be auto, short, standard, or long")
    description = effective_description(profile, description_override)
    selected = None if mode == "auto" else modes[mode]
    return {
        "channel": {
            "id": profile["id"],
            "name": profile["name"],
            "group": profile["group"],
            "matched_reference": str(reference),
        },
        "description": description,
        "description_status": profile["description_status"],
        "publishing_enabled": profile.get("publishing_enabled", True),
        "inference_confidence": profile.get("inference_confidence"),
        "content_pillars": profile.get("content_pillars", []),
        "tone": profile.get("tone"),
        "objective": str(objective or "").strip() or None,
        "format": {
            "requested": mode,
            "selected_guidance": selected,
            "preferred": profile["preferred_formats"],
            "available": modes,
            "auto_rules": registry["format_policy"]["auto_rules"],
            "hard_limit_utf16": registry["format_policy"]["telegram_utf16_limit"],
        },
        "quality_rules": registry["quality_rules"],
        "operational_note": profile.get("operational_note"),
    }


def _plain_text(value: Any) -> str:
    return WHITESPACE_RE.sub(" ", TAG_RE.sub(" ", str(value or ""))).strip()


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _select_format(profile: Dict[str, Any], modes: Dict[str, Any], length: int) -> str:
    preferred = list(profile.get("preferred_formats") or modes.keys())
    for mode in preferred:
        if length <= int(modes[mode]["max_chars"]):
            return mode
    return "long"


def review_post(
    reference: Any,
    text: str,
    requested_format: str = "auto",
    description_override: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Return a deterministic preflight report for a channel-specific post."""
    registry = data or load_profiles()
    profile = find_profile(reference, registry)
    body = _plain_text(text)
    normalized = body.casefold().replace("ё", "е")
    utf16_length = _utf16_length(body)
    hard_limit = int(registry["format_policy"]["telegram_utf16_limit"])
    modes = registry["format_policy"]["modes"]
    requested = str(requested_format or "auto").strip().lower()
    if requested not in {"auto", *modes.keys()}:
        raise ChannelProfileError(
            "requested_format must be auto, short, standard, or long"
        )
    selected = _select_format(profile, modes, len(body)) if requested == "auto" else requested
    guidance = modes[selected]
    topic_matches = sorted(
        {
            str(marker)
            for marker in profile.get("topic_keywords", [])
            if str(marker).casefold().replace("ё", "е") in normalized
        },
        key=str.casefold,
    )
    mojibake = sorted({marker for marker in MOJIBAKE_MARKERS if marker in body})
    generic_phrases = sorted({phrase for phrase in GENERIC_PHRASES if phrase in normalized})
    paragraphs = [item.strip() for item in re.split(r"\n\s*\n", str(text)) if item.strip()]

    blockers: List[str] = []
    warnings: List[str] = []
    if not body:
        blockers.append("post is empty")
    if mojibake:
        blockers.append("text contains probable mojibake or replacement characters")
    if utf16_length > hard_limit:
        blockers.append(f"text exceeds Telegram UTF-16 limit ({utf16_length}/{hard_limit})")
    if len(body) < 180:
        blockers.append("post is too thin for a reviewed network publication")
    if len(topic_matches) < 2:
        if profile.get("inference_confidence") in {"high", "medium"}:
            blockers.append(
                "post has fewer than two independent connections to the channel profile"
            )
        else:
            warnings.append("channel profile is low-confidence and thematic fit is unproven")
    if len(body) < int(guidance["min_chars"]):
        warnings.append(f"text is shorter than {selected} format guidance")
    if len(body) > int(guidance["max_chars"]):
        warnings.append(f"text is longer than {selected} format guidance")
    if len(body) >= 700 and len(paragraphs) < 2:
        warnings.append("long text needs paragraph structure for Telegram readability")
    if generic_phrases:
        warnings.append("generic AI-style phrases weaken originality")

    profile_confidence = str(profile.get("inference_confidence") or "").strip().lower()
    topic_score = 35 if len(topic_matches) >= 2 else 25 if topic_matches else 0
    # Low-confidence profiles cannot prove a mismatch. Preserve the warning,
    # but do not make an otherwise valid post mathematically unable to pass.
    if not topic_matches and profile_confidence == "low":
        topic_score = 12

    score = 20
    score += 15 if utf16_length <= hard_limit else 0
    score += 15 if int(guidance["min_chars"]) <= len(body) <= int(guidance["max_chars"]) else 8
    score += topic_score
    score += 10 if len(body) < 700 or len(paragraphs) >= 2 else 4
    score += 5 if not generic_phrases else 1
    if mojibake:
        score = min(score, 20)
    elif blockers:
        score = min(score, 65)
    score = max(0, min(100, score))
    return {
        "passed": not blockers and score >= 70,
        "score": score,
        "channel": {"id": profile["id"], "name": profile["name"]},
        "profile_confidence": profile_confidence or None,
        "description": effective_description(profile, description_override),
        "format": {
            "requested": requested,
            "selected": selected,
            "chars": len(body),
            "utf16_units": utf16_length,
            "guidance": guidance,
            "hard_limit_utf16": hard_limit,
        },
        "topic_matches": topic_matches,
        "blockers": blockers,
        "warnings": warnings,
        "generic_phrases": generic_phrases,
        "mojibake_markers": mojibake,
    }
