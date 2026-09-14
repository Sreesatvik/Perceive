/**
 * Channel Consistency Check Module
 * 
 * Independent verification layer comparing STRUCTURAL redaction (dom_summary.elements)
 * with VISUAL redaction (redactedRegions) before network dispatch.
 */

/**
 * Checks whether structural redaction requirements match actual visual redaction regions.
 *
 * @param {object} payload - Payload containing dom_summary.elements
 * @param {Array<{element_id: string, bounding_box: object}>} redactedRegions - Regions visually redacted
 * @returns {{ consistent: boolean, mismatches: Array<{element_id: string, issue: string}> }}
 */
export function checkChannelConsistency(payload, redactedRegions) {
  const mismatches = [];

  const elements = (payload && payload.dom_summary && Array.isArray(payload.dom_summary.elements))
    ? payload.dom_summary.elements
    : [];

  const regions = Array.isArray(redactedRegions) ? redactedRegions : [];

  // 1. Set of element_ids that SHOULD be redacted
  //
  // Redaction should be based on sensitivity, not on whether a token
  // happened to be assigned. A tier 1/2 field can be legitimately
  // sensitive with no token yet (e.g. an empty password input, per the
  // Phase 3.1 fix to sensitivity-tiers.js's semantic_token: null for
  // unfilled fields) and must still be treated as "should be redacted" —
  // requiring semantic_token !== null here caused a real, live
  // "visual redaction present but structural summary shows no
  // sensitivity" false-positive failure on an actual empty login form.
  const shouldBeRedacted = new Set();
  for (const el of elements) {
    if (el && el.is_sensitive === true) {
      if (el.element_id) {
        shouldBeRedacted.add(el.element_id);
      }
    }
  }

  // Detection methods used ONLY by the vision channel (see
  // redaction-engine.js's visionRegionsForMerge construction: faces are
  // always 'vision_model', OCR-caught PII is always 'ocr_regex'). No new
  // field was added to redactedRegions entries to mark this — every field
  // that reaches redacted_regions is deliberately allowlisted elsewhere
  // (see test-canvas-balance-pii.js's leak-surface check) as a guard
  // against a raw-value ever hitching a ride on a new key, so this reuses
  // the existing detection_source value instead of adding one.
  const VISION_ONLY_DETECTION_SOURCES = new Set(['vision_model', 'ocr_regex']);

  // 2. Set of element_ids that WERE ACTUALLY visually redacted.
  //
  // Tracked as two sets: `actuallyRedacted` (every region, regardless of
  // source) and `domSourcedRedacted` (regions whose detection_source is
  // NOT vision-only). A vision-only region (a face, or OCR-caught PII in
  // a <canvas> with no DOM node) uses a synthetic element_id
  // ("vision-face-1", "vision-ocr-1", ...) that by construction can never
  // appear in dom_summary.elements — that's not a data-quality problem to
  // flag, it's the whole point of the vision channel per
  // mergeSensitivityChannels' union-not-intersection design (a real,
  // live bug found here: every capture with ANY vision finding was
  // failing this check and exhausting retries, even on step 1). The
  // "structural claimed but visual missing" direction below still checks
  // against the full set — a DOM element correctly never has a vision
  // detection_source, so this doesn't relax that half of the check at all.
  const actuallyRedacted = new Set();
  const domSourcedRedacted = new Set();
  for (const region of regions) {
    if (region && region.element_id) {
      actuallyRedacted.add(region.element_id);
      if (!VISION_ONLY_DETECTION_SOURCES.has(region.detection_source)) {
        domSourcedRedacted.add(region.element_id);
      }
    }
  }

  // 3. Compare sets
  // Structural claimed but visual missing
  for (const id of shouldBeRedacted) {
    if (!actuallyRedacted.has(id)) {
      mismatches.push({
        element_id: id,
        issue: 'structural redaction claimed but visual redaction missing'
      });
    }
  }

  // Visual present but structural missing/not sensitive — only for
  // DOM-sourced regions (see the comment above for why vision-only
  // regions are exempt from this direction of the check).
  for (const id of domSourcedRedacted) {
    if (!shouldBeRedacted.has(id)) {
      mismatches.push({
        element_id: id,
        issue: 'visual redaction present but structural summary shows no sensitivity — possible over-redaction or stale data'
      });
    }
  }

  // 4. Consistent if no mismatches
  return {
    consistent: mismatches.length === 0,
    mismatches
  };
}

/**
 * Hard gate that throws a descriptive Error if visual and structural redactions do not agree.
 *
 * @param {object} payload - Payload containing dom_summary.elements
 * @param {Array<{element_id: string, bounding_box: object}>} redactedRegions - Regions visually redacted
 * @throws {Error} If channel consistency check fails
 */
export function assertChannelsConsistent(payload, redactedRegions) {
  const result = checkChannelConsistency(payload, redactedRegions);

  if (!result.consistent) {
    const details = result.mismatches
      .map(m => `  - [${m.element_id}]: ${m.issue}`)
      .join('\n');

    throw new Error(
      `Channel consistency check failed with ${result.mismatches.length} mismatch(es):\n${details}`
    );
  }
}

/**
 * Intersection-over-union of two {x,y,w,h} boxes, in [0,1].
 * @param {{x:number,y:number,w:number,h:number}} a
 * @param {{x:number,y:number,w:number,h:number}} b
 * @returns {number}
 */
function iou(a, b) {
  if (!a || !b) return 0;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;

  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;

  const unionArea = a.w * a.h + b.w * b.h - interArea;
  if (unionArea <= 0) return 0;

  return interArea / unionArea;
}

/**
 * Phase 2.4 — Channel fusion. Union-based merge of DOM-derived and
 * vision-derived sensitive regions: whichever channel says "sensitive"
 * wins, and redaction coverage only ever grows when a new channel is
 * added, never shrinks. A vision region that overlaps an existing DOM
 * region (IoU > 0.3) is treated as confirming that region rather than
 * added as a duplicate; a vision region with no DOM counterpart (e.g. a
 * face, or PII text in a <canvas> with no backing DOM node) is added
 * outright.
 *
 * This is separate from checkChannelConsistency()/assertChannelsConsistent()
 * above, which specifically cross-checks dom_summary.elements against
 * structural redaction claims by element_id — vision-only regions have no
 * element_id to check against, so they go through this union merge instead.
 *
 * @param {Array<{box: {x:number,y:number,w:number,h:number}, [key: string]: any}>} domRegions
 * @param {Array<{box: {x:number,y:number,w:number,h:number}, [key: string]: any}>} visionRegions
 * @returns {Array<object>} merged region list
 */
export function mergeSensitivityChannels(domRegions, visionRegions) {
  const dom = Array.isArray(domRegions) ? domRegions : [];
  const vision = Array.isArray(visionRegions) ? visionRegions : [];

  const merged = dom.map(r => ({ ...r }));

  for (const vr of vision) {
    const overlapsExisting = merged.some(dr => iou(dr.box, vr.box) > 0.3);
    if (!overlapsExisting) {
      merged.push({ ...vr, source: 'vision', is_sensitive: true });
    } else {
      const match = merged.find(dr => iou(dr.box, vr.box) > 0.3);
      if (match) match.visionConfirmed = true;
    }
  }

  return merged;
}
