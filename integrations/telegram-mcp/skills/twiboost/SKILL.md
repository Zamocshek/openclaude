# TwiBoost API Control

Use this project skill when an MCP agent needs to inspect or manage TwiBoost
promotion services through `https://twiboost.com/api/v2`.

## Rules

- Read `twiboost_config_status` first. Do not ask for the API key if
  `configured` is true.
- Call `twiboost_services` before an order and verify the exact `service`,
  `type`, `category`, `rate`, `min`, `max`, `refill`, and `cancel` fields.
- Call `twiboost_add_order` with `confirm=false` first. Show the exact target,
  service, quantity, provider rate, and any provider-specific fields.
- Use `confirm=true` only after explicit human approval of that exact preview.
- Use `twiboost_order_status` after creation. Pass comma-separated IDs through
  `order_ids` for batch checks.
- Use `twiboost_create_refill` only when the selected service has `refill=true`
  and after explicit approval.
- Use `twiboost_cancel_order` only after explicit approval. Never retry a paid,
  refill, or cancellation action blindly after an uncertain network result.

## Supported service types

The service catalog may contain `like`, `subscribe`, `comment`,
`like_to_comment`, `dislike`, `dislike_to_comment`, `repost`, `friend`, `vote`,
`retweet`, `follow`, and `favorite`. Treat the provider catalog as the source
of truth for limits and eligibility.

## Order payload

The common fields are:

```json
{
  "service": 1,
  "link": "https://instagram.com/example",
  "quantity": 100
}
```

Provider-specific fields can be passed as a JSON object through `extra_json`.
Do not put the API key in `extra_json` or in a URL.

## Secret handling

Configure the deployment-local `TWIBOOST_API_KEY` in the Telegram MCP `.env`.
Never print it, put it in a prompt, commit it, or include it in a screenshot.
The key supplied during development was exposed in chat and must be rotated
before production use.
