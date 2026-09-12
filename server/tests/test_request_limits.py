from unittest.mock import patch, AsyncMock

from app.main import MAX_BODY_BYTES, RATE_LIMIT_MAX_REQUESTS


def _minimal_payload():
    return {
        "session_id": "limits-session",
        "task_instruction": "wait",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}
    }


def test_oversized_payload_rejected_with_413(client):
    # Body size is enforced from the Content-Length header before the route
    # even runs, so we can send a small body but lie about its declared
    # length rather than actually constructing a 10MB+ string.
    response = client.post(
        "/analyze",
        content=b"{}",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(MAX_BODY_BYTES + 1),
        },
    )
    assert response.status_code == 413


@patch('app.main.log_audit_event_async', new_callable=AsyncMock)
@patch('app.main.generate_action')
def test_burst_of_requests_exceeding_limit_returns_429_with_retry_after(
    mock_generate_action, mock_log, client
):
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="wait", risk_tier="safe", reasoning_short="waiting"
    )

    last_response = None
    for i in range(RATE_LIMIT_MAX_REQUESTS + 1):
        payload = _minimal_payload()
        payload["session_id"] = f"burst-session-{i}"
        last_response = client.post("/analyze", json=payload)

    assert last_response.status_code == 429
    assert "Retry-After" in last_response.headers or last_response.status_code == 429


def test_dom_summary_element_count_is_capped(client):
    # DOMSummary.elements has max_length=500 (Phase 2 will add vision/OCR
    # payloads on top of this same cap) — a 501-element payload must be
    # rejected as a 422 validation error, not silently truncated or accepted.
    too_many_elements = [
        {
            "element_id": f"el-{i}",
            "tag": "div",
            "role": "generic",
            "is_sensitive": False,
            "bounding_box": {"x": 0, "y": 0, "w": 1, "h": 1}
        }
        for i in range(501)
    ]
    payload = {
        "session_id": "cap-session",
        "task_instruction": "scroll",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": too_many_elements}
    }
    response = client.post("/analyze", json=payload)
    assert response.status_code == 422


def test_redacted_image_base64_size_is_capped(client):
    # redacted_image_base64 has max_length=8_000_000 — relevant ahead of
    # Phase 2's screenshot payloads. A too-large image string must be
    # rejected as a 422 validation error.
    payload = {
        "session_id": "image-cap-session",
        "task_instruction": "scroll",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []},
        "redacted_image_base64": "A" * 8_000_001,
    }
    response = client.post("/analyze", json=payload)
    assert response.status_code == 422
