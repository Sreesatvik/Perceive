# Phase C.2(c) / C.4 — Server-mediated fallback: real end-to-end verification

Date: 2026-09-13
Test file: [`dev2/test-task-parsing-fallback-e2e.mjs`](../dev2/test-task-parsing-fallback-e2e.mjs) (permanent, repeatable)
Server: real, live `uvicorn` instance (`server/app/main.py`), real Groq LLM calls — no mocks.

## What this proves

This is not a unit test against a mocked LLM response (that's `server/tests/test_field_mapping.py`).
This drives the actual client-side extraction code against a live running backend and inspects the
real bytes sent over the wire, to close out Phase C task list Item 2 in full:

- **(a)** The fallback path actually fires instead of the fast path — confirmed the phrase genuinely
  defeats every fast-path pattern (labeled quoted/unquoted values, all three informal X/Y-pair anchor
  variants) while still being detected by `extractCandidateValueSlots`'s looser pair regex.
- **(b)** It correctly maps the instruction to the right field(s) — real Groq response classified
  `SLOT_1 -> username`, `SLOT_2 -> password`.
- **(c)** The request sent to the LLM contains only `<<SLOT_N>>` placeholders, zero raw values —
  verified against the actual serialized HTTP request body, not the source code.
- **(d)** The final result correctly resolves and the task completes — patched instruction re-run
  through the real fast path produced correct `NAME`/`PASSWORD` tokens with zero raw-value leakage.

Test phrase used (deliberately fast-path-defeating, but reachable by the fallback):

> "I'd like to log in to the dashboard; my details are tomsmith and Password123, if that's still current."

## Result

```
--- ALL 6 / 6 FALLBACK END-TO-END CHECKS PASSED ---
```

All 6 real assertions passed on a live run against `http://127.0.0.1:8000` with a real `GROQ_API_KEY`.

## Latency measurement (Phase C task list Item 3)

Instrumented start/end timing around only the fallback's own HTTP round-trip
(`generate_field_mapping()`'s call), separate from the existing hallucination-retry loop's timing.
8 real, independent samples against the live server:

| Sample | Latency (ms) |
|---|---|
| 1 | 1104 |
| 2 | 1054 |
| 3 | 1278 |
| 4 | 1292 |
| 5 | 1192 |
| 6 | 1158 |
| 7 | 870 |
| 8 | 1265 |

**Average: 1152 ms** (min 870 ms, max 1292 ms, n=8)

### Worst-case compounding analysis

Confirmed constants (grepped directly from source, not recalled):

- `server/app/main.py:45` — `MAX_RETRIES = 3` for the main action-generation hallucination-retry loop.
- `server/app/llm_client.py:94` and `:178` — both `generate_action` and `generate_field_mapping` use
  `asyncio.wait_for(..., timeout=12.0)`, i.e. a 12-second ceiling per LLM call.
- The fallback itself (`generate_field_mapping`) has **no retry loop of its own** — one attempt, then
  falls through to `UNRESOLVED_SENSITIVE_REFERENCE` on failure. It cannot compound with itself.

Worst case for one orchestrator step where the fallback fires **and** the subsequent retried
action-generation step then needs its full hallucination-retry budget:

- 1 fallback call + up to 3 main-action attempts, each capped at 12s
- **Theoretical ceiling: ~48 seconds** for that one step.
- **Realistic worst case**, using the measured 1152ms average per call instead of the 12s ceiling:
  1152ms + 3 × 1152ms ≈ **4.6 seconds**.

This is within a sane bound for an interactive step, but the 48-second theoretical ceiling is worth
flagging explicitly for Phase G's performance budget: if Groq degrades toward its real timeout under
load, a single step could stall for tens of seconds while still succeeding. No fix is being made here
since it stayed within a sane bound in practice — this is a flag for Phase G, not a Phase C defect.

## How to reproduce

```bash
cd server && source .venv/Scripts/activate && \
  AUDIT_LOG_FILE=audit_fallback_e2e.jsonl python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
cd dev2 && BACKEND_API_KEY=my-test-secret-123 node test-task-parsing-fallback-e2e.mjs
```

The test skips gracefully (exit 0) if no live server is reachable — see the test file's header comment.
