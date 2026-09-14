"""
Phase G / G.2 Row 6 — two concurrent sessions, no cross-session token or
state leakage. Genuinely uncovered before this: test_session.py only tests
a single session in isolation; nothing exercised two sessions interleaved.

Two independent things verified here:
  1. session.py's per-session isolation: session A's step_number/history/lock
     is never affected by interleaved calls to session B, and vice versa —
     via real, interleaved (not literally simultaneous, but out-of-order)
     /analyze calls through the real endpoint.
  2. logger.py's audit chain is GLOBAL, not per-session (documented in
     logger.py itself) — confirmed here as a real, committed test (this was
     previously only spot-checked ad hoc against a real 2-entry chain
     earlier this session, never as a permanent regression test): entries
     from two interleaved sessions still form ONE valid, unbroken hash
     chain end to end when verify_audit_chain() runs over the whole file.
"""
from unittest.mock import AsyncMock, patch

from app import logger as logger_module
from app.logger import verify_audit_chain, GENESIS_HASH
from app.models import ActionInstruction
from app.session import get_or_create_session, clear_session, get_session_lock


def _safe_action(reasoning):
    return ActionInstruction(type="wait", risk_tier="safe", reasoning_short=reasoning)


def _read_entries(path):
    import json
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


@patch('app.main.generate_action')
def test_two_interleaved_sessions_never_cross_contaminate_step_numbers_or_history(mock_generate_action, client, tmp_path, monkeypatch):
    log_path = tmp_path / "concurrent_sessions_audit.jsonl"
    monkeypatch.setattr(logger_module, "LOG_FILE", str(log_path))
    monkeypatch.setattr(logger_module, "_last_entry_hash", GENESIS_HASH)

    session_a = "concurrent-session-A"
    session_b = "concurrent-session-B"
    clear_session(session_a)
    clear_session(session_b)

    def payload_for(session_id, step_number):
        return {
            "session_id": session_id,
            "task_instruction": f"step {step_number} for {session_id}",
            "step_number": step_number,
            "dom_summary": {"url": "http://test.com", "elements": []},
        }

    # Deliberately interleaved order: A1, B1, A2, B2, A3 — never in strict
    # per-session sequence, to actually exercise cross-session interleaving
    # rather than two back-to-back-but-separate blocks.
    mock_generate_action.return_value = _safe_action("A step 1")
    resp_a1 = client.post("/analyze", json=payload_for(session_a, 1))
    assert resp_a1.status_code == 200
    assert resp_a1.json()["step_number"] == 2, "session A must advance to step 2 after its own first step"

    mock_generate_action.return_value = _safe_action("B step 1")
    resp_b1 = client.post("/analyze", json=payload_for(session_b, 1))
    assert resp_b1.status_code == 200
    assert resp_b1.json()["step_number"] == 2, "session B's step counter must start fresh at 2, NOT continue from session A's progress"

    mock_generate_action.return_value = _safe_action("A step 2")
    resp_a2 = client.post("/analyze", json=payload_for(session_a, 2))
    assert resp_a2.status_code == 200
    assert resp_a2.json()["step_number"] == 3

    mock_generate_action.return_value = _safe_action("B step 2")
    resp_b2 = client.post("/analyze", json=payload_for(session_b, 2))
    assert resp_b2.status_code == 200
    assert resp_b2.json()["step_number"] == 3

    mock_generate_action.return_value = _safe_action("A step 3")
    resp_a3 = client.post("/analyze", json=payload_for(session_a, 3))
    assert resp_a3.status_code == 200
    assert resp_a3.json()["step_number"] == 4

    # Cross-session state check: each session's real server-side History
    # object contains ONLY its own steps/instructions, never the other's.
    real_session_a = get_or_create_session(session_a)
    real_session_b = get_or_create_session(session_b)

    assert real_session_a.last_step == 3
    assert real_session_b.last_step == 2
    assert len(real_session_a.history) == 3
    assert len(real_session_b.history) == 2
    assert all("for concurrent-session-A" in step["instruction"] for step in real_session_a.history), "session A's history must never contain session B's instructions"
    assert all("for concurrent-session-B" in step["instruction"] for step in real_session_b.history), "session B's history must never contain session A's instructions"

    # Lock isolation: the two sessions must hold DIFFERENT lock objects, so
    # a request in flight for one can never block or be blocked by the other.
    import asyncio
    lock_a = asyncio.run(get_session_lock(session_a))
    lock_b = asyncio.run(get_session_lock(session_b))
    assert lock_a is not lock_b

    # Audit-chain check: each successful /analyze call logs 7 granular
    # pipeline events (Phase D.2: PIPELINE_START, CAPTURE_COMPLETE,
    # DOM_FINDINGS, VISION_FINDINGS, LLM_RESPONSE, POLICY_DECISION, then the
    # final action-decision entry) — 5 interleaved steps (A1,B1,A2,B2,A3)
    # means 35 entries total, all appended to the SAME global log file, in
    # that write order. The chain must verify clean end to end regardless
    # of the session_id interleaving — this is the committed version of the
    # ad hoc spot-check done earlier this session.
    entries = _read_entries(log_path)
    ENTRIES_PER_STEP = 7
    assert len(entries) == 5 * ENTRIES_PER_STEP

    # The 7 entries for each step all share that step's session_id, and the
    # 5 step-blocks appear in exactly the interleaved order the calls were
    # made in (A,B,A,B,A) — proving entries from the two sessions are truly
    # interleaved in the global file, not merely both present somewhere.
    expected_session_order = [session_a, session_b, session_a, session_b, session_a]
    actual_session_blocks = [entries[i]["session_id"] for i in range(0, len(entries), ENTRIES_PER_STEP)]
    assert actual_session_blocks == expected_session_order
    for i, entry in enumerate(entries):
        expected_session = expected_session_order[i // ENTRIES_PER_STEP]
        assert entry["session_id"] == expected_session, f"entry {i} has the wrong session_id — a real cross-session leak in the audit log"

    ok, broken_index = verify_audit_chain(entries)
    assert ok is True, f"interleaved multi-session audit chain must verify clean; broke at index {broken_index}"
    assert broken_index is None

    clear_session(session_a)
    clear_session(session_b)
