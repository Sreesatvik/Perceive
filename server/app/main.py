import os
import traceback
import logging
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel as _BaseModel, ValidationError
from typing import Optional
from .models import ClientPayload, ServerResponse, ActionInstruction
from .llm_client import generate_action
from .session import get_or_create_session, clear_session
from .logger import log_audit_event
from .auth import require_api_key
from .policy import evaluate_action_risk
from .config import settings

logger = logging.getLogger(__name__)

allowed_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]

app = FastAPI(title="Lightweight Browser Agent Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_RETRIES = 3

@app.post("/analyze", response_model=ServerResponse, dependencies=[Depends(require_api_key)])
async def analyze_step(payload: ClientPayload):
    """
    Receives a sanitized payload, fetches session history,
    calls the reasoning LLM, and enforces ActionInstruction schema.
    Retries up to MAX_RETRIES on malformed LLM output.
    """
    session = get_or_create_session(payload.session_id)
    
    # Session continuity defense
    if payload.step_number > 1 and not session.history:
        log_audit_event(
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
    
    from groq import RateLimitError, APIError
    
    for attempt in range(MAX_RETRIES):
        try:
            # The LLM client already returns a Pydantic-validated ActionInstruction
            action = await generate_action(payload)
            
            # Additional semantic validation
            if action.target_element_id:
                valid_ids = [el.element_id for el in payload.dom_summary.elements]
                if action.target_element_id not in valid_ids:
                    raise ValueError(f"Hallucinated target_element_id '{action.target_element_id}'. Must be one of {valid_ids}")
                    
            # Server-authoritative risk tier override / enforcement
            target_el = None
            if action.target_element_id:
                target_el = next((el for el in payload.dom_summary.elements if el.element_id == action.target_element_id), None)
            
            action.risk_tier = evaluate_action_risk(action.model_dump(), target_el.model_dump() if target_el else None)
            
            # Record step to session history
            session.add_step(payload.step_number, payload.task_instruction, action)
            
            # Log the event
            log_audit_event(
                session_id=payload.session_id,
                step_number=payload.step_number,
                instruction=payload.task_instruction,
                action=action.model_dump(),
                confidence=0.90,
                payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
            )
            
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
            log_audit_event(
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
        except Exception as e:
            # Other errors (e.g., API failures)
            logger.error("API Failure in analyze_step", exc_info=True)
            log_audit_event(
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
    log_audit_event(
        session_id=payload.session_id,
        step_number=payload.step_number,
        instruction=payload.task_instruction,
        action={"error": "Failed to generate valid action"},
        confidence=0.0,
        payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
    )
    raise HTTPException(
        status_code=500, 
        detail="Internal server error"
    )

@app.exception_handler(ValidationError)
async def validation_exception_handler(request: Request, exc: ValidationError):
    """Custom handler to ensure malformed incoming payloads are clearly rejected."""
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "body": exc.body},
    )

@app.get("/health")
async def health_check():
    return {"status": "ok"}

class SessionEndRequest(_BaseModel):
    reason: str = "unspecified"

@app.post("/session/{session_id}/end", dependencies=[Depends(require_api_key)])
async def end_session(session_id: str, body: SessionEndRequest):
    """
    Called by the client when a task session completes, fails, or is aborted.
    Cleans up server-side session state for this session_id.
    """
    try:
        clear_session(session_id)
    except Exception:
        pass
    log_audit_event(
        session_id=session_id,
        step_number=-1,
        instruction="",
        action={"event": "session_ended", "reason": body.reason},
        confidence=0.0,
        payload_notes=[]
    )
    return {"status": "session_ended", "session_id": session_id}
