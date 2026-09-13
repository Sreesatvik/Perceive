"""
Phase F / Step 4 — confirms evaluate_action_risk() already forces a phone-
number-field update to "risky" independent of the LLM's own risk_tier claim,
via the SAME existing mechanism the red-team tests exercise (target_element
.is_sensitive), rather than needing a new phone-specific rule. This is a
confirming test, not a fix: dom-heuristics.js's classifyElement() already
flags a phone field as is_sensitive=True/sensitivity_type=PHONE, and
policy.py's evaluate_action_risk() already checks target_element.is_sensitive
BEFORE ever consulting action.risk_tier (see policy.py's first branch) — so
no server-side change was needed for this scenario. Proven here rather than
assumed by stubbing the exact case the prompt describes: an LLM-returned
action explicitly claiming risk_tier="safe" against a real phone-number
target_element.
"""
from app.policy import evaluate_action_risk


def test_phone_number_update_forced_risky_even_when_llm_claims_safe():
    target_element = {
        "label_text": "Phone Number",
        "is_sensitive": True,
        "sensitivity_type": "PHONE",
    }
    action = {
        "type": "type",
        "target_element_id": "phone-field",
        "value": "[PHONE_a1b2c3]",
        "reasoning_short": "Updating the phone number as requested",
        "risk_tier": "safe",  # the LLM's own claim — must be overridden
    }
    assert evaluate_action_risk(action, target_element) == "risky"


def test_phone_number_update_forced_risky_even_with_no_risk_tier_claim_at_all():
    """Same override, but for the fail-closed default path (no risk_tier
    key at all) — the is_sensitive check must short-circuit before that
    default is ever reached."""
    target_element = {"label_text": "Phone Number", "is_sensitive": True, "sensitivity_type": "PHONE"}
    action = {"type": "type", "target_element_id": "phone-field", "value": "[PHONE_a1b2c3]"}
    assert evaluate_action_risk(action, target_element) == "risky"


def test_control_a_non_sensitive_field_update_is_not_force_risky():
    """Proves the phone-field override above is a real signal (driven by
    is_sensitive), not just evaluate_action_risk() always returning risky
    for every 'type' action."""
    target_element = {"label_text": "Favorite Color", "is_sensitive": False, "sensitivity_type": "UNKNOWN"}
    action = {"type": "type", "target_element_id": "color-field", "value": "blue", "risk_tier": "safe"}
    assert evaluate_action_risk(action, target_element) == "safe"
