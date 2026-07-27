# Multi-Account System — telegram-mcp

## Overview

telegram-mcp supports multiple Telegram accounts simultaneously. Each account is a `.session` file in the `session/` folder with an optional `.json` config.

## Smooth Mode (Anti-Ban Protection)

Smooth mode enforces delays between Telegram API calls to prevent account bans.

### Defaults

| Parameter | Default | Description |
|---|---|---|
| `enabled` | `true` | Smooth mode on/off |
| `delay_between_requests` | `8` sec | Min delay between API calls for one account |
| `delay_between_accounts` | `8` sec | Delay between accounts in mass operations |
| `max_parallel` | `1` | Max parallel account operations |

### Configuration

- **MCP tool**: `set_smooth_mode(delay=8, between_accounts=8, enabled=true)`
- **View**: `get_smooth_mode`
- **File**: `session/smooth.json` (auto-saved, persists across restarts)

### Why 8 seconds?

Telegram rate-limits aggressive API usage. Accounts that send too many requests in short intervals get flagged. 8 seconds is a safe default — adjust higher (10-15s) for mass operations, lower (3-5s) for light read-only work.

## Session Setup

### File Structure

```
session/
  account_name.session       # Telethon SQLite session
  account_name.json          # Optional config (proxy, fingerprint, api_id)
  proxies.json               # Global proxy defaults
  smooth.json                # Smooth mode config
```

### JSON Config Format

```json
{
  "app_id": 123456,
  "app_hash": "b18441a1ff607e10a989891a546be627",
  "device": "Samsung Galaxy S24",
  "sdk": "Android 14",
  "app_version": "10.8.1",
  "lang_code": "en",
  "system_lang_code": "en",
  "proxy": {
    "type": "mtproto",
    "host": "1.2.3.4",
    "port": 443,
    "secret": "dd6b3fb02424dbac55fef2da67c8c949"
  }
}
```

- `app_id` / `app_hash` — if not set, falls back to `.env` values
- `proxy` — per-account proxy (mtproto, socks5, http)
- `device`, `sdk`, `app_version` — anti-detect fingerprint

## Proxy

### Types Supported

| Type | Config | Notes |
|---|---|---|
| MTProto | `"type": "mtproto"` + `host`, `port`, `secret` | Best for Telegram, encrypted |
| SOCKS5 | `"type": "socks5"` + `host`, `port` | Requires `PySocks` |
| HTTP | `"type": "http"` + `host`, `port` | Basic proxy |

### MTProto Secret Handling

Secrets starting with `dd` or `ee` are handled correctly (Telethon bug patched). Always provide the full hex string.

### Proxy Tools

- `set_account_proxy(account_id, type, host, port, secret)` — set proxy, hot-reload
- `get_account_proxy(account_id)` — show current proxy
- `remove_account_proxy(account_id)` — remove proxy (WARNING: direct connection)
- `rotate_proxies()` — rotate all accounts to next proxy in pool
- `show_proxy_pool()` — show all proxies in use

### No Proxy = Warning

Accounts without proxy show `WARNING` in `list_accounts` and `check_account`. Direct connection exposes your IP and risks bans. Always configure proxies before mass operations.

## Key Tools

| Tool | Description |
|---|---|
| `list_accounts` | Show all accounts with status and proxy |
| `check_account(id)` | Validate one account (disposable client, safe) |
| `check_all_accounts` | Check all accounts sequentially with smooth delays |
| `clear_failed_accounts` | Reset failed cache for retry |
| `delete_session(id)` | Delete session files and remove from memory |
| `set_smooth_mode(...)` | Configure rate limiting |
| `get_smooth_mode` | View current rate limit config |

## Account Diagnostics

### check_account Output

- `ok: 12345 Name @username | proxy: mtproto 1.2.3.4:443` — all good
- `error: session not authorized (expired/revoked)` — session dead, needs re-login
- `error: connect/auth timeout` — proxy or network issue
- `error: proxy unreachable (1.2.3.4:443)` — proxy server down
- `error: session file missing` — no .session file
- `error: auth_key missing or truncated` — corrupted session

### Fatal vs Temporary Errors

**Fatal** (cached in _failed_accounts): `auth_key_unregistered`, `user_deactivated`, `session_revoked`, `session_expired`, `auth_key_duplicated`

**Temporary** (retryable): timeouts, proxy unreachable, network errors

Use `clear_failed_accounts` to retry fatal accounts after fixing the issue.

## Spamblock Check

1. Send `/start` to `@SpamBot` from each account
2. Read the response:
   - "no limits" = clean
   - "Your account was blocked" = permanent ban by Telegram moderators

Blocked accounts can connect to API but cannot resolve usernames, send messages to users, or join channels.

## FAQ

**Q: Why did my accounts get banned?**
A: Aggressive parallel requests without delays. Always use smooth mode (8+ seconds between calls).

**Q: Can I speed up mass operations?**
A: `set_smooth_mode(delay=3)` for read-only ops. For sending messages, keep 8+ seconds.

**Q: Account shows "session not authorized" — can I fix it?**
A: No. The session file is dead. You need to re-login with the phone number to create a new session.

**Q: How to add a new account?**
A: Three ways:
1. Place `name.session` + `name.json` in `session/` folder, restart MCP server.
2. Use `authorize_send_code(phone)` → `authorize_complete(session_name, code)` — authorize directly via MCP (no restart needed).
3. Use `add_session_string(session_string)` — import a Telethon StringSession (no restart needed).

**Q: What are view_posts / view_posts_quick?**
A: Tools for incrementing post view counters on channels using multiple accounts. `view_posts(channel, "1,2,3")` for specific posts, `view_posts_quick(channel, count=10)` for the latest N posts.
