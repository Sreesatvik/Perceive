export const IOU_MATCH_THRESHOLD = 0.3;

export function iou(boxA, boxB) {
  const [ax, ay, aw, ah] = boxA;
  const [bx, by, bw, bh] = boxB;
  const ax2 = ax + aw, ay2 = ay + ah, bx2 = bx + bw, by2 = by + bh;
  const interX1 = Math.max(ax, bx), interY1 = Math.max(ay, by);
  const interX2 = Math.min(ax2, bx2), interY2 = Math.min(ay2, by2);
  const interW = Math.max(0, interX2 - interX1), interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;
  const unionArea = aw * ah + bw * bh - interArea;
  return unionArea <= 0 ? 0 : interArea / unionArea;
}

export function scoreDetection(detectedFaces, groundTruth, threshold = IOU_MATCH_THRESHOLD) {
  const matchedGtIdx = new Set();
  const matches = [];
  for (let di = 0; di < detectedFaces.length; di++) {
    let bestGi = -1, bestIou = 0;
    for (let gi = 0; gi < groundTruth.length; gi++) {
      if (matchedGtIdx.has(gi)) continue;
      const value = iou(detectedFaces[di].box, groundTruth[gi]);
      if (value > bestIou) { bestIou = value; bestGi = gi; }
    }
    if (bestGi !== -1 && bestIou >= threshold) {
      matchedGtIdx.add(bestGi);
      matches.push({ detIdx: di, gtIdx: bestGi, iou: bestIou });
    }
  }

  return {
    matches,
    truePositives: matches.length,
    falseNegatives: groundTruth.length - matches.length,
    falsePositives: detectedFaces.length - matches.length,
  };
}
