#!/usr/bin/env python3
"""
Smoke tests for Internal 3DS Sandbox / Security Demo.

Run:
    python smoke_test.py

Uses Flask test_client — no server needed.
"""
import json
import sys
import os

# Ensure we import from the kit directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_TOKEN", "")
os.environ.setdefault("ADMIN_IDS", "")

from app import app

FAILURES = []


def check(condition, label):
    if not condition:
        FAILURES.append(label)
        print(f"  FAIL: {label}")
    else:
        print(f"  PASS: {label}")


def assert_no_secrets(data, path=""):
    """Recursively check that no full PAN, CVV, OTP, or secret appears in a dict/list/str."""
    key = path.rsplit(".", 1)[-1].lower()
    if isinstance(data, dict):
        for k, v in data.items():
            assert_no_secrets(v, f"{path}.{k}")
    elif isinstance(data, list):
        for i, v in enumerate(data):
            assert_no_secrets(v, f"{path}[{i}]")
    elif isinstance(data, str):
        # Ensure no raw payment card-like numbers. Technical ids/timestamps are allowed.
        if key not in {"session_id", "id", "created_at", "updated_at"}:
            digits_only = "".join(ch for ch in data if ch.isdigit())
            check(
                len(digits_only) < 14,
                f"no_long_digit_sequence_at_{path}: {data[:80]}",
            )
        check(
            "cvv" not in data.lower() or "cvv" not in path.lower(),
            f"no_cvv_at_{path}",
        )


def test_health():
    print("--- test_health ---")
    with app.test_client() as c:
        resp = c.get("/health")
        check(resp.status_code == 200, "health_200")
        j = resp.get_json()
        check(j["status"] == "ok", "health_status_ok")
        check("version" in j, "health_has_version")
        check("Internal 3DS Sandbox" in j.get("label", ""), "health_label_correct")
        assert_no_secrets(j, "health_response")
    print()


def test_create_session():
    print("--- test_create_session ---")
    with app.test_client() as c:
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "Test Shop",
                "amount": "49.99",
                "currency": "EUR",
                "test_card_alias": "test_visa_4242",
                "scenario": "medium_risk",
            },
        )
        check(resp.status_code == 201, "create_201")
        j = resp.get_json()
        check("session_id" in j, "has_session_id")
        check(len(j["session_id"]) == 32, "session_id_hex32")
        check(j["merchant"] == "Test Shop", "merchant_echo")
        check(j["card_masked"] is not None, "card_masked_present")
        check(j["three_ds_status"] == "pending_challenge", "initial_3ds_status")
        check(j["risk_score"] == 45, "risk_score_45")
        assert_no_secrets(j, "create_session_response")
        sid = j["session_id"]

        # Get session
        resp2 = c.get(f"/api/sessions/{sid}")
        check(resp2.status_code == 200, "get_session_200")
        j2 = resp2.get_json()
        check(j2["session_id"] == sid, "get_session_id_match")
        check(j2["card_masked"].endswith("4242"), "card_masked_4242")
        check(j2["card_bank"] is not None, "card_bank_present")
        assert_no_secrets(j2, "get_session_response")

        return sid
    print()


def test_challenge_approve(sid):
    print("--- test_challenge_approve ---")
    with app.test_client() as c:
        resp = c.post(
            f"/api/sessions/{sid}/challenge",
            json={"action": "approve"},
        )
        check(resp.status_code == 200, "challenge_200")
        j = resp.get_json()
        check(j["challenge_result"] == "approve", "challenge_result_approve")
        check(j["three_ds_status"] == "approved", "final_3ds_approved")
        assert_no_secrets(j, "challenge_response")

        # Verify via GET
        resp2 = c.get(f"/api/sessions/{sid}")
        j2 = resp2.get_json()
        check(j2["three_ds_status"] == "approved", "get_after_approve")
        check(j2["challenge_result"] == "approve", "get_challenge_result_approve")
    print()


def test_challenge_decline():
    print("--- test_challenge_decline ---")
    with app.test_client() as c:
        # Create session
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "Decline Test",
                "amount": "199.00",
                "currency": "USD",
                "test_card_alias": "test_mc_5555",
                "scenario": "high_risk",
            },
        )
        sid = resp.get_json()["session_id"]

        # Decline
        resp2 = c.post(
            f"/api/sessions/{sid}/challenge",
            json={"action": "decline"},
        )
        check(resp2.status_code == 200, "decline_200")
        j = resp2.get_json()
        check(j["challenge_result"] == "decline", "challenge_result_decline")
        check(j["three_ds_status"] == "declined", "final_3ds_declined")
        assert_no_secrets(j, "decline_response")

        # Verify via GET
        resp3 = c.get(f"/api/sessions/{sid}")
        j3 = resp3.get_json()
        check(j3["three_ds_status"] == "declined", "get_after_decline")
    print()


def test_blocked_scenario():
    print("--- test_blocked_scenario ---")
    with app.test_client() as c:
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "Blocked Test",
                "amount": "9999.99",
                "currency": "USD",
                "test_card_alias": "test_visa_4242",
                "scenario": "blocked",
            },
        )
        check(resp.status_code == 201, "blocked_create_201")
        j = resp.get_json()
        check(j["three_ds_status"] == "blocked", "blocked_status")

        sid = j["session_id"]
        resp2 = c.post(
            f"/api/sessions/{sid}/challenge",
            json={"action": "approve"},
        )
        check(resp2.status_code == 409, "blocked_challenge_409")
    print()


def test_frictionless_scenario():
    print("--- test_frictionless_scenario ---")
    with app.test_client() as c:
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "Frictionless Test",
                "amount": "29.99",
                "currency": "EUR",
                "test_card_alias": "test_3ds_frictionless",
                "scenario": "low_risk",
            },
        )
        check(resp.status_code == 201, "frictionless_201")
        j = resp.get_json()
        check(j["three_ds_status"] == "frictionless_success", "frictionless_status")
    print()


def test_not_enrolled():
    print("--- test_not_enrolled ---")
    with app.test_client() as c:
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "Non-3DS Test",
                "amount": "15.00",
                "currency": "USD",
                "test_card_alias": "test_3ds_not_enrolled",
                "scenario": "low_risk",
            },
        )
        check(resp.status_code == 201, "not_enrolled_201")
        j = resp.get_json()
        check(j["three_ds_status"] == "not_enrolled", "not_enrolled_status")
    print()


def test_admin_page():
    print("--- test_admin_page ---")
    with app.test_client() as c:
        resp = c.get("/admin")
        check(resp.status_code == 200, "admin_200")
        html = resp.data.decode()
        check("3DS Sandbox" in html, "admin_branding")
        check("No real data" in html, "admin_safety_label")
        # Should NOT contain raw digits that look like a PAN
        check("424242424242" not in html, "admin_no_full_pan")
        check("555555" not in html, "admin_no_full_pan_mc")
    print()


def test_invalid_inputs():
    print("--- test_invalid_inputs ---")
    with app.test_client() as c:
        # Unknown card alias
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "Bad",
                "amount": "10",
                "test_card_alias": "real_card_1234",
                "scenario": "low_risk",
            },
        )
        check(resp.status_code == 400, "bad_card_400")

        # Unknown scenario
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "Bad",
                "amount": "10",
                "test_card_alias": "test_visa_4242",
                "scenario": "nonexistent",
            },
        )
        check(resp.status_code == 400, "bad_scenario_400")

        # Bad challenge action
        resp = c.post(
            "/api/sessions",
            json={
                "merchant": "T",
                "amount": "1",
                "test_card_alias": "test_visa_4242",
                "scenario": "medium_risk",
            },
        )
        sid = resp.get_json()["session_id"]
        resp2 = c.post(
            f"/api/sessions/{sid}/challenge",
            json={"action": "bypass"},
        )
        check(resp2.status_code == 400, "bad_action_400")

        # Not found
        resp = c.get("/api/sessions/nonexistent123")
        check(resp.status_code == 404, "not_found_404")
    print()


def test_checkout_page():
    print("--- test_checkout_page ---")
    with app.test_client() as c:
        resp = c.get("/")
        check(resp.status_code == 200, "checkout_200")
        html = resp.data.decode()
        check("3DS Sandbox" in html, "checkout_branding")
        check("Internal 3DS Sandbox" in html, "checkout_label")
    print()


def main():
    print("=" * 60)
    print("Internal 3DS Sandbox — Smoke Tests")
    print("=" * 60)
    print()

    test_health()
    test_checkout_page()
    sid = test_create_session()
    test_challenge_approve(sid)
    test_challenge_decline()
    test_blocked_scenario()
    test_frictionless_scenario()
    test_not_enrolled()
    test_admin_page()
    test_invalid_inputs()

    print("=" * 60)
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} check(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    else:
        print("ALL CHECKS PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()
