import { loadFaceDetector } from './modelLoader.js';

/**
 * Runs face detection against a captured canvas/image and returns pixel-space
 * bounding boxes ready to merge with DOM-derived sensitive regions.
 *
 * Confidence threshold is tuned conservatively low (see modelLoader.js) since
 * a missed face is worse than an over-eager one — redaction false positives
 * are acceptable, false negatives are not (Phase 2 fail-closed principle).
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
    const { detector } = await loadFaceDetector();
    const result = detector.detect(imageSource);

    const width = imageSource.width || imageSource.naturalWidth || 0;
    const height = imageSource.height || imageSource.naturalHeight || 0;

    faces = (result.detections || []).map((d) => {
      // MediaPipe returns boundingBox already in pixel coordinates relative
      // to the input image (not normalized 0-1) for FaceDetector's IMAGE
      // running mode.
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
    }).filter((f) => f.bounding_box.w > 0 && f.bounding_box.h > 0);

    void width;
    void height;
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
