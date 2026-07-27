import asyncio

import httpx
import pytest

import vpromotions_client as vp


def _client(handler):
    transport = httpx.MockTransport(handler)
    config = vp.VPromotionsConfig(api_url="https://example.test/api", api_key="secret")
    return vp.VPromotionsClient(config, transport=transport)


def test_add_order_payload_supports_screenshot_order_types():
    payload = vp.build_add_order_payload(
        service=123,
        link="https://t.me/example/1",
        quantity=10,
        comments="one\ntwo",
        answer_number=2,
        username="channel_name",
        min_quantity=10,
        max_quantity=50,
        posts=3,
        delay=15,
        expiry="31/12/2026",
        extra_json='{"custom_field": "x"}',
    )

    assert payload["service"] == "123"
    assert payload["quantity"] == "10"
    assert payload["comments"] == "one\ntwo"
    assert payload["answer_number"] == "2"
    assert payload["username"] == "channel_name"
    assert payload["min"] == "10"
    assert payload["max"] == "50"
    assert payload["posts"] == "3"
    assert payload["delay"] == "15"
    assert payload["expiry"] == "31/12/2026"
    assert payload["custom_field"] == "x"


def test_add_order_payload_requires_target():
    with pytest.raises(ValueError, match="link or username"):
        vp.build_add_order_payload(service=1, quantity=10)


def test_filter_services_by_text_and_limit():
    services = [
        {"service": 1, "name": "Telegram Views", "type": "Default", "category": "TG"},
        {"service": 2, "name": "Instagram Likes", "type": "Default", "category": "IG"},
        {"service": 3, "name": "Telegram Poll", "type": "Poll", "category": "TG"},
    ]

    result = vp.filter_services(services, search="telegram", limit=1)

    assert len(result) == 1
    assert result[0]["service"] == 1


def test_services_request_posts_form_data():
    async def run():
        def handler(request: httpx.Request) -> httpx.Response:
            body = request.content.decode()
            assert request.method == "POST"
            assert "key=secret" in body
            assert "action=services" in body
            return httpx.Response(200, json=[{"service": 1, "name": "Views"}])

        return await _client(handler).services()

    assert asyncio.run(run())[0]["service"] == 1


def test_api_error_is_raised():
    async def run():
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"error": "Invalid API key"})

        await _client(handler).balance()

    with pytest.raises(vp.VPromotionsAPIError, match="Invalid API key"):
        asyncio.run(run())
