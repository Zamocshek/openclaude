#!/usr/bin/env python3
"""Synchronize the persisted OpenRAG config with production environment choices."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml


def mapping(parent: dict[str, Any], key: str) -> dict[str, Any]:
    value = parent.get(key)
    if not isinstance(value, dict):
        value = {}
        parent[key] = value
    return value


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: sync-openrag-config.py <config.yaml>", file=sys.stderr)
        return 2

    config_path = Path(sys.argv[1]).resolve()
    config_path.parent.mkdir(parents=True, exist_ok=True)

    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            raise ValueError(f"{config_path} must contain a YAML mapping")
        config: dict[str, Any] = loaded
    else:
        config = {}

    llm_provider = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
    llm_model = os.getenv("LLM_MODEL", "qwen3:1.7b").strip()
    embedding_provider = os.getenv("EMBEDDING_PROVIDER", "ollama").strip().lower()
    embedding_model = os.getenv(
        "EMBEDDING_MODEL", "nomic-embed-text:latest"
    ).strip()
    selected_providers = {llm_provider, embedding_provider}

    providers = mapping(config, "providers")
    for name in ("openai", "anthropic", "watsonx", "ollama"):
        mapping(providers, name)

    # Production selection is declarative. Unused cloud credentials must not
    # trigger registry probes or stale-key failures after a restart.
    key_env = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "watsonx": "WATSONX_API_KEY",
    }
    for provider_name, env_name in key_env.items():
        provider = mapping(providers, provider_name)
        selected = provider_name in selected_providers
        provider["api_key"] = ""
        provider["configured"] = selected and bool(os.getenv(env_name, "").strip())

    ollama = mapping(providers, "ollama")
    ollama_endpoint = os.getenv(
        "OLLAMA_ENDPOINT", "http://host.docker.internal:11434"
    ).strip()
    ollama["endpoint"] = ollama_endpoint
    ollama["resolved_endpoint"] = ollama_endpoint
    ollama["configured"] = "ollama" in selected_providers

    knowledge = mapping(config, "knowledge")
    knowledge["embedding_provider"] = embedding_provider
    knowledge["embedding_model"] = embedding_model

    agent = mapping(config, "agent")
    agent["llm_provider"] = llm_provider
    agent["llm_model"] = llm_model

    # Environment remains authoritative on subsequent container starts.
    config["edited"] = False

    previous_mode = config_path.stat().st_mode if config_path.exists() else None
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=config_path.parent,
        prefix=f".{config_path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        yaml.safe_dump(config, handle, allow_unicode=True, sort_keys=False)
        temporary_path = Path(handle.name)

    if previous_mode is not None:
        temporary_path.chmod(previous_mode)
    os.replace(temporary_path, config_path)
    print(
        "OpenRAG config synchronized: "
        f"llm={llm_provider}/{llm_model}, "
        f"embedding={embedding_provider}/{embedding_model}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
