import assert from 'assert';
import { createTokenVault } from './token-vault.js';
import { processPageForRedaction } from './redaction-engine.js';
import { assertSafeToSend } from './leakage-auditor.js';
import { detectPII } from './pii-patterns.js';
import { mergeSensitivityChannels } from './channel-consistency-check.js';

console.log('=== RUNNING PHASE 2 VISION-FUSION TEST SUITE ===\n');

let passCount = 0;
let totalCount = 0;

function runTestCase(name, fn) {
  totalCount++;
  try {
    fn();
    passCount++;
    console.log(`[PASS] Test ${totalCount}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Test ${totalCount}: ${name}\n  Error: ${err.message}`);
    throw err;
  }
}

const validBase64Padding = 'A'.repeat(120);
const mockCanvas = {
  getContext: () => ({
    fillRect: () => {},
    clearRect: () => {},
    drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) })
  }),
  toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' + validBase64Padding
};

// --- Scenario: Plain HTML login form (regression) — no vision channel input at all ---
runTestCase('Plain HTML login form (regression): DOM channel alone still redacts correctly, no vision channel', () => {
  const mockPwd = {
    id: 'pwd-plain',
    tagName: 'INPUT',
    type: 'password',
    value: 'SuperSecret!',
    getAttribute: (attr) => (attr === 'type' ? 'password' : null),
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 })
  };

  const vault = createTokenVault();
  const payload = processPageForRedaction([mockPwd], mockCanvas, vault); // no 4th arg

  assert.strictEqual(payload.dom_summary.elements[0].is_sensitive, true);
  assert.strictEqual(payload.redacted_regions.length, 1);
  assert.strictEqual(payload.redacted_regions[0].element_id, 'pwd-plain');
  assert.doesNotThrow(() => assertSafeToSend(payload, detectPII));
});

// --- Scenario: profile photo with a visible face ---
runTestCase('Profile photo with a visible face: vision channel detects and redacts the face region', () => {
  const vault = createTokenVault();
  const visionData = {
    faces: [{ bounding_box: { x: 300, y: 50, w: 80, h: 80 }, confidence: 0.9 }],
    ocrLines: []
  };

  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  assert.strictEqual(payload.dom_summary.elements.length, 0, 'DOM channel is silent — no DOM elements at all');
  assert.strictEqual(payload.redacted_regions.length, 1);
  assert.strictEqual(payload.redacted_regions[0].detection_source, 'vision_model');
  assert.strictEqual(payload.redacted_regions[0].sensitivity_type, 'FACE');
  assert.strictEqual(payload.redacted_regions[0].bounding_box.w, 80);

  const faceNote = payload.detection_confidence_notes.find(n => n.method === 'vision_model');
  assert.ok(faceNote, 'A vision_model confidence note must exist for the detected face');

  assert.doesNotThrow(() => assertSafeToSend(payload, detectPII));
});

// --- Scenario: canvas-rendered balance/dashboard with a card number embedded in OCR text ---
runTestCase('Canvas-rendered dashboard: OCR channel extracts text, PII regex flags it, region redacted with no DOM node', () => {
  const vault = createTokenVault();
  const visionData = {
    faces: [],
    ocrLines: [
      { text: 'Card on file: 4111 1111 1111 1111', bounding_box: { x: 20, y: 200, w: 300, h: 20 }, confidence: 0.85 },
      { text: 'Welcome back!', bounding_box: { x: 20, y: 10, w: 150, h: 20 }, confidence: 0.95 }, // no PII, must be ignored
    ]
  };

  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  assert.strictEqual(payload.dom_summary.elements.length, 0);
  assert.strictEqual(payload.redacted_regions.length, 1, 'Only the PII-bearing line should produce a redacted region');
  assert.strictEqual(payload.redacted_regions[0].detection_source, 'ocr_regex');
  assert.strictEqual(payload.redacted_regions[0].sensitivity_type, 'CARD_NUMBER');
  assert.ok(/^\[CARD_NUMBER_[a-z0-9]{10}\]$/.test(payload.redacted_regions[0].semantic_token));

  // The raw card number must never appear anywhere in the outgoing payload.
  const payloadStr = JSON.stringify(payload);
  assert.strictEqual(payloadStr.includes('4111 1111 1111 1111'), false);
  assert.strictEqual(payloadStr.includes('4111111111111111'), false);

  assert.doesNotThrow(() => assertSafeToSend(payload, detectPII));
});

// --- Scenario: low-confidence detection still redacts (fail-closed on threshold policy) ---
runTestCase('Low-confidence face/OCR detections still redact — fail-closed, not filtered out here', () => {
  const vault = createTokenVault();
  const visionData = {
    faces: [{ bounding_box: { x: 0, y: 0, w: 40, h: 40 }, confidence: 0.05 }], // very low confidence
    ocrLines: [{ text: 'user@example.com', bounding_box: { x: 0, y: 100, w: 100, h: 15 }, confidence: 0.1 }]
  };

  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  assert.strictEqual(payload.redacted_regions.length, 2, 'Both low-confidence detections still produce redacted regions');
  // Confidence is preserved for audit/debug visibility (Phase 4 dashboard), not silently dropped.
  const confidences = payload.detection_confidence_notes.map(n => n.confidence);
  assert.ok(confidences.includes(0.05));
  assert.ok(confidences.includes(0.1));
});

// --- mergeSensitivityChannels unit tests ---
runTestCase('mergeSensitivityChannels: vision region overlapping a DOM region marks it visionConfirmed, does not duplicate', () => {
  const domRegions = [{ box: { x: 10, y: 10, w: 100, h: 20 }, element_id: 'el-1', source: 'dom' }];
  const visionRegions = [{ box: { x: 12, y: 11, w: 95, h: 20 }, source: 'vision' }]; // heavy overlap

  const merged = mergeSensitivityChannels(domRegions, visionRegions);
  assert.strictEqual(merged.length, 1, 'Overlapping vision region must not create a duplicate entry');
  assert.strictEqual(merged[0].visionConfirmed, true);
});

runTestCase('mergeSensitivityChannels: non-overlapping vision region is added as a new entry', () => {
  const domRegions = [{ box: { x: 10, y: 10, w: 100, h: 20 }, element_id: 'el-1', source: 'dom' }];
  const visionRegions = [{ box: { x: 500, y: 500, w: 50, h: 50 }, source: 'vision' }]; // no overlap

  const merged = mergeSensitivityChannels(domRegions, visionRegions);
  assert.strictEqual(merged.length, 2, 'Non-overlapping vision region must be added as a distinct entry');
  const added = merged.find(r => r.source === 'vision');
  assert.ok(added);
  assert.strictEqual(added.is_sensitive, true);
});

runTestCase('mergeSensitivityChannels: redaction coverage only grows, never shrinks (union, not intersection)', () => {
  const domRegions = [
    { box: { x: 0, y: 0, w: 10, h: 10 }, element_id: 'a' },
    { box: { x: 100, y: 100, w: 10, h: 10 }, element_id: 'b' },
  ];
  const visionRegions = []; // vision channel found nothing this time

  const merged = mergeSensitivityChannels(domRegions, visionRegions);
  assert.strictEqual(merged.length, 2, 'DOM-detected regions must never be dropped just because vision found nothing');
});

console.log(`\n--- ALL ${passCount} / ${totalCount} PHASE 2 VISION-FUSION TESTS PASSED SUCCESSFULLY ---`);
