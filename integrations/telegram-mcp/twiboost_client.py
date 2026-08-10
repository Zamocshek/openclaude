"""TwiBoost API client for Telegram MCP tools and CLI usage."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

import httpx

import runtime_config  # noqa: F401 - loads project .env as a side effect

DEFAULT_API_URL = "https://twiboost.com/api/v2"
DEFAULT_TIMEOUT = 30.0


class TwiBoostError(RuntimeError):
    """Base error for the TwiBoost integration."""


class TwiBoostAPIError(TwiBoostError):
    """The remote API returned an error payload or HTTP error."""


def _clean_payload(payload: Mapping[str, Any]) -> Dict[str, str]:
    clean: Dict[str, str] = {}
    for key, value in payload.items():
        if value is None:
            continue
        text = str(value).strip()
        if text:
            clean[key] = text
    return clean


def _parse_extra_json(extra_json: Optional[str]) -> Dict[str, Any]:
    if not extra_json:
        return {}
    try:
        parsed = json.loads(extra_json)
    except json.JSONDecodeError as exc:
        raise ValueError("extra_json must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("extra_json must be a JSON object")
    return parsed


def _parse_orders_csv(orders: str | Iterable[int]) -> List[int]:
    raw = orders.split(",") if isinstance(orders, str) else [str(item) for item in orders]
    try:
        parsed = [int(item.strip()) for item in raw if item.strip()]
    except ValueError as exc:
        raise ValueError("order ids must be positive integers") from exc
    if not parsed or any(order_id <= 0 for order_id in parsed):
        raise ValueError("at least one positive order id is required")
    return parsed


def build_add_order_payload(
    *,
    service: int,
    link: str,
    quantity: Optional[int] = None,
    extra_json: Optional[str] = None,
) -> Dict[str, str]:
    """Build a TwiBoost add payload without including the API key."""
    if int(service) <= 0:
        raise ValueError("service must be a positive integer")
    if not str(link).strip():
        raise ValueError("link is required")
    if quantity is not None and int(quantity) <= 0:
        raise ValueError("quantity must be a positive integer")

    extra = _parse_extra_json(extra_json)
    reserved = {"service", "link", "quantity"}
    collision = reserved.intersection(extra)
    if collision:
        raise ValueError(f"extra_json cannot override: {', '.join(sorted(collision))}")
    payload: Dict[str, Any] = {
        "service": int(service),
        "link": str(link).strip(),
        "quantity": quantity,
    }
    payload.update(extra)
    return _clean_payload(payload)


def filter_services(
    services: Sequence[Mapping[str, Any]],
    *,
    search: Optional[str] = None,
    category: Optional[str] = None,
    service_type: Optional[str] = None,
    limit: int = 50,
) -> List[Mapping[str, Any]]:
    """Filter the provider service catalog without changing provider data."""
    search_l = (search or "").strip().lower()
    category_l = (category or "").strip().lower()
    type_l = (service_type or "").strip().lower()
    result: List[Mapping[str, Any]] = []
    for service in services:
        name = str(service.get("name", "")).lower()
        category_text = str(service.get("category", "")).lower()
        type_text = str(service.get("type", "")).lower()
        if search_l and not any(search_l in value for value in (name, category_text, type_text)):
            continue
        if category_l and category_l not in category_text:
            continue
        if type_l and type_l not in type_text:
            continue
        result.append(service)
        if limit > 0 and len(result) >= limit:
            break
    return result


@dataclass(frozen=True)
class TwiBoostConfig:
    api_url: str = DEFAULT_API_URL
    api_key: str = ""
    timeout: float = DEFAULT_TIMEOUT

    @classmethod
    def from_env(cls) -> "TwiBoostConfig":
        raw_timeout = os.getenv("TWIBOOST_TIMEOUT", str(DEFAULT_TIMEOUT))
        try:
            timeout = float(raw_timeout)
        except ValueError as exc:
            raise TwiBoostError("TWIBOOST_TIMEOUT must be a number") from exc
        if timeout <= 0:
            raise TwiBoostError("TWIBOOST_TIMEOUT must be positive")
        return cls(
            api_url=(os.getenv("TWIBOOST_API_URL") or DEFAULT_API_URL).strip().rstrip("/"),
            api_key=(os.getenv("TWIBOOST_API_KEY") or "").strip(),
            timeout=timeout,
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    @property
    def masked_key(self) -> str:
        if not self.api_key:
            return ""
        if len(self.api_key) <= 8:
            return "*" * len(self.api_key)
        return f"{self.api_key[:4]}...{self.api_key[-4:]}"


class TwiBoostClient:
    def __init__(
        self,
        config: Optional[TwiBoostConfig] = None,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.config = config or TwiBoostConfig.from_env()
        self._transport = transport

    def _redact(self, value: str) -> str:
        if self.config.api_key:
            return value.replace(self.config.api_key, "[REDACTED]")
        return value

    async def _request(self, action: str, payload: Optional[Mapping[str, Any]] = None) -> Any:
        if not self.config.api_key:
            raise TwiBoostError("TWIBOOST_API_KEY is not configured")
        data = {"key": self.config.api_key, "action": action}
        data.update(_clean_payload(payload or {}))
        try:
            async with httpx.AsyncClient(
                timeout=self.config.timeout,
                transport=self._transport,
            ) as client:
                response = await client.post(self.config.api_url, data=data)
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise TwiBoostError("TwiBoost request timed out") from exc
        except httpx.HTTPStatusError as exc:
            raise TwiBoostAPIError(
                f"TwiBoost API returned HTTP {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise TwiBoostError(f"TwiBoost request failed: {self._redact(str(exc))}") from exc

        try:
            parsed = response.json()
        except ValueError as exc:
            raise TwiBoostError("TwiBoost returned a non-JSON response") from exc
        if isinstance(parsed, dict) and parsed.get("error"):
            raise TwiBoostAPIError(self._redact(str(parsed["error"])))
        if isinstance(parsed, str) and parsed:
            raise TwiBoostAPIError(self._redact(parsed))
        return parsed

    async def services(self) -> List[Mapping[str, Any]]:
        result = await self._request("services")
        if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
            raise TwiBoostError("services response must be a list of objects")
        return result

    async def balance(self) -> Mapping[str, Any]:
        result = await self._request("balance")
        if not isinstance(result, dict):
            raise TwiBoostError("balance response must be an object")
        return result

    async def add_order(self, **kwargs: Any) -> Mapping[str, Any]:
        result = await self._request("add", build_add_order_payload(**kwargs))
        if not isinstance(result, dict):
            raise TwiBoostError("add response must be an object")
        return result

    async def order_status(self, order: int) -> Mapping[str, Any]:
        order_id = int(order)
        if order_id <= 0:
            raise ValueError("order must be a positive integer")
        result = await self._request("status", {"order": order_id})
        if not isinstance(result, dict):
            raise TwiBoostError("status response must be an object")
        return result

    async def orders_status(self, orders: str | Iterable[int]) -> Mapping[str, Any]:
        order_ids = _parse_orders_csv(orders)
        result = await self._request("status", {"orders": ",".join(map(str, order_ids))})
        if not isinstance(result, dict):
            raise TwiBoostError("status response must be an object")
        return result

    async def refill(self, order: int) -> Mapping[str, Any]:
        order_id = int(order)
        if order_id <= 0:
            raise ValueError("order must be a positive integer")
        result = await self._request("refill", {"order": order_id})
        if not isinstance(result, dict):
            raise TwiBoostError("refill response must be an object")
        return result

    async def cancel(self, order: int) -> Mapping[str, Any]:
        order_id = int(order)
        if order_id <= 0:
            raise ValueError("order must be a positive integer")
        result = await self._request("cancel", {"order": order_id})
        if not isinstance(result, dict):
            raise TwiBoostError("cancel response must be an object")
        return result


def config_status() -> Dict[str, Any]:
    cfg = TwiBoostConfig.from_env()
    return {
        "configured": cfg.configured,
        "api_url": cfg.api_url,
        "api_key": cfg.masked_key,
        "timeout": cfg.timeout,
    }


async def _cli_async(args: argparse.Namespace) -> Any:
    client = TwiBoostClient()
    if args.command == "config":
        return config_status()
    if args.command == "balance":
        return await client.balance()
    if args.command == "services":
        return filter_services(
            await client.services(),
            search=args.search,
            category=args.category,
            service_type=args.service_type,
            limit=args.limit,
        )
    if args.command == "status":
        return await (client.orders_status(args.orders) if args.orders else client.order_status(args.order))
    if args.command == "add":
        payload = build_add_order_payload(
            service=args.service,
            link=args.link,
            quantity=args.quantity,
            extra_json=args.extra_json,
        )
        if not args.confirm:
            return {"preview": True, "action": "add", "payload": payload}
        return await client.add_order(
            service=args.service,
            link=args.link,
            quantity=args.quantity,
            extra_json=args.extra_json,
        )
    if args.command in {"refill", "cancel"}:
        if not args.confirm:
            return {"preview": True, "action": args.command, "payload": {"order": args.order}}
        method = client.refill if args.command == "refill" else client.cancel
        return await method(args.order)
    raise ValueError(f"Unsupported command: {args.command}")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="TwiBoost API helper")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("config")
    sub.add_parser("balance")
    services = sub.add_parser("services")
    services.add_argument("--search", default="")
    services.add_argument("--category", default="")
    services.add_argument("--service-type", default="")
    services.add_argument("--limit", type=int, default=20)
    status = sub.add_parser("status")
    status.add_argument("--order", type=int, default=0)
    status.add_argument("--orders", default="")
    add = sub.add_parser("add")
    add.add_argument("--service", type=int, required=True)
    add.add_argument("--link", required=True)
    add.add_argument("--quantity", type=int)
    add.add_argument("--extra-json", default="")
    add.add_argument("--confirm", action="store_true")
    for command in ("refill", "cancel"):
        action = sub.add_parser(command)
        action.add_argument("--order", type=int, required=True)
        action.add_argument("--confirm", action="store_true")
    result = asyncio.run(_cli_async(parser.parse_args()))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
