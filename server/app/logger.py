import hashlib
import json
import logging
import os
import asyncio
from datetime import datetime

logger = logging.getLogger(__name__)

# Basic setup for JSONL logging
LOG_FILE = os.getenv("AUDIT_LOG_FILE", "audit.jsonl")

GENESIS_HASH = "0" * 64

# LOG_FILE above is a single global append-only file shared across every
# session (not one file per session), so the hash chain is global too:
# entries from different sessions interleave in write order in the same
# file, and each entry's previous_hash refers to whatever entry was written
# immediately before it, regardless of session_id.
#
# NOTE: chain state resets on server restart; startup reload not
# implemented in this phase.
_last_entry_hash = GENESIS_HASH

# No lock previously existed around the write path in this file. This one
# serializes the entire "read last hash, compute new hash, write to disk,
# update last hash" sequence (performed inside log_audit_event, called via
# asyncio.to_thread below) so two concurrent audit writes can never both
# read the same previous_hash and fork the chain.
_audit_chain_lock = asyncio.Lock()


def _compute_entry_hash(entry_without_hash: dict, previous_hash: str) -> str:
    """
    entry_without_hash must already include `previous_hash` but must NOT
    include `entry_hash` (an entry can't hash itself). sort_keys=True is
    mandatory for determinism, both here and in verify_audit_chain below —
    they must use the identical procedure or verification would fail even
    on untampered data.
    """
    serialized = json.dumps(entry_without_hash, sort_keys=True)
    return hashlib.sha256((serialized + previous_hash).encode("utf-8")).hexdigest()


def log_audit_event(session_id: str, step_number: int, instruction: str, action: dict, confidence: float, payload_notes: list):
    """
    Records an audit event containing context, decision, and confidence.
    Also chains it to the previous entry via previous_hash/entry_hash so
    tampering with, deleting, or reordering past entries is detectable
    later via verify_audit_chain.
    """
    global _last_entry_hash
    try:
        sanitized_action = dict(action) if isinstance(action, dict) else action
        if isinstance(sanitized_action, dict) and "value" in sanitized_action:
            sanitized_action["value"] = "[REDACTED]"

        instruction_str = instruction if instruction is not None else ""
        instruction_hash = hashlib.sha256(instruction_str.encode()).hexdigest()

        previous_hash = _last_entry_hash

        event = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "session_id": session_id,
            "step_number": step_number,
            "instruction_hash": instruction_hash,
            "action": sanitized_action,
            "confidence": confidence,
            "payload_notes": payload_notes,
            "previous_hash": previous_hash,
        }

        # entry_hash is computed over everything above (including
        # previous_hash) but must not include itself.
        event["entry_hash"] = _compute_entry_hash(event, previous_hash)

        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")

        _last_entry_hash = event["entry_hash"]
    except Exception:
        logger.error("audit_log_error")

async def log_audit_event_async(session_id: str, step_number: int, instruction: str, action: dict, confidence: float, payload_notes: list):
    """
    Runs the synchronous audit write in a thread pool so it never blocks the
    event loop. Held under _audit_chain_lock for the whole call so the
    read-last-hash / write / update-last-hash sequence inside
    log_audit_event is atomic across concurrent callers — the lock is
    acquired here (async level) and only released after the threaded write
    completes.
    """
    async with _audit_chain_lock:
        await asyncio.to_thread(
            log_audit_event, session_id, step_number, instruction, action, confidence, payload_notes
        )


def verify_audit_chain(entries: list[dict]) -> tuple[bool, int | None]:
    """
    Verifies a hash chain over an already-parsed list of audit entry dicts.
    Caller is responsible for reading the JSONL file and json.loads-ing each
    line before calling this — this is a pure verification function only.

    Returns (True, None) if every entry in order forms a valid chain
    (including the trivial empty-list case), or (False, i) for the index of
    the first entry where the chain breaks (missing hash fields, a
    previous_hash mismatch, or a recomputed entry_hash mismatch).
    """
    expected_previous_hash = GENESIS_HASH

    for i, entry in enumerate(entries):
        try:
            if "entry_hash" not in entry or "previous_hash" not in entry:
                return False, i

            if entry["previous_hash"] != expected_previous_hash:
                return False, i

            entry_without_hash = {k: v for k, v in entry.items() if k != "entry_hash"}
            recomputed_hash = _compute_entry_hash(entry_without_hash, entry["previous_hash"])

            if recomputed_hash != entry["entry_hash"]:
                return False, i

            expected_previous_hash = entry["entry_hash"]
        except Exception:
            return False, i

    return True, None
