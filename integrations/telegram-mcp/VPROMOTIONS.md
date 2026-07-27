# VPromotions API Integration

This project integrates `https://vpromotions.ru/api/v2` as an MCP-managed
provider for buying and monitoring promotion services.

## Environment

```env
VPROMOTIONS_API_URL=https://vpromotions.ru/api/v2
VPROMOTIONS_API_KEY=your_api_key_here
VPROMOTIONS_TIMEOUT=30
```

The local `.env` file is git-ignored. Do not commit real provider keys.

## MCP Tools

- `vpromotions_config_status()` shows API URL and masked key status.
- `vpromotions_balance()` reads balance.
- `vpromotions_services(search?, category?, service_type?, limit?)` lists services.
- `vpromotions_add_order(...)` previews or creates an order.
- `vpromotions_order_status(order_id?, order_ids?)` checks order state.
- `vpromotions_create_refill(order_id, confirm?)` requests a refill.
- `vpromotions_refill_status(refill_id)` checks refill state.

## Safety

`vpromotions_add_order` and `vpromotions_create_refill` are guarded. With the
default `confirm=false`, they return the exact payload preview and do not call
the paid provider action. Set `confirm=true` only after explicit approval.

## Order Types

Default:

```json
{
  "service": 1,
  "link": "https://t.me/channel/123",
  "quantity": 100,
  "runs": 1,
  "interval": 10
}
```

Package:

```json
{
  "service": 2,
  "link": "https://t.me/channel/123"
}
```

Custom Comments:

```json
{
  "service": 3,
  "link": "https://t.me/channel/123",
  "comments": "first comment\nsecond comment"
}
```

Poll:

```json
{
  "service": 4,
  "link": "https://t.me/channel/123",
  "quantity": 100,
  "answer_number": 2
}
```

Subscriptions:

```json
{
  "service": 5,
  "username": "channel_username",
  "min_quantity": 10,
  "max_quantity": 50,
  "posts": 5,
  "delay": 15,
  "expiry": "31/12/2026"
}
```

Provider-specific fields can be passed through `extra_json`.

## CLI

```bash
python vpromotions_client.py config
python vpromotions_client.py balance
python vpromotions_client.py services --search telegram --limit 10
python vpromotions_client.py status --order 23501
```
