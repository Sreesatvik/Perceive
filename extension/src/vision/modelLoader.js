/**
 * Lazy singleton loaders for the two on-device vision models (Phase 2.2).
 *
 * Model choice note (deviates from the plan's illustrative transformers.js
 * sketch — see test-logs/phase2_test_log.md for the full rationale): there
 * is no real, published ONNX face-detection or general-purpose OCR model
 * packaged for transformers.js today. This uses two verified, real,
 * purpose-built libraries instead:
 *   - Face detection: @mediapipe/tasks-vision (Google's official task API,
 *     WASM + GPU-delegate backends, ships a small BlazeFace-based model).
 *   - OCR: tesseract.js (the standard in-browser OCR engine, WASM-based).
 */

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { createWorker } from 'tesseract.js';

function extensionUrl(relativePath) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(relativePath);
  }
  // Test-harness / plain-webpage fallback (sandbox, Node-driven browser tests):
  // resolve relative to the current document location instead.
  return relativePath;
}

let cachedFaceDetector = null;
let faceDetectorLoadPromise = null;

/**
 * Loads (once) and returns a MediaPipe FaceDetector. Tries the GPU delegate
 * first (WebGPU-backed on platforms that support it) and transparently
 * falls back to the CPU/WASM delegate on any failure — required so the
 * pipeline never crashes on a browser/device without WebGPU support.
 * @returns {Promise<{ detector: import('@mediapipe/tasks-vision').FaceDetector, delegate: 'GPU' | 'CPU' }>}
 */
export async function loadFaceDetector() {
  if (cachedFaceDetector) return cachedFaceDetector;
  if (faceDetectorLoadPromise) return faceDetectorLoadPromise;

  faceDetectorLoadPromise = (async () => {
    const filesetResolver = await FilesetResolver.forVisionTasks(
      extensionUrl('dist/vendor/mediapipe-wasm')
    );

    const modelAssetPath =
      'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

    async function tryCreate(delegate) {
      return FaceDetector.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.3, // conservatively low: favor recall over precision (fail-closed)
      });
    }

    let detector;
    let delegate = 'GPU';
    try {
      detector = await tryCreate('GPU');
    } catch (gpuErr) {
      console.warn('[Vision] GPU delegate unavailable, falling back to CPU/WASM:', gpuErr.message);
      delegate = 'CPU';
      detector = await tryCreate('CPU');
    }

    cachedFaceDetector = { detector, delegate };
    return cachedFaceDetector;
  })();

  return faceDetectorLoadPromise;
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
    const worker = await createWorker('eng', 1, {
      workerPath: extensionUrl('dist/vendor/tesseract/worker.min.js'),
      corePath: extensionUrl('dist/vendor/tesseract'),
      // Trained-data is not bundled (large, English-only default covers the
      // common demo case) — fetched once from Tesseract's own CDN and cached
      // by the browser afterwards.
    });
    cachedOcrWorker = worker;
    return worker;
  })();

  return ocrWorkerLoadPromise;
}

/** Test/teardown helper — releases cached model instances. */
export async function unloadModels() {
  if (cachedFaceDetector) {
    try { cachedFaceDetector.detector.close(); } catch (_e) { /* noop */ }
    cachedFaceDetector = null;
    faceDetectorLoadPromise = null;
  }
  if (cachedOcrWorker) {
    try { await cachedOcrWorker.terminate(); } catch (_e) { /* noop */ }
    cachedOcrWorker = null;
    ocrWorkerLoadPromise = null;
  }
}
