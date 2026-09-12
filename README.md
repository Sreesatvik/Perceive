# Perceive: Privacy-Preserving Web Automation Agent

Perceive is a privacy-first web automation agent backend. It processes webpage interactions by replacing sensitive user credentials and personally identifiable information (PII) with semantic tokens before querying large language models.

---

## Key Features

- **DOM Privacy Sanitization**: Evaluates DOM nodes, sensitivity tiers (Tier 1-3), and sensitive types (passwords, card numbers, emails, names, amounts).
- **Semantic Tokenization**: Replaces sensitive values with tokens (e.g., `[CARD_NUMBER]`, `[AMOUNT]`) before inference.
- **LLM-Driven Action Generation**: Uses Groq-hosted `llama-3.3-70b-versatile` (or an offline-compatible provider) to decide the next action (`click`, `type`, `scroll`, `wait`, `ask_user_confirmation`, `task_complete`, `task_failed`).
- **Server-Side Policy Enforcement**: `evaluate_action_risk()` re-derives the risk tier for every action server-side — the LLM's own risk assessment is never trusted directly.
- **API Key Auth & CORS Allowlist**: `/analyze` and `/session/{id}/end` require an `X-API-Key` header; CORS origins are read from `ALLOWED_ORIGINS`, no wildcard.
- **Strict Audit Logging**: Records sanitized request metadata and agent actions to `audit.jsonl` without exposing sensitive user inputs.

---

## Project Structure

```
Perceive/
├── server/
│   ├── app/
│   │   ├── main.py              # FastAPI application and endpoint definitions
│   │   ├── auth.py               # X-API-Key auth dependency
│   │   ├── config.py             # Fail-fast pydantic-settings configuration
│   │   ├── llm_client.py         # Groq API client with offline fallback
│   │   ├── logger.py             # Async audit logger (log_audit_event_async)
│   │   ├── models.py             # Pydantic request/response contracts
│   │   ├── policy.py             # Server-authoritative risk evaluation
│   │   └── session.py            # Per-session history + async lock registry
│   ├── tests/                    # pytest suite (see Testing below)
│   └── requirements.txt
├── extension/                     # Browser extension (content scripts, popup, orchestrator)
├── dev2/                          # DOM heuristics, redaction, token vault, PII patterns
├── run_server.bat                 # Quick-start script for Windows
└── README.md
```

---

## Getting Started

### 1. Prerequisites
- Python 3.10+ (tested on Python 3.14)
- A Groq Cloud API key (or an offline-compatible LLM endpoint)

### 2. Environment Setup
Create and activate a virtual environment:
```powershell
cd server
python -m venv venv
.\venv\Scripts\activate
```

Install the dependencies:
```powershell
pip install -r requirements.txt
```

### 3. Configure Environment Variables
Create `server/.env`:
```env
LLM_PROVIDER=groq
MODEL_NAME=llama-3.3-70b-versatile
GROQ_API_KEY=gsk_your_groq_api_key_here
BACKEND_API_KEY=choose_a_strong_shared_secret
ALLOWED_ORIGINS=http://localhost:3000
```
`config.py` fails fast at boot if any required variable is missing.

### 4. Run the Backend Server
Using the quick-start script:
```powershell
.\run_server.bat
```
Or directly with uvicorn:
```powershell
cd server
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The API will be available at `http://127.0.0.1:8000`. Interactive documentation is available at `http://127.0.0.1:8000/docs`.

---

## API Endpoints

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | none | Health status check |
| `POST` | `/analyze` | `X-API-Key` | Receives DOM summary and returns the next automated action |
| `POST` | `/session/{id}/end` | `X-API-Key` | Ends and clears server-side session state |

---

## Testing

```powershell
cd server
pytest tests/ -q
```

Test fixtures live in `server/tests/conftest.py`, which sets safe default env vars and provides an authenticated `client` fixture (and an unauthenticated `client_no_auth` fixture for auth-boundary tests).
