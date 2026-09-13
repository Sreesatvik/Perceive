/**
 * Face detection now runs inside a dedicated, CLASSIC (non-module) Web
 * Worker (faceDetectionWorker.js) rather than in this content-script module
 * directly. See faceDetectionWorker.js's header comment for the full,
 * empirically-verified root-cause explanation: MediaPipe's WASM glue loader
 * relies on the classic-worker `importScripts()` API to set a global
 * (`self.ModuleFactory`) after loading its Emscripten glue script; a
 * `type: 'module'` worker's `importScripts()` throws (disallowed by spec),
 * which sends the loader down a fallback path that never sets that global —
 * reproducing "ModuleFactory not set" on both the GPU and CPU delegate. A
 * classic worker's real `importScripts()` sets it correctly. (This is NOT
 * about Chrome extension isolated-world semantics, despite an earlier
 * hypothesis to that effect — the same failure reproduces in a plain
 * webpage's own module worker.) This mirrors why tesseract.js (used for
 * OCR) already works: it loads its worker as a classic script too.
 *
 * This module's external contract is unchanged: detectFaces(imageSource)
 * still returns Promise<Array<{ bounding_box, confidence }>> and fails open
 * (never throws / never blocks the rest of the pipeline).
 */

function extensionUrl(relativePath) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(relativePath);
  }
  return relativePath;
}

let worker = null;
let nextRequestId = 1;
const pending = new Map(); // requestId -> { resolve, reject }

function getWorker() {
  if (worker) return worker;

  // IMPORTANT: no `{ type: 'module' }` here. MediaPipe's internal WASM glue
  // loader relies on the classic-worker `importScripts()` to set a global
  // (`self.ModuleFactory`) after loading its Emscripten glue script. A
  // module worker throws on `importScripts()` (disallowed by spec), which
  // sends the loader down a fallback `import()` path that does not end up
  // setting that global — reproducing "ModuleFactory not set" on both the
  // GPU and CPU delegate, empirically confirmed independent of extension
  // isolated-world semantics. See build.mjs's workerBuildOptions comment and
  // faceDetectionWorker.js's header for the full story. The bundle itself is
  // plain ES5/ES2017-ish JS (esbuild resolves our `import` source into an
  // IIFE at build time), so it runs fine as a classic worker script.
  worker = new Worker(extensionUrl('dist/faceDetectionWorker.bundle.js'));

  worker.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'log') {
      const level = msg.level === 'warn' ? console.warn : console.log;
      level(msg.message);
      return;
    }
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    if (msg.type === 'result') {
      entry.resolve(msg.faces || []);
    } else if (msg.type === 'error') {
      entry.reject(new Error(msg.message || 'Face detection worker error'));
    }
  };

  worker.onerror = (event) => {
    // A worker-level error (e.g. failed to load the bundle) can't be tied to
    // a specific requestId — fail every in-flight request open rather than
    // hanging them forever, then drop the worker so the next call retries.
    const err = new Error((event && event.message) || 'Face detection worker crashed');
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    try { worker.terminate(); } catch (_e) { /* noop */ }
    worker = null;
  };

  return worker;
}

/**
 * Extracts RGBA pixel data + dimensions from a canvas/image source so it can
 * be transferred (as an ArrayBuffer) into the face-detection worker. Canvas
 * elements/OffscreenCanvas expose getContext('2d') directly; plain
 * HTMLImageElement sources are first drawn onto a scratch canvas.
 * @param {HTMLCanvasElement | OffscreenCanvas | HTMLImageElement} imageSource
 */
function extractImageData(imageSource) {
  const width = imageSource.width || imageSource.naturalWidth || 0;
  const height = imageSource.height || imageSource.naturalHeight || 0;
  if (!width || !height) return null;

  let ctx;
  if (typeof imageSource.getContext === 'function') {
    ctx = imageSource.getContext('2d');
  } else {
    // HTMLImageElement (or similar drawable without its own 2d context):
    // draw onto a scratch canvas first.
    const scratch = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    ctx = scratch.getContext('2d');
    ctx.drawImage(imageSource, 0, 0, width, height);
  }

  if (!ctx) return null;
  const imageData = ctx.getImageData(0, 0, width, height);
  return { width, height, data: imageData.data };
}

/**
 * Runs face detection against a captured canvas/image and returns pixel-space
 * bounding boxes ready to merge with DOM-derived sensitive regions.
 *
 * Confidence threshold is tuned conservatively low (see faceDetectionWorker.js)
 * since a missed face is worse than an over-eager one — redaction false
 * positives are acceptable, false negatives are not (Phase 2 fail-closed
 * principle).
 *
 * @param {HTMLCanvasElement | HTMLImageElement} imageSource
 * @returns {Promise<Array<{ bounding_box: {x:number,y:number,w:number,h:number}, confidence: number }>>}
 */
export async function detectFaces(imageSource) {
  if (!imageSource) return [];

  const markStart = 'perceive:vision:face-detect:start';
  const markEnd = 'perceive:vision:face-detect:end';
  const measureName = 'perceive:vision:face-detect';

  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(markStart);
  }

  let faces = [];
  try {
    const extracted = extractImageData(imageSource);
    if (!extracted) {
      faces = [];
    } else {
      const { width, height, data } = extracted;
      // data is a Uint8ClampedArray view over an internal buffer; copy into
      // a fresh, transferable ArrayBuffer (structured-clone transfer detaches
      // it from this thread, which is fine — we don't need it afterwards).
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

      faces = await new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        pending.set(requestId, { resolve, reject });
        getWorker().postMessage(
          { type: 'detect', requestId, width, height, pixels: buffer },
          [buffer]
        );
      });
    }
  } catch (err) {
    // Fail-closed on the DETECTION channel itself would mean blocking the
    // whole task on a model-load failure, which is worse than just running
    // without this channel — the DOM channel still covers text-based PII.
    // Log loudly so this isn't silently invisible in the audit dashboard.
    console.error('[Vision] Face detection failed, continuing without this channel:', err);
    faces = [];
  }

  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(markEnd);
    try {
      performance.measure(measureName, markStart, markEnd);
    } catch (_e) { /* noop */ }
  }

  return faces;
}

/** Test/teardown helper — releases the cached worker instance. */
export function unloadFaceDetectionWorker() {
  if (worker) {
    try { worker.terminate(); } catch (_e) { /* noop */ }
    worker = null;
  }
  for (const { reject } of pending.values()) reject(new Error('Face detection worker torn down'));
  pending.clear();
}
