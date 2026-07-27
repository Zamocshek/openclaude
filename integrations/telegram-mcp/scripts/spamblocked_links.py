#!/usr/bin/env python3
"""
Выводит tg://user?id=USER_ID для аккаунтов в спамблоке.
Запуск: uv run python scripts/spamblocked_links.py
Требует: MCP telegram не должен быть запущен (иначе .session заблокированы).
"""
import asyncio
import json
import os
import sys

# Add parent to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from telethon import TelegramClient

from runtime_config import get_session_dir

SESSION_DIR = str(get_session_dir())
API_ID = int(os.getenv("TELEGRAM_API_ID", 0))
API_HASH = os.getenv("TELEGRAM_API_HASH", "")

# Аккаунты в спамблоке (из транскрипта диалога)
SPAMBLOCKED_IDS = [
    "сок", "Reidzio_Vadez",
    "217843949", "217843956", "217843961", "217843964", "217843967",
    "217843972", "217843976", "217843983", "217843984", "217843990",
    "217843997", "217843999", "217844004", "217844014", "217844017",
    "218038922", "218038930", "218038934", "218038937", "218038941",
    "218039534", "218039554", "218039576", "218039593", "218039643",
    "218039676", "218039709", "218039717", "218039727",
]


def _load_session_config(name: str) -> dict:
    p = os.path.join(SESSION_DIR, f"{name}.json")
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _resolve_proxy(name: str) -> dict | None:
    cfg = _load_session_config(name)
    p = cfg.get("proxy")
    if p and p.get("host"):
        return p
    proxies_path = os.path.join(SESSION_DIR, "proxies.json")
    if os.path.isfile(proxies_path):
        try:
            with open(proxies_path, encoding="utf-8") as f:
                data = json.load(f)
            return data.get("default_proxy")
        except Exception:
            pass
    return None


def _build_proxy_kwargs(proxy: dict) -> dict:
    t = (proxy.get("type") or "socks5").lower()
    host = proxy.get("host", "")
    port = int(proxy.get("port", 0))
    if "mtproto" in t or "mtproto" in str(proxy):
        from telethon.network.connection.tcpmtproxy import TcpMTProxy
        return {"proxy": (TcpMTProxy, host, port, proxy.get("secret", ""))}
    if "socks5" in t or t == "socks":
        from telethon.network.connection.tcpfull import ConnectionTcpFull
        return {"proxy": (ConnectionTcpFull, host, port, True)}
    from telethon.network.connection.tcpfull import ConnectionTcpFull
    return {"proxy": (ConnectionTcpFull, host, port, False)}


async def main():
    if not API_ID or not API_HASH:
        print("TELEGRAM_API_ID и TELEGRAM_API_HASH в .env обязательны", file=sys.stderr)
        sys.exit(1)

    results = []
    for aid in SPAMBLOCKED_IDS:
        session_path = os.path.join(SESSION_DIR, aid)
        if not os.path.isfile(session_path + ".session"):
            results.append((aid, None, "no session"))
            continue

        cfg = _load_session_config(aid)
        api_id = int(cfg.get("app_id") or API_ID)
        api_hash = str(cfg.get("app_hash") or API_HASH)
        kwargs = {}
        proxy = _resolve_proxy(aid)
        if proxy:
            kwargs = _build_proxy_kwargs(proxy)

        client = TelegramClient(
            session_path, api_id, api_hash,
            timeout=10, connection_retries=2,
            **kwargs
        )
        try:
            await client.connect()
            if not await client.is_user_authorized():
                results.append((aid, None, "not authorized"))
                continue
            me = await client.get_me()
            if me:
                results.append((aid, me.id, me.first_name or ""))
            else:
                results.append((aid, None, "get_me empty"))
        except Exception as e:
            results.append((aid, None, str(e)[:50]))
        finally:
            await client.disconnect()
        await asyncio.sleep(2)  # пауза между аками

    # Вывод в формате tg://user?id=...
    print("# Спамблок — tg://user?id=USER_ID")
    print("# account_id | user_id | имя | ссылка")
    print("-" * 60)
    for aid, uid, extra in results:
        if uid:
            print(f"tg://user?id={uid}")
        else:
            print(f"# {aid} — {extra}")


if __name__ == "__main__":
    asyncio.run(main())
