"""Small Ollama compatibility adapter for LightRAG's local extraction model."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse


UPSTREAM = os.getenv("OLLAMA_UPSTREAM_URL", "http://lightrag-ollama:11434").rstrip("/")
KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")
FORCE_NO_THINK = os.getenv("OLLAMA_FORCE_NO_THINK", "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
}
HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

app = FastAPI(title="LightRAG Ollama Adapter", docs_url=None, redoc_url=None)
logger = logging.getLogger("lightrag-ollama-adapter")


def _forward_headers(headers: httpx.Headers) -> dict[str, str]:
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }


@app.get("/healthz")
async def health() -> JSONResponse:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{UPSTREAM}/api/tags")
            response.raise_for_status()
        return JSONResponse({"status": "healthy", "upstream": "ollama"})
    except Exception as error:
        return JSONResponse(
            {"status": "unhealthy", "error": type(error).__name__}, status_code=503
        )


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    response_model=None,
)
async def proxy(path: str, request: Request):
    body = await request.body()
    if request.method in {"POST", "PUT", "PATCH"} and path == "api/chat":
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return JSONResponse({"error": "invalid JSON request"}, status_code=400)
        if FORCE_NO_THINK:
            payload["think"] = False
        payload.setdefault("keep_alive", KEEP_ALIVE)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS | {"host"}
    }
    client = httpx.AsyncClient(timeout=None)
    try:
        upstream_response = await client.request(
            request.method,
            f"{UPSTREAM}/{path}",
            params=request.query_params,
            headers=headers,
            content=body,
        )
    except Exception as error:
        logger.exception("Ollama upstream request failed: %s %s", request.method, path)
        await client.aclose()
        return JSONResponse(
            {
                "error": "Ollama upstream unavailable",
                "kind": type(error).__name__,
                "detail": str(error)[:500],
            },
            status_code=502,
        )

    async def stream_body() -> AsyncIterator[bytes]:
        try:
            yield upstream_response.content
        finally:
            await client.aclose()

    return StreamingResponse(
        stream_body(),
        status_code=upstream_response.status_code,
        headers=_forward_headers(upstream_response.headers),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=11435)
