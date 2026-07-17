#!/usr/bin/env python3
"""
Internal 3DS Sandbox / Security Demo
====================================
Flask application for testing 3D Secure payment flows in a safe,
self-contained environment. Uses mock data, test card aliases,
and masked fields only. No real PAN, CVV, OTP, or credentials.

Version: 2.0.0 (rewrite)
"""
__version__ = "2.0.0"

import os
import json
import time
import uuid
import hashlib
import logging
from datetime import datetime, timezone

from flask import Flask, render_template_string, request, jsonify

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("3ds-sandbox")

# ---------------------------------------------------------------------------
# Config from env
# ---------------------------------------------------------------------------
SECRET_KEY = os.environ.get("FLASK_SECRET", os.urandom(32).hex())
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
ADMIN_IDS = [
    x.strip()
    for x in os.environ.get("ADMIN_IDS", "").split(",")
    if x.strip()
]

# ---------------------------------------------------------------------------
# Known test card aliases (no real PANs)
# ---------------------------------------------------------------------------
TEST_CARDS = {
    "test_visa_4242": {
        "alias": "test_visa_4242",
        "scheme": "visa",
        "masked": "**** **** **** 4242",
        "bank": "Test Issuer Bank",
        "country": "US",
        "type": "credit",
        "three_ds": "enrolled",
    },
    "test_mc_5555": {
        "alias": "test_mc_5555",
        "scheme": "mastercard",
        "masked": "**** **** **** 4444",
        "bank": "Test Acquirer Bank",
        "country": "GB",
        "type": "credit",
        "three_ds": "enrolled",
    },
    "test_amex_3782": {
        "alias": "test_amex_3782",
        "scheme": "amex",
        "masked": "**** ****** *0005",
        "bank": "Amex Test Bank",
        "country": "US",
        "type": "charge",
        "three_ds": "enrolled",
    },
    "test_visa_debit": {
        "alias": "test_visa_debit",
        "scheme": "visa",
        "masked": "**** **** **** 0001",
        "bank": "Debit Test Bank",
        "country": "DE",
        "type": "debit",
        "three_ds": "enrolled",
    },
    "test_3ds_frictionless": {
        "alias": "test_3ds_frictionless",
        "scheme": "visa",
        "masked": "**** **** **** 1111",
        "bank": "Frictionless Bank",
        "country": "US",
        "type": "credit",
        "three_ds": "frictionless",
    },
    "test_3ds_not_enrolled": {
        "alias": "test_3ds_not_enrolled",
        "scheme": "mastercard",
        "masked": "**** **** **** 5100",
        "bank": "Non-3DS Bank",
        "country": "BR",
        "type": "credit",
        "three_ds": "not_enrolled",
    },
}

# ---------------------------------------------------------------------------
# Risk scenarios for demo
# ---------------------------------------------------------------------------
RISK_SCENARIOS = {
    "low_risk": {
        "name": "Low Risk",
        "score": 15,
        "recommendation": "frictionless",
        "flags": [],
    },
    "medium_risk": {
        "name": "Medium Risk",
        "score": 45,
        "recommendation": "challenge",
        "flags": ["new_device"],
    },
    "high_risk": {
        "name": "High Risk",
        "score": 78,
        "recommendation": "challenge",
        "flags": ["new_device", "high_amount", "unusual_location"],
    },
    "blocked": {
        "name": "Blocked",
        "score": 95,
        "recommendation": "deny",
        "flags": ["blacklisted_ip", "velocity_check_failed"],
    },
}

# ---------------------------------------------------------------------------
# In-memory store
# ---------------------------------------------------------------------------
sessions = {}
audit_log = []


def _now():
    return datetime.now(timezone.utc).isoformat()


def _audit(event, session_id, detail=""):
    entry = {
        "timestamp": _now(),
        "event": event,
        "session_id": session_id,
        "detail": detail,
    }
    audit_log.append(entry)
    logger.info("AUDIT %s | session=%s | %s", event, session_id[:12], detail)


# ---------------------------------------------------------------------------
# Safe Telegram notify (masked fields only)
# ---------------------------------------------------------------------------
def tg_notify_safe(session_id, event_label, extra=""):
    """Send masked sandbox event via Telegram. Disabled if BOT_TOKEN/ADMIN_IDS unset."""
    if not BOT_TOKEN or not ADMIN_IDS:
        return False

    sess = sessions.get(session_id)
    if not sess:
        return False

    card = sess.get("test_card_info", {})
    body = (
        f"[3DS SANDBOX] {event_label}\n"
        f"Session:  {session_id[:12]}...\n"
        f"Merchant: {sess.get('merchant', '?')}\n"
        f"Amount:   {sess.get('amount', '?')}\n"
        f"Card:     {card.get('masked', '?')}\n"
        f"Scheme:   {card.get('scheme', '?')}\n"
        f"3DS:      {sess.get('three_ds_status', '?')}\n"
        f"Risk:     {sess.get('risk_score', '?')}\n"
        f"Time:     {_now()}\n"
    )
    if extra:
        body += f"\n{extra}"

    import requests

    for aid in ADMIN_IDS:
        try:
            requests.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={
                    "chat_id": aid,
                    "text": body,
                    "disable_web_page_preview": True,
                },
                timeout=5,
            )
        except Exception:
            pass
    return True


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = SECRET_KEY

# ---------------------------------------------------------------------------
# Templates (inline — safe, no external template dependency)
# ---------------------------------------------------------------------------

CHECKOUT_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Internal 3DS Sandbox — Payment Demo</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:#f0f2f5;display:flex;align-items:center;justify-content:center;
  min-height:100vh;margin:0;padding:20px}
.card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);
  max-width:480px;width:100%;padding:32px}
.badge{display:inline-block;background:#1a73e8;color:#fff;padding:4px 10px;
  border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;
  margin-bottom:16px;letter-spacing:.5px}
h1{font-size:20px;margin:0 0 8px;color:#1a1a1a}
.sub{color:#666;font-size:14px;margin-bottom:24px}
label{display:block;font-size:13px;font-weight:600;color:#333;margin:12px 0 4px}
input,select{width:100%;padding:10px 12px;border:1px solid #d0d5dd;border-radius:8px;
  font-size:14px;font-family:inherit}
input:focus,select:focus{outline:none;border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.15)}
.row{display:flex;gap:12px}
.row>div{flex:1}
.btn{width:100%;padding:12px;background:#1a73e8;color:#fff;border:none;
  border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:20px}
.btn:hover{background:#1557b0}
.result{margin-top:20px;padding:16px;border-radius:8px;display:none;
  font-size:13px;line-height:1.6}
.result.success{background:#e6f7ed;border:1px solid #a3e4bc;color:#1a5c2a;display:block}
.result.error{background:#fde8e8;border:1px solid #f5b5b5;color:#8b1a1a;display:block}
.result.info{background:#e8f0fe;border:1px solid #a8c8fa;color:#1a3a5c;display:block}
pre{background:#f5f5f5;padding:8px;border-radius:4px;overflow-x:auto;font-size:12px}
.footer{margin-top:24px;font-size:11px;color:#999;text-align:center;
  border-top:1px solid #eee;padding-top:16px}
</style>
</head>
<body>
<div class="card">
  <span class="badge">Internal 3DS Sandbox</span>
  <h1>Payment Sandbox Demo</h1>
  <p class="sub">Create a demo payment session to test 3D Secure flow.</p>

  <form id="payment-form">
    <label for="merchant">Merchant Name</label>
    <input id="merchant" type="text" value="Demo Shop" required>

    <div class="row">
      <div>
        <label for="amount">Amount</label>
        <input id="amount" type="text" value="99.95" required>
      </div>
      <div>
        <label for="currency">Currency</label>
        <select id="currency">
          <option>USD</option><option>EUR</option><option>GBP</option>
        </select>
      </div>
    </div>

    <label for="test_card_alias">Test Card Alias</label>
    <select id="test_card_alias">
      {% for alias, info in test_cards.items() %}
      <option value="{{ alias }}">{{ info.masked }} — {{ info.scheme.upper() }} {{ info.type }} ({{ info.three_ds }})</option>
      {% endfor %}
    </select>

    <label for="scenario">Risk Scenario</label>
    <select id="scenario">
      {% for key, sc in scenarios.items() %}
      <option value="{{ key }}">{{ sc.name }} (score: {{ sc.score }}, rec: {{ sc.recommendation }})</option>
      {% endfor %}
    </select>

    <button type="submit" class="btn">Create Demo Session</button>
  </form>

  <div id="result" class="result"></div>
</div>

<div class="footer">
  Internal 3DS Sandbox / Security Demo &mdash; v{{ version }} &mdash; No real data
</div>

<script>
document.getElementById('payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = document.getElementById('result');
  result.className = 'result info';
  result.textContent = 'Creating session...';

  const body = {
    merchant: document.getElementById('merchant').value,
    amount: document.getElementById('amount').value,
    currency: document.getElementById('currency').value,
    test_card_alias: document.getElementById('test_card_alias').value,
    scenario: document.getElementById('scenario').value,
  };

  try {
    const resp = await fetch('/api/sessions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (resp.ok) {
      result.className = 'result success';
      result.innerHTML = '<strong>Session Created</strong><br>'
        + 'ID: <code>' + data.session_id + '</code><br>'
        + '3DS Status: <strong>' + data.three_ds_status + '</strong><br>'
        + 'Risk Score: ' + data.risk_score + '<br>'
        + 'Recommendation: ' + data.recommendation + '<br><br>'
        + '<a href="/admin#' + data.session_id + '">View in Admin Dashboard</a> &mdash; '
        + '<button onclick="runChallenge(\'' + data.session_id + '\',\'approve\')" '
        + 'style="font-size:13px;padding:4px 10px;cursor:pointer">Approve Challenge</button> '
        + '<button onclick="runChallenge(\'' + data.session_id + '\',\'decline\')" '
        + 'style="font-size:13px;padding:4px 10px;cursor:pointer">Decline Challenge</button>';
    } else {
      result.className = 'result error';
      result.textContent = 'Error: ' + JSON.stringify(data);
    }
  } catch(err) {
    result.className = 'result error';
    result.textContent = 'Network error: ' + err.message;
  }
});

async function runChallenge(sid, action) {
  const result = document.getElementById('result');
  try {
    const resp = await fetch('/api/sessions/' + sid + '/challenge', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: action}),
    });
    const data = await resp.json();
    result.className = 'result ' + (resp.ok ? 'success' : 'error');
    result.innerHTML = '<strong>Challenge ' + action.toUpperCase() + '</strong><br>'
      + 'Status: ' + data.three_ds_status + '<br>'
      + 'Result: <strong>' + data.challenge_result + '</strong>';
  } catch(err) {
    result.className = 'result error';
    result.textContent = 'Error: ' + err.message;
  }
}
</script>
</body>
</html>"""

ADMIN_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3DS Sandbox — Admin Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:#f0f2f5;margin:0;padding:20px;color:#1a1a1a}
h1{font-size:22px;margin:0 0 4px}h1 small{font-size:13px;color:#666;font-weight:400}
.header{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:20px;
  box-shadow:0 2px 8px rgba(0,0,0,.06)}
.stats{display:flex;gap:16px;margin-top:12px;flex-wrap:wrap}
.stat{padding:10px 16px;background:#f5f7fa;border-radius:8px;font-size:13px}
.stat strong{display:block;font-size:20px;color:#1a73e8}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;
  overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)}
th,td{padding:10px 14px;text-align:left;font-size:13px;border-bottom:1px solid #eee}
th{background:#f5f7fa;font-weight:600;color:#555;font-size:12px;text-transform:uppercase}
tr:hover{background:#fafbfc}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}
.tag-ok{background:#e6f7ed;color:#1a5c2a}
.tag-challenge{background:#fff3cd;color:#856404}
.tag-decline{background:#fde8e8;color:#8b1a1a}
.tag-block{background:#fde8e8;color:#8b1a1a}
.section{margin-bottom:28px}
.section h2{font-size:16px;margin:0 0 12px}
.audit-entry{font-size:12px;padding:4px 0;border-bottom:1px solid #f0f0f0;
  font-family:monospace;display:flex;gap:12px}
.audit-entry .ts{color:#999;white-space:nowrap}
.audit-entry .ev{font-weight:600;min-width:140px}
.audit-entry .de{color:#555}
</style>
</head>
<body>
<div class="header">
  <h1>3DS Sandbox &mdash; Admin Dashboard <small>v{{ version }}</small></h1>
  <div class="stats">
    <div class="stat"><strong>{{ stats.total }}</strong>Total Sessions</div>
    <div class="stat"><strong>{{ stats.pending }}</strong>Pending Challenge</div>
    <div class="stat"><strong>{{ stats.approved }}</strong>Approved</div>
    <div class="stat"><strong>{{ stats.declined }}</strong>Declined</div>
    <div class="stat"><strong>{{ stats.blocked }}</strong>Blocked</div>
    <div class="stat"><strong>{{ stats.frictionless }}</strong>Frictionless</div>
  </div>
</div>

<div class="section">
  <h2>Sessions</h2>
  {% if sessions %}
  <table>
    <thead><tr>
      <th>Session ID</th><th>Merchant</th><th>Amount</th><th>Card (masked)</th>
      <th>Scheme</th><th>3DS Status</th><th>Risk Score</th><th>Scenario</th><th>Created</th>
    </tr></thead>
    <tbody>
    {% for s in sessions %}
    <tr id="{{ s.id }}">
      <td><code>{{ s.id[:12] }}...</code></td>
      <td>{{ s.merchant }}</td>
      <td>{{ s.amount }}</td>
      <td>{{ s.card_masked }}</td>
      <td>{{ s.scheme }}</td>
      <td><span class="tag tag-{{ s.status_css }}">{{ s.three_ds_status }}</span></td>
      <td>{{ s.risk_score }}</td>
      <td>{{ s.scenario }}</td>
      <td>{{ s.created_at[:19] }}</td>
    </tr>
    {% endfor %}
    </tbody>
  </table>
  {% else %}
  <p style="color:#999;font-size:14px">No sessions yet. Create one from the <a href="/">checkout page</a>.</p>
  {% endif %}
</div>

<div class="section">
  <h2>Audit Log ({{ audit_count }} events)</h2>
  {% for entry in audit_entries %}
  <div class="audit-entry">
    <span class="ts">{{ entry.timestamp[:19] }}</span>
    <span class="ev">{{ entry.event }}</span>
    <span class="de">{{ entry.detail }}</span>
  </div>
  {% endfor %}
  {% if not audit_entries %}
  <p style="color:#999;font-size:14px">No audit events yet.</p>
  {% endif %}
</div>

<div style="text-align:center;padding:20px;font-size:11px;color:#999">
  Internal 3DS Sandbox / Security Demo &mdash; No real data. Mock test cards only.
</div>
</body>
</html>"""

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "version": __version__,
            "sessions": len(sessions),
            "uptime_seconds": int(time.time() - _start_time),
            "label": "Internal 3DS Sandbox / Security Demo",
        }
    )


@app.route("/")
def index():
    return render_template_string(
        CHECKOUT_PAGE,
        version=__version__,
        test_cards=TEST_CARDS,
        scenarios=RISK_SCENARIOS,
    )


@app.route("/api/sessions", methods=["POST"])
def create_session():
    """Create a demo payment session with mock data."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "invalid_json"}), 400

    merchant = (data.get("merchant") or "Unknown").strip()
    amount = (data.get("amount") or "0.00").strip()
    currency = (data.get("currency") or "USD").strip().upper()
    alias = (data.get("test_card_alias") or "test_visa_4242").strip()
    scenario_key = (data.get("scenario") or "medium_risk").strip()

    if alias not in TEST_CARDS:
        return jsonify({"error": "unknown_test_card_alias", "valid": list(TEST_CARDS.keys())}), 400
    if scenario_key not in RISK_SCENARIOS:
        return jsonify({"error": "unknown_scenario", "valid": list(RISK_SCENARIOS.keys())}), 400

    card = TEST_CARDS[alias]
    scenario = RISK_SCENARIOS[scenario_key]
    session_id = uuid.uuid4().hex

    # Determine 3DS flow
    if scenario["recommendation"] == "deny":
        three_ds_status = "blocked"
    elif card["three_ds"] == "frictionless":
        three_ds_status = "frictionless_success"
    elif card["three_ds"] == "not_enrolled":
        three_ds_status = "not_enrolled"
    else:
        three_ds_status = "pending_challenge"

    sessions[session_id] = {
        "id": session_id,
        "merchant": merchant,
        "amount": f"{float(amount):.2f} {currency}",
        "currency": currency,
        "test_card_alias": alias,
        "test_card_info": {
            "masked": card["masked"],
            "scheme": card["scheme"],
            "bank": card["bank"],
            "country": card["country"],
            "type": card["type"],
            "three_ds_enrollment": card["three_ds"],
        },
        "scenario": scenario["name"],
        "risk_score": scenario["score"],
        "risk_flags": scenario["flags"],
        "recommendation": scenario["recommendation"],
        "three_ds_status": three_ds_status,
        "challenge_result": None,
        "created_at": _now(),
    }

    _audit("session_created", session_id, f"merchant={merchant} card={alias} scenario={scenario_key} status={three_ds_status}")

    tg_notify_safe(
        session_id,
        "New 3DS Session",
        f"Status: {three_ds_status} | Scenario: {scenario['name']}",
    )

    return (
        jsonify(
            {
                "session_id": session_id,
                "merchant": merchant,
                "amount": sessions[session_id]["amount"],
                "card_masked": card["masked"],
                "card_scheme": card["scheme"],
                "three_ds_status": three_ds_status,
                "risk_score": scenario["score"],
                "risk_flags": scenario["flags"],
                "recommendation": scenario["recommendation"],
                "scenario": scenario["name"],
            }
        ),
        201,
    )


@app.route("/api/sessions/<session_id>", methods=["GET"])
def get_session(session_id):
    """Return session status with masked fields only."""
    sess = sessions.get(session_id)
    if not sess:
        return jsonify({"error": "not_found"}), 404

    return jsonify(
        {
            "session_id": sess["id"],
            "merchant": sess["merchant"],
            "amount": sess["amount"],
            "card_masked": sess["test_card_info"]["masked"],
            "card_scheme": sess["test_card_info"]["scheme"],
            "card_bank": sess["test_card_info"]["bank"],
            "card_type": sess["test_card_info"]["type"],
            "three_ds_enrollment": sess["test_card_info"]["three_ds_enrollment"],
            "three_ds_status": sess["three_ds_status"],
            "challenge_result": sess["challenge_result"],
            "risk_score": sess["risk_score"],
            "risk_flags": sess["risk_flags"],
            "recommendation": sess["recommendation"],
            "scenario": sess["scenario"],
            "created_at": sess["created_at"],
        }
    )


@app.route("/api/sessions/<session_id>/challenge", methods=["POST"])
def complete_challenge(session_id):
    """Complete a mock 3DS challenge."""
    sess = sessions.get(session_id)
    if not sess:
        return jsonify({"error": "not_found"}), 404

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "invalid_json"}), 400

    action = (data.get("action") or "").strip().lower()
    if action not in ("approve", "decline"):
        return jsonify({"error": "invalid_action", "valid": ["approve", "decline"]}), 400

    if sess["three_ds_status"] == "blocked":
        return jsonify({"error": "session_blocked", "message": "This session is blocked and cannot be challenged."}), 409

    if sess["three_ds_status"] in ("frictionless_success", "not_enrolled"):
        return (
            jsonify(
                {
                    "error": "challenge_not_needed",
                    "message": f"3DS status is '{sess['three_ds_status']}' — no challenge required.",
                }
            ),
            409,
        )

    if sess["challenge_result"] is not None:
        return (
            jsonify(
                {
                    "error": "already_completed",
                    "message": f"Challenge already completed with result: {sess['challenge_result']}",
                }
            ),
            409,
        )

    sess["challenge_result"] = action
    sess["three_ds_status"] = "approved" if action == "approve" else "declined"

    _audit("challenge_completed", session_id, f"result={action}")

    tg_notify_safe(
        session_id,
        f"3DS Challenge: {action.upper()}",
        f"Result: {sess['three_ds_status']}",
    )

    return jsonify(
        {
            "session_id": sess["id"],
            "action": action,
            "challenge_result": action,
            "three_ds_status": sess["three_ds_status"],
            "message": f"Mock 3DS challenge {action.upper()}D successfully.",
        }
    )


@app.route("/admin")
def admin_dashboard():
    """Admin dashboard listing all sessions and audit events."""
    session_list = sorted(sessions.values(), key=lambda s: s["created_at"], reverse=True)

    stats = {
        "total": len(sessions),
        "pending": sum(1 for s in sessions.values() if s["three_ds_status"] == "pending_challenge"),
        "approved": sum(1 for s in sessions.values() if s["three_ds_status"] == "approved"),
        "declined": sum(1 for s in sessions.values() if s["three_ds_status"] == "declined"),
        "blocked": sum(1 for s in sessions.values() if s["three_ds_status"] == "blocked"),
        "frictionless": sum(1 for s in sessions.values() if s["three_ds_status"] == "frictionless_success"),
    }

    rows = []
    for s in session_list:
        css_map = {
            "approved": "ok",
            "frictionless_success": "ok",
            "not_enrolled": "ok",
            "pending_challenge": "challenge",
            "declined": "decline",
            "blocked": "block",
        }
        rows.append(
            {
                "id": s["id"],
                "merchant": s["merchant"],
                "amount": s["amount"],
                "card_masked": s["test_card_info"]["masked"],
                "scheme": s["test_card_info"]["scheme"].upper(),
                "three_ds_status": s["three_ds_status"],
                "status_css": css_map.get(s["three_ds_status"], "challenge"),
                "risk_score": s["risk_score"],
                "scenario": s["scenario"],
                "created_at": s["created_at"],
            }
        )

    audit_reversed = list(reversed(audit_log[-100:]))

    return render_template_string(
        ADMIN_PAGE,
        version=__version__,
        stats=stats,
        sessions=rows,
        audit_entries=audit_reversed,
        audit_count=len(audit_log),
    )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
_start_time = time.time()

if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))

    print(f" Internal 3DS Sandbox v{__version__}")
    print(f" http://{host}:{port}/          — Checkout demo")
    print(f" http://{host}:{port}/admin     — Admin dashboard")
    print(f" http://{host}:{port}/health    — Health check")
    print(f" Telegram notify: {'ENABLED' if BOT_TOKEN and ADMIN_IDS else 'disabled'}")
    print(f" Test cards: {len(TEST_CARDS)} | Scenarios: {len(RISK_SCENARIOS)}")

    app.run(host=host, port=port, debug=False, threaded=True)
