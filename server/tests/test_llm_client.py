import pytest
import os
from unittest.mock import AsyncMock, patch
from pydantic import ValidationError
from app.llm_client import generate_action
from app.models import ClientPayload, DOMSummary, ActionInstruction

@pytest.fixture
def mock_payload():
    return ClientPayload(
        session_id="test-session-3",
        task_instruction="Do something",
        step_number=1,
        dom_summary=DOMSummary(url="http://test.com", elements=[])
    )

@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_generate_action_success(mock_groq, mock_payload, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "wait", "risk_tier": "safe", "reasoning_short": "wait"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    
    action = await generate_action(mock_payload)
    assert action.type == "wait"
    assert action.risk_tier == "safe"


@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_prompt_omits_execution_feedback_when_no_prior_error(mock_groq, mock_payload, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "wait", "risk_tier": "safe", "reasoning_short": "wait"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

    await generate_action(mock_payload)

    user_message = mock_client.chat.completions.create.call_args.kwargs["messages"][1]["content"]
    assert "EXECUTION FEEDBACK" not in user_message


@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_prompt_includes_execution_feedback_when_previous_action_failed(mock_groq, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    payload = ClientPayload(
        session_id="test-session-retry",
        task_instruction="log in",
        step_number=2,
        dom_summary=DOMSummary(url="http://test.com", elements=[]),
        last_action_error="Previous action (click on login-submit) failed to execute: target_element_not_found",
    )
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "wait", "risk_tier": "safe", "reasoning_short": "wait"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

    await generate_action(payload)

    user_message = mock_client.chat.completions.create.call_args.kwargs["messages"][1]["content"]
    assert "EXECUTION FEEDBACK" in user_message
    assert "target_element_not_found" in user_message


@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_system_prompt_clarifies_instruction_tokens_are_valid_even_when_dom_token_is_null(mock_groq, mock_payload, monkeypatch):
    """Regression test for a real bug found in live testing: given a login
    task like "login with username [NAME_x] and password [PASSWORD_y]"
    against empty (semantic_token: null) username/password fields, the LLM
    repeatedly refused with reasoning like "no semantic token provided" —
    it was checking the DOM element's OWN semantic_token instead of the
    token already present in the trusted task instruction text. The system
    prompt must explicitly clarify that an empty field's null semantic_token
    does not mean no safe value exists; the real value is the bracketed
    token in the instruction itself."""
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "wait", "risk_tier": "safe", "reasoning_short": "wait"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

    await generate_action(mock_payload)

    system_message = mock_client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    assert "semantic_token" in system_message and "null" in system_message
    assert "TASK INSTRUCTION" in system_message.upper() or "task instruction" in system_message.lower()

@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_generate_action_validation_error(mock_groq, mock_payload, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    # Invalid JSON schema: missing risk_tier and reasoning_short
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "wait"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    
    with pytest.raises(ValidationError):
        await generate_action(mock_payload)

@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_generate_action_offline_fallback(mock_groq, mock_payload, monkeypatch):
    # Simulate environment swap to offline
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    monkeypatch.setenv("OFFLINE_API_BASE", "http://localhost:11434/v1")
    
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "scroll", "risk_tier": "safe", "reasoning_short": "reading"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    
    action = await generate_action(mock_payload)
    assert action.type == "scroll"
    
    # Check that client was created with the offline base_url instead of groq's default
    mock_groq.assert_called_with(api_key="offline-local", base_url="http://localhost:11434/v1")
