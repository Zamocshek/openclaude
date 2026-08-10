# TwiBoost API Integration

This project integrates `https://twiboost.com/api/v2` as an MCP-managed
provider for inspecting and managing promotion service orders.

## Environment

```env
TWIBOOST_API_URL=https://twiboost.com/api/v2
TWIBOOST_API_KEY=your_api_key_here
TWIBOOST_TIMEOUT=30
```

The deployment-local `.env` is ignored by Git. Never commit a real provider
key. The key supplied during development was exposed in chat and must be
rotated before production use.

## MCP tools

- `twiboost_config_status()`
- `twiboost_balance()`
- `twiboost_services(search?, category?, service_type?, limit?)`
- `twiboost_add_order(service, link, quantity?, extra_json?, confirm?)`
- `twiboost_order_status(order_id?, order_ids?)`
- `twiboost_create_refill(order_id, confirm?)`
- `twiboost_cancel_order(order_id, confirm?)`

`twiboost_services` returns the provider fields `service`, `name`, `type`,
`category`, `rate`, `min`, `max`, `refill`, and `cancel`. Use that response as
the source of truth before preparing an order.

## CLI

```bash
telegram-mcp-twiboost config
telegram-mcp-twiboost balance
telegram-mcp-twiboost services --search Instagram --limit 10
telegram-mcp-twiboost status --order 1
telegram-mcp-twiboost status --orders 1,2,3
telegram-mcp-twiboost add --service 1 --link https://instagram.com/example --quantity 100
telegram-mcp-twiboost refill --order 1
telegram-mcp-twiboost cancel --order 1
```

The CLI also previews add, refill, and cancellation actions. Add
`--confirm` only after checking the exact preview and obtaining explicit
approval. Do not blindly retry a paid action after a network timeout; inspect
the order status first.
