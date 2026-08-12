#!/usr/bin/env python3
"""Portable, local-only Qwen-MM MCP facade.

The upstream package remains unmodified. This facade pins the local Ollama
endpoint/model and exposes only capabilities that work without DashScope.
"""

from __future__ import annotations

import os
import sys
import warnings
import logging
from pathlib import Path


LOCAL_MODEL = os.environ.get("QWEN_MM_MODEL", "qwen3-vl:2b-instruct")
CORE_TOOLS = {
    "read_image",
    "media_info",
    "read_video",
    "visualize",
    "crop",
    "draw_bbox",
    "save_view",
}
LOCAL_API_TOOLS = {"vision_chat", "ocr", "grounding"}
HIDDEN_ARGUMENTS = {"api_key", "base_url", "model"}


def silence_upstream_runtime_noise() -> None:
    """Keep optional upstream typing warnings out of MCP stderr activity."""
    logging.disable(logging.INFO)
    try:
        from pydantic_settings.sources.utils import IncompleteFieldDefinitionWarning

        warnings.filterwarnings("ignore", category=IncompleteFieldDefinitionWarning)
    except ImportError:
        # The filter is cosmetic. The capability still works with a future
        # upstream package that moves or removes this optional warning class.
        pass


def default_base_url() -> str:
    configured = (
        os.environ.get("QWEN_MM_BASE_URL")
        or os.environ.get("OPENCLAUDE_QWEN_MM_BASE_URL")
    )
    if configured:
        return configured.rstrip("/")
    if Path("/.dockerenv").exists():
        return "http://openclaude-ollama:11434/v1"
    return "http://127.0.0.1:11434/v1"


def configure_local_endpoint() -> None:
    os.environ["DASHSCOPE_BASE_URL"] = default_base_url()
    os.environ["DASHSCOPE_API_KEY"] = "ollama-local"
    os.environ.setdefault("QWEN_MM_CHAT_TIMEOUT", "300")


def filter_specs(package: object, allowed: set[str], local_api: bool) -> None:
    specs = [spec for spec in package.SPECS if spec.name in allowed]
    if local_api:
        for spec in specs:
            properties = spec.input_schema.get("properties", {})
            for name in HIDDEN_ARGUMENTS:
                properties.pop(name, None)
            required = spec.input_schema.get("required")
            if isinstance(required, list):
                spec.input_schema["required"] = [
                    name for name in required if name not in HIDDEN_ARGUMENTS
                ]
            spec.description = (
                f"{spec.description} Uses local Ollama model {LOCAL_MODEL}; "
                "no cloud API or external credential is used."
            )
    package.SPECS = specs


def main() -> None:
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else "api"
    if mode not in {"api", "core"}:
        raise SystemExit("usage: local_server.py [api|core]")
    # The launcher consumes only its first positional argument. Keep framework
    # flags such as --check-system available to the upstream CLI.
    sys.argv = [sys.argv[0], *sys.argv[2:]]

    silence_upstream_runtime_noise()
    configure_local_endpoint()
    from mcp_framework import run_main

    if mode == "api":
        from shared import api_openai
        import qwen_mm_plugins_api as package

        api_openai.DEFAULT_MODEL = LOCAL_MODEL
        filter_specs(package, LOCAL_API_TOOLS, local_api=True)
        package.USAGE_NOTE = (
            f"Local-only Qwen-MM vision facade: {LOCAL_MODEL} at "
            f"{default_base_url()}."
        )
        run_main("qwen_mm_plugins_api")
        return

    import qwen_mm_plugins_core as package

    filter_specs(package, CORE_TOOLS, local_api=False)
    run_main("qwen_mm_plugins_core")


if __name__ == "__main__":
    main()
