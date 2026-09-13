# Phase E.2 — DOM robustness scoping decisions

Two explicit decisions from Phase E.2, both made by reading the actual code
paths rather than assuming — recorded here so neither is left ambiguous.

## 1. Re-indexing: reactive-only is sufficient (decision: keep as-is)

**Finding.** `extension/src/content/domIndex.js`'s `startMutationTracking()`
runs a real `MutationObserver` and increments `mutationCount` on every DOM
change, and `getMutationCount()`/`resetMutationCount()` are exported and
genuinely tested (`extension/tests/test-dom-index.js`). But grepping
`orchestrator.js` and `actionExecutor.js` for callers of `getMutationCount()`
turns up none — nothing in the real control flow ever reads that counter.
The mutation count is tracked but never consumed to trigger anything.

The only actual re-indexing path is `findAgentElementResilient()`
(`domIndex.js`), called from `actionExecutor.js` at the moment an action is
about to execute. It is purely **reactive**: it only re-scans when the
*specific element the LLM just chose* fails a direct lookup or no longer
matches what was perceived (tag+label mismatch). It never proactively
re-scans the whole page just because a mutation happened somewhere.

**Decision: reactive-only is sufficient. No proactive re-scan is being
added.** Reasoning:

- `orchestrator.js`'s `captureOnce()` — full DOM traversal
  (`document.querySelectorAll('input, button, select, textarea')`, now also
  viewport-filtered per Phase E.2 above) — runs **fresh, every single
  step**, not once at task start. A field that appears after initial page
  load (the exact "dynamically-injected fields" case from E.1's SPA test)
  is picked up automatically on the *next* step's capture — there is no
  stale, cached snapshot from task start that a proactive re-scan would
  need to correct.
- The narrower, real race condition — the *specific* element the LLM was
  just told to act on disappearing or being replaced between being
  perceived and being executed, within the same step — is exactly what
  `findAgentElementResilient()` already handles, and is tested.
- A proactive re-scan triggered on every mutation would be expensive (a
  full capture involves a screenshot, DOM traversal, face detection, and
  OCR — not a cheap operation) and mutation-heavy pages (animations,
  polling widgets, ad iframes messing with their own DOM) would make a
  naive "re-scan on mutation" thrash constantly for no benefit, since
  per-step freshness already exists.
- `getMutationCount()`/`resetMutationCount()` are left as-is (tested,
  harmless, available diagnostic infrastructure) — not removed, since they
  cost nothing to keep and could inform a future decision (e.g. surfacing
  "N mutations since last capture" on the audit dashboard) without being
  load-bearing for correctness today.

## 2. Iframes: explicitly out of scope for this round (decision: (b))

**Finding.** Zero iframe handling exists anywhere in the codebase —
confirmed by grep (no matches for `iframe`/`contentWindow`/`contentDocument`
in `dev2/` or `extension/src/`). `extension/manifest.json`'s
`content_scripts` entry has no `"all_frames": true` (Chrome defaults this to
`false`), so `orchestrator.js` — the only content script, and the only place
that does DOM capture (`document.querySelectorAll(...)`) — **never runs
inside any iframe at all**, same-origin or cross-origin. Any sensitive
field living inside an iframe (a common real pattern — embedded payment
widgets, SSO login iframes) is invisible to this pipeline today.

**Decision: (b) — explicitly documented as out of scope for this round.**
Given the remaining time in this session, extending capture into
same-origin iframes via frame-bridge messaging (new content-script-to-
content-script relay logic, new session-binding rules for per-frame
identity, new redaction-boundary reasoning for content originating from a
different frame than the one that captured it, and real testing against an
actual iframe-based target) is real, non-trivial work that cannot be done
*and* properly tested in what's left. Attempting it without time to test it
against a real page would be worse than not attempting it, per this
project's standing discipline against fabricated/unverified claims of
correctness.

**Does Phase 5's multi-frame session binding in `transport.js` change this
answer? No — checked, not assumed.** `transport.js`'s
`bindOrVerifySessionContext()` binds a `session_id` to the `(tabId,
frameId)` of whichever sender first used it, and rejects any later message
claiming that same `session_id` from a *different* tab/frame. This is a
**session-identity/security** guard only — it stops a different
tab/frame from hijacking an in-flight session's `session_id`. It says
nothing about, and does nothing to enable, DOM *capture* reaching into
iframes. In practice, since the content script never runs inside an iframe
(no `all_frames: true`), every real message this binding ever sees already
carries the top frame's `frameId` (0) — the mechanism exists for Phase 5's
SPA/multi-tab resilience concerns, not for cross-frame capture, and was
never intended to imply the latter.

**What this means concretely today:** a target page with a sensitive field
inside an iframe (e.g. an embedded payment form) will simply not have that
field appear in the DOM summary at all — it is invisible to detection,
not mis-detected. This is a real, known limitation, not a silent bug: if a
future phase needs iframe support, it starts from this document.
