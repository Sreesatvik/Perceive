/**
 * Lazy singleton loader for the OCR model (Phase 2.2).
 *
 * Model choice note (deviates from the plan's illustrative transformers.js
 * sketch — see test-logs/phase2_test_log.md for the full rationale): there
 * is no real, published ONNX general-purpose OCR model packaged for
 * transformers.js today. This uses tesseract.js instead (the standard
 * in-browser OCR engine, WASM-based, runs inside its own Web Worker).
 *
 * Face detection (@mediapipe/tasks-vision) used to be loaded from this file
 * too, but MediaPipe's WASM glue script always executes in the page's main
 * world (it's injected as a <script> tag) even when the loading code runs
 * in a content script's isolated world — the two worlds have separate JS
 * globals, so the glue script's `ModuleFactory` global was invisible to the
 * isolated-world caller ("ModuleFactory not set", on both the GPU and
 * CPU/WASM delegate attempts). Tesseract.js doesn't hit this because it
 * already runs inside a dedicated Worker, which has its own global scope
 * regardless of isolated/main-world semantics. Face detection has been
 * moved into its own dedicated worker for the same reason — see
 * faceDetectionWorker.js and visionPipeline.js.
 */

import { createWorker } from 'tesseract.js';
import { VISION_TIMEOUT_MS } from '../shared/constants.js';

function extensionUrl(relativePath) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(relativePath);
  }
  // Test-harness / plain-webpage fallback (sandbox, Node-driven browser tests):
  // resolve relative to the current document location instead.
  return relativePath;
}

let cachedOcrWorker = null;
let ocrWorkerLoadPromise = null;

/**
 * Loads (once) and returns a ready Tesseract.js worker configured to load
 * its WASM core from the extension's own bundled files rather than a CDN.
 * @returns {Promise<import('tesseract.js').Worker>}
 */
export async function loadOcrWorker() {
  if (cachedOcrWorker) return cachedOcrWorker;
  if (ocrWorkerLoadPromise) return ocrWorkerLoadPromise;

  ocrWorkerLoadPromise = (async () => {
    // Raced against VISION_TIMEOUT_MS: eng.traineddata (fetched live from
    // Tesseract's CDN, per the comment below) can stall on a slow/blocked
    // network with no timeout of its own, hanging createWorker()'s promise
    // forever. Unlike a callback-based sendMessage, there's no "late
    // response" to ignore here — createWorker() is a plain promise — so
    // instead of a settled-flag guard, a late resolution (after we've
    // already timed out and moved on) is handled by terminating the
    // now-orphaned worker rather than leaving it running untracked.
    let timedOut = false;
    let timeoutId;

    const timeoutPromise = new Promise((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`OCR worker initialization timed out after ${VISION_TIMEOUT_MS}ms (eng.traineddata fetch may have stalled)`));
      }, VISION_TIMEOUT_MS);
    });

    const createPromise = createWorker('eng', 1, {
      workerPath: extensionUrl('dist/vendor/tesseract/worker.min.js'),
      corePath: extensionUrl('dist/vendor/tesseract'),
      // Trained-data is not bundled (large, English-only default covers the
      // common demo case) — fetched once from Tesseract's own CDN and cached
      // by the browser afterwards.
    }).then((worker) => {
      clearTimeout(timeoutId);
      if (timedOut) {
        worker.terminate().catch(() => {});
        return null; // never observed — timeoutPromise already won the race below
      }
      return worker;
    });

    const worker = await Promise.race([createPromise, timeoutPromise]);
    cachedOcrWorker = worker;
    return worker;
  })();

  return ocrWorkerLoadPromise;
}

/** Test/teardown helper — releases cached model instances. */
export async function unloadModels() {
  if (cachedOcrWorker) {
    try { await cachedOcrWorker.terminate(); } catch (_e) { /* noop */ }
    cachedOcrWorker = null;
    ocrWorkerLoadPromise = null;
  }
}
