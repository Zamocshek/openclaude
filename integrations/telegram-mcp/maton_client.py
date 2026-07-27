"""Maton API Gateway client used by Telegram MCP tools and local checks."""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional
from urllib.parse import unquote, urlsplit

import httpx

import runtime_config  # noqa: F401 - loads the deployment-local .env file

DEFAULT_API_URL = "https://api.maton.ai"
DEFAULT_TIMEOUT = 30.0
_CONNECTION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_APP_RE = re.compile(r"^[a-z][a-z0-9-]{0,99}$")
_BLOCKED_HEADERS = {"authorization", "maton-connection", "host", "content-length"}


class MatonError(RuntimeError):
    """Base error for the Maton integration."""


class MatonAPIError(MatonError):
    """Maton returned an HTTP or structured API error."""


@dataclass(frozen=True)
class MatonConfig:
    api_url: str = DEFAULT_API_URL
    api_key: str = ""
    timeout: float = DEFAULT_TIMEOUT

    @classmethod
    def from_env(cls) -> "MatonConfig":
        api_url = (os.getenv("MATON_API_URL") or DEFAULT_API_URL).strip().rstrip("/")
        parsed = urlsplit(api_url)
        if parsed.scheme != "https" or parsed.netloc != "api.maton.ai" or parsed.path:
            raise MatonError("MATON_API_URL must be exactly https://api.maton.ai")
        try:
            timeout = float(os.getenv("MATON_TIMEOUT", str(DEFAULT_TIMEOUT)))
        except ValueError as exc:
            raise MatonError("MATON_TIMEOUT must be a number") from exc
        if timeout <= 0:
            raise MatonError("MATON_TIMEOUT must be positive")
        return cls(
            api_url=api_url,
            api_key=(os.getenv("MATON_API_KEY") or "").strip(),
            timeout=timeout,
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


def config_status() -> Dict[str, Any]:
    config = MatonConfig.from_env()
    return {
        "configured": config.configured,
        "api_url": config.api_url,
        "api_key_configured": config.configured,
        "timeout": config.timeout,
    }


def parse_json_object(value: Optional[str], field_name: str) -> Dict[str, Any]:
    if not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError(f"{field_name} must be a JSON object")
    return parsed


def validate_app(app: str) -> str:
    normalized = str(app or "").strip().lower()
    if not _APP_RE.fullmatch(normalized):
        raise ValueError("app must be a Maton app identifier, for example notion or google-drive")
    return normalized


def validate_connection_id(connection_id: str) -> str:
    normalized = str(connection_id or "").strip()
    if not _CONNECTION_ID_RE.fullmatch(normalized):
        raise ValueError("connection_id contains unsupported characters")
    return normalized


def validate_route_path(path: str) -> str:
    raw = str(path or "").strip()
    parsed = urlsplit(raw)
    if not raw or parsed.scheme or parsed.netloc or parsed.fragment or "\\" in raw:
        raise ValueError("path must be a relative Maton API route")
    cleaned_path = parsed.path.lstrip("/")
    if not cleaned_path:
        raise ValueError("path is required")
    for segment in cleaned_path.split("/"):
        if unquote(segment) in {"", ".", ".."}:
            raise ValueError("path contains an unsafe segment")
    return cleaned_path + (f"?{parsed.query}" if parsed.query else "")


def validate_custom_headers(headers: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    if not headers:
        return {}
    clean: Dict[str, str] = {}
    for key, value in headers.items():
        name = str(key).strip()
        if not name or name.lower() in _BLOCKED_HEADERS:
            raise ValueError(f"header {name or '<empty>'} is managed by the Maton client")
        if "\r" in name or "\n" in name:
            raise ValueError("header names cannot contain newlines")
        text = str(value)
        if "\r" in text or "\n" in text:
            raise ValueError("header values cannot contain newlines")
        clean[name] = text
    return clean


def summarize_connection(
    connection: Mapping[str, Any], *, include_authorization_url: bool = False
) -> Dict[str, Any]:
    result = {
        key: connection.get(key)
        for key in (
            "connection_id",
            "app",
            "status",
            "method",
            "creation_time",
            "last_updated_time",
        )
        if key in connection
    }
    if "metadata" in connection:
        result["metadata_available"] = bool(connection.get("metadata"))
    url = connection.get("url")
    if url:
        if include_authorization_url:
            result["authorization_url"] = url
        else:
            result["authorization_url_available"] = True
    return result


class MatonClient:
    def __init__(
        self,
        config: Optional[MatonConfig] = None,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.config = config or MatonConfig.from_env()
        self._transport = transport

    def _require_configured(self) -> None:
        if not self.config.configured:
            raise MatonError("MATON_API_KEY is not configured")

    async def request(
        self,
        *,
        method: str,
        app: str,
        path: str,
        connection_id: str,
        body: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        self._require_configured()
        method = str(method or "").upper()
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise ValueError("method must be GET, POST, PUT, PATCH, or DELETE")
        app = validate_app(app)
        path = validate_route_path(path)
        connection_id = validate_connection_id(connection_id)
        request_headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Maton-Connection": connection_id,
            **validate_custom_headers(headers),
        }
        request_kwargs: Dict[str, Any] = {"headers": request_headers}
        if body:
            request_kwargs["json"] = dict(body)
        async with httpx.AsyncClient(
            timeout=self.config.timeout,
            transport=self._transport,
            follow_redirects=False,
        ) as client:
            response = await client.request(
                method, f"{self.config.api_url}/{app}/{path}", **request_kwargs
            )
        try:
            payload: Any = response.json()
        except ValueError:
            payload = response.text[:1000]
        if response.is_error:
            if isinstance(payload, Mapping):
                detail = payload.get("error") or payload.get("message") or "remote API error"
            else:
                detail = str(payload) or "remote API error"
            raise MatonAPIError(f"Maton API returned HTTP {response.status_code}: {detail}")
        return {"status_code": response.status_code, "data": payload}

    async def list_connections(
        self, *, app: Optional[str] = None, status: Optional[str] = None
    ) -> Dict[str, Any]:
        self._require_configured()
        params: Dict[str, str] = {}
        if app:
            params["app"] = validate_app(app)
        if status:
            params["status"] = str(status).strip().upper()
        headers = {"Authorization": f"Bearer {self.config.api_key}"}
        async with httpx.AsyncClient(
            timeout=self.config.timeout,
            transport=self._transport,
            follow_redirects=False,
        ) as client:
            response = await client.get(
                f"{self.config.api_url}/connections", params=params, headers=headers
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise MatonAPIError("Maton connections response was not JSON") from exc
        if response.is_error:
            detail = payload.get("error") if isinstance(payload, Mapping) else "remote API error"
            raise MatonAPIError(f"Maton API returned HTTP {response.status_code}: {detail}")
        if not isinstance(payload, dict):
            raise MatonAPIError("Maton connections response must be an object")
        return payload

    async def get_connection(self, connection_id: str) -> Dict[str, Any]:
        self._require_configured()
        connection_id = validate_connection_id(connection_id)
        headers = {"Authorization": f"Bearer {self.config.api_key}"}
        async with httpx.AsyncClient(
            timeout=self.config.timeout,
            transport=self._transport,
            follow_redirects=False,
        ) as client:
            response = await client.get(
                f"{self.config.api_url}/connections/{connection_id}", headers=headers
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise MatonAPIError("Maton connection response was not JSON") from exc
        if response.is_error:
            detail = payload.get("error") if isinstance(payload, Mapping) else "remote API error"
            raise MatonAPIError(f"Maton API returned HTTP {response.status_code}: {detail}")
        if not isinstance(payload, dict):
            raise MatonAPIError("Maton connection response must be an object")
        return payload

    async def create_connection(self, *, app: str, method: str = "OAUTH2") -> Dict[str, Any]:
        self._require_configured()
        app = validate_app(app)
        method = str(method or "OAUTH2").upper()
        if method not in {"API_KEY", "BASIC", "OAUTH1", "OAUTH2", "MCP"}:
            raise ValueError("unsupported Maton connection method")
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(
            timeout=self.config.timeout,
            transport=self._transport,
            follow_redirects=False,
        ) as client:
            response = await client.post(
                f"{self.config.api_url}/connections",
                headers=headers,
                json={"app": app, "method": method},
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise MatonAPIError("Maton create-connection response was not JSON") from exc
        if response.is_error:
            detail = payload.get("error") if isinstance(payload, Mapping) else "remote API error"
            raise MatonAPIError(f"Maton API returned HTTP {response.status_code}: {detail}")
        if not isinstance(payload, dict):
            raise MatonAPIError("Maton create-connection response must be an object")
        return payload


async def _cli_async(command: str) -> Dict[str, Any]:
    client = MatonClient()
    if command == "config":
        return config_status()
    if command == "connections":
        response = await client.list_connections()
        connections = response.get("connections", [])
        return {"connections": [summarize_connection(item) for item in connections]}
    raise ValueError(f"Unsupported command: {command}")


def main() -> None:
    import argparse

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Maton API Gateway helper")
    parser.add_argument("command", choices=("config", "connections"))
    result = asyncio.run(_cli_async(parser.parse_args().command))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
