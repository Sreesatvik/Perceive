import hashlib
import json
import logging
import os
from datetime import datetime

logger = logging.getLogger(__name__)

# Basic setup for JSONL logging
LOG_FILE = os.getenv("AUDIT_LOG_FILE", "audit.jsonl")

def log_audit_event(session_id: str, step_number: int, instruction: str, action: dict, confidence: float, payload_notes: list):
    """
    Records an audit event containing context, decision, and confidence.
    """
    try:
        sanitized_action = dict(action) if isinstance(action, dict) else action
        if isinstance(sanitized_action, dict) and "value" in sanitized_action:
            sanitized_action["value"] = "[REDACTED]"

        instruction_str = instruction if instruction is not None else ""
        instruction_hash = hashlib.sha256(instruction_str.encode()).hexdigest()

        event = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "session_id": session_id,
            "step_number": step_number,
            "instruction_hash": instruction_hash,
            "action": sanitized_action,
            "confidence": confidence,
            "payload_notes": payload_notes
        }
        
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except Exception:
        logger.error("audit_log_error")
