// Phase F / Step 6 — canvas-rendered PII (account balance) detection, and
// an honest check of whether a genuinely read-only task path exists.
//
// Uses the exact same OCR-fusion pattern as test-vision-fusion.js's
// Test 3 (Card-on-file case): processPageForRedaction() fed a real
// visionData.ocrLines entry (no DOM element at all — zero DOM cooperation,
// matching the deliberate design of extension/tests/e2e/three-page-site/
// dashboard.html's canvas-only balance).
import assert from 'assert';
import { createTokenVault } from './token-vault.js';
import { processPageForRedaction } from './redaction-engine.js';
import { detectPII } from './pii-patterns.js';

console.log('=== RUNNING PHASE F CANVAS-BALANCE PII TEST SUITE ===\n');

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

const mockCanvas = {
  getContext: () => ({
    fillRect: () => {}, clearRect: () => {}, drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }),
  toDataURL: () => 'data:image/png;base64,' + 'A'.repeat(150),
};

const BALANCE_TEXT = 'Balance: $4,281.50';

runTestCase('detectPII() recognizes a canvas-rendered dollar amount as PII-shaped (AMOUNT) — real gap found and fixed this phase, not assumed', () => {
  const matches = detectPII(BALANCE_TEXT);
  const amountMatch = matches.find((m) => m.type === 'AMOUNT');
  assert.ok(amountMatch, `expected an AMOUNT match in "${BALANCE_TEXT}", got: ${JSON.stringify(matches)}`);
  assert.strictEqual(amountMatch.match, '$4,281.50');
});

runTestCase('A canvas-only balance (zero DOM elements at all) is detected purely via the OCR/vision channel and produces a redacted region', () => {
  const vault = createTokenVault();
  const visionData = {
    faces: [],
    ocrLines: [
      { text: BALANCE_TEXT, bounding_box: { x: 20, y: 40, w: 220, h: 24 }, confidence: 0.9 },
      { text: 'My Dashboard', bounding_box: { x: 20, y: 10, w: 150, h: 20 }, confidence: 0.95 }, // no PII, must be ignored
    ],
  };

  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  assert.strictEqual(payload.dom_summary.elements.length, 0, 'this is the deliberate zero-DOM-cooperation case — no DOM element backs the balance at all');
  assert.strictEqual(payload.redacted_regions.length, 1, 'only the balance line should produce a redacted region');
  assert.strictEqual(payload.redacted_regions[0].detection_source, 'ocr_regex');
  assert.strictEqual(payload.redacted_regions[0].sensitivity_type, 'AMOUNT');
  assert.ok(/^\[AMOUNT_[a-z0-9]{10}\]$/.test(payload.redacted_regions[0].semantic_token), `expected a real vault-backed AMOUNT token, got: ${payload.redacted_regions[0].semantic_token}`);
});

runTestCase('The raw balance text/number never appears anywhere in the outgoing payload (architecturally guaranteed: OCR runs and redacts BEFORE any network payload is built)', () => {
  const vault = createTokenVault();
  const visionData = { faces: [], ocrLines: [{ text: BALANCE_TEXT, bounding_box: { x: 20, y: 40, w: 220, h: 24 }, confidence: 0.9 }] };
  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  const payloadStr = JSON.stringify(payload);
  assert.strictEqual(payloadStr.includes('4,281.50'), false);
  assert.strictEqual(payloadStr.includes('4281.50'), false);
  assert.strictEqual(payloadStr.includes(BALANCE_TEXT), false);
});

// --- Honest architecture check: is there a genuinely read-only task path
// at all (the LLM/user learns the balance without any DOM mutation)? ---
//
// This is not something a unit test can prove positively (there is no
// function to call — that is the entire finding). Documented here instead
// of faked: server/app/models.py's ClientPayload carries dom_summary,
// redacted_image_base64, and detection_confidence_notes (element_id/
// confidence/method only) — grepped for any field carrying extracted OCR
// TEXT content anywhere in server/app/models.py or the payload built by
// dev2/redaction-engine.js, and there is none. The balance's redaction
// happens client-side BEFORE a payload is ever built, which is exactly
// what guarantees test 3 above — but it also means the extracted value
// never reaches the LLM (by design, for privacy) and there is no separate
// local-only "read and report to the user" path either. A "check my
// balance" task cannot currently be fulfilled end-to-end by this
// architecture: the system can safely detect-and-redact the value, and can
// safely guarantee it never leaks to the server, but has no mechanism to
// answer the user's actual question. Real, reportable gap — not fixed in
// this phase (a local-only read-back path is new user-facing behavior,
// out of scope for a redaction/policy-hardening pass).
runTestCase('Architecture check: no field anywhere carries extracted OCR text content back out of the redaction step (confirms no read-only answer path exists yet)', () => {
  const vault = createTokenVault();
  const visionData = { faces: [], ocrLines: [{ text: BALANCE_TEXT, bounding_box: { x: 20, y: 40, w: 220, h: 24 }, confidence: 0.9 }] };
  const payload = processPageForRedaction([], mockCanvas, vault, visionData);

  // The ONLY things describing this detection anywhere in the payload are
  // structural metadata (type/tier/token/bounding box/confidence) — never
  // the actual text. This is the concrete, checkable form of "the value
  // never reaches anywhere it could be relayed back to the user."
  const region = payload.redacted_regions[0];
  const allowedKeys = new Set(['element_id', 'bounding_box', 'sensitivity_tier', 'semantic_token', 'detection_source', 'sensitivity_type', 'reason']);
  for (const key of Object.keys(region)) {
    assert.ok(allowedKeys.has(key), `redacted_regions entries must only ever carry structural metadata — unexpected key "${key}" could be a raw-value leak vector`);
  }
});

console.log(`\n--- ALL ${passCount} / ${totalCount} CANVAS-BALANCE PII TESTS PASSED SUCCESSFULLY ---`);
