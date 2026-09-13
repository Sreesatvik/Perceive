// Phase F / Step 5 — payload inspection, not assumption: for a full login
// step, the ACTUAL bytes sendToBackend() (transport.js) would PUT ON THE
// WIRE via fetch() to /analyze contain a [PASSWORD_N]-style token and NEVER
// the raw password. dev2/test-dev2.js's "E2E Case 12" already proves the
// negative half (no raw value anywhere in the structural payload object,
// recursively) — this test complements it with the positive half (the
// token IS present, in the right shape) AND inspects the literal
// JSON.stringify'd string transport.js sends over a real (mocked) fetch
// call, not just the pre-serialization object.
import assert from 'assert';
import { createTokenVault } from '../../dev2/token-vault.js';
import { processPageForRedaction } from '../../dev2/redaction-engine.js';

console.log('=== RUNNING PHASE F PASSWORD-TOKENIZATION WIRE TEST SUITE ===\n');

let passCount = 0;
let totalCount = 0;

async function runTestCase(name, fn) {
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

// --- Mock chrome + fetch BEFORE importing transport.js (module-load-time
// chrome.* access), same convention as test-transport-resilience.js. ---
global.chrome = {
  runtime: { onMessage: { addListener: () => {} } },
  storage: { local: { get: async () => ({ backendApiKey: 'test-key' }) } },
};

let capturedRequestBody = null;
global.fetch = async (_url, options) => {
  capturedRequestBody = options.body;
  return new Response(
    JSON.stringify({ session_id: 'wire-test-session', step_number: 2, action: { type: 'wait', risk_tier: 'safe' }, confidence: 0.9 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

const { sendToBackend } = await import('../src/background/transport.js');

const RAW_PASSWORD = 'SuperSecretWirePass!42';

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
      value: RAW_PASSWORD,
      getAttribute: (attr) => (attr === 'type' ? 'password' : null),
      getBoundingClientRect: () => ({ x: 10, y: 50, width: 200, height: 30 }),
    },
  ];
}

const mockCanvas = {
  getContext: () => ({
    fillRect: () => {}, clearRect: () => {}, drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }),
  toDataURL: () => 'data:image/png;base64,' + 'A'.repeat(150),
};

await runTestCase('A full login-step payload built by the real redaction engine, sent through the real sendToBackend(): the actual wire bytes contain a [PASSWORD_...] token and never the raw password', async () => {
  const vault = createTokenVault();
  const result = processPageForRedaction(mockLoginForm(), mockCanvas, vault);

  const payload = {
    session_id: 'wire-test-session',
    task_instruction: 'log in',
    step_number: 1,
    ...result,
  };

  await sendToBackend(payload);

  assert.ok(capturedRequestBody, 'fetch must have been called with a request body');
  assert.strictEqual(capturedRequestBody.includes(RAW_PASSWORD), false, 'the raw password must never appear in the actual wire bytes');

  const tokenMatch = /\[PASSWORD_[a-z0-9]+\]/.exec(capturedRequestBody);
  assert.ok(tokenMatch, `expected a [PASSWORD_...] token in the actual request body, got: ${capturedRequestBody}`);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} PASSWORD-TOKENIZATION WIRE TESTS PASSED SUCCESSFULLY ---`);
