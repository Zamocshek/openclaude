---
name: maton-api-gateway
description: Route user-requested Google, Notion, YouTube, Telegram Bot API, and other supported-service operations through the local Telegram MCP Maton tools.
---

# Maton API Gateway for Telegram MCP

Use the MCP tools first. They keep the Maton API key local and make all side effects explicit.

1. Call `maton_config_status` and `maton_connections` to inspect readiness.
2. Use `maton_get` for reads. Always specify the `connection_id` selected by the user.
3. For a connection not yet authorised, use `maton_prepare_connection` only after the user names the app and account they want to authorise. Then wait for `assistant_confirm_action`.
4. For a write, use `maton_prepare_request` with the app, connection ID, method, route, body, and a plain-language summary. Show the generated pending action and wait for explicit human approval before `assistant_confirm_action`.
5. For Telegram posting from the main user account, prefer `content_prepare_publish` and `assistant_confirm_action`. Maton Telegram routes are for a separately connected Bot API account and do not replace the multi-account Telethon workflow.

The full upstream Maton skill and provider references are vendored at `maton skills for telegram/`. Read the matching reference before making a service-specific call, especially for Google and Notion API versions.

For YouTube, select one app explicitly: `youtube` for channel, video, playlist,
subscription, and comment data; `youtube-analytics` for channel metrics; or
`youtube-reporting` for report jobs. First inspect
`maton_connections(app="youtube")`, select the exact connection, then make a
small GET such as `youtube/v3/channels?part=snippet,statistics&mine=true`.
For route details, read `maton skills for telegram/references/youtube/README.md`,
`youtube-analytics/README.md`, or `youtube-reporting/README.md`. Ratings,
comments, subscriptions, playlists, and report jobs are writes and require the
normal prepare-and-confirm sequence.

Terraform is not currently a Maton-supported app. Treat it as a separate infrastructure workflow and never run `terraform apply` without a reviewed plan and explicit approval.
