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
 *   -> { type: 'detect', requestId, width, height, pixels: ArrayBuffer (RGBA, transferred),
 *        config?: {
 *          model?: 'short_range' | 'full_range',       // default: 'short_range' (shipped default)
 *          minDetectionConfidence?: number,             // default: 0.3
 *          minSuppressionThreshold?: number,             // default: MediaPipe's own default (0.3)
 *          dedupIouThreshold?: number,                   // default: none (no post-hoc dedup) — Phase B.5 Step 5
 *          unionWithModel?: 'short_range' | 'full_range' // default: none (single model) — Phase B.5 Step 2
 *        } }
 *   <- { type: 'result', requestId, faces: [{ bounding_box, confidence }] }
 *   <- { type: 'error',  requestId, message }
 *
 * `config` is entirely optional and additive — omitting it reproduces
 * today's shipped behavior exactly (single short_range model,
 * minDetectionConfidence 0.3, MediaPipe's own default suppression
 * threshold, no dedup, no union). This is what makes it safe for
 * visionPipeline.js's real production call (detectFaces(canvas), no
 * config) to stay completely unaffected by this Phase B.5 experimentation
 * harness.
 */

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { dedupFaces } from './faceDedup.js';

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

// Phase B.5 Step 1: model variant. short_range is optimized for close-up
// faces (<2m); full_range claims better coverage for smaller/farther faces
// (<5m) — the plan's hypothesis for improving small_distant/multiple_faces
// recall. URLs follow MediaPipe's own documented model-store convention
// (task/model_name/precision/version/file) — same pattern as short_range's
// existing URL below — but full_range's exact URL has NOT been verified by
// an actual successful load in this project (this sandbox cannot run real
// Chrome); if it 404s, check MediaPipe's face detector model card page for
// the current exact path.
const MODEL_URLS = {
  short_range: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  full_range: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite',
};

const DEFAULT_MIN_DETECTION_CONFIDENCE = 0.3;

// Cached per model variant (not a single global) so a union run (Step 2)
// can hold both loaded detectors at once without reloading either between
// calls.
const detectorCache = new Map(); // model -> Promise<{ detector, delegate }>

let filesetResolverPromise = null;
function getFilesetResolver() {
  if (!filesetResolverPromise) {
    // self.location is .../dist/faceDetectionWorker.bundle.js, so
    // '../vendor/mediapipe-wasm' from the worker's own dist/ directory
    // resolves to dist/vendor/mediapipe-wasm — same assets orchestrator.js
    // already ships, just addressed relative to the worker instead of
    // chrome.runtime.getURL (which is not guaranteed inside a worker global).
    filesetResolverPromise = FilesetResolver.forVisionTasks(vendorUrl('vendor/mediapipe-wasm'));
  }
  return filesetResolverPromise;
}

async function loadFaceDetector(model, minDetectionConfidence, minSuppressionThreshold) {
  const cacheKey = `${model}|${minDetectionConfidence}|${minSuppressionThreshold ?? 'default'}`;
  if (detectorCache.has(cacheKey)) return detectorCache.get(cacheKey);

  const loadPromise = (async () => {
    const filesetResolver = await getFilesetResolver();
    const modelAssetPath = MODEL_URLS[model] || MODEL_URLS.short_range;

    const baseOptions = { minDetectionConfidence, ...(minSuppressionThreshold !== undefined ? { minSuppressionThreshold } : {}) };

    async function tryCreate(delegate) {
      return FaceDetector.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'IMAGE',
        ...baseOptions,
      });
    }

    let detector;
    let delegate = 'GPU';
    try {
      detector = await tryCreate('GPU');
    } catch (gpuErr) {
      self.postMessage({ type: 'log', level: 'warn', message: `[Vision Worker] GPU delegate unavailable for ${model}, falling back to CPU/WASM: ${gpuErr.message}` });
      delegate = 'CPU';
      detector = await tryCreate('CPU');
    }

    return { detector, delegate };
  })();

  detectorCache.set(cacheKey, loadPromise);
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
  const config = msg.config || {};
  const model = config.model || 'short_range';
  const minDetectionConfidence = config.minDetectionConfidence !== undefined ? config.minDetectionConfidence : DEFAULT_MIN_DETECTION_CONFIDENCE;
  const minSuppressionThreshold = config.minSuppressionThreshold; // undefined = MediaPipe's own default
  const dedupIouThreshold = config.dedupIouThreshold;
  const unionWithModel = config.unionWithModel;
  const configActuallyApplied = {
    requested_config: config,
    model,
    model_url: MODEL_URLS[model] || MODEL_URLS.short_range,
    minDetectionConfidence,
    minSuppressionThreshold: minSuppressionThreshold ?? null,
    dedupIouThreshold: dedupIouThreshold ?? null,
    unionWithModel: unionWithModel || null,
    models_loaded: [],
  };

  self.postMessage({ type: 'log', level: 'info', message: `[Vision Worker] config_actually_applied ${JSON.stringify(configActuallyApplied)}` });

  try {
    if (!width || !height || !pixels) {
      self.postMessage({ type: 'result', requestId, faces: [] });
      return;
    }

    // Rehydrate the transferred RGBA ArrayBuffer into an ImageData object,
    // which MediaPipe's detect() accepts directly as an image-like source.
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);

    const { detector } = await loadFaceDetector(model, minDetectionConfidence, minSuppressionThreshold);
    configActuallyApplied.models_loaded.push(model);
    const t0 = Date.now();
    let faces = toFaces(detector.detect(imageData));
    const primaryLatencyMs = Date.now() - t0;
    let secondaryLatencyMs = 0;

    // Phase B.5 Step 2: union of two models' detections for the same
    // frame — run the second model too, then dedup the combined set.
    if (unionWithModel && unionWithModel !== model) {
      const { detector: secondDetector } = await loadFaceDetector(unionWithModel, minDetectionConfidence, minSuppressionThreshold);
      configActuallyApplied.models_loaded.push(unionWithModel);
      const t1 = Date.now();
      const secondFaces = toFaces(secondDetector.detect(imageData));
      secondaryLatencyMs = Date.now() - t1;
      faces = dedupFaces([...faces, ...secondFaces], dedupIouThreshold || 0.5);
    } else if (dedupIouThreshold) {
      faces = dedupFaces(faces, dedupIouThreshold);
    }

    self.postMessage({
      type: 'result',
      requestId,
      faces,
      config_actually_applied: configActuallyApplied,
      latency_ms: { primary: primaryLatencyMs, secondary: secondaryLatencyMs, total: primaryLatencyMs + secondaryLatencyMs },
    });
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: (err && err.message) || String(err) });
  }
};
