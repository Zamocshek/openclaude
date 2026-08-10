# Tool Contract

## Portable MCP Setup

Use this skill only with an MCP client that can launch a local stdio process.
Copy `assets/mcp-stdio.example.json` and replace the two repository placeholders.
The server loads Telegram and Maton credentials from its own `.env`.

Clients with another configuration schema should preserve these values:

| Field | Value |
|---|---|
| Transport | stdio |
| Command | Python executable available to the host |
| Argument | absolute path to `main.py` |
| Working directory | repository root |
| Secrets | deployment-local `.env`, never client config |

## Tool Selection

| Need | Read or prepare | Confirmed effect |
|---|---|---|
| Account health | `list_accounts`, `check_account` | None |
| Chat context | `assistant_sync_chat`, `assistant_get_chat_context` | None |
| Rich post validation | `post_formatting_help`, `post_preview`, `post_extract_custom_emojis` | None |
| Reply or rich post | `assistant_prepare_send`, `post_prepare_send` | `assistant_confirm_action` |
| Source research | `content_sync_sources`, `content_capture_source_post`, `content_research_context` | None |
| Channel editorial profile | `content_channel_profiles`, `content_channel_post_brief`, `content_quality_review` | None |
| Original draft | `content_similarity_check`, `content_create_draft` | None |
| Publish rich draft or batch | `content_prepare_publish`, `content_prepare_publish_batch` | `assistant_confirm_action` once per action |
| Reconcile action batch | `assistant_action_status_batch` | None |
| Maton connection status | `maton_config_status`, `maton_connections`, `maton_connection_get` | None |
| Maton Telegram identity/chat read | `maton_telegram_get_me`, `maton_telegram_get_chat` | None |
| Maton Telegram text/animation send | `maton_telegram_prepare_send_message`, `maton_telegram_prepare_send_animation` | `assistant_confirm_action` |
| Local Telegram bot access/send fallback | `telegram_bot_check_posting_access`, `telegram_bot_prepare_send_message` | `assistant_confirm_action` |
| Other Maton read | `maton_get` | None |
| Create Maton connection | `maton_prepare_connection` | `assistant_confirm_action` |
| Other Maton write | `maton_prepare_request` | `assistant_confirm_action` |
| VPromotions order | `vpromotions_services`, preview `vpromotions_add_order` | `vpromotions_add_order(confirm=true)` |
| TwiBoost order | `twiboost_services`, preview `twiboost_add_order` | `twiboost_add_order(confirm=true)` |

## Provider Routes

Provider details are intentionally not duplicated here. Read the exact local
reference just before forming a Maton request:

- Notion: `maton skills for telegram/references/notion/README.md`
- Google Docs: `maton skills for telegram/references/google-docs/README.md`
- Google Sheets: `maton skills for telegram/references/google-sheets/README.md`
- Gmail: `maton skills for telegram/references/google-mail/README.md`
- YouTube Data: `references/youtube.md` and `maton skills for telegram/references/youtube/README.md`
- YouTube Analytics: `maton skills for telegram/references/youtube-analytics/README.md`
- YouTube Reporting: `maton skills for telegram/references/youtube-reporting/README.md`
- Telegram Bot API: `maton skills for telegram/references/telegram/README.md`

For common Telegram operations, prefer the dedicated `maton_telegram_*` tools
instead of assembling a route manually. For other operations, always send a
relative route to `maton_get` or `maton_prepare_request`. The MCP
client pins requests to Maton and manages authorization headers itself.

## Rich Post Contract

Before writing channel content, call `content_channel_post_brief` for the exact
target. Use `auto` for adaptive depth or select `short`, `standard`, or `long`
when requested. The profile registry distinguishes confirmed descriptions from
inferred placeholders and does not impose one global post length. Telegram text
still has a hard 4096 UTF-16-unit limit; media captions have 1024.

Use `format_mode` as `plain`, `html`, or `markdown`. Preview the exact source
with `post_preview` before preparing a send. HTML supports Telegram formatting
tags including `b`, `i`, `u`, `s`, `code`, `pre`, `blockquote`, `a`, and
`tg-emoji`. A custom emoji needs an existing Telegram `document_id` and must be
written as `<tg-emoji emoji-id="DOCUMENT_ID">fallback emoji</tg-emoji>`.

`post_extract_custom_emojis` reads reusable IDs from a message. The selected
personal account must be Premium for a post containing custom premium emoji.
The prepare tools accept `silent`, `link_preview`, `reply_to_msg_id`, and
`send_as`; every prepared post needs a single explicit confirmation. To attach
an image or document, pass a readable local `media_path`. Images are photos by
default; `force_document=true` preserves the file as a document. A formatted
media caption is limited to 1024 UTF-16 characters. `link_preview` applies only
to text posts.
