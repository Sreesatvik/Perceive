from pydantic import BaseModel, Field, model_validator, field_validator
from typing import List, Optional, Literal

# -------------------------------------------------------------------
# Enum-like Literals per PDF Section 4 contracts
# -------------------------------------------------------------------

TagType = str
RoleType = str
SensitivityTier = Literal[1, 2, 3]
SensitivityType = Literal["PASSWORD", "CARD_NUMBER", "EMAIL", "NAME", "AMOUNT", "PHONE", "AADHAAR", "OTP", "IFSC", "UNKNOWN"]
DetectionMethod = Literal["dom_heuristic", "vision_model", "ocr_regex"]
ActionType = Literal["click", "type", "scroll", "wait", "ask_user_confirmation", "task_complete", "task_failed"]
RiskTier = Literal["safe", "risky"]

# -------------------------------------------------------------------
# Client -> Server Payload Models
# -------------------------------------------------------------------

class BoundingBox(BaseModel):
    x: int
    y: int
    w: int
    h: int

class DOMElement(BaseModel):
    element_id: str
    tag: TagType
    role: RoleType
    label_text: Optional[str] = None
    is_sensitive: bool
    sensitivity_tier: Optional[SensitivityTier] = None
    sensitivity_type: Optional[SensitivityType] = None
    semantic_token: Optional[str] = None
    has_value: bool = False
    bounding_box: BoundingBox

    @model_validator(mode='after')
    def check_sensitive_has_token(self):
        # Fail-closed invariant: the server must never receive a real
        # sensitive value. A sensitive element with actual content
        # must carry a semantic token. A sensitive element with no
        # value yet (has_value=False) is allowed to have a null
        # token, since there's nothing to leak and no real value to
        # back a vault entry with.
        if self.is_sensitive and self.has_value and (self.semantic_token is None or self.semantic_token == ""):
            raise ValueError('Sensitive DOM element with a value must include a semantic_token')
        return self

class DOMSummary(BaseModel):
    url: str
    elements: List[DOMElement] = Field(max_length=500)

class DetectionConfidenceNote(BaseModel):
    element_id: str
    confidence: float = Field(ge=0.0, le=1.0)
    method: DetectionMethod

class ClientPayload(BaseModel):
    session_id: str
    task_instruction: str = Field(min_length=1, max_length=2000)
    step_number: int
    dom_summary: DOMSummary
    redacted_image_base64: Optional[str] = Field(default=None, max_length=8_000_000)
    detection_confidence_notes: List[DetectionConfidenceNote] = Field(default_factory=list, max_length=500)
    redacted_regions: Optional[List[dict]] = None
    # Set by the client when the PREVIOUS action for this session failed to
    # execute (a stale/missing DOM target, a rejected task_complete
    # postcondition, etc.) — without this, the LLM has no way to know why
    # the page looks unchanged from the last step and may blindly repeat
    # the same failing action or give up prematurely. See
    # llm_client.py's EXECUTION FEEDBACK prompt block.
    last_action_error: Optional[str] = Field(default=None, max_length=1000)

# -------------------------------------------------------------------
# Server -> Client Action Response Models
# -------------------------------------------------------------------

class ActionInstruction(BaseModel):
    type: ActionType
    target_element_id: Optional[str] = None
    value: Optional[str] = None
    risk_tier: RiskTier
    reasoning_short: str

    @field_validator("risk_tier", mode="before")
    @classmethod
    def reject_non_enum_risk_tier(cls, v):
        if v not in ("safe", "risky"):
            raise ValueError(
                f"risk_tier must be 'safe' or 'risky', got {v!r} "
                f"(type {type(v).__name__}) — numeric conversion is client-side only, "
                f"backend does not coerce"
            )
        return v

    @model_validator(mode='after')
    def check_required_fields_based_on_type(self):
        if self.type in ["click", "type"] and not self.target_element_id:
            raise ValueError(f"target_element_id is required for action type '{self.type}'")
        if self.type == "type" and self.value is None:
            raise ValueError("value is required for 'type' action")
        return self

class ServerResponse(BaseModel):
    session_id: str
    step_number: int
    action: ActionInstruction
    confidence: float = Field(ge=0.0, le=1.0)
