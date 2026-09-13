# Vision Engine: Measured Accuracy & Scope Decision (Phase B)

## What this document is

A committed, numbers-backed decision document: which visual PII classes are
reliably covered, with what technology, measured against real fixture sets
— and which are explicitly out of scope for this round. This supersedes an
earlier version of this document that recorded Phase B as skipped; Phase B
has now actually run, and this reflects its real results.

## Status of the prior known regression

An earlier session found face detection threw `Worker is not defined` in
live Chrome (Service Workers cannot spawn a nested `Worker` at all — see
git history for the `chrome.offscreen`-based fix). **That regression is
fixed** as of this session (`transport.js`'s `ensureOffscreenDocument()` +
`offscreenFaceDetection.js`), confirmed by the full extension test suite
passing (47/47). The accuracy measurement below is a separate question from
whether the pipeline runs at all — it's now confirmed to run; how *well* it
detects faces is what Phase B measures.

## B.2 — Face detection: measured result

**Recall and precision could not be measured in this session's sandboxed
environment — not due to a shortcut, but a confirmed, evidence-based
environment limitation, not a code defect.**

15 hand-labeled fixtures were built (`extension/tests/fixtures/faces/`,
13 real public-domain photos + 2 disclosed synthetic composites — see that
directory's README). The test harness
(`extension/tests/vision/faceAccuracyTest.js`) drives the actual,
unmodified `extension/dist/faceDetectionWorker.bundle.js` — not a mock —
inside a Node `vm` sandbox shaped as a classic Worker scope. Getting there
required fixing 8 real, sequential environment gaps in order (Worker
message plumbing, `ImageData`, `document`, `importScripts` /
Node-vs-Worker environment detection, static-server MIME types,
`navigator`, `atob`/`btoa`, and a `WebGLRenderingContext` presence stub) —
at which point MediaPipe's own compiled WASM graph genuinely initialized
(`"Graph successfully started running."`, a real log line from MediaPipe's
C++ code, not this harness). It then failed identically across **all 15**
fixtures with `Cannot read properties of undefined (reading
'activeTexture')`: BlazeFace's WASM build requires a real WebGL context for
image-texture ingestion even on its nominal "CPU" delegate. That requires a
native OpenGL binding for Node (`gl`/headless-gl); `npm install gl`
confirmed this sandbox has no C++ build toolchain (Visual Studio) to
compile it.

**The bar for this measurement**, had it been possible to run: **≥90%
recall**, per the plan's own reference point — chosen because a missed
face (false negative) is strictly worse than an extra false-positive
redaction under this project's fail-closed principle, so the bar should be
high, and 90% is a defensible floor for a fixture set this size (15 images,
~25 labeled faces) without claiming statistical rigor a larger set would
need.

**Consequence: face detection accuracy is unmeasured, not "passing" or
"failing" a bar.** Saying otherwise would be rounding up. The fixture set,
ground truth, and harness are real and committed — they will produce a
real number the moment they're run somewhere with either an actual Chrome
browser (the real production path, via the offscreen document already
fixed) or a working native GL toolchain for Node. **A fallback/ensemble
model was considered but not evaluated this session, due to time** — not
because the measured recall was low (it wasn't measured at all), but
because the environment blocker above consumed the time that would have
gone to a second-model comparison.

## B.3 — OCR: measured result

**Recall (PII-type level): 100.0% (1/1). Precision: 100.0% (1/1). Average
latency: 119ms.**

4 synthetic fixtures (`extension/tests/fixtures/ocr/`, all canvas-rendered,
disclosed as such — not real screenshots). The harness
(`extension/tests/vision/ocrAccuracyTest.js`) runs the real tesseract.js
WASM OCR engine (same version as production; `ocrPipeline.js`'s own
`runOcr()` hardcodes browser-only worker asset paths that don't run under
Node, so the harness calls `createWorker()` directly instead and reuses
`runOcr()`'s exact line-extraction logic verbatim — see that file's header
comment), then the real, unmodified `detectPII()` from
`dev2/pii-patterns.js` against the extracted text.

The plan's single most-emphasized case — **a PII-shaped string rendered
only as `<canvas>` pixels, with zero DOM cooperation** — was caught
perfectly: `canvas_dashboard_1.png`'s `4111-1111-1111-1111` was OCR'd
character-for-character correctly and matched as `CARD_NUMBER`. Clean
printed text and low-contrast/small text both correctly triggered zero
false-positive PII detections. The rotated-text fixture (~18°) is a real,
worth-flagging caveat: raw OCR *text quality* degraded noticeably under
rotation (`"Rotate tex Sample for Ocr testing Orqg, ID; 998-220, "4;"` vs.
the correct `"Rotated text sample for OCR testing Order ID:
998-2201-4471"`), even though this particular fixture had no PII pattern
to catch either way — meaning rotation-induced character errors on a
*real* PII string (not tested here) could plausibly break an exact-shape
regex match. That's a follow-up worth a fixture with genuine PII content
under rotation, not evaluated this session.

## Visual PII classes with no dedicated detector today

Unchanged from the prior version of this document — Phase B measured
accuracy of what exists; it didn't add new detector classes:

- **ID card** (shape/presence detection) — no dedicated detector.
- **Signature** — no dedicated detector.
- **Generic sensitive document** (envelope/letterhead/etc.) — no dedicated
  detector.
- **Credit card** is only partially covered, via OCR text-pattern matching
  (`dev2/pii-patterns.js`'s `CARD_NUMBER` regex on OCR'd text) — not a
  visual card-shape/layout detector. A physical card photographed at an
  angle, or one whose printed number OCR fails to read cleanly, would not
  be caught. The `id_card_1.jpg` face fixture (a synthetic ID-card-shaped
  composite) exists specifically to test face-detector-on-document overlap
  for this gap, but — per B.2 above — could not actually be run this
  session.

## The explicit B.4 decision

**Given today's remaining time, the explicit choice for ID card /
signature / generic sensitive document is (b): these are scoped out of
this round's demo, not addressed with a lightweight classifier pass.** A
real ONNX (or similar) classifier integration, plus its own accuracy
validation against a fixture set — the same B.2/B.3 discipline just
applied to face/OCR — is almost certainly more work than remains available
this session, and shipping an unvalidated classifier would replace one
undocumented gap with an undocumented false sense of coverage, which is
worse. This is a scoping decision made explicitly, for a stated reason, not
an oversight discovered later.

## Revisit before further demoing

Two concrete, bounded follow-ups, not a vague "improve accuracy later":

1. Run `extension/tests/vision/faceAccuracyTest.js` (already built,
   committed, ready) on a machine with either a real Chrome browser or a
   working native GL toolchain for Node, to get the first real face-
   detection recall/precision numbers against this fixture set.
2. Add a rotated-text fixture that contains genuine PII-shaped content (not
   just prose) to `extension/tests/fixtures/ocr/`, to directly test whether
   OCR's rotation-induced character errors (observed in B.3 above) actually
   break PII-pattern matching, rather than inferring it from a proxy case.
