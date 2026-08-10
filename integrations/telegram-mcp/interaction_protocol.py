import json
import re
from typing import Any, Dict, Iterable, Optional


AGENT_INTERACTION_PROTOCOL = "openclaude.interaction/v1"
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_SENSITIVE_STATE_KEY_RE = re.compile(
    r"(?:code|credential|key|pass|phone|secret|token)",
    re.IGNORECASE,
)


def format_agent_interaction_envelope(
    *,
    interaction_id: str,
    handler: str,
    stage: str,
    prompt: str,
    input_name: str,
    input_kind: str,
    input_prompt: str,
    state: Optional[Dict[str, Any]] = None,
    expires_in_ms: int = 600_000,
    min_length: Optional[int] = None,
    max_length: Optional[int] = None,
    choices: Optional[Iterable[str]] = None,
) -> str:
    """Build safe continuation metadata shared by multi-step MCP tools."""
    for name, value in (
        ("interaction_id", interaction_id),
        ("handler", handler),
        ("stage", stage),
        ("input_name", input_name),
    ):
        if not value or not _IDENTIFIER_RE.fullmatch(value):
            raise ValueError(f"Invalid {name}")
    if input_kind not in {"text", "secret", "otp", "confirmation", "choice"}:
        raise ValueError("Invalid interaction input kind")
    safe_state = _validate_safe_state(state or {})
    input_spec: Dict[str, Any] = {
        "name": input_name,
        "kind": input_kind,
        "prompt": str(input_prompt)[:500],
    }
    if min_length is not None:
        input_spec["minLength"] = max(0, min(10_000, int(min_length)))
    if max_length is not None:
        input_spec["maxLength"] = max(0, min(10_000, int(max_length)))
    normalized_choices = [str(value)[:120] for value in (choices or [])][:32]
    if normalized_choices:
        input_spec["choices"] = normalized_choices
    payload = {
        "protocol": AGENT_INTERACTION_PROTOCOL,
        "id": interaction_id[:160],
        "handler": handler[:128],
        "stage": stage[:64],
        "prompt": str(prompt)[:500],
        "input": input_spec,
        "state": safe_state,
        "expiresInMs": max(60_000, min(30 * 60_000, int(expires_in_ms))),
    }
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    return f"<openclaude_interaction>{encoded}</openclaude_interaction>"


def _validate_safe_state(state: Dict[str, Any]) -> Dict[str, Any]:
    if len(state) > 32:
        raise ValueError("Interaction state has too many fields")
    result: Dict[str, Any] = {}
    for key, value in state.items():
        if not _IDENTIFIER_RE.fullmatch(str(key)) or _SENSITIVE_STATE_KEY_RE.search(str(key)):
            raise ValueError("Interaction state contains a sensitive or invalid key")
        if isinstance(value, bool):
            result[str(key)] = value
        elif isinstance(value, (int, float)) and not isinstance(value, complex):
            result[str(key)] = value
        elif isinstance(value, str):
            result[str(key)] = value[:500]
        else:
            raise ValueError("Interaction state values must be scalar")
    return result
