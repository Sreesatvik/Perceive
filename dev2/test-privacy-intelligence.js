import assert from 'assert';
import { createTokenVault } from './token-vault.js';
import { processPageForRedaction } from './redaction-engine.js';
import {
  recordConfirmedSensitiveLabel,
  getConfirmedSensitiveLabels,
  clearOriginProfile,
} from './origin-sensitivity-profile.js';

console.log('=== RUNNING PHASE 3 PRIVACY-INTELLIGENCE TEST SUITE ===\n');

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

async function runAsyncTestCase(name, fn) {
  totalCount++;
  try {
    await fn();
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
    fillRect: () => {}, clearRect: () => {}, drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) })
  }),
  toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' + validBase64Padding
};

function mockPasswordElement(labelText = 'Password') {
  return {
    id: 'pwd-3',
    tagName: 'INPUT',
    type: 'password',
    value: 'SuperSecret!',
    getAttribute: (attr) => (attr === 'type' ? 'password' : null),
    labels: [{ textContent: labelText }],
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 })
  };
}

// --- 3.1: every redacted region has a non-empty, correct reason string ---

runTestCase('3.1: DOM-detected password field gets a reason mentioning its label', () => {
  const vault = createTokenVault();
  const payload = processPageForRedaction([mockPasswordElement('Password')], mockCanvas, vault);

  assert.strictEqual(payload.redacted_regions.length, 1);
  const reason = payload.redacted_regions[0].reason;
  assert.ok(reason && reason.length > 0, 'Reason must be non-empty');
  assert.ok(reason.includes('Password'), `Reason should reference the field label, got: "${reason}"`);
});

runTestCase('3.1: PII-regex-only match (no DOM heuristic) gets a "matched X pattern" reason', () => {
  const vault = createTokenVault();
  const genericEl = {
    id: 'generic-1',
    tagName: 'DIV',
    value: undefined,
    innerText: 'user@example.com',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 })
  };
  const payload = processPageForRedaction([genericEl], mockCanvas, vault);

  assert.strictEqual(payload.redacted_regions.length, 1);
  const reason = payload.redacted_regions[0].reason;
  assert.ok(reason && reason.length > 0, 'Reason must be non-empty');
  assert.ok(reason.includes('EMAIL') && reason.includes('pattern'), `Expected a pattern-match reason, got: "${reason}"`);
});

runTestCase('3.1: vision-detected face gets the exact plan-specified reason', () => {
  const vault = createTokenVault();
  const visionData = { faces: [{ bounding_box: { x: 10, y: 10, w: 50, h: 50 }, confidence: 0.9 }], ocrLines: [] };
  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  assert.strictEqual(payload.redacted_regions.length, 1);
  assert.strictEqual(payload.redacted_regions[0].reason, 'detected as face by vision model');
});

runTestCase('3.1: vision-detected OCR PII gets a pattern reason annotated as OCR-sourced', () => {
  const vault = createTokenVault();
  const visionData = { faces: [], ocrLines: [{ text: '4111 1111 1111 1111', bounding_box: { x: 0, y: 0, w: 100, h: 20 }, confidence: 0.8 }] };
  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  assert.strictEqual(payload.redacted_regions.length, 1);
  const reason = payload.redacted_regions[0].reason;
  assert.ok(reason.includes('CARD_NUMBER') && reason.includes('OCR'), `Expected an OCR-annotated reason, got: "${reason}"`);
});

runTestCase('3.1: every redacted region across a mixed DOM+vision run has a non-empty reason', () => {
  const vault = createTokenVault();
  const visionData = {
    faces: [{ bounding_box: { x: 300, y: 10, w: 50, h: 50 }, confidence: 0.9 }],
    ocrLines: [{ text: 'user@example.com', bounding_box: { x: 0, y: 100, w: 100, h: 15 }, confidence: 0.7 }]
  };
  const payload = processPageForRedaction([mockPasswordElement()], mockCanvas, vault, visionData);

  assert.ok(payload.redacted_regions.length >= 3, 'Expected DOM + face + OCR regions');
  for (const region of payload.redacted_regions) {
    assert.ok(typeof region.reason === 'string' && region.reason.length > 0,
      `Every redacted region must have a non-empty reason; got ${JSON.stringify(region)}`);
  }
});

// --- 3.2: per-origin memory is a confidence boost, never a bypass ---

await runAsyncTestCase('3.2: confirmed label boosts confidence but leaves tier/token/redaction unchanged', async () => {
  const origin = 'https://boost-test.example.com';
  await clearOriginProfile(origin);

  const vault1 = createTokenVault();
  const withoutMemory = processPageForRedaction([mockPasswordElement('Password')], mockCanvas, vault1, null, []);
  const noteWithout = withoutMemory.detection_confidence_notes[0];

  await recordConfirmedSensitiveLabel(origin, 'Password');
  const labels = await getConfirmedSensitiveLabels(origin);
  assert.deepStrictEqual(labels, ['Password']);

  const vault2 = createTokenVault();
  const withMemory = processPageForRedaction([mockPasswordElement('Password')], mockCanvas, vault2, null, labels);
  const noteWith = withMemory.detection_confidence_notes[0];

  // Confidence boosted...
  assert.ok(noteWith.confidence > noteWithout.confidence, 'Confidence should be boosted when the label was previously confirmed');
  assert.strictEqual(noteWith.origin_confirmed, true);
  // ...but redaction outcome itself is identical either way (boost, not bypass).
  assert.strictEqual(withMemory.dom_summary.elements[0].is_sensitive, withoutMemory.dom_summary.elements[0].is_sensitive);
  assert.strictEqual(withMemory.dom_summary.elements[0].sensitivity_tier, withoutMemory.dom_summary.elements[0].sensitivity_tier);
  assert.strictEqual(withMemory.redacted_regions.length, withoutMemory.redacted_regions.length);

  await clearOriginProfile(origin);
});

await runAsyncTestCase('3.2: a field confirmed on visit 1 is still independently re-verified on visit 2 (not blindly trusted)', async () => {
  const origin = 'https://reverify-test.example.com';
  await clearOriginProfile(origin);
  await recordConfirmedSensitiveLabel(origin, 'Promo Code'); // NOT actually a sensitive DOM/PII type

  const labels = await getConfirmedSensitiveLabels(origin);

  // A field whose label happens to match a "confirmed" entry, but which
  // independent DOM+PII detection does NOT consider sensitive, must NOT
  // become sensitive just because memory says so — memory cannot manufacture
  // sensitivity, only boost confidence on what detection already found.
  const nonSensitiveEl = {
    id: 'promo-1',
    tagName: 'INPUT',
    type: 'text',
    value: 'SAVE10',
    getAttribute: () => null,
    labels: [{ textContent: 'Promo Code' }],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 })
  };

  const vault = createTokenVault();
  const payload = processPageForRedaction([nonSensitiveEl], mockCanvas, vault, null, labels);

  assert.strictEqual(payload.dom_summary.elements[0].is_sensitive, false,
    'Memory must never manufacture sensitivity for a field independent detection does not flag');
  assert.strictEqual(payload.redacted_regions.length, 0);

  await clearOriginProfile(origin);
});

await runAsyncTestCase('3.2: redaction is correct even if the memory profile is corrupted/cleared mid-session', async () => {
  const origin = 'https://corrupt-test.example.com';
  await recordConfirmedSensitiveLabel(origin, 'Password');

  // Simulate corruption/clearing mid-session.
  await clearOriginProfile(origin);
  const labelsAfterCorruption = await getConfirmedSensitiveLabels(origin);
  assert.deepStrictEqual(labelsAfterCorruption, []);

  const vault = createTokenVault();
  const payload = processPageForRedaction([mockPasswordElement('Password')], mockCanvas, vault, null, labelsAfterCorruption);

  // Redaction must still occur — it never depended on the memory to begin with.
  assert.strictEqual(payload.dom_summary.elements[0].is_sensitive, true);
  assert.strictEqual(payload.redacted_regions.length, 1);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} PHASE 3 PRIVACY-INTELLIGENCE TESTS PASSED SUCCESSFULLY ---`);
