import re

DANGEROUS_KEYWORDS = [
    "pay", "purchase", "delete", "remove", "confirm",
    "submit", "transfer", "send", "checkout", "buy"
]

# Ported from dev2/pii-patterns.js so the server enforces the same raw-PII
# shapes the client is supposed to have already tokenized. This is the
# concrete defense against "the LLM echoes or hallucinates a raw-looking
# value instead of a token" (Phase 1.4) — independent of and in addition to
# the client-side leakage auditor, since the LLM's output is never trusted.
VALID_TOKEN_PATTERN = re.compile(r'^\[[A-Za-z0-9_]+\]$')

RAW_PII_VALUE_PATTERNS = {
    "EMAIL": re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'),
    "PHONE": re.compile(r'(?<!\d)[6-9]\d{9}(?!\d)'),
    "CARD_NUMBER": re.compile(r'(?<!\d)(?:\d[ -]?){15}\d(?!\d)'),
    "AADHAAR": re.compile(r'(?<!\d)(?:\d[ -]?){11}\d(?!\d)'),
    "IFSC": re.compile(r'\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b'),
}


def value_field_violates_pii_guard(value: str | None) -> str | None:
    """Returns the matched PII type name if `value` looks like a raw,
    non-tokenized sensitive value; returns None if `value` is safe
    (either a valid token-bracket form, or plain non-PII text)."""
    if not value:
        return None
    if VALID_TOKEN_PATTERN.match(value):
        return None
    for pii_type, pattern in RAW_PII_VALUE_PATTERNS.items():
        if pattern.search(value):
            return pii_type
    return None

def evaluate_action_risk(action: dict, target_element: dict | None) -> str:
    """Returns 'safe' or 'risky'. Independent of LLM-supplied risk_tier."""
    if target_element and target_element.get("is_sensitive"):
        return "risky"
    if action.get("type") == "click":
        text = f"{target_element.get('label_text', '') if target_element else ''} {action.get('reasoning_short', '')}".lower()
        if any(kw in text for kw in DANGEROUS_KEYWORDS):
            return "risky"
    if action.get("type") in ("task_complete", "task_failed"):
        return "safe"
    return action.get("risk_tier", "risky") if action.get("risk_tier") in ("safe", "risky") else "risky"
