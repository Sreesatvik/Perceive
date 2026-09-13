/**
 * Face detection runs inside a dedicated, CLASSIC (non-module) Web Worker
 * (faceDetectionWorker.js). See that file's header comment for the full,
 * empirically-verified explanation of why a classic worker is required at
 * all (MediaPipe's WASM glue loader relies on classic-worker
 * importScripts() to set a global; a module worker's importScripts()
 * throws, breaking it).
 *
 * WHERE the worker is spawned matters too, and changed after real-world
 * testing surfaced a second issue: spawning `new Worker(chrome-extension://...)`
 * directly from a content script running on a real, security-conscious
 * site (observed live on leetcode.com) throws:
 *   SecurityError: Failed to construct 'Worker': Script at
 *   'chrome-extension://.../faceDetectionWorker.bundle.js' cannot be
 *   accessed from origin 'https://leetcode.com'.
 * This is the HOST PAGE's own Content-Security-Policy (worker-src)
 * rejecting a cross-origin worker script, independent of this extension's
 * own manifest.json web_accessible_resources declaration — a page's CSP
 * can block this regardless of what the extension permits.
 *
 * Fix: the worker is now spawned from the BACKGROUND SERVICE WORKER
 * (extension/src/background/transport.js) instead of the content script.
 * The background service worker's own execution context has a
 * chrome-extension:// origin and is never subject to any web page's CSP,
 * so it can construct the worker unconditionally. The content script
 * relays detection requests to it via chrome.runtime.sendMessage (mirrors
 * the existing SEND_PAYLOAD pattern already used for network calls).
 *
 * A direct-worker fallback is kept for non-extension contexts (the
 * sandbox/plain-webpage test harness, where chrome.runtime doesn't exist
 * and the cross-origin CSP issue above doesn't apply anyway, since nothing
 * is loaded from a chrome-extension:// URL in that context).
 *
 * This module's external contract is unchanged: detectFaces(imageSource)
 * still returns Promise<Array<{ bounding_box, confidence }>> and fails open
 * (never throws / never blocks the rest of the pipeline).
 */

function hasExtensionRuntime() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
}

function extensionUrl(relativePath) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(relativePath);
  }
  return relativePath;
}

// --- Direct-worker fallback path (non-extension contexts only: sandbox /
// plain-webpage test harness. Real extension usage always goes through
// detectViaBackground() below instead.) ---
let localWorker = null;
let nextLocalRequestId = 1;
const localPending = new Map();

function getLocalWorker() {
  if (localWorker) return localWorker;

  localWorker = new Worker(extensionUrl('dist/faceDetectionWorker.bundle.js'));

  localWorker.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'log') {
      const level = msg.level === 'warn' ? console.warn : console.log;
      level(msg.message);
      return;
    }
    const entry = localPending.get(msg.requestId);
    if (!entry) return;
    localPending.delete(msg.requestId);
    if (msg.type === 'result') {
      entry.resolve(msg.faces || []);
    } else if (msg.type === 'error') {
      entry.reject(new Error(msg.message || 'Face detection worker error'));
    }
  };

  localWorker.onerror = (event) => {
    const err = new Error((event && event.message) || 'Face detection worker crashed');
    for (const { reject } of localPending.values()) reject(err);
    localPending.clear();
    try { localWorker.terminate(); } catch (_e) { /* noop */ }
    localWorker = null;
  };

  return localWorker;
}

function detectViaLocalWorker(width, height, buffer) {
  return new Promise((resolve, reject) => {
    const requestId = nextLocalRequestId++;
    localPending.set(requestId, { resolve, reject });
    getLocalWorker().postMessage(
      { type: 'detect', requestId, width, height, pixels: buffer },
      [buffer]
    );
  });
}

// --- Background-relay path (real extension content-script context) ---
function detectViaBackground(width, height, buffer) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'DETECT_FACES', width, height, pixels: encodePixelBuffer(buffer) },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error((response && response.error) || 'DETECT_FACES failed'));
          return;
        }
        resolve(response.faces || []);
      }
    );
  });
}

function encodePixelBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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

      faces = hasExtensionRuntime()
        ? await detectViaBackground(width, height, buffer)
        : await detectViaLocalWorker(width, height, buffer);
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

/** Test/teardown helper — releases the cached local-fallback worker instance. */
export function unloadFaceDetectionWorker() {
  if (localWorker) {
    try { localWorker.terminate(); } catch (_e) { /* noop */ }
    localWorker = null;
  }
  for (const { reject } of localPending.values()) reject(new Error('Face detection worker torn down'));
  localPending.clear();
}
