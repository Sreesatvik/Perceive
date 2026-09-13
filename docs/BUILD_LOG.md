# Build Log

Running log of phase completions and their verification status.

## Phase C — closed 2026-09-13

Phase C closed — fast path 26/27 (1 intentional fail-closed exception, documented), fallback path verified end-to-end with payload inspection, fallback latency measured at 1152ms average.

Details:
- Fast-path regex/heuristic extraction (`dev2/task-entity-extractor.js`): 26/27 stress-test phrasings resolve correctly. The 1 remaining case (typo'd `usename`/`paswrod` labels) is an intentional fail-closed design decision, not a bug — see the comment at the throw site in `resolveCredentialTokens()` and the annotated case in [`dev2/task-parsing-stress-test.mjs`](../dev2/task-parsing-stress-test.mjs).
- Server-mediated fallback (C.2c) verified for real, end-to-end, against a live server with a real Groq LLM call, with the actual outgoing HTTP request body inspected for zero raw-value leakage: [`dev2/test-task-parsing-fallback-e2e.mjs`](../dev2/test-task-parsing-fallback-e2e.mjs), full writeup in [`docs/fallback-e2e-verification.md`](fallback-e2e-verification.md). 6/6 real assertions passed.
- Fallback round-trip latency measured over 8 real samples: avg 1152ms (min 870ms, max 1292ms). Worst-case compounding with the existing `MAX_RETRIES=3` hallucination-retry loop (each LLM call capped at 12s) analyzed: theoretical ceiling ~48s for one step, realistic worst case ~4.6s using measured latency. Flagged for Phase G's performance budget, not treated as a Phase C defect.
- Full regression re-run after the above changes, all green, no regressions:
  - `server/tests/test_field_mapping.py`: 6/6 passed
  - `server/tests/test_prompt_injection.py`: 2/2 passed (includes the 6/6 prompt-injection self-test suite referenced in earlier Phase C work)
  - `dev2 npm test` (6 suites incl. the 27-phrase stress test, Phase C task-parsing fix, vision-fusion, privacy-intelligence, red-team DOM): all passed
  - `extension npm test` (vision background-relay, offscreen face detection, popup error handling, face-dedup): all passed
