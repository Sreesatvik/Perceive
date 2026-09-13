import pytest
from unittest.mock import patch, AsyncMock


def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@patch('app.main.generate_action')
@patch('app.main.log_audit_event_async', new_callable=AsyncMock)
def test_analyze_endpoint_success(mock_log, mock_generate_action, client):
    # Mock the LLM generating a valid action
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="click",
        target_element_id="btn-submit",
        risk_tier="safe",
        reasoning_short="Submitting form"
    )

    payload = {
        "session_id": "api-session-1",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {
            "url": "http://test.com",
            "elements": [
                {
                    "element_id": "btn-submit",
                    "tag": "button",
                    "role": "button",
                    "is_sensitive": False,
                    "bounding_box": {"x": 10, "y": 10, "w": 100, "h": 50}
                }
            ]
        }
    }

    response = client.post("/analyze", json=payload)
    assert response.status_code == 200

    data = response.json()
    assert data["session_id"] == "api-session-1"
    assert data["step_number"] == 2
    assert data["action"]["type"] == "click"
    assert data["action"]["target_element_id"] == "btn-submit"

    # Phase D.2: the audit log now records the full pipeline (PIPELINE_START,
    # CAPTURE_COMPLETE, DOM_FINDINGS, VISION_FINDINGS up front, then
    # LLM_RESPONSE, POLICY_DECISION, and the final action decision) rather
    # than a single call per request — check it was called multiple times
    # and that the granular events are actually present, not just count.
    assert mock_log.await_count >= 6
    event_types = [c.kwargs["action"].get("event_type") for c in mock_log.await_args_list]
    assert "PIPELINE_START" in event_types
    assert "DOM_FINDINGS" in event_types
    assert "LLM_RESPONSE" in event_types
    assert "POLICY_DECISION" in event_types


@patch('app.main.generate_action')
def test_analyze_endpoint_validation_error(mock_generate_action, client):
    # Mock the LLM raising an exception after max retries
    class FakeError(ValueError):
        pass

    mock_generate_action.side_effect = FakeError("Mocked failure")

    payload = {
        "session_id": "api-session-2",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}
    }

    response = client.post("/analyze", json=payload)
    assert response.status_code == 500
    assert "Mocked failure" in response.json()["detail"]
    assert mock_generate_action.call_count == 3  # MAX_RETRIES


@patch('app.main.log_audit_event_async', new_callable=AsyncMock)
@patch('app.main.generate_action')
def test_analyze_endpoint_rate_limit(mock_generate_action, mock_log, client):
    from groq import RateLimitError
    import httpx

    mock_generate_action.side_effect = RateLimitError(
        message="Rate limit exceeded",
        response=httpx.Response(status_code=429, request=httpx.Request("POST", "http://test")),
        body={"error": {"message": "rate limit"}}
    )

    payload = {
        "session_id": "api-session-rate",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}
    }

    response = client.post("/analyze", json=payload)
    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "5"
    assert mock_generate_action.call_count == 1  # Does not retry blindly
    # Phase D.2: the 4 unconditional pipeline-start events are logged before
    # generate_action is even called, plus the final rate-limit error event.
    assert mock_log.await_count >= 5
    event_types = [c.kwargs["action"].get("event_type") for c in mock_log.await_args_list]
    assert "PIPELINE_START" in event_types


@patch('app.main.log_audit_event_async', new_callable=AsyncMock)
def test_analyze_endpoint_session_continuity_fail(mock_log, client):
    payload = {
        "session_id": "api-session-fresh",
        "task_instruction": "submit form",
        "step_number": 3,  # > 1 but no history
        "dom_summary": {"url": "http://test.com", "elements": []}
    }

    response = client.post("/analyze", json=payload)
    assert response.status_code == 400
    assert "no session history found" in response.json()["detail"]
    # Phase D.2: the 4 unconditional pipeline-start events are logged before
    # the session-continuity check runs, plus the continuity-error event.
    assert mock_log.await_count >= 5
    event_types = [c.kwargs["action"].get("event_type") for c in mock_log.await_args_list]
    assert "PIPELINE_START" in event_types


@patch('app.main.generate_action')
@patch('app.main.log_audit_event_async', new_callable=AsyncMock)
def test_analyze_endpoint_session_continuity_retry_valid(mock_log, mock_generate_action, client):
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="wait", risk_tier="safe", reasoning_short="waiting"
    )

    # First request works
    payload = {
        "session_id": "api-session-retry",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}
    }
    response = client.post("/analyze", json=payload)
    assert response.status_code == 200

    # Client retries step 2 because the frontend failed to execute it
    payload["step_number"] = 2
    response2 = client.post("/analyze", json=payload)
    assert response2.status_code == 200  # Should succeed since session.history is populated


@patch('app.main.generate_action')
@patch('app.main.log_audit_event_async', new_callable=AsyncMock)
def test_analyze_endpoint_risk_tier_enforcement(mock_log, mock_generate_action, client):
    from app.models import ActionInstruction
    # LLM incorrectly marks action on sensitive field as 'safe'
    mock_generate_action.return_value = ActionInstruction(
        type="type",
        target_element_id="input-password",
        value="something",
        risk_tier="safe",
        reasoning_short="Typing into field"
    )

    payload = {
        "session_id": "api-session-risk",
        "task_instruction": "type password",
        "step_number": 1,
        "dom_summary": {
            "url": "http://test.com",
            "elements": [
                {
                    "element_id": "input-password",
                    "tag": "input",
                    "role": "textbox",
                    "is_sensitive": True,  # Server should enforce risky
                    "sensitivity_tier": 1,
                    "sensitivity_type": "PASSWORD",
                    "semantic_token": "[PASSWORD]",
                    "bounding_box": {"x": 10, "y": 10, "w": 100, "h": 50}
                }
            ]
        }
    }

    response = client.post("/analyze", json=payload)
    assert response.status_code == 200
    assert response.json()["action"]["risk_tier"] == "risky"


@patch('app.main.generate_action')
def test_analyze_endpoint_hallucinated_target(mock_generate_action, client):
    from app.models import ActionInstruction
    # LLM returns a target_element_id that is not in the DOM summary
    mock_generate_action.return_value = ActionInstruction(
        type="click",
        target_element_id="fake-id",
        risk_tier="safe",
        reasoning_short="Clicking fake"
    )

    payload = {
        "session_id": "api-session-hallucinate",
        "task_instruction": "click fake",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}  # Empty elements
    }

    response = client.post("/analyze", json=payload)
    # The server should catch the ValueError, retry 3 times, and fail with 500
    assert response.status_code == 500
    assert "fake-id" in response.json()["detail"]
    assert mock_generate_action.call_count == 3


@pytest.mark.parametrize("status_path", ["success", "400", "429", "500"])
@patch('app.main.log_audit_event_async', new_callable=AsyncMock)
@patch('app.main.generate_action')
def test_analyze_endpoint_audit_log_records_pipeline_start_on_every_path(
    mock_generate_action, mock_log, client, status_path
):
    """Locks in the 'no dark spots in the audit trail' guarantee: every
    /analyze code path (success, session-continuity 400, provider 429,
    unexpected 500) must await the audit logger at least once, and the
    very first thing logged is always PIPELINE_START (Phase D.2: this now
    fires unconditionally before ANY other processing, including the
    session-continuity check, so there is truly no code path that reaches
    /analyze and leaves zero trace)."""
    from app.models import ActionInstruction
    from groq import RateLimitError
    import httpx

    session_id = f"api-session-audit-{status_path}"

    if status_path == "success":
        mock_generate_action.return_value = ActionInstruction(
            type="wait", risk_tier="safe", reasoning_short="waiting"
        )
        payload = {
            "session_id": session_id,
            "task_instruction": "wait",
            "step_number": 1,
            "dom_summary": {"url": "http://test.com", "elements": []}
        }
    elif status_path == "400":
        payload = {
            "session_id": session_id,
            "task_instruction": "submit form",
            "step_number": 3,  # no prior history -> continuity break
            "dom_summary": {"url": "http://test.com", "elements": []}
        }
    elif status_path == "429":
        mock_generate_action.side_effect = RateLimitError(
            message="Rate limit exceeded",
            response=httpx.Response(status_code=429, request=httpx.Request("POST", "http://test")),
            body={"error": {"message": "rate limit"}}
        )
        payload = {
            "session_id": session_id,
            "task_instruction": "submit form",
            "step_number": 1,
            "dom_summary": {"url": "http://test.com", "elements": []}
        }
    else:  # 500
        mock_generate_action.side_effect = Exception("boom")
        payload = {
            "session_id": session_id,
            "task_instruction": "submit form",
            "step_number": 1,
            "dom_summary": {"url": "http://test.com", "elements": []}
        }

    client.post("/analyze", json=payload)
    assert mock_log.await_count >= 1
    first_call_action = mock_log.await_args_list[0].kwargs["action"]
    assert first_call_action.get("event_type") == "PIPELINE_START"
