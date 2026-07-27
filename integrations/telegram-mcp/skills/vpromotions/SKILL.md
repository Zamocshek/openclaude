# VPromotions API Control

Use this project skill when an MCP agent needs to buy, inspect, or monitor
VPromotions services through `https://vpromotions.ru/api/v2`.

## Rules

- Read `vpromotions_config_status` first. Do not ask for the API key if
  `configured` is true.
- Use `vpromotions_services` before buying so the agent can check service id,
  type, min/max, refill support, category, and price.
- Use `vpromotions_add_order` with `confirm=false` first to preview the exact
  payload. Call it with `confirm=true` only after the human explicitly approves
  the service id, target, quantity, and expected cost.
- Use `vpromotions_order_status` after creation. For many orders, pass
  comma-separated ids through `order_ids`.
- Use `vpromotions_create_refill` only for services with refill support and
  after explicit approval.

## Add Order Payloads

- Default: `service`, `link`, `quantity`, optional `runs`, `interval`.
- Package: `service`, `link`.
- Custom Comments: `service`, `link`, `comments` separated by `\n`.
- Poll: `service`, `link`, `quantity`, `answer_number`.
- Subscriptions: `service`, `username`, `min_quantity`, `max_quantity`,
  `posts`, `delay`, optional `expiry`.

Unknown provider-specific fields can be passed through `extra_json`.
