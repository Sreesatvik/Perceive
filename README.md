# Perceive: Privacy-Preserving Web Automation Agent

Perceive is a privacy-first web automation agent backend. It processes webpage interactions by replacing sensitive user credentials and personally identifiable information (PII) with semantic tokens before querying large language models.

---

## Key Features

- **DOM Privacy Sanitization**: Evaluates DOM nodes, sensitivity tiers (Tier 1-3), and sensitive types (passwords, card numbers, emails, names, amounts).
- **Semantic Tokenization**: Replaces sensitive values with tokens (e.g., `[CARD_NUMBER]`, `[AMOUNT]`) before inference.
- **LLM-Driven Action Generation**: Uses a Groq-hosted model (or an offline-compatible provider) to decide the next action (`click`, `type`, `scroll`, `wait`, `ask_user_confirmation`, `task_complete`, `task_failed`).
- **Server-Side Policy Enforcement**: `evaluate_action_risk()` re-derives the risk tier for every action server-side — the LLM's own risk assessment is never trusted directly.
- **API Key Auth & CORS Allowlist**: `/analyze` and `/session/{id}/end` require an `X-API-Key` header; CORS origins are read from `ALLOWED_ORIGINS`, no wildcard.
- **Strict Audit Logging**: Records sanitized request metadata and agent actions to `audit.jsonl` without exposing sensitive user inputs.
- **On-Device Multimodal Perception**: Face detection (`@mediapipe/tasks-vision`) and OCR (`tesseract.js`) run entirely in-browser, feeding the same PII-tokenization pipeline as DOM-detected text — raw pixels never leave the browser. OCR is accuracy-measured against a real fixture set (100% recall/precision on PII-pattern matches, incl. the canvas-rendered "zero DOM cooperation" case — see `docs/vision-accuracy/ocr-results.json`); face detection's pipeline is confirmed working end-to-end in live Chrome, but its detection accuracy has not yet been measured (see `docs/vision-engine-decision.md`).

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
│   ├── src/vision/                # On-device face detection (Phase 2) + OCR pipelines
│   ├── dev2/                      # Synced copy of dev2/ (Chrome extensions can only load
│   │                              #   resources from within their own manifest directory —
│   │                              #   run dev2/sync-to-extension.sh after editing dev2/*.js)
│   ├── build.mjs                  # esbuild bundler — run before loading the unpacked extension
│   └── package.json
├── dev2/                          # DOM heuristics, redaction, token vault, PII patterns (canonical source)
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
MODEL_NAME=openai/gpt-oss-120b
GROQ_API_KEY=gsk_your_groq_api_key_here
BACKEND_API_KEY=choose_a_strong_shared_secret
ALLOWED_ORIGINS=http://localhost:3000
```
`config.py` fails fast at boot if any required variable is missing.

Groq's model catalog changes over time — models get deprecated/renamed
(e.g. `llama-3.3-70b-versatile`, previously documented here, returns a 404
`model_not_found` as of this writing). Check currently available models
with your key via:
```bash
curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY" | python -m json.tool
```

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

## Building & Loading the Browser Extension

```powershell
cd extension
npm install
npm run build
```

This bundles `src/content/orchestrator.js` into `dist/orchestrator.bundle.js`
and copies the MediaPipe/Tesseract WASM runtime assets into `dist/vendor/`
(both required for on-device face detection and OCR). Neither
`node_modules/` nor `dist/` is committed — they're fully reproducible via the
above and regenerated on every build.

Then load `extension/` as an unpacked extension via
`chrome://extensions` → Developer mode → **Load unpacked**.

If you change anything under `dev2/`, run `dev2/sync-to-extension.sh`
afterwards — the extension loads its own copy under `extension/dev2/` (a
Chrome-extension packaging requirement), and the two must stay identical.

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
