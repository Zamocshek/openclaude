import pytest
import os

os.environ["TELEGRAM_API_ID"] = "12345"
os.environ["TELEGRAM_API_HASH"] = "dummy_hash"
from main import (
    ValidationError,
    _channel_posting_access,
    _normalize_chat_reference,
    log_and_format_error,
    validate_id,
)
from functools import wraps
import asyncio
from typing import Union, List, Optional


# A simple async function to be decorated for testing
@validate_id("user_id", "chat_id", "user_ids")
async def dummy_function(**kwargs):
    return "success", kwargs


@pytest.mark.asyncio
async def test_valid_integer_id():
    result, kwargs = await dummy_function(user_id=12345)
    assert result == "success"
    assert kwargs["user_id"] == 12345


@pytest.mark.asyncio
async def test_valid_negative_integer_id():
    result, kwargs = await dummy_function(chat_id=-100123456)
    assert result == "success"
    assert kwargs["chat_id"] == -100123456


@pytest.mark.asyncio
async def test_valid_string_integer_id():
    result, kwargs = await dummy_function(user_id="12345")
    assert result == "success"
    assert kwargs["user_id"] == 12345


@pytest.mark.asyncio
async def test_valid_username():
    result, kwargs = await dummy_function(user_id="@test_user")
    assert result == "success"
    assert kwargs["user_id"] == "@test_user"


@pytest.mark.asyncio
async def test_valid_username_without_at():
    result, kwargs = await dummy_function(user_id="test_user_long_enough")
    assert result == "success"
    assert kwargs["user_id"] == "test_user_long_enough"


@pytest.mark.asyncio
async def test_valid_list_of_ids():
    result, kwargs = await dummy_function(user_ids=[123, "456", "@test_user"])
    assert result == "success"
    assert kwargs["user_ids"] == [123, 456, "@test_user"]


@pytest.mark.asyncio
async def test_invalid_float_id():
    result = await dummy_function(user_id=123.45)
    assert "Invalid user_id" in result
    assert "Type must be an integer or a string" in result


@pytest.mark.asyncio
async def test_invalid_string_id():
    result = await dummy_function(user_id="inv")  # too short
    assert "Invalid user_id" in result
    assert "Must be a valid integer ID, or a username string" in result


@pytest.mark.asyncio
async def test_integer_out_of_range():
    result = await dummy_function(user_id=2**64)
    assert "Invalid user_id" in result
    assert "out of the valid integer range" in result


@pytest.mark.asyncio
async def test_invalid_item_in_list():
    result = await dummy_function(user_ids=[123, "456", 123.45])
    assert "Invalid user_ids" in result
    assert "Type must be an integer or a string" in result


@pytest.mark.asyncio
async def test_no_id_provided():
    result, kwargs = await dummy_function()
    assert result == "success"


@pytest.mark.asyncio
async def test_none_id_provided():
    result, kwargs = await dummy_function(user_id=None)
    assert result == "success"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://t.me/slivmartin", ("entity", "slivmartin")),
        ("t.me/+nS0h5CVn-_Q1OTAy", ("invite", "nS0h5CVn-_Q1OTAy")),
        ("https://t.me/joinchat/AbCd_123", ("invite", "AbCd_123")),
        ("-1001776823101", ("entity", -1001776823101)),
        ("@endryteytfull", ("entity", "@endryteytfull")),
    ],
)
def test_normalize_chat_reference(value, expected):
    assert _normalize_chat_reference(value) == expected


def test_broadcast_posting_access_requires_explicit_post_messages_right():
    entity = type(
        "FakeChannel",
        (),
        {
            "creator": False,
            "broadcast": True,
            "megagroup": False,
            "admin_rights": type("Rights", (), {"post_messages": True})(),
        },
    )()

    access = _channel_posting_access(entity)

    assert access["can_post"] is True
    assert access["basis"] == "admin_rights.post_messages"


def test_platform_restriction_overrides_creator_or_admin_rights():
    reason = type(
        "Reason",
        (),
        {"platform": "all", "reason": "terms", "text": "channel restricted"},
    )()
    entity = type(
        "FakeRestrictedChannel",
        (),
        {
            "creator": True,
            "broadcast": True,
            "megagroup": False,
            "restricted": True,
            "restriction_reason": [reason],
            "admin_rights": type("Rights", (), {"post_messages": True})(),
        },
    )()

    access = _channel_posting_access(entity)

    assert access["can_post"] is False
    assert access["basis"] == "channel is restricted by Telegram"
    assert access["restriction_reasons"][0]["reason"] == "terms"


def test_batch_timeout_is_longer_than_single_operation_timeout():
    from main import BATCH_TOOL_OPERATION_TIMEOUT, TOOL_OPERATION_TIMEOUT

    assert BATCH_TOOL_OPERATION_TIMEOUT > TOOL_OPERATION_TIMEOUT
