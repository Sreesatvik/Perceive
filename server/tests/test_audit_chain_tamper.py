"""
Phase D.2 / Step 6 — real, permanent regression test for tamper detection
on the hash-chained audit log.

Writes several REAL audit entries through the actual logger (not
hand-built dicts), verifies the chain checker (verify_audit_chain, and the
standalone server/app/verify_audit_chain.py CLI tool built on top of it)
reports it clean, then physically mutates one historical entry's content on
disk and re-verifies the checker reports a break starting AT THAT SPECIFIC
ENTRY — not merely "a break exists somewhere".
"""
import json
import subprocess
import sys

import pytest

from app import logger as logger_module
from app.logger import log_audit_event, verify_audit_chain, GENESIS_HASH


@pytest.fixture
def isolated_audit_log(tmp_path, monkeypatch):
    """Points the logger at a fresh temp file and resets its in-process
    chain-tip state, so this test's chain starts from a real genesis and
    is never polluted by entries any other test wrote in the same process."""
    log_path = tmp_path / "audit_tamper_test.jsonl"
    monkeypatch.setattr(logger_module, "LOG_FILE", str(log_path))
    monkeypatch.setattr(logger_module, "_last_entry_hash", GENESIS_HASH)
    return log_path


def _read_entries(path):
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _write_entries(path, entries):
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")


def test_real_chain_from_the_actual_logger_verifies_clean(isolated_audit_log):
    log_audit_event("session-1", 1, "log in", {"type": "click", "risk_tier": "safe"}, 0.9, [])
    log_audit_event("session-1", 2, "type password", {"type": "type", "risk_tier": "risky"}, 0.9, [])
    log_audit_event("session-1", 3, "submit", {"type": "click", "risk_tier": "safe"}, 0.9, [])

    entries = _read_entries(isolated_audit_log)
    assert len(entries) == 3

    ok, broken_index = verify_audit_chain(entries)
    assert ok is True
    assert broken_index is None


def test_genesis_entry_chains_from_the_documented_fixed_seed(isolated_audit_log):
    log_audit_event("session-1", 1, "log in", {"type": "click", "risk_tier": "safe"}, 0.9, [])
    entries = _read_entries(isolated_audit_log)
    assert entries[0]["previous_hash"] == "0" * 64 == GENESIS_HASH


def test_mutating_a_historical_entry_is_detected_at_that_exact_entry(isolated_audit_log):
    log_audit_event("session-1", 1, "log in", {"type": "click", "risk_tier": "safe"}, 0.9, [])
    log_audit_event("session-1", 2, "type password", {"type": "type", "risk_tier": "risky"}, 0.9, [])
    log_audit_event("session-1", 3, "submit", {"type": "click", "risk_tier": "safe"}, 0.9, [])
    log_audit_event("session-1", 4, "confirm", {"type": "click", "risk_tier": "safe"}, 0.9, [])

    entries = _read_entries(isolated_audit_log)
    assert len(entries) == 4

    # Sanity: untampered chain verifies clean before we touch anything.
    ok, broken_index = verify_audit_chain(entries)
    assert ok is True and broken_index is None

    # Tamper with entry index 2 (the THIRD entry, 0-indexed) — change its
    # confidence value in place on disk, exactly as an attacker editing the
    # JSONL file directly would. entry_hash/previous_hash are left as they
    # were originally written, so the recomputed hash over the now-mutated
    # content will no longer match the stored entry_hash.
    tampered_entries = [dict(e) for e in entries]
    assert tampered_entries[2]["confidence"] == 0.9
    tampered_entries[2]["confidence"] = 0.0  # the mutation
    _write_entries(isolated_audit_log, tampered_entries)

    reloaded = _read_entries(isolated_audit_log)
    ok, broken_index = verify_audit_chain(reloaded)

    assert ok is False
    assert broken_index == 2, (
        f"expected the break to be reported starting at the tampered entry (index 2), got index {broken_index}"
    )

    # Entries before the tamper point are untouched and still chain
    # correctly among themselves — confirming the checker isn't just
    # reporting "something, somewhere" but the actual first broken link.
    ok_prefix, _ = verify_audit_chain(reloaded[:2])
    assert ok_prefix is True


def test_deleting_a_historical_entry_breaks_the_chain_at_the_gap(isolated_audit_log):
    log_audit_event("session-1", 1, "log in", {"type": "click", "risk_tier": "safe"}, 0.9, [])
    log_audit_event("session-1", 2, "type password", {"type": "type", "risk_tier": "risky"}, 0.9, [])
    log_audit_event("session-1", 3, "submit", {"type": "click", "risk_tier": "safe"}, 0.9, [])

    entries = _read_entries(isolated_audit_log)
    # Remove the middle entry — entry 2's previous_hash now no longer
    # matches entry 0's entry_hash, so the break must be reported AT index 1
    # (the first entry whose previous_hash is now wrong), not index 2.
    deleted_entries = [entries[0], entries[2]]
    _write_entries(isolated_audit_log, deleted_entries)

    reloaded = _read_entries(isolated_audit_log)
    ok, broken_index = verify_audit_chain(reloaded)

    assert ok is False
    assert broken_index == 1


def test_standalone_verify_audit_chain_cli_reports_the_same_break(isolated_audit_log):
    """Exercises server/app/verify_audit_chain.py as an actual subprocess —
    the real tool an operator would run — not just the library function it
    wraps."""
    log_audit_event("session-1", 1, "log in", {"type": "click", "risk_tier": "safe"}, 0.9, [])
    log_audit_event("session-1", 2, "type password", {"type": "type", "risk_tier": "risky"}, 0.9, [])

    entries = _read_entries(isolated_audit_log)
    tampered_entries = [dict(e) for e in entries]
    tampered_entries[1]["action"] = {"type": "type", "risk_tier": "safe"}  # flip risk_tier post hoc
    _write_entries(isolated_audit_log, tampered_entries)

    result = subprocess.run(
        [sys.executable, "-m", "app.verify_audit_chain", str(isolated_audit_log)],
        cwd=str(pytest.importorskip("app").__path__[0] + "/.."),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 1
    assert "CHAIN BROKEN at entry index 1" in result.stdout
