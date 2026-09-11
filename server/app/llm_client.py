import os
import json
import asyncio
from typing import Any, Dict

from dotenv import load_dotenv
from groq import AsyncGroq

from .models import ClientPayload, ActionInstruction
from .session import get_or_create_session

server_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(server_dir, ".env"))

print(f"[DEBUG] GROQ_API_KEY loaded: {'YES' if os.getenv('GROQ_API_KEY') else 'NO'}")
print(f"[DEBUG] Current working directory: {os.getcwd()}")

def get_llm_client():
    provider = os.getenv("LLM_PROVIDER", "groq").lower()
    if provider == "offline":
        base_url = os.getenv("OFFLINE_API_BASE", "http://localhost:11434/v1")
        return AsyncGroq(
            api_key="offline-local",
            base_url=base_url,
        )
    else:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise ValueError("GROQ_API_KEY environment variable not set")
        return AsyncGroq(api_key=api_key)

async def generate_action(payload: ClientPayload) -> ActionInstruction:
    session = get_or_create_session(payload.session_id)
    history_context = session.get_context_string()
    
    model_name = os.getenv("MODEL_NAME", "openai/gpt-oss-120b")
    client = get_llm_client()
    
    system_prompt = """You are a highly capable browser automation agent.
Your task is to analyze the user's instruction and the current state of the webpage (DOM Summary) to determine the next action.

You MUST output your response as a single, flat JSON object with EXACTLY these fields (no nesting, no wrapping array, no extra top-level keys):
{
    "type": "click" | "type" | "scroll" | "wait" | "ask_user_confirmation" | "task_complete" | "task_failed",
    "target_element_id": "<element_id from dom_summary, or null>",
    "value": "<text to type, only for type actions, or null>",
    "risk_tier": "safe" | "risky",
    "reasoning_short": "<one short sentence explaining your decision>"
}

Example valid response:
{"type": "click", "target_element_id": "checkout-submit-btn", "value": null, "risk_tier": "safe", "reasoning_short": "Clicking submit to complete the checkout form."}

Do NOT wrap this object in an array. Do NOT wrap it under a key like "actions" or "action". Return exactly one flat JSON object matching the shape above, nothing else.

IMPORTANT: You MUST NEVER output real sensitive values (passwords, card numbers, etc). If interacting with a sensitive field, use the provided semantic_token as the value instead.
"""
    
    user_prompt = f"""
Task Instruction: {payload.task_instruction}
Step Number: {payload.step_number}

History:
{history_context}

DOM Summary:
{payload.dom_summary.model_dump_json(indent=2)}

Detection Confidence Notes:
{json.dumps([n.model_dump() for n in payload.detection_confidence_notes], indent=2)}

Determine the next action to take. Output strictly as JSON.
"""

    print(f"[LLM] Starting Groq call for session {payload.session_id}, step {payload.step_number}")
    try:
        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.0,
                response_format={"type": "json_object"}
            ),
            timeout=12.0
        )
    except asyncio.TimeoutError:
        raise ValueError(f"LLM request timed out after 12 seconds (session {payload.session_id}, step {payload.step_number})")
    
    raw_response = response.choices[0].message.content
    if not raw_response:
        raise ValueError("Empty response from LLM")
        
    action_dict = json.loads(raw_response)
    if isinstance(action_dict, list) and len(action_dict) > 0:
        action_dict = action_dict[0]
    elif isinstance(action_dict, dict):
        for wrapper_key in ("actions", "action", "response", "result"):
            if wrapper_key in action_dict:
                inner = action_dict[wrapper_key]
                if isinstance(inner, list) and len(inner) > 0:
                    action_dict = inner[0]
                elif isinstance(inner, dict):
                    action_dict = inner
                break

    if not isinstance(action_dict, dict):
        raise ValueError(f"LLM response could not be normalized to a flat action object: {raw_response}")

    action = ActionInstruction(**action_dict)
    return action