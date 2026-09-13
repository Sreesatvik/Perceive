// Phase D.3 / Step 5 — graceful-degradation regression test.
//
// This sandbox cannot drive a real Chrome tab (see the Phase B/D.3 real-
// Chrome limitations noted throughout this project), so this test exercises
// the two REAL, decoupled points where "vision engine unavailable" actually
// manifests in the shipped pipeline, rather than mocking orchestrator.js's
// internals wholesale:
//
//   1. visionPipeline.js's detectFaces() and ocrPipeline.js's runOcr() both
//      fail OPEN to `[]` on any internal error (confirmed by reading their
//      source — both wrap their body in try/catch and return [] on
//      failure, never rethrow). So "vision engine unavailable" for the rest
//      of the pipeline IS EXACTLY the case `{ faces: [], ocrLines: [] }`
//      reaching dev2/redaction-engine.js's processPageForRedaction() — this
//      test simulates that real fail-open shape directly against the real
//      redaction engine (not a stub), on a real sensitive DOM field, and
//      confirms it does not crash and still redacts via the DOM channel
//      alone.
//   2. orchestrator.js's status tracking (dashboardUtils.js's
//      summarizeVisionStatus, unit tested in test-dashboard-utils.js) is
//      what turns "engine failed this step" into the dashboard's honest
//      "unavailable" label — confirmed here too, so the two halves of
//      graceful degradation (pipeline keeps working + dashboard tells the
//      truth about it) are both covered.
import assert from 'assert';
import { createTokenVault } from '../../dev2/token-vault.js';
import { processPageForRedaction } from '../../dev2/redaction-engine.js';
import { assertSafeToSend } from '../../dev2/leakage-auditor.js';
import { detectPII } from '../../dev2/pii-patterns.js';
import { summarizeVisionStatus } from '../src/panel/dashboardUtils.js';

console.log('=== RUNNING PHASE D.3 GRACEFUL-DEGRADATION TEST SUITE ===\n');

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
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }),
  toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' + validBase64Padding,
};

function mockLoginForm() {
  return [
    {
      id: 'username-field',
      tagName: 'INPUT',
      type: 'text',
      value: 'tomsmith',
      getAttribute: (attr) => (attr === 'name' || attr === 'id' ? 'username' : null),
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 200, height: 30 }),
    },
    {
      id: 'password-field',
      tagName: 'INPUT',
      type: 'password',
      value: 'SuperSecret!123',
      getAttribute: (attr) => (attr === 'type' ? 'password' : null),
      getBoundingClientRect: () => ({ x: 10, y: 50, width: 200, height: 30 }),
    },
  ];
}

runTestCase('Vision engine fully down (both faces=[] and ocrLines=[], the real fail-open shape) does NOT crash processPageForRedaction on a real login form', () => {
  const vault = createTokenVault();
  const visionData = { faces: [], ocrLines: [] }; // exactly what detectFaces()/runOcr() return on internal failure

  assert.doesNotThrow(() => {
    const payload = processPageForRedaction(mockLoginForm(), mockCanvas, vault, visionData);
    // Task must still be completable: DOM channel alone still finds and
    // redacts the sensitive password field.
    const pwdElement = payload.dom_summary.elements.find((el) => el.element_id === 'password-field');
    assert.ok(pwdElement, 'password field must still be present in dom_summary');
    assert.strictEqual(pwdElement.is_sensitive, true, 'password field must still be flagged sensitive via the DOM channel alone');
    assert.ok(payload.redacted_regions.length >= 1, 'at least the password field must be redacted');
  }, 'processPageForRedaction must never throw just because the vision channel came back empty/unavailable');
});

runTestCase('With the vision engine down, the task still completes with zero raw leakage (assertSafeToSend still passes)', () => {
  const vault = createTokenVault();
  const visionData = { faces: [], ocrLines: [] };
  const payload = processPageForRedaction(mockLoginForm(), mockCanvas, vault, visionData);

  assert.doesNotThrow(() => assertSafeToSend(payload, detectPII), 'DOM-only redaction with vision down must still produce a leak-free payload');
});

runTestCase('A DOM-only degraded run produces zero vision-sourced findings (no fabricated vision detections when the engine is down)', () => {
  const vault = createTokenVault();
  const visionData = { faces: [], ocrLines: [] };
  const payload = processPageForRedaction(mockLoginForm(), mockCanvas, vault, visionData);

  const visionSourced = payload.redacted_regions.filter((r) => r.detection_source === 'vision_model' || r.detection_source === 'ocr_regex');
  assert.strictEqual(visionSourced.length, 0, 'no region should be attributed to vision/OCR when the engine produced nothing');
});

runTestCase('Dashboard status labeling: when the vision engine actually failed this step, both engines are honestly reported unavailable (never a generic "vision: available")', () => {
  const status = summarizeVisionStatus({ faceDetectionFailed: true, ocrFailed: true });
  assert.ok(status.ocr.includes('unavailable'));
  assert.ok(status.faceDetection.includes('unavailable'));
});

console.log(`\n--- ALL ${passCount} / ${totalCount} GRACEFUL-DEGRADATION TESTS PASSED SUCCESSFULLY ---`);
