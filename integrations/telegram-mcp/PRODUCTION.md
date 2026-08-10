# Production Guide

This repository ships two processes:

- `telegram-mcp`: the stdio MCP server used by Claude, OpenClou, Hermes, Cursor, and other MCP clients.
- `telegram-mcp-web`: a local web console for operators. It is optional and must not replace the MCP agent.

The MCP server is the capability layer. The external MCP client remains the agent/brain.

## Runtime Layout

All runtime state is configurable. Do not store secrets or sessions in git.

Recommended production `.env`:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef

TELEGRAM_MCP_CONFIG_DIR=
TELEGRAM_MCP_DATA_DIR=./data
TELEGRAM_MCP_SESSION_DIR=./data/session
TELEGRAM_MCP_LOG_FILE=./data/logs/mcp_errors.log
TELEGRAM_MCP_ASSISTANT_DB=./data/session/assistant_memory.sqlite3
TELEGRAM_MCP_CONTENT_DB=./data/session/content_workflow.sqlite3

TELEGRAM_SESSION_NAME=telegram_session
TELEGRAM_SESSION_STRING=

TELEGRAM_MCP_WEB_HOST=127.0.0.1
TELEGRAM_MCP_WEB_PORT=8765
TELEGRAM_MCP_WEB_TOKEN=
VPROMOTIONS_API_URL=https://vpromotions.ru/api/v2
VPROMOTIONS_API_KEY=
VPROMOTIONS_TIMEOUT=30
TWIBOOST_API_URL=https://twiboost.com/api/v2
TWIBOOST_API_KEY=
TWIBOOST_TIMEOUT=30
```

Relative runtime paths are resolved from the source/deployment directory. Set
`TELEGRAM_MCP_CONFIG_DIR` when running an installed package from a dedicated
directory that contains `.env`. Use absolute paths when deploying as a service.

Important files:

- `.env`: `TELEGRAM_MCP_CONFIG_DIR/.env` when `TELEGRAM_MCP_CONFIG_DIR` is set
- `.session` files: `TELEGRAM_MCP_SESSION_DIR`
- default file session: simple `TELEGRAM_SESSION_NAME` values are stored under `TELEGRAM_MCP_SESSION_DIR`
- per-account configs: `TELEGRAM_MCP_SESSION_DIR/<account_id>.json`
- proxy pool: `TELEGRAM_MCP_SESSION_DIR/proxies.json`
- smooth mode config: `TELEGRAM_MCP_SESSION_DIR/smooth.json`
- operator/web/agent config: `TELEGRAM_MCP_SESSION_DIR/operator_config.json`
- assistant memory: `TELEGRAM_MCP_ASSISTANT_DB`
- content workflow DB: `TELEGRAM_MCP_CONTENT_DB`
- logs: `TELEGRAM_MCP_LOG_FILE`

## Install

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Fill `.env`, then generate or import a Telegram session:

```bash
python session_string_generator.py
```

## Run MCP

For stdio MCP clients:

```bash
python main.py
```

Installed package command:

```bash
telegram-mcp
```

## Run Web Console

Local-only:

```bash
python web_app.py
```

Open:

```text
http://127.0.0.1:8765
```

If binding to anything except localhost, set `TELEGRAM_MCP_WEB_TOKEN` and put the service behind HTTPS/reverse proxy.

The web console can inspect local memory, accounts, pending actions, todos, and reminders.
It also has a mini account admin for importing `.session`/`.json` files,
checking account status, viewing recent dialogs, syncing dialogs to the local
assistant DB, and sending a manual confirmed reply from a selected account.
The same operator settings are exposed to MCP agents through
`operator_get_config`, `operator_set_config`, and `operator_reset_config`.

Synthetic stat report rendering is available through `stat_report_templates`,
`stat_report_render`, and the `telegram-mcp-render-stat` CLI command. Outputs
are local HTML/PNG files under `TELEGRAM_MCP_DATA_DIR/stat_reports` by default
and always include a visible `DEMO` watermark block.

## Docker

Build:

```bash
docker compose build
```

Run stdio MCP container:

```bash
docker compose up telegram-mcp
```

Run web console:

```bash
docker compose --profile web up telegram-mcp-web
```

Runtime state is mounted at `./data:/data`. Compose explicitly maps
`TELEGRAM_MCP_*` runtime paths to `/data` so relative host-side values from
`.env` do not accidentally write into the container filesystem.

## Multi-Account Production

Put accounts in `TELEGRAM_MCP_SESSION_DIR`:

```text
data/session/
  main.session
  main.json
  worker-01.session
  worker-01.json
  proxies.json
  smooth.json
```

Example `worker-01.json`:

```json
{
  "app_id": 123456,
  "app_hash": "0123456789abcdef0123456789abcdef",
  "device": "Desktop",
  "sdk": "Windows 11",
  "app_version": "5.0",
  "lang_code": "en",
  "proxy": {
    "type": "socks5",
    "host": "127.0.0.1",
    "port": 1080
  }
}
```

Example `smooth.json`:

```json
{
  "enabled": true,
  "delay_between_requests": 8,
  "delay_between_accounts": 8,
  "max_parallel": 3
}
```

`delay_between_requests` is enforced with a per-account async lock. `max_parallel` is used by multi-account batch tools where supported.

## Assistant Layer

TelegramHelper-like functionality is exposed as MCP tools:

- memory sync/search: `assistant_sync_memory`, `assistant_sync_chat`, `assistant_search_memory`
- chat context: `assistant_get_chat_context`
- confirmed sending: `assistant_prepare_send`, then `assistant_confirm_action`
- tasks/reminders: `assistant_add_todo`, `assistant_list_todos`, `assistant_add_reminder`, `assistant_list_reminders`
- digest/news context: `assistant_daily_digest_context`, `assistant_news_digest_context`

The external agent should use these tools to summarize, draft replies, extract tasks, and decide next actions.

## Content Workflow

The content workflow adds a local editorial pipeline for channel posting:

- `content_workflow_config`: set the main research account and duplicate threshold.
- `content_add_source`: register channels/chats that the research account reads.
- `content_add_target`: register channels/chats where approved posts can be published.
- `content_sync_sources`: cache recent source posts in `TELEGRAM_MCP_CONTENT_DB`.
- `content_research_context`: give the MCP agent source material plus recent own history.
- `content_channel_profiles`: list channel themes, description status, and formats.
- `content_channel_post_brief`: resolve the exact target's editorial rules before drafting.
- `content_similarity_check`: check a draft against stored source/draft/published posts.
- `content_create_draft`: store a draft only if it is not too similar, unless explicitly overridden.
- `content_prepare_publish`: create a pending Telegram send action.
- `assistant_confirm_action`: sends the pending post after human approval and marks the draft published.

Recommended safe sequence:

```text
content_workflow_config -> content_add_source/content_add_target -> content_sync_sources
-> content_research_context -> content_channel_post_brief -> agent rewrites -> content_create_draft
-> content_prepare_publish -> human approval -> assistant_confirm_action
```

`channel_profiles.json` ships with the deployment. Until the owner supplies a
confirmed description, the registry uses an explicitly labelled inferred
placeholder. Use `auto` for adaptive length or select `short`, `standard`, or
`long`; do not impose one global length range. Telegram's own hard limits still
apply: 4096 UTF-16 units for text and 1024 for media captions.

## Maton API Gateway

Maton is optional and uses `MATON_API_KEY` from the ignored `.env`. The client
pins gateway traffic to `https://api.maton.ai`, prevents absolute/escaping routes,
and never returns the API key. Use `maton_connections` before choosing a concrete
`connection_id` for Google or Notion requests.

All connection creation and external writes are stored as pending actions. The
operator must review the app, connection ID, relative endpoint, headers, JSON
body, and expected outcome before `assistant_confirm_action` executes it. This
means the content workflow's multi-account Telegram posting does not acquire a
second bot dependency.

Terraform is not a Maton app. Keep Terraform state and credentials in its own
deployment boundary and require `terraform plan` review before apply.

## Release Checklist

- `.env`, `data/`, `session/`, logs, `.session` files are ignored.
- `python -m py_compile main.py account_admin.py assistant_memory.py content_workflow.py maton_client.py runtime_config.py web_app.py`
- `python -m pytest test_validation.py test_assistant_memory.py test_content_workflow.py test_maton_client.py test_web_app.py`
- `docker compose build`
- MCP client config points to `python main.py` or `telegram-mcp`.
- Web console token is set if exposed beyond localhost.
