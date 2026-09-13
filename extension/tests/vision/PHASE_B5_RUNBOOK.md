# Phase B.5 face-detection experiment runbook

This session's sandbox cannot load an unpacked Chrome extension or drive a
real browser — everything in Steps 1-6 below needs to be run by a human (or
an automated agent with real browser access) once, in one sitting, using
the harness this phase built. This file is that sitting's checklist.

## One-time setup

1. `cd extension && npm run build` (already done as of this commit — the
   worker now accepts a runtime `config` object; no further rebuild is
   needed between presets, since model/threshold/dedup are all selected
   per-request, not baked into the bundle).
2. Load `extension/` as an unpacked extension via `chrome://extensions`
   (Developer mode → Load unpacked), or reload it if already loaded.
3. Open `chrome-extension://<extension-id>/tests/vision/faceAccuracyTest.html`.

## Running each step

The page has a preset dropdown + "Run preset" button, and a separate
custom-config box + "Run custom config" button for Step 6. Every run is
scored against the same 25-fixture manifest (Phase B.5 Step 0's expanded
set — occluded/id_card/zero_face raised from 1/1/3 to 5/5/5) and appended
to an in-page results list.

Run **in this exact order** (each isolates exactly one variable, per this
phase's own instructions — do not skip ahead to Step 6 before seeing 1/4/5):

1. **`step0_baseline`** — current shipped default (short_range,
   minDetectionConfidence 0.3, MediaPipe's own default suppression
   threshold, no dedup) against the expanded 25-fixture set. This is the
   new baseline; **not directly comparable** to the original 15-fixture/23-face
   run (39.1%/60%) — different fixture count.
2. **`step1_full_range`** — model swap only (short_range → full_range).
   ⚠ The full_range model URL in `faceDetectionWorker.js` follows
   MediaPipe's documented naming convention but has **not been verified by
   an actual successful load** in this project. If this run errors on
   every fixture with a fetch/model-load failure, check MediaPipe's face
   detector model card for the current exact URL and update `MODEL_URLS`
   in `extension/src/vision/faceDetectionWorker.js` accordingly, then
   rebuild.
3. **`step2_union_short_full`** — both models run per fixture, unioned and
   deduped (IoU 0.5). This is a **third, separate data point**, not a
   replacement for Step 1. Watch the console log for `worker_latency_ms`
   per fixture (has `primary`/`secondary`/`total` breakdown) — this is the
   real added-latency cost of running two models, which matters for
   whether this is viable in the live capture pipeline, not just as an
   offline benchmark.
4. **`step4_suppression_adjusted`** — ⚠ **substitution, not the literally
   requested change**: `FaceDetectorOptions` (checked the actual
   `.d.ts` in `node_modules/@mediapipe/tasks-vision`) has only
   `minDetectionConfidence` and `minSuppressionThreshold` — there is no
   `maxResults`/face-count-cap option for `FaceDetector` at all (that's an
   `ObjectDetector`-only concept). This preset instead raises
   `minSuppressionThreshold` from MediaPipe's default (0.3) to 0.5 — the
   closest real lever, since it controls how readily two nearby detections
   are treated as "the same object" and suppressed, which is directly
   relevant to `multiple_faces`.
5. **`step5_dedup_only`** — IoU 0.5 post-hoc dedup (this phase's own new
   `dedupFaces()`, see `extension/src/vision/faceDedup.js`, unit-tested in
   `extension/tests/test-face-dedup.js`), baseline model/settings
   otherwise.
6. **Step 6 (combined)** — after seeing 1/4/5's numbers, type a config
   combining only whichever ones actually helped into the custom-config
   box, e.g. `{"model":"full_range","dedupIouThreshold":0.5}` if both
   Step 1 and Step 5 helped, or just `{"dedupIouThreshold":0.5}` if only
   Step 5 did. Click "Run custom config".

## After all runs

Click "Copy ALL runs so far as JSON" — this copies a single
`{"results": [...]}` array with every run from this session, in order,
fully labeled. Paste it to replace `docs/vision-accuracy/face-detection-results.json`
(that file already has the ORIGINAL 15-fixture/0.3-threshold real
result and the never-executed 0.15 experiment as its first two entries —
keep those, per this project's own standard of not discarding prior real
measurements, and append these new ones rather than overwriting).

Then:
- If Step 6 clears **≥70% overall recall, no category below 50% except
  possibly small_distant**: update `faceDetectionWorker.js`'s actual
  defaults to Step 6's winning config (not just leave it as an
  experiment), rewrite `docs/vision-engine-decision.md`'s B.2 section with
  the real story (what was tried, what worked, final shipped numbers), and
  update `README.md`'s face-detection line.
- If it does not clear the bar: update the same two docs to say so
  plainly — which categories are still weak and why, and an explicit
  recommendation on whether Phase D should proceed with the limitation
  disclosed, or wait. Do not round up either way.
