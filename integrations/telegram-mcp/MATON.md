# Maton API Gateway

This project can route supported third-party APIs through Maton while keeping the
Maton API key in the local `.env` file. It does not send the key to Telegram or
any service other than `https://api.maton.ai`.

## Setup

```dotenv
MATON_API_URL=https://api.maton.ai
MATON_API_KEY=replace-me
MATON_TIMEOUT=30
```

The key is ignored by Git. Check only its presence with `maton_config_status`.

## MCP workflow

1. Inspect the authorised integrations with `maton_connections`.
2. For Telegram Bot API reads, use `maton_telegram_get_me` or
   `maton_telegram_get_chat`. With exactly one active Telegram connection the
   server selects it automatically; otherwise pass `connection_id`.
3. For Telegram text or animation sends, use
   `maton_telegram_prepare_send_message` or
   `maton_telegram_prepare_send_animation`. They create pending actions and do
   not publish immediately.
4. For other Maton apps and methods, select the exact `connection_id` and use
   `maton_get` for reads or `maton_prepare_request` for writes.
5. To add a connection, call `maton_prepare_connection`. Confirm its pending action,
   then complete the returned Maton authorization URL in a browser.
6. To change an external service, call `maton_prepare_request`; it stores the exact
   endpoint, connection, headers, and JSON body as a pending action. Only
   `assistant_confirm_action` performs the remote POST, PUT, PATCH, or DELETE.

Google Drive, Docs, Sheets, Gmail, Calendar, Notion, YouTube, YouTube Analytics,
and YouTube Reporting are supported by Maton and have local route references in
`maton skills for telegram/references/`. For YouTube, use `youtube` for channel
and content data, `youtube-analytics` for metrics, and `youtube-reporting` for
bulk report jobs. Each app can require its own connection; inspect it with
`maton_connections(app=...)` before a request. Telegram Bot API is also
supported, but the server's normal multi-account publishing uses Telethon and
remains the preferred route for personal Telegram accounts.

Terraform is not listed as a Maton service. Keep Terraform credentials and state in
its own backend; review `terraform plan` before any `terraform apply`.
