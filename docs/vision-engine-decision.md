# Vision Engine: Scope Decision (Phase B Skipped)

## What this document is

An honest record of a deliberate scope decision made for this compressed
session — not a retroactive justification written after the fact.

## Decision

**Phase B of the Multimodal Upgrade Plan — empirical accuracy measurement of
the vision engine — was explicitly skipped for this session due to time
constraints.** This includes both:

- Face detection recall/precision, measured against a hand-labeled fixture
  set of real images.
- OCR recall/precision/latency, measured against a fixture set.

This was not silently dropped: it is called out here, now, as a known gap.

## What exists today, un-measured

The vision pipeline is implemented and wired into `extension/src/vision/`:

- **Face detection**: MediaPipe BlazeFace (short-range model), running in a
  dedicated worker (`faceDetectionWorker.js`).
- **OCR**: Tesseract.js (WASM), loaded via `modelLoader.js` and run through
  `ocrPipeline.js`.

Both are exercised only by unit tests of the worker *contract* (message
shapes, request/response plumbing, error handling) — e.g.
`extension/tests/test-vision-worker-contract.js`,
`test-vision-background-relay.js`. Neither has ever been benchmarked for
actual detection/recognition accuracy against a labeled set of real images.
The confidence values currently attached to detections (see
`detectFaces`/`runOcr` and their callers) are placeholders reflecting
pipeline/method provenance, not measured accuracy.

## Known regression found during live Chrome verification (2026-09-13)

During a real, loaded-Chrome end-to-end run (not the jsdom harness used
elsewhere for verification), face detection threw `Worker is not defined`
in the content-script context and failed to run at all for this session.

The system correctly **failed open** on this: task completion, redaction,
and audit logging all continued normally via the DOM channel alone. This
is **not a security regression** — it's a functionality gap. Redaction
correctness for DOM-visible sensitive fields was unaffected.

This means face detection is currently **non-functional** in the real
built extension — a stronger claim than "unbenchmarked for accuracy"
stated elsewhere in this doc. This section supersedes that framing for
face detection specifically.

Root cause not yet investigated. Likely candidate, based on the same
class of fix already applied to `captureService.js`/`demoCapture.js` this
session: something in `faceDetectionWorker.js`'s spawn path needing
`chrome.runtime.getURL()` or a background-worker relay that isn't
present, since content scripts have a different global scope (no bare
`Worker` global in some MV3 content-script contexts) than the background
service worker.

Also observed, in the same console output during this run: two
Content-Security-Policy inline-script violations. Not yet root-caused;
not confirmed related to the Worker issue above. Flagged as a secondary,
lower-priority item — possibly connected to Tesseract.js/OCR script
loading, not yet investigated.

## Visual PII classes with no dedicated detector today

From the problem statement's target PII classes, the following have **no
dedicated visual detector** in the current pipeline:

- **ID card** (shape/presence detection)
- **Signature**
- **Generic sensitive document** (envelope/letterhead/etc.)

**Credit card is only partially covered**: today it is caught via
OCR-extracted text run through `dev2/pii-patterns.js`'s regex matching
(card-number digit patterns), not via any visual card-shape/layout
detector. A physical card photographed at an angle, or one whose printed
number OCR fails to read cleanly, would not be caught.

## Why this is a scoping decision, not an oversight

Given the time available this round, effort went into shipping and wiring
the face+OCR pipeline end-to-end (capture → detection → redaction →
audit/artifact trail) over validating its accuracy or building out the
remaining detector classes. That trade-off was made consciously.

**This should be revisited before any further demoing, if time allows** —
per Phase B of the full Multimodal Upgrade Plan: build the labeled fixture
sets, measure face/OCR recall and precision, and decide whether the
uncovered PII classes (ID card, signature, generic document) need dedicated
detectors before being represented as covered.
