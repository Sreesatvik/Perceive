import os
import traceback
import logging
import time
import asyncio
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel as _BaseModel, ValidationError
from typing import Optional
from .models import ClientPayload, ServerResponse, ActionInstruction
from .llm_client import generate_action, generate_field_mapping
from .session import get_or_create_session, clear_session, get_session_lock
from .logger import log_audit_event_async
from .artifact_store import save_redacted_image
from .auth import require_api_key
from .policy import evaluate_action_risk, value_field_violates_pii_guard
from .config import settings

logger = logging.getLogger(__name__)

allowed_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]

app = FastAPI(title="Lightweight Browser Agent Backend")

MAX_BODY_BYTES = 10_000_000

class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        return await call_next(request)

app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_RETRIES = 3
_rate_limit_state = {}
RATE_LIMIT_MAX_REQUESTS = 20
RATE_LIMIT_WINDOW_SECONDS = 60

def enforce_rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    window_start, count = _rate_limit_state.get(ip, (now, 0))
    if now - window_start > RATE_LIMIT_WINDOW_SECONDS:
        window_start, count = now, 0
    count += 1
    _rate_limit_state[ip] = (window_start, count)
    if count > RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

LLM_CONCURRENCY_LIMIT = 5
_llm_semaphore = asyncio.Semaphore(LLM_CONCURRENCY_LIMIT)

@app.post("/analyze", response_model=ServerResponse, dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)])
async def analyze_step(payload: ClientPayload):
    """
    Receives a sanitized payload, fetches session history,
    calls the reasoning LLM, and enforces ActionInstruction schema.
    Retries up to MAX_RETRIES on malformed LLM output.
    """
    session = get_or_create_session(payload.session_id)
    session_lock = await get_session_lock(payload.session_id)

    # Phase D.2: pipeline-event audit trail. These four are logged
    # unconditionally at the top of every /analyze call (including the
    # field_mapping_request branch below) because they're all real,
    # server-observable facts about the payload as received — not
    # after-the-fact guesses about what the client did:
    #   PIPELINE_START     — this call has begun processing this step.
    #   CAPTURE_COMPLETE    — as observed server-side: a redacted screenshot
    #                         arrived in the payload (the capture itself
    #                         happened client-side; this is the server's
    #                         only observable proxy for it).
    #   DOM_FINDINGS        — count of DOM elements the client's detection
    #                         pipeline reported (real field: dom_summary.elements).
    #   VISION_FINDINGS     — count of detection_confidence_notes whose
    #                         method is vision_model/ocr_regex (real field).
    await log_audit_event_async(
        session_id=payload.session_id,
        step_number=payload.step_number,
        instruction=payload.task_instruction,
        action={"event_type": "PIPELINE_START"},
        confidence=0.0,
        payload_notes=[]
    )
    await log_audit_event_async(
        session_id=payload.session_id,
        step_number=payload.step_number,
        instruction=payload.task_instruction,
        action={"event_type": "CAPTURE_COMPLETE", "image_present": payload.redacted_image_base64 is not None},
        confidence=0.0,
        payload_notes=[]
    )
    await log_audit_event_async(
        session_id=payload.session_id,
        step_number=payload.step_number,
        instruction=payload.task_instruction,
        action={"event_type": "DOM_FINDINGS", "count": len(payload.dom_summary.elements)},
        confidence=0.0,
        payload_notes=[]
    )
    vision_finding_count = sum(
        1 for note in payload.detection_confidence_notes if note.method in ("vision_model", "ocr_regex")
    )
    await log_audit_event_async(
        session_id=payload.session_id,
        step_number=payload.step_number,
        instruction=payload.task_instruction,
        action={"event_type": "VISION_FINDINGS", "count": vision_finding_count},
        confidence=0.0,
        payload_notes=[]
    )

    async with session_lock:

        # Phase C.2(c): narrow, structural-only field-mapping fallback.
        # Handled as its own early branch, separate from the real
        # action-generation step sequence below — it does not advance
        # session history/step numbering, and its result is never an
        # executable action, so it must never reach evaluate_action_risk()
        # or value_field_violates_pii_guard() (both are action-shaped
        # checks; a field mapping has no target_element_id/value/risk_tier
        # to evaluate in the first place).
        if payload.field_mapping_request is not None:
            try:
                mapping = await generate_field_mapping(payload)
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action={"event_type": "LLM_RESPONSE", "call": "generate_field_mapping"},
                    confidence=0.0,
                    payload_notes=[]
                )
            except Exception as e:
                logger.error("Field-mapping LLM call failed in analyze_step", exc_info=True)
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action={"error": f"field_mapping_request failed: {e}"},
                    confidence=0.0,
                    payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
                )
                raise HTTPException(status_code=500, detail="Field-mapping request failed")

            await log_audit_event_async(
                session_id=payload.session_id,
                step_number=payload.step_number,
                instruction=payload.task_instruction,
                action={"event": "field_mapping_request", "field_mapping": mapping},
                confidence=0.0,
                payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
            )
            return ServerResponse(
                session_id=payload.session_id,
                step_number=payload.step_number,
                action=None,
                field_mapping=mapping,
                confidence=0.90,
            )

        # Session continuity defense
        if payload.step_number > 1 and not session.history:
            await log_audit_event_async(
                session_id=payload.session_id,
                step_number=payload.step_number,
                instruction=payload.task_instruction,
                action={"error": "Session continuity broken (fresh UUID mid-task)"},
                confidence=0.0,
                payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
            )
            raise HTTPException(
                status_code=400,
                detail="Step number > 1 but no session history found. Did the client regenerate session_id mid-task?"
            )
        
        last_exception: Optional[Exception] = None
        
        from groq import RateLimitError, APIError, APIStatusError
        
        for attempt in range(MAX_RETRIES):
            try:
                # The LLM client already returns a Pydantic-validated ActionInstruction
                async with _llm_semaphore:
                    action = await generate_action(payload)
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action={"event_type": "LLM_RESPONSE", "call": "generate_action", "attempt": attempt + 1},
                    confidence=0.0,
                    payload_notes=[]
                )

                # Additional semantic validation
                if action.target_element_id:
                    valid_ids = [el.element_id for el in payload.dom_summary.elements]
                    if action.target_element_id not in valid_ids:
                        raise ValueError(f"Hallucinated target_element_id '{action.target_element_id}'. Must be one of {valid_ids}")

                # Fail-closed guard against the LLM echoing or hallucinating a
                # raw-looking PII value instead of a semantic token. This is
                # rejected outright (422), not retried like a hallucinated
                # target — a raw value in the value field is a policy
                # violation, not a transient parsing failure.
                if action.type == "type":
                    violated_type = value_field_violates_pii_guard(action.value)
                    if violated_type:
                        await log_audit_event_async(
                            session_id=payload.session_id,
                            step_number=payload.step_number,
                            instruction=payload.task_instruction,
                            action={"error": f"Rejected: value field matched raw {violated_type} shape, not a valid token"},
                            confidence=0.0,
                            payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
                        )
                        raise HTTPException(
                            status_code=422,
                            detail=f"Action value field matched a raw {violated_type} shape instead of a valid semantic token. Rejected."
                        )

                # Server-authoritative risk tier override / enforcement
                target_el = None
                if action.target_element_id:
                    target_el = next((el for el in payload.dom_summary.elements if el.element_id == action.target_element_id), None)
                
                action.risk_tier = evaluate_action_risk(action.model_dump(), target_el.model_dump() if target_el else None)
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action={"event_type": "POLICY_DECISION", "risk_tier": action.risk_tier, "action_type": action.type},
                    confidence=0.0,
                    payload_notes=[]
                )

                # Record step to session history
                session.add_step(payload.step_number, payload.task_instruction, action)

                # Log the event
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action=action.model_dump(),
                    confidence=0.90,
                    payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
                )

                # Best-effort demo/audit artifact persistence — never allowed
                # to affect the response, so any failure here is swallowed.
                # save_redacted_image() already catches its own internal
                # exceptions and returns None on failure; this try/except is
                # extra insurance against something unexpected (e.g. a bad
                # session_id causing an OS-level path error).
                try:
                    saved_path = save_redacted_image(payload.session_id, payload.step_number, payload.redacted_image_base64)
                    if saved_path:
                        logger.info(f"Saved redacted image artifact: {saved_path}")
                        await log_audit_event_async(
                            session_id=payload.session_id,
                            step_number=payload.step_number,
                            instruction=payload.task_instruction,
                            action={"event_type": "REDACTION_COMPLETE", "artifact_path": saved_path},
                            confidence=0.0,
                            payload_notes=[]
                        )
                except Exception:
                    logger.warning("Failed to save redacted image artifact", exc_info=True)

                response = ServerResponse(
                    session_id=payload.session_id,
                    step_number=payload.step_number + 1,
                    action=action,
                    confidence=0.90 
                )
                return response
                
            except (ValueError, ValidationError) as ve:
                # Covers Pydantic ValidationError and our custom ValueError
                print(f"=== RETRY {attempt + 1}/{MAX_RETRIES} FAILED: {type(ve).__name__}: {ve} ===")
                last_exception = ve
                continue
            except RateLimitError as e:
                # Don't blindly retry 429s in a tight loop
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action={"error": "Rate limit exceeded (429)"},
                    confidence=0.0,
                    payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
                )
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Rate limit exceeded. Please wait and try again."},
                    headers={"Retry-After": "5"}
                )
            except HTTPException:
                # Deliberate rejections raised above (e.g. the PII value-field
                # guard) must propagate with their own status code, not be
                # swallowed into a generic 500 by the catch-all below.
                raise
            except APIStatusError as e:
                if e.status_code == 413:
                    await log_audit_event_async(
                        session_id=payload.session_id,
                        step_number=payload.step_number,
                        instruction=payload.task_instruction,
                        action={"error": "Request too large for model token limit"},
                        confidence=0.0,
                        payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
                    )
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "The page content is too large for the current model's token limit. Try a simpler page or reduce visible elements."},
                    )
                logger.error("Groq API status error in analyze_step", exc_info=True)
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action={"error": "API Failure"},
                    confidence=0.0,
                    payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
                )
                raise HTTPException(status_code=502, detail="Upstream LLM provider error")
            except Exception as e:
                # Other errors (e.g., API failures)
                logger.error("API Failure in analyze_step", exc_info=True)
                await log_audit_event_async(
                    session_id=payload.session_id,
                    step_number=payload.step_number,
                    instruction=payload.task_instruction,
                    action={"error": "API Failure"},
                    confidence=0.0,
                    payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
                )
                raise HTTPException(status_code=500, detail="Internal server error")
                
        # If we hit the max retries, fail
        logger.error(f"Failed to generate a valid action after {MAX_RETRIES} attempts. Last error: {str(last_exception)}", exc_info=True)
        await log_audit_event_async(
            session_id=payload.session_id,
            step_number=payload.step_number,
            instruction=payload.task_instruction,
            action={"error": "Failed to generate valid action"},
            confidence=0.0,
            payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
        )
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {last_exception}"
        )

@app.exception_handler(ValidationError)
async def validation_exception_handler(request: Request, exc: ValidationError):
    """Custom handler to ensure malformed incoming payloads are clearly rejected."""
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )

@app.get("/health")
async def health_check():
    return {"status": "ok"}

# Phase D.2: these two pipeline events genuinely happen entirely
# client-side and have no other way to reach the server's audit log:
#   FIREWALL_BLOCK   — dev2/leakage-auditor.js's assertSafeToSend() rejects
#                      an outgoing payload in transport.js BEFORE the
#                      /analyze request is ever sent, so /analyze itself can
#                      never observe this. See transport.js's sendToBackend.
#   ACTION_EXECUTED  — the DOM click/type actually happens inside the page's
#                      content script (actionExecutor.js), which the server
#                      has no visibility into at all. See orchestrator.js.
# A fixed allow-list keeps this endpoint from becoming a generic arbitrary
# client-log sink.
ALLOWED_CLIENT_EVENT_TYPES = {"FIREWALL_BLOCK", "ACTION_EXECUTED"}

class PipelineEventRequest(_BaseModel):
    step_number: int
    event_type: str
    details: Optional[dict] = None

@app.post("/session/{session_id}/event", dependencies=[Depends(require_api_key)])
async def report_pipeline_event(session_id: str, body: PipelineEventRequest):
    if body.event_type not in ALLOWED_CLIENT_EVENT_TYPES:
        raise HTTPException(status_code=400, detail=f"event_type must be one of {sorted(ALLOWED_CLIENT_EVENT_TYPES)}")
    await log_audit_event_async(
        session_id=session_id,
        step_number=body.step_number,
        instruction="",
        action={"event_type": body.event_type, **(body.details or {})},
        confidence=0.0,
        payload_notes=[]
    )
    return {"status": "logged"}

class SessionEndRequest(_BaseModel):
    reason: str = "unspecified"

@app.post("/session/{session_id}/end", dependencies=[Depends(require_api_key)])
async def end_session(session_id: str, body: SessionEndRequest):
    """
    Called by the client when a task session completes, fails, or is aborted.
    Cleans up server-side session state for this session_id.
    """
    session_lock = await get_session_lock(session_id)
    try:
        async with session_lock:
            clear_session(session_id)
    except Exception:
        pass
    await log_audit_event_async(
        session_id=session_id,
        step_number=-1,
        instruction="",
        action={"event": "session_ended", "reason": body.reason},
        confidence=0.0,
        payload_notes=[]
    )
    return {"status": "session_ended", "session_id": session_id}
