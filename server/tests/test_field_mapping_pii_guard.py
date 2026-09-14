"""
Phase G / G.2 Row 4 (fresh verification, most scrutinized row) — does raw
PII rejection actually apply to the server-mediated field-mapping
fallback's output path (Phase C.2c), added THIS session as new surface
after value_field_violates_pii_guard was originally built?

Finding, checked by reading app/llm_client.py's generate_field_mapping()
rather than assumed: it does NOT call value_field_violates_pii_guard() at
all — and it never needs to, for a structural reason distinct from "the
guard was extended to cover it":

  1. The fallback's LLM output is a mapping of slot_id -> field-purpose
     LABEL (e.g. "username", "password"), sanitized against a small FIXED
     allowlist (`request.candidate_field_purposes`) before being returned
     — see generate_field_mapping()'s `sanitized[slot_id] = value if value
     in allowed_purposes else None`. A raw PII-shaped string (an email, a
     card number, an actual leaked value) can never be a member of that
     allowlist, so it is unconditionally nulled out regardless of shape —
     this is a strict POSITIVE allowlist, which is a strictly stronger
     guarantee against raw-value leakage than value_field_violates_pii_guard's
     negative/regex-based denylist (which only catches values matching
     specific known PII shapes).
  2. Even setting that aside: the field-mapping response is NEVER used as
     an action's `value` field. orchestrator.js's tryServerMediatedFieldMapping
     patches the retried instruction using the CLIENT'S OWN locally-held
     slot value (extractCandidateValueSlots's `slots.slotValues[slotId]`,
     which never left the browser) — not anything the LLM returned. There
     is no code path by which this fallback's LLM output could end up
     inside an executed action's value field at all.

This file adds the ONE test the existing suite (test_field_mapping.py's
test_field_mapping_sanitizes_out_of_vocabulary_response) didn't specifically
cover: a genuinely PII-SHAPED response (the same shapes
value_field_violates_pii_guard's own RAW_PII_VALUE_PATTERNS recognizes:
email, card number, phone), not just a generic nonsense string, closing
the exact gap this row calls out.
"""
from unittest.mock import AsyncMock, patch

import pytest

from app.llm_client import generate_field_mapping
from app.models import ClientPayload
from app.policy import value_field_violates_pii_guard


def _payload(instruction, slot_ids=("SLOT_1", "SLOT_2"), purposes=("username", "password", "email", "phone", "name")):
    return ClientPayload(**{
        "session_id": "g2-row4-session",
        "task_instruction": instruction,
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []},
        "field_mapping_request": {
            "slot_ids": list(slot_ids),
            "candidate_field_purposes": list(purposes),
        },
    })


def _mock_llm_response(content: str):
    mock_response = AsyncMock()
    mock_response.choices = [AsyncMock(message=AsyncMock(content=content))]
    return mock_response


RAW_PII_SHAPED_RESPONSES = [
    ("a raw email address instead of a field-purpose label", '{"SLOT_1": "attacker@example.com", "SLOT_2": "password"}', "SLOT_1"),
    ("a raw card number instead of a field-purpose label", '{"SLOT_1": "4111 1111 1111 1111", "SLOT_2": "password"}', "SLOT_1"),
    ("a raw phone number instead of a field-purpose label", '{"SLOT_1": "username", "SLOT_2": "9876543210"}', "SLOT_2"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("description,llm_content,poisoned_slot", RAW_PII_SHAPED_RESPONSES, ids=[r[0] for r in RAW_PII_SHAPED_RESPONSES])
@patch('app.llm_client.AsyncGroq')
async def test_field_mapping_nulls_out_raw_pii_shaped_response(mock_groq, monkeypatch, description, llm_content, poisoned_slot):
    """The single most important Row 4 check: even if the field-mapping
    LLM call is compromised/hallucinating and returns an ACTUAL raw
    PII-shaped value (not just a nonsense string) in place of a field-
    purpose label, the allowlist sanitization nulls it out — confirmed
    against each of the exact PII shapes value_field_violates_pii_guard
    itself recognizes (EMAIL, CARD_NUMBER, PHONE), proving parity between
    the two independent guards even though they use different mechanisms."""
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    payload = _payload("update my details using <<SLOT_1>> and <<SLOT_2>>")

    mock_client = mock_groq.return_value
    mock_client.chat.completions.create = AsyncMock(return_value=_mock_llm_response(llm_content))

    mapping = await generate_field_mapping(payload)

    assert mapping[poisoned_slot] is None, f"a raw PII-shaped response ({description}) must be sanitized to null, never passed through"
    # Sanity: the exact raw value that was supposedly returned really is
    # PII-shaped by the server's OWN independent guard's definition too —
    # proves this test is exercising a real adversarial shape, not a straw man.
    import json
    raw_returned_value = json.loads(llm_content)[poisoned_slot]
    assert value_field_violates_pii_guard(raw_returned_value) is not None, "test bug: the mocked LLM response must actually be PII-shaped per policy.py's own definition"


@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_field_mapping_response_never_reaches_value_field_violates_pii_guard_because_it_is_never_an_action(mock_groq, monkeypatch):
    """Structural confirmation of the SECOND, independent reason raw PII
    can't leak through this path: the field-mapping response is a plain
    dict, never an ActionInstruction, so value_field_violates_pii_guard
    (which only ever inspects action.value) has nothing to check here in
    the first place — confirmed by inspecting the real return type."""
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    payload = _payload("log in using <<SLOT_1>> and <<SLOT_2>>")

    mock_client = mock_groq.return_value
    mock_client.chat.completions.create = AsyncMock(return_value=_mock_llm_response('{"SLOT_1": "username", "SLOT_2": "password"}'))

    mapping = await generate_field_mapping(payload)

    assert isinstance(mapping, dict)
    assert not hasattr(mapping, "value"), "the field-mapping result must never be action-shaped"
