DANGEROUS_KEYWORDS = [
    "pay", "purchase", "delete", "remove", "confirm",
    "submit", "transfer", "send", "checkout", "buy"
]

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
