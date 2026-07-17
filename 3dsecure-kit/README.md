# Internal 3DS Sandbox / Security Demo

Version 2.0.0

Flask application for testing 3D Secure payment flows in a safe, self-contained
environment. Uses **mock data, test card aliases, and masked fields only**.

**No real PAN, CVV, OTP, or credentials are ever stored or transmitted.**

## Quick Start

### Local

```bash
cd 3dsecure-kit
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000 for the checkout demo and
http://localhost:5000/admin for the admin dashboard.

### Docker

```bash
docker compose up -d
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/` | Checkout demo page |
| `POST` | `/api/sessions` | Create a demo payment session |
| `GET` | `/api/sessions/<id>` | Get session status (masked fields) |
| `POST` | `/api/sessions/<id>/challenge` | Complete mock 3DS challenge |
| `GET` | `/admin` | Admin dashboard (sessions + audit log) |

## API Examples

### Create a Session

```bash
curl -s -X POST http://localhost:5000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "merchant": "Demo Shop",
    "amount": "99.95",
    "currency": "USD",
    "test_card_alias": "test_visa_4242",
    "scenario": "medium_risk"
  }'
```

Response:
```json
{
  "session_id": "a1b2c3d4e5f6...",
  "merchant": "Demo Shop",
  "amount": "99.95 USD",
  "card_masked": "424242******4242",
  "card_scheme": "visa",
  "three_ds_status": "pending_challenge",
  "risk_score": 45,
  "recommendation": "challenge"
}
```

### Complete 3DS Challenge

```bash
curl -s -X POST http://localhost:5000/api/sessions/{id}/challenge \
  -H 'Content-Type: application/json' \
  -d '{"action": "approve"}'
```

### Get Session Status

```bash
curl -s http://localhost:5000/api/sessions/{id}
```

## Test Card Aliases

| Alias | Scheme | Masked | 3DS Enrollment |
|-------|--------|--------|----------------|
| `test_visa_4242` | Visa | 424242******4242 | enrolled |
| `test_mc_5555` | Mastercard | **** **** **** 4444 | enrolled |
| `test_amex_3782` | Amex | 378282*****0005 | enrolled |
| `test_visa_debit` | Visa Debit | 400005******0001 | enrolled |
| `test_3ds_frictionless` | Visa | 411111******1111 | frictionless |
| `test_3ds_not_enrolled` | Mastercard | 510510******5100 | not_enrolled |

## Risk Scenarios

| Scenario | Score | Recommendation | Flags |
|----------|-------|----------------|-------|
| `low_risk` | 15 | frictionless | none |
| `medium_risk` | 45 | challenge | new_device |
| `high_risk` | 78 | challenge | new_device, high_amount, unusual_location |
| `blocked` | 95 | deny | blacklisted_ip, velocity_check_failed |

## Test Scenarios

1. **Frictionless flow** — `low_risk` + `test_3ds_frictionless` → no challenge needed
2. **Standard challenge** — `medium_risk` + any enrolled card → challenge → approve
3. **Declined challenge** — `high_risk` + any enrolled card → challenge → decline
4. **Hard block** — `blocked` → session blocked, no challenge possible
5. **Non-3DS card** — `low_risk` + `test_3ds_not_enrolled` → flows through without 3DS

## Run Smoke Tests

```bash
python smoke_test.py
```

## Optional Telegram Integration

Set `BOT_TOKEN` and `ADMIN_IDS` in `.env` to receive sandbox event notifications
in Telegram. Notifications contain **masked fields only** (no full PAN, CVV, or OTP).
If these env vars are absent, Telegram integration is disabled entirely.

## Safety Boundaries

- **No real PAN/CVV/OTP** — only test card aliases with masked representation
- **No credential storage** — session data is in-memory only, never persisted
- **No SMS or OTP collection** — challenges are mock approve/decline actions
- **No email templates or phishing pages** — old CRM/demo-crm-attack directory is unused
- **No external API calls** — BIN lookup, IP geolocation, and similar are removed
- **Telegram messages are masked** — only session ID, merchant, amount, test card alias,
  risk score, and 3DS status
- **Clear labeling** — every page shows "Internal 3DS Sandbox / Security Demo"

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `HOST` | `0.0.0.0` | Flask bind address |
| `PORT` | `5000` | Flask port |
| `FLASK_SECRET` | random | Session secret key |
| `BOT_TOKEN` | (none) | Telegram bot token (optional) |
| `ADMIN_IDS` | (none) | Comma-separated Telegram chat IDs (optional) |

## Directory Structure

```
3dsecure-kit/
├── app.py                   # Flask sandbox app (safe, no capture/intercept)
├── config.py                # Configuration module
├── smoke_test.py            # Automated smoke tests
├── Dockerfile               # Docker build
├── docker-compose.yml       # Docker orchestration
├── .env.example             # Environment template
├── requirements.txt         # Python dependencies
├── templates/               # Old theme templates (unused by sandbox)
├── demo-crm-attack/         # Old CRM directory (unused by sandbox)
└── scripts/                 # Deployment scripts
```
