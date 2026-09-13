/**
 * Dedicated Web Worker for MediaPipe face detection (Phase 2.7 fix).
 *
 * WHY THIS FILE EXISTS (root cause, empirically verified — see
 * extension/tests/vision/raw-worker-test*.html): MediaPipe's internal WASM
 * glue loader does, roughly:
 *   if (typeof importScripts !== 'function') {
 *     // inject a <script> tag via `document` (not available in a worker)
 *   } else {
 *     try { importScripts(glueUrl); }
 *     catch (TypeError) { await import(glueUrl); }
 *   }
 * then reads a global the glue script is expected to have set:
 * `self.ModuleFactory`.
 *
 * In a plain content-script *page* (no worker at all), this runs in the
 * page's own global scope and works. Inside a `type: 'module'` WORKER,
 * `importScripts()` throws (module workers disallow it per spec), so the
 * loader falls into the `import()` fallback — and dynamically import()-ing
 * that non-ESM classic glue script does NOT end up setting
 * `self.ModuleFactory`, reproducing "ModuleFactory not set" on BOTH the GPU
 * and CPU/WASM delegate attempts. (An earlier hypothesis blamed Chrome
 * extension isolated-world semantics for this — verified WRONG: the exact
 * same failure reproduces in a plain webpage's own module worker, nothing
 * extension-specific about it.)
 *
 * A CLASSIC worker (no `{ type: 'module' }`) has a real, spec-compliant
 * `importScripts()` that runs synchronously in the worker's own global and
 * sets `self.ModuleFactory` exactly as the glue script expects — confirmed
 * empirically with a real GPU-delegate detection succeeding. This file is
 * written with ESM `import` syntax for source-code ergonomics, but esbuild
 * (see build.mjs) bundles it into a plain IIFE, so at runtime it is loaded
 * as a classic worker script (`new Worker(url)`, no `type: 'module'` — see
 * visionPipeline.js). This also mirrors why tesseract.js (used for OCR
 * elsewhere in this pipeline) already works: it loads its worker as a
 * classic script too.
 *
 * Protocol (all messages are plain objects via postMessage):
 *   -> { type: 'detect', requestId, width, height, pixels: ArrayBuffer (RGBA, transferred) }
 *   <- { type: 'result', requestId, faces: [{ bounding_box, confidence }] }
 *   <- { type: 'error',  requestId, message }
 */

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

// Resolved relative to this worker script's own location (which is served
// from the extension via chrome.runtime.getURL when bundled) — workers don't
// have `chrome.runtime` available by default in all contexts, so we resolve
// vendor asset paths relative to our own module URL instead.
function vendorUrl(relativePath) {
  try {
    return new URL(relativePath, self.location.href).href;
  } catch (_e) {
    return relativePath;
  }
}

let cachedDetector = null;
let loadPromise = null;

async function loadFaceDetector() {
  if (cachedDetector) return cachedDetector;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // self.location is .../dist/faceDetectionWorker.bundle.js, so
    // '../vendor/mediapipe-wasm' from the worker's own dist/ directory
    // resolves to dist/vendor/mediapipe-wasm — same assets orchestrator.js
    // already ships, just addressed relative to the worker instead of
    // chrome.runtime.getURL (which is not guaranteed inside a worker global).
    const filesetResolver = await FilesetResolver.forVisionTasks(
      vendorUrl('vendor/mediapipe-wasm')
    );

    const modelAssetPath =
      'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

    async function tryCreate(delegate) {
      return FaceDetector.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.3,
      });
    }

    let detector;
    let delegate = 'GPU';
    try {
      detector = await tryCreate('GPU');
    } catch (gpuErr) {
      self.postMessage({ type: 'log', level: 'warn', message: `[Vision Worker] GPU delegate unavailable, falling back to CPU/WASM: ${gpuErr.message}` });
      delegate = 'CPU';
      detector = await tryCreate('CPU');
    }

    cachedDetector = { detector, delegate };
    return cachedDetector;
  })();

  return loadPromise;
}

function toFaces(result) {
  return (result.detections || [])
    .map((d) => {
      const box = d.boundingBox || {};
      const confidence = (d.categories && d.categories[0] && d.categories[0].score) || 0;
      return {
        bounding_box: {
          x: Math.max(0, Math.round(box.originX || 0)),
          y: Math.max(0, Math.round(box.originY || 0)),
          w: Math.round(box.width || 0),
          h: Math.round(box.height || 0),
        },
        confidence,
      };
    })
    .filter((f) => f.bounding_box.w > 0 && f.bounding_box.h > 0);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== 'detect') return;

  const { requestId, width, height, pixels } = msg;
  try {
    if (!width || !height || !pixels) {
      self.postMessage({ type: 'result', requestId, faces: [] });
      return;
    }

    // Rehydrate the transferred RGBA ArrayBuffer into an ImageData object,
    // which MediaPipe's detect() accepts directly as an image-like source.
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);

    const { detector } = await loadFaceDetector();
    const result = detector.detect(imageData);
    const faces = toFaces(result);

    self.postMessage({ type: 'result', requestId, faces });
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: (err && err.message) || String(err) });
  }
};
