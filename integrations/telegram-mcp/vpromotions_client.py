"""VPromotions API client for MCP tools and CLI usage."""

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

DEFAULT_API_URL = "https://vpromotions.ru/api/v2"
DEFAULT_TIMEOUT = 30.0


class VPromotionsError(RuntimeError):
    """Base error for VPromotions integration."""


class VPromotionsAPIError(VPromotionsError):
    """The remote API returned an error payload."""


@dataclass(frozen=True)
class VPromotionsConfig:
    api_url: str = DEFAULT_API_URL
    api_key: str = ""
    timeout: float = DEFAULT_TIMEOUT

    @classmethod
    def from_env(cls) -> "VPromotionsConfig":
        return cls(
            api_url=(os.getenv("VPROMOTIONS_API_URL") or DEFAULT_API_URL).strip(),
            api_key=(os.getenv("VPROMOTIONS_API_KEY") or "").strip(),
            timeout=float(os.getenv("VPROMOTIONS_TIMEOUT", str(DEFAULT_TIMEOUT))),
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


def _clean_payload(payload: Mapping[str, Any]) -> Dict[str, str]:
    clean: Dict[str, str] = {}
    for key, value in payload.items():
        if value is None:
            continue
        text = str(value).strip()
        if text == "":
            continue
        clean[key] = text
    return clean


def _parse_extra_json(extra_json: Optional[str]) -> Dict[str, Any]:
    if not extra_json:
        return {}
    parsed = json.loads(extra_json)
    if not isinstance(parsed, dict):
        raise ValueError("extra_json must be a JSON object")
    return parsed


def _parse_orders_csv(orders: str | Iterable[int]) -> List[int]:
    if isinstance(orders, str):
        raw = [part.strip() for part in orders.split(",")]
    else:
        raw = [str(part).strip() for part in orders]
    parsed = [int(part) for part in raw if part]
    if not parsed:
        raise ValueError("at least one order id is required")
    return parsed


def build_add_order_payload(
    *,
    service: int,
    link: Optional[str] = None,
    quantity: Optional[int] = None,
    runs: Optional[int] = None,
    interval: Optional[int] = None,
    comments: Optional[str] = None,
    username: Optional[str] = None,
    min_quantity: Optional[int] = None,
    max_quantity: Optional[int] = None,
    posts: Optional[int] = None,
    delay: Optional[int] = None,
    expiry: Optional[str] = None,
    answer_number: Optional[int] = None,
    extra_json: Optional[str] = None,
) -> Dict[str, str]:
    if int(service) <= 0:
        raise ValueError("service must be a positive integer")
    payload: Dict[str, Any] = {
        "service": int(service),
        "link": link,
        "quantity": quantity,
        "runs": runs,
        "interval": interval,
        "comments": comments,
        "username": username,
        "min": min_quantity,
        "max": max_quantity,
        "posts": posts,
        "delay": delay,
        "expiry": expiry,
        "answer_number": answer_number,
    }
    payload.update(_parse_extra_json(extra_json))
    clean = _clean_payload(payload)
    if "link" not in clean and "username" not in clean:
        raise ValueError("link or username is required")
    return clean


def filter_services(
    services: Sequence[Mapping[str, Any]],
    *,
    search: Optional[str] = None,
    category: Optional[str] = None,
    service_type: Optional[str] = None,
    limit: int = 50,
) -> List[Mapping[str, Any]]:
    search_l = (search or "").strip().lower()
    category_l = (category or "").strip().lower()
    type_l = (service_type or "").strip().lower()
    result: List[Mapping[str, Any]] = []
    for service in services:
        name = str(service.get("name", "")).lower()
        cat = str(service.get("category", "")).lower()
        typ = str(service.get("type", "")).lower()
        if search_l and search_l not in name and search_l not in cat and search_l not in typ:
            continue
        if category_l and category_l not in cat:
            continue
        if type_l and type_l not in typ:
            continue
        result.append(service)
        if limit > 0 and len(result) >= limit:
            break
    return result


class VPromotionsClient:
    def __init__(
        self,
        config: Optional[VPromotionsConfig] = None,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.config = config or VPromotionsConfig.from_env()
        self._transport = transport

    async def _request(self, action: str, payload: Optional[Mapping[str, Any]] = None) -> Any:
        if not self.config.api_key:
            raise VPromotionsError("VPROMOTIONS_API_KEY is not configured")
        data = {"key": self.config.api_key, "action": action}
        data.update(_clean_payload(payload or {}))
        async with httpx.AsyncClient(
            timeout=self.config.timeout,
            transport=self._transport,
        ) as client:
            response = await client.post(self.config.api_url, data=data)
            response.raise_for_status()
        try:
            parsed = response.json()
        except ValueError as exc:
            raise VPromotionsError("VPromotions returned non-JSON response") from exc
        if isinstance(parsed, dict) and parsed.get("error"):
            raise VPromotionsAPIError(str(parsed["error"]))
        return parsed

    async def services(self) -> List[Mapping[str, Any]]:
        result = await self._request("services")
        if not isinstance(result, list):
            raise VPromotionsError("services response must be a list")
        return result

    async def balance(self) -> Mapping[str, Any]:
        result = await self._request("balance")
        if not isinstance(result, dict):
            raise VPromotionsError("balance response must be an object")
        return result

    async def add_order(self, **kwargs: Any) -> Mapping[str, Any]:
        payload = build_add_order_payload(**kwargs)
        result = await self._request("add", payload)
        if not isinstance(result, dict):
            raise VPromotionsError("add response must be an object")
        return result

    async def order_status(self, order: int) -> Mapping[str, Any]:
        result = await self._request("status", {"order": int(order)})
        if not isinstance(result, dict):
            raise VPromotionsError("status response must be an object")
        return result

    async def orders_status(self, orders: str | Iterable[int]) -> Mapping[str, Any]:
        order_ids = _parse_orders_csv(orders)
        result = await self._request("status", {"orders": ",".join(map(str, order_ids))})
        if not isinstance(result, dict):
            raise VPromotionsError("status response must be an object")
        return result

    async def refill(self, order: int) -> Mapping[str, Any]:
        result = await self._request("refill", {"order": int(order)})
        if not isinstance(result, dict):
            raise VPromotionsError("refill response must be an object")
        return result

    async def refill_status(self, refill: int | str) -> Mapping[str, Any]:
        result = await self._request("refill_status", {"refill": refill})
        if not isinstance(result, dict):
            raise VPromotionsError("refill_status response must be an object")
        return result


def config_status() -> Dict[str, Any]:
    cfg = VPromotionsConfig.from_env()
    return {
        "configured": cfg.configured,
        "api_url": cfg.api_url,
        "api_key": cfg.masked_key,
        "timeout": cfg.timeout,
    }


async def _cli_async(args: argparse.Namespace) -> Any:
    client = VPromotionsClient()
    if args.command == "config":
        return config_status()
    if args.command == "balance":
        return await client.balance()
    if args.command == "services":
        services = await client.services()
        return filter_services(
            services,
            search=args.search,
            category=args.category,
            service_type=args.service_type,
            limit=args.limit,
        )
    if args.command == "status":
        if args.orders:
            return await client.orders_status(args.orders)
        return await client.order_status(args.order)
    raise ValueError(f"Unsupported command: {args.command}")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="VPromotions API helper")
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
    result = asyncio.run(_cli_async(parser.parse_args()))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
