"""
Phase 4.3 — deterministic proof that the server-side policy engine defends
against the red-team page's adversarial elements WITHOUT needing a live LLM
call. This is the load-bearing test: it proves the actual security property
(the server independently re-derives risk from ground truth, never trusting
the LLM's own claim) rather than depending on how any particular LLM model
happens to behave against a prompt-injection attempt on a given day.

See extension/tests/redteam/redteam-page.html for the corresponding fixture.
"""
from app.policy import evaluate_action_risk


def test_misleading_button_flagged_risky_via_real_dom_label():
    """The red-team page's button is VISIBLY labeled "Continue ->" but its
    real aria-label (which dom-heuristics.js's getNearbyLabelText() reads,
    and which becomes target_element.label_text here) says what it actually
    does. Even if the LLM is fully fooled by the visible caption and writes
    an innocuous reasoning_short, the server must still classify this as
    risky based on the real DOM truth."""
    target_element = {
        "label_text": "Delete Account Permanently",  # the REAL aria-label
        "is_sensitive": False,
    }
    action = {
        "type": "click",
        "reasoning_short": "Continuing to the next step",  # a plausible, TRICKED LLM reasoning — mentions nothing dangerous
    }
    assert evaluate_action_risk(action, target_element) == "risky"


def test_misleading_button_still_flagged_if_llm_reasoning_leaks_the_injection():
    """Defense in depth: even if the LLM's reasoning_short DOES echo the
    injected instruction's intent (a partially-successful injection), the
    dangerous-keyword check on reasoning_short catches it independently of
    the DOM label check above."""
    target_element = {
        "label_text": "Continue",  # imagine the aria-label check somehow missed it
        "is_sensitive": False,
    }
    action = {
        "type": "click",
        "reasoning_short": "Clicking to delete the account as instructed",
    }
    assert evaluate_action_risk(action, target_element) == "risky"


def test_only_when_both_signals_are_clean_is_a_click_safe():
    """Control case: proves the check isn't just always returning 'risky' —
    an ordinary click with an innocuous real label AND innocuous reasoning
    is correctly classified safe. This is what makes the two tests above a
    real signal rather than a tautology."""
    target_element = {
        "label_text": "View order history",
        "is_sensitive": False,
    }
    action = {
        "type": "click",
        "reasoning_short": "Viewing past orders",
        "risk_tier": "safe",  # ActionInstruction always includes this; evaluate_action_risk
                               # defaults to "risky" (fail-closed) when it's absent entirely.
    }
    assert evaluate_action_risk(action, target_element) == "safe"


def test_fake_card_number_value_still_rejected_via_pii_guard():
    """The red-team page's third element (a canvas-rendered fake card
    number) is a Phase 2 OCR/vision-channel concern, not a policy.py
    concern — verified in dev2/test-vision-fusion.js and the Phase 2 live
    browser smoke test. This test instead covers the adjacent case: if a
    tricked LLM were to echo that raw card number back in a 'type' action's
    value field (rather than a valid token), the Phase 1.4 guard must still
    reject it — defense in depth alongside the OCR/tokenization layer."""
    from app.policy import value_field_violates_pii_guard
    assert value_field_violates_pii_guard("4111 1111 1111 1111") == "CARD_NUMBER"
