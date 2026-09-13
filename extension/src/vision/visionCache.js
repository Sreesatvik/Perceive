/**
 * Phase 2.7 — debounce/skip rule for the vision pipeline.
 *
 * The plan calls for reusing the existing MutationObserver debouncing "already
 * in the orchestrator" to skip re-running vision inference when the DOM
 * hasn't materially changed. That MutationObserver doesn't actually exist
 * yet — screen capture in orchestrator.js is still `mockDev1`, a placeholder
 * pending the real capture module. Building real MutationObserver logic
 * against a hardcoded mock would just be dead code with nothing real to
 * observe.
 *
 * This is the honest interim equivalent: a content-hash memoization, keyed
 * per session, so repeated calls against the SAME captured frame (which the
 * mock's identical output already exercises today, and a real capture module
 * disabled by a debounced observer would produce tomorrow) skip re-running
 * the expensive face/OCR models and reuse the last result. When the real
 * capture module lands, whatever change-detection it uses can feed this same
 * cache instead of (or in addition to) the hash.
 */

const cache = new Map(); // sessionId -> { hash: string, result: { faces, ocrLines } }

/**
 * Cheap, non-cryptographic content signature for a canvas/image. Prefers the
 * pixel data itself when available (toDataURL); falls back to a
 * dimensions-only signature (which never matches twice, i.e. never skips)
 * for sources that don't support it, since failing to skip is always safe —
 * failing to RE-run when content actually changed would not be.
 * @param {HTMLCanvasElement | HTMLImageElement} imageSource
 * @returns {string}
 */
export function hashImageSource(imageSource) {
  if (!imageSource) return '';
  if (typeof imageSource.toDataURL === 'function') {
    try {
      return imageSource.toDataURL('image/png');
    } catch (_e) {
      // e.g. tainted canvas (cross-origin content) — fall through to the
      // always-miss signature below rather than throwing.
    }
  }
  return `no-hash:${Date.now()}:${Math.random()}`;
}

/**
 * Returns the cached vision result for this session if the image content
 * hash is unchanged since the last call, otherwise runs `computeFn` and
 * caches its result.
 * @param {string} sessionId
 * @param {HTMLCanvasElement | HTMLImageElement} imageSource
 * @param {() => Promise<{ faces: Array, ocrLines: Array }>} computeFn
 * @returns {Promise<{ faces: Array, ocrLines: Array, skipped: boolean }>}
 */
export async function getVisionResultCached(sessionId, imageSource, computeFn) {
  const hash = hashImageSource(imageSource);
  const cached = cache.get(sessionId);

  if (cached && hash && cached.hash === hash) {
    return { ...cached.result, skipped: true };
  }

  const result = await computeFn();
  cache.set(sessionId, { hash, result });
  return { ...result, skipped: false };
}

/** Clears a session's cached vision result (call on session teardown). */
export function clearVisionCache(sessionId) {
  cache.delete(sessionId);
}
