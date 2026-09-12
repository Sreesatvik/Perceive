from unittest.mock import patch, AsyncMock

from app.policy import value_field_violates_pii_guard


# --- Unit tests for the pure guard function (policy.py) ---

def test_valid_token_form_passes():
    assert value_field_violates_pii_guard("[PASSWORD_a83f]") is None


def test_raw_phone_shape_rejected():
    assert value_field_violates_pii_guard("9876543210") == "PHONE"


def test_raw_card_shape_rejected():
    assert value_field_violates_pii_guard("4111111111111111") == "CARD_NUMBER"


def test_ordinary_non_pii_text_passes():
    assert value_field_violates_pii_guard("click here") is None


def test_empty_or_none_value_passes():
    assert value_field_violates_pii_guard(None) is None
    assert value_field_violates_pii_guard("") is None


def test_raw_email_shape_rejected():
    assert value_field_violates_pii_guard("someone@example.com") == "EMAIL"


# --- Integration tests through /analyze (main.py wiring + 422 status code) ---

def _payload(value, session_id="policy-guard-session"):
    return {
        "session_id": session_id,
        "task_instruction": "type into field",
        "step_number": 1,
        "dom_summary": {
            "url": "http://test.com",
            "elements": [
                {
                    "element_id": "input-1",
                    "tag": "input",
                    "role": "textbox",
                    "is_sensitive": False,
                    "bounding_box": {"x": 10, "y": 10, "w": 100, "h": 50}
                }
            ]
        }
    }


@patch('app.main.generate_action')
def test_analyze_rejects_raw_card_number_value_with_422(mock_generate_action, client):
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="type",
        target_element_id="input-1",
        value="4111111111111111",
        risk_tier="safe",
        reasoning_short="typing card number directly"
    )
    response = client.post("/analyze", json=_payload("4111111111111111", "policy-guard-session-1"))
    assert response.status_code == 422
    assert "CARD_NUMBER" in response.json()["detail"]


@patch('app.main.generate_action')
def test_analyze_allows_valid_token_value(mock_generate_action, client):
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="type",
        target_element_id="input-1",
        value="[CARD_NUMBER_a83f]",
        risk_tier="safe",
        reasoning_short="typing tokenized value"
    )
    response = client.post("/analyze", json=_payload("[CARD_NUMBER_a83f]", "policy-guard-session-2"))
    assert response.status_code == 200


@patch('app.main.generate_action')
def test_analyze_allows_ordinary_non_pii_type_value(mock_generate_action, client):
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="type",
        target_element_id="input-1",
        value="hello world",
        risk_tier="safe",
        reasoning_short="typing search text"
    )
    response = client.post("/analyze", json=_payload("hello world", "policy-guard-session-3"))
    assert response.status_code == 200
