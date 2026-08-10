import asyncio

import httpx
import pytest

import twiboost_client as tb


def _client(handler):
    transport = httpx.MockTransport(handler)
    config = tb.TwiBoostConfig(api_url="https://example.test/api", api_key="secret")
    return tb.TwiBoostClient(config, transport=transport)


def test_add_order_payload_supports_provider_specific_fields():
    payload = tb.build_add_order_payload(
        service=123,
        link="https://instagram.com/example",
        quantity=100,
        extra_json='{"comments": "hello", "username": "example"}',
    )

    assert payload == {
        "service": "123",
        "link": "https://instagram.com/example",
        "quantity": "100",
        "comments": "hello",
        "username": "example",
    }


def test_add_order_payload_rejects_core_field_override():
    with pytest.raises(ValueError, match="cannot override"):
        tb.build_add_order_payload(
            service=1,
            link="https://example.test",
            extra_json='{"quantity": 999}',
        )


def test_filter_services_by_type_and_limit():
    services = [
        {"service": 1, "name": "Live RU", "type": "subscribe", "category": "Instagram"},
        {"service": 2, "name": "Likes", "type": "like", "category": "Instagram"},
        {"service": 3, "name": "Followers", "type": "follow", "category": "TikTok"},
    ]

    result = tb.filter_services(services, search="instagram", service_type="subscribe", limit=1)

    assert [item["service"] for item in result] == [1]


def test_services_request_posts_form_data_without_key_in_url():
    async def run():
        def handler(request: httpx.Request) -> httpx.Response:
            body = request.content.decode()
            assert request.method == "POST"
            assert request.url.query == b""
            assert "key=secret" in body
            assert "action=services" in body
            return httpx.Response(200, json=[{"service": 1, "name": "Followers"}])

        return await _client(handler).services()

    assert asyncio.run(run())[0]["service"] == 1


def test_batch_status_and_cancel_use_expected_actions():
    actions = []

    async def run():
        def handler(request: httpx.Request) -> httpx.Response:
            body = request.content.decode()
            actions.append(body)
            if "action=status" in body:
                return httpx.Response(200, json={"1": {"status": "Completed"}, "2": "Incorrect order ID"})
            return httpx.Response(200, json={"ok": "true"})

        client = _client(handler)
        statuses = await client.orders_status("1,2")
        canceled = await client.cancel(2)
        return statuses, canceled

    statuses, canceled = asyncio.run(run())
    assert statuses["1"]["status"] == "Completed"
    assert canceled["ok"] == "true"
    assert "action=status" in actions[0] and "orders=1%2C2" in actions[0]
    assert "action=cancel" in actions[1] and "order=2" in actions[1]


def test_api_error_is_raised_without_exposing_key():
    async def run():
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"error": "Invalid API key: secret"})

        await _client(handler).balance()

    with pytest.raises(tb.TwiBoostAPIError, match=r"\[REDACTED\]"):
        asyncio.run(run())
