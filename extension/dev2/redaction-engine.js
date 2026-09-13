import { classifyElement, getElementId } from './dom-heuristics.js';
import { detectPII } from './pii-patterns.js';
import { classifySensitivity } from './sensitivity-tiers.js';
import { redactImage, canvasToBase64 } from './redaction-renderer.js';
import { mergeSensitivityChannels } from './channel-consistency-check.js';

/**
 * Top-level orchestrator function to process page elements and source canvas/image for redaction.
 * @param {HTMLElement[]} elements - List of DOM elements to classify and inspect.
 * @param {HTMLCanvasElement | HTMLImageElement} sourceCanvasOrImage - Canvas or image element to redact.
 * @param {object} tokenVault - Session-scoped Token Vault instance (REQUIRED).
 * @param {{
 *   faces?: Array<{ bounding_box: {x:number,y:number,w:number,h:number}, confidence: number }>,
 *   ocrLines?: Array<{ text: string, bounding_box: {x:number,y:number,w:number,h:number}, confidence: number }>
 * }} [visionData] - Phase 2: on-device vision-channel detections. Faces are
 *   always redacted (no PII pattern applies to a face); OCR lines are run
 *   through the SAME detectPII()/classifySensitivity() pipeline used for DOM
 *   text, so PII-pattern and tiering logic is never duplicated across channels.
 * @param {string[]} [originConfirmedLabels] - Phase 3.2: field labels the
 *   user previously confirmed sensitive for this origin, earlier in the
 *   same browser session. Used ONLY as a confidence-score boost on an
 *   already-independently-detected sensitive field — never changes
 *   is_sensitive, sensitivity_tier, or whether redaction/tokenization
 *   happens. Safe to omit, pass empty, or pass a stale/corrupted list.
 * @returns {{
 *   dom_summary: {
 *     url: string,
 *     elements: Array<{
 *       element_id: string,
 *       tag: string,
 *       role: string | null,
 *       label_text: string | null,
 *       is_sensitive: boolean,
 *       sensitivity_tier: 1 | 2 | 3,
 *       sensitivity_type: string,
 *       semantic_token: string | null,
 *       has_stable_token: boolean,
 *       bounding_box: {x: number, y: number, w: number, h: number}
 *     }>
 *   },
 *   redacted_image_base64: string,
 *   detection_confidence_notes: Array<{element_id: string, confidence: number, method: 'dom_heuristic' | 'vision_model' | 'ocr_regex'}>,
 *   redacted_regions: Array<{element_id: string, bounding_box: {x: number, y: number, w: number, h: number}, sensitivity_tier: 1 | 2 | 3, semantic_token: string | null}>
 * }}
 */
export function processPageForRedaction(elements = [], sourceCanvasOrImage, tokenVault, visionData = null, originConfirmedLabels = []) {
  const confirmedLabelSet = new Set(Array.isArray(originConfirmedLabels) ? originConfirmedLabels : []);
  const currentUrl = typeof window !== 'undefined' && window.location ? window.location.href : '';

  const summaryElements = [];
  const confidenceNotes = [];
  const sensitiveRawValues = [];
  const redactedRegionsList = [];
  const domRegionsForMerge = [];

  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (!el) continue;

      const element_id = getElementId(el);
      const elementClassification = classifyElement(el);

      const rect = typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect()
        : { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };

      const bounding_box = {
        x: Math.round(rect.x || rect.left || 0),
        y: Math.round(rect.y || rect.top || 0),
        w: Math.round(rect.width || 0),
        h: Math.round(rect.height || 0)
      };

      // 1. Extract rawValue by priority order
      let rawValue = null;
      if (el.value !== undefined && el.value !== null && String(el.value).trim() !== '') {
        rawValue = el.value;
      } else if (el.innerText && el.innerText.trim() !== '') {
        rawValue = el.innerText.trim();
      } else {
        rawValue = null;
      }

      const textToScan = rawValue || el.textContent || '';
      const piiMatches = detectPII(textToScan);

      // 2. Classify sensitivity passing rawValue and tokenVault
      const sensitivity = classifySensitivity(elementClassification, piiMatches, rawValue, tokenVault);
      const { sensitivity_tier, sensitivity_type, semantic_token, reason } = sensitivity;
      const is_sensitive = sensitivity_tier !== 3;

      // 3. Verify token presence in vault
      const has_stable_token = Boolean(
        semantic_token &&
        tokenVault &&
        typeof tokenVault.hasToken === 'function' &&
        tokenVault.hasToken(semantic_token)
      );
      // Tells the backend whether this field actually contains a real
      // value right now (server/app/models.py's check_sensitive_has_token
      // validator requires a semantic_token whenever is_sensitive AND
      // has_value are both true — this field is how it knows the
      // difference between "sensitive but empty" and "sensitive with an
      // unredacted value that must be tokenized").
      const has_value = Boolean(rawValue && String(rawValue).trim() !== '');

      summaryElements.push({
        element_id,
        tag: elementClassification.tag,
        role: elementClassification.role,
        label_text: elementClassification.label_text,
        is_sensitive,
        sensitivity_tier,
        sensitivity_type,
        semantic_token,
        has_stable_token,
        has_value,
        bounding_box,
        reason
      });

      let confidence = 0.92;
      let method = 'dom_heuristic';

      if (elementClassification && elementClassification.sensitivity_type !== 'UNKNOWN') {
        confidence = 0.92;
        method = 'dom_heuristic';
      } else if (piiMatches && piiMatches.length > 0) {
        confidence = 0.6;
        method = 'ocr_regex';
      }

      // Phase 3.2: a field the user has previously confirmed sensitive on
      // this origin gets a confidence BOOST only — is_sensitive,
      // sensitivity_tier, and redaction below are entirely unaffected by
      // this, computed the same as if the memory didn't exist at all.
      let origin_confirmed = false;
      if (is_sensitive && elementClassification.label_text && confirmedLabelSet.has(elementClassification.label_text)) {
        confidence = Math.min(confidence + 0.15, 0.99);
        origin_confirmed = true;
      }

      confidenceNotes.push({
        element_id,
        confidence,
        method,
        origin_confirmed
      });

      if (sensitivity_tier === 1 || sensitivity_tier === 2) {
        domRegionsForMerge.push({
          box: bounding_box,
          bounding_box,
          sensitivity_tier,
          sensitivity_type,
          semantic_token,
          element_id,
          source: 'dom',
          detection_method: method,
          is_sensitive: true,
          reason
        });

        redactedRegionsList.push({
          element_id,
          bounding_box,
          sensitivity_tier,
          semantic_token,
          reason
        });

        if (rawValue && String(rawValue).trim()) {
          sensitiveRawValues.push(String(rawValue).trim());
        }
        for (const m of piiMatches) {
          if (m && m.match && m.match.trim()) {
            sensitiveRawValues.push(m.match.trim());
          }
        }
      }
    }
  }

  // --- Phase 2: vision-channel detections (faces, OCR-caught PII in
  // non-DOM regions like <canvas>). Faces have no PII pattern to match —
  // they're always treated as tier-1/hard-redact. OCR lines are run
  // through the exact same detectPII()/classifySensitivity() calls used
  // above for DOM text, so there is only ever one PII-pattern/tiering
  // implementation, never two that could drift apart.
  const visionRegionsForMerge = [];
  let visionCounter = 0;

  if (visionData && Array.isArray(visionData.faces)) {
    for (const face of visionData.faces) {
      if (!face || !face.bounding_box) continue;
      visionCounter++;
      const syntheticId = `vision-face-${visionCounter}`;

      visionRegionsForMerge.push({
        box: face.bounding_box,
        bounding_box: face.bounding_box,
        sensitivity_tier: 1,
        sensitivity_type: 'FACE',
        semantic_token: null,
        element_id: syntheticId,
        source: 'vision',
        detection_method: 'vision_model',
        confidence: typeof face.confidence === 'number' ? face.confidence : 0.5,
        render: 'box',
        reason: 'detected as face by vision model'
      });
    }
  }

  if (visionData && Array.isArray(visionData.ocrLines)) {
    for (const line of visionData.ocrLines) {
      if (!line || !line.text) continue;
      const piiMatches = detectPII(line.text);
      if (piiMatches.length === 0) continue;

      const sensitivity = classifySensitivity(null, piiMatches, line.text, tokenVault);
      if (sensitivity.sensitivity_tier !== 1 && sensitivity.sensitivity_tier !== 2) continue;

      visionCounter++;
      const syntheticId = `vision-ocr-${visionCounter}`;

      visionRegionsForMerge.push({
        box: line.bounding_box,
        bounding_box: line.bounding_box,
        sensitivity_tier: sensitivity.sensitivity_tier,
        sensitivity_type: sensitivity.sensitivity_type,
        semantic_token: sensitivity.semantic_token,
        element_id: syntheticId,
        source: 'vision',
        detection_method: 'ocr_regex',
        confidence: typeof line.confidence === 'number' ? line.confidence : 0.5,
        render: 'box',
        reason: `${sensitivity.reason} in on-screen text (OCR)`
      });

      sensitiveRawValues.push(line.text.trim());
      for (const m of piiMatches) {
        if (m && m.match && m.match.trim()) {
          sensitiveRawValues.push(m.match.trim());
        }
      }
    }
  }

  const mergedRegions = mergeSensitivityChannels(domRegionsForMerge, visionRegionsForMerge);

  // Reflect vision confirmation back onto the existing DOM-sourced audit
  // entries, and append new entries (+ confidence notes) for vision-only
  // detections that had no DOM counterpart to merge into.
  for (const region of mergedRegions) {
    if (region.source === 'vision') {
      redactedRegionsList.push({
        element_id: region.element_id,
        bounding_box: region.bounding_box,
        sensitivity_tier: region.sensitivity_tier,
        semantic_token: region.semantic_token,
        sensitivity_type: region.sensitivity_type,
        detection_source: region.detection_method,
        reason: region.reason
      });
      confidenceNotes.push({
        element_id: region.element_id,
        confidence: region.confidence,
        method: region.detection_method
      });
    } else if (region.visionConfirmed) {
      const existing = redactedRegionsList.find(r => r.element_id === region.element_id);
      if (existing) existing.vision_confirmed = true;
    }
  }

  const renderRegions = mergedRegions.map(r => ({
    bounding_box: r.bounding_box,
    sensitivity_tier: r.sensitivity_tier,
    render: r.render || 'pill'
  }));

  const redactedCanvas = redactImage(sourceCanvasOrImage, renderRegions);
  const redacted_image_base64 = canvasToBase64(redactedCanvas);

  const output = {
    dom_summary: {
      url: currentUrl,
      elements: summaryElements
    },
    redacted_image_base64,
    detection_confidence_notes: confidenceNotes,
    redacted_regions: redactedRegionsList
  };

  // Top-level Recursive Guard Assertion: confirm no sensitive raw values leak into output object tree
  function walkAndAssert(node, path) {
    if (node === null || node === undefined) return;
    if (path === 'redacted_image_base64') return;

    if (typeof node === 'string') {
      for (const rawVal of sensitiveRawValues) {
        if (!rawVal || rawVal.length < 3) continue;
        if (node.includes(rawVal) && !node.startsWith('[')) {
          throw new Error(`Privacy Assertion Violated: Raw sensitive value "${rawVal}" found in output object at "${path}"`);
        }
      }
      return;
    }

    if (typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkAndAssert(node[i], `${path}[${i}]`);
      }
      return;
    }

    for (const key of Object.keys(node)) {
      const childPath = path ? `${path}.${key}` : key;
      walkAndAssert(node[key], childPath);
    }
  }

  walkAndAssert(output, '');

  return output;
}
