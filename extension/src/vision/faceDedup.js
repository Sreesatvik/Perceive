/**
 * Phase B.5 Step 5 — IoU-based post-hoc dedup of face detections.
 *
 * Pure, side-effect-free by design (no `self`/worker globals) so it's
 * directly unit-testable in plain Node (see tests/test-face-dedup.js) and
 * importable from faceDetectionWorker.js without pulling in any
 * worker-only behavior.
 *
 * Motivating case from the original real-Chrome run: angled_1.jpg
 * produced two overlapping boxes for what visually appeared to be one
 * face. This merges near-duplicate detections (by IoU, greedy
 * highest-confidence-first) down to one — independent of MediaPipe's own
 * internal NMS (minSuppressionThreshold), since that operates on raw
 * anchor-box proposals before decoding, not on the final returned boxes
 * this function sees.
 */

export function iou(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
  const interX1 = Math.max(a.x, b.x), interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2), interY2 = Math.min(ay2, by2);
  const interW = Math.max(0, interX2 - interX1), interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;
  const unionArea = a.w * a.h + b.w * b.h - interArea;
  return unionArea <= 0 ? 0 : interArea / unionArea;
}

/**
 * @param {Array<{bounding_box: {x,y,w,h}, confidence: number}>} faces
 * @param {number} [iouThreshold] falsy (0/undefined) disables dedup entirely — a no-op, matching today's shipped (no-dedup) behavior.
 */
export function dedupFaces(faces, iouThreshold) {
  if (!iouThreshold) return faces;
  const sorted = [...faces].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const face of sorted) {
    const overlapsKept = kept.some((k) => iou(k.bounding_box, face.bounding_box) >= iouThreshold);
    if (!overlapsKept) kept.push(face);
  }
  return kept;
}
