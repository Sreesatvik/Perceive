import threading
import asyncio
from typing import Dict, List, Any
from .models import ActionInstruction

class Session:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.history: List[Dict[str, Any]] = []
        self.last_step = 0
        self._lock = threading.Lock()

    def add_step(self, step_number: int, instruction: str, action: ActionInstruction):
        with self._lock:
            expected = self.last_step + 1
            if step_number != expected:
                raise ValueError(f"Expected step {expected}, got {step_number}")
            self.history.append({
                "step_number": step_number,
                "instruction": instruction,
                "action": action.model_dump() if hasattr(action, "model_dump") else action,
            })
            self.last_step = step_number
        
    def get_context_string(self) -> str:
        if not self.history:
            return "No previous steps in this session."
        
        context = "Previous steps taken:\n"
        for step in self.history:
            context += f"Step {step['step_number']}: Intended to '{step['instruction']}'. Executed action: {step['action']['type']} on {step['action'].get('target_element_id', 'N/A')}\n"
        return context

# Simple in-memory store
_sessions: Dict[str, Session] = {}
_session_locks: Dict[str, asyncio.Lock] = {}
_locks_registry_lock = asyncio.Lock()

async def get_session_lock(session_id: str) -> asyncio.Lock:
    async with _locks_registry_lock:
        if session_id not in _session_locks:
            _session_locks[session_id] = asyncio.Lock()
        return _session_locks[session_id]

def get_or_create_session(session_id: str) -> Session:
    if session_id not in _sessions:
        _sessions[session_id] = Session(session_id)
    return _sessions[session_id]

def clear_session(session_id: str):
    if session_id in _sessions:
        del _sessions[session_id]
    if session_id in _session_locks:
        del _session_locks[session_id]
