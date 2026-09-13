import assert from 'assert';

console.log('=== RUNNING BACKGROUND FACE-DETECTION RELAY TEST SUITE ===\n');

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

// --- Mock chrome BEFORE importing transport.js ---
//
// transport.js no longer spawns a Worker itself (that broke with
// "ReferenceError: Worker is not defined" — Chrome does not support
// creating a Worker from within a Service Worker context at all). It now
// ensures a chrome.offscreen document exists and relays DETECT_FACES to it
// as OFFSCREEN_DETECT_FACES via a second chrome.runtime.sendMessage call.
// That relayed message is handled by offscreenFaceDetection.js, which is
// covered separately in test-offscreen-face-detection.js (it owns the
// actual worker-spawning logic now). This file only proves transport.js's
// half of the contract: ensure-offscreen-then-relay-then-forward-response.
let registeredMessageListener = null;
let hasDocumentCalls = 0;
let createDocumentCalls = [];
let hasDocumentReturnValue = false;

// Captures every chrome.runtime.sendMessage call so this test can inspect
// the OFFSCREEN_DETECT_FACES relay and manually drive its response,
// simulating the offscreen document without actually running one.
let lastSendMessageCall = null;

global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { registeredMessageListener = fn; } },
    getURL: (p) => `chrome-extension://fake-id/${p}`,
    sendMessage: (message, callback) => {
      lastSendMessageCall = { message, callback };
    },
    lastError: undefined,
  },
  storage: { local: { get: async () => ({ backendApiKey: 'test-key' }) } },
  tabs: { onRemoved: { addListener: () => {} } },
  offscreen: {
    hasDocument: async () => {
      hasDocumentCalls++;
      return hasDocumentReturnValue;
    },
    createDocument: async (options) => {
      createDocumentCalls.push(options);
      hasDocumentReturnValue = true; // subsequent hasDocument() calls see it as created
    },
  },
};
global.fetch = async () => { throw new Error('unused in this test file'); };

function invokeListener(message, sender = { tab: { id: 1 }, frameId: 0 }) {
  return new Promise((resolve) => {
    registeredMessageListener(message, sender, resolve);
  });
}

await import('../src/background/transport.js');
assert.ok(registeredMessageListener, 'transport.js must register a chrome.runtime.onMessage listener');

await runTestCase('DETECT_FACES ensures an offscreen document exists before relaying (chrome.offscreen.createDocument called once)', async () => {
  const promise = invokeListener({ type: 'DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) });
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(createDocumentCalls.length, 1, 'createDocument should be called exactly once');
  assert.strictEqual(createDocumentCalls[0].url, 'src/background/offscreen.html');
  assert.ok(Array.isArray(createDocumentCalls[0].reasons) && createDocumentCalls[0].reasons.includes('WORKERS'));

  assert.ok(lastSendMessageCall, 'transport.js should relay via chrome.runtime.sendMessage');
  assert.strictEqual(lastSendMessageCall.message.type, 'OFFSCREEN_DETECT_FACES');
  assert.strictEqual(lastSendMessageCall.message.width, 2);
  assert.strictEqual(lastSendMessageCall.message.height, 2);

  // Simulate the offscreen document's response.
  lastSendMessageCall.callback({ success: true, faces: [] });
  const res = await promise;
  assert.deepStrictEqual(res, { success: true, faces: [] });
});

await runTestCase('DETECT_FACES does NOT recreate the offscreen document on a second call (hasDocument reports it already exists)', async () => {
  const createDocumentCallsBefore = createDocumentCalls.length;

  const promise = invokeListener({ type: 'DETECT_FACES', width: 3, height: 3, pixels: new ArrayBuffer(36) });
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(createDocumentCalls.length, createDocumentCallsBefore, 'createDocument must not be called again once hasDocument() reports true');

  const fakeFaces = [{ bounding_box: { x: 5, y: 5, w: 20, h: 20 }, confidence: 0.7 }];
  lastSendMessageCall.callback({ success: true, faces: fakeFaces });
  const res = await promise;
  assert.deepStrictEqual(res, { success: true, faces: fakeFaces });
});

await runTestCase('DETECT_FACES resolves { success: false, error } when the offscreen relay reports failure', async () => {
  const promise = invokeListener({ type: 'DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) });
  await new Promise((r) => setTimeout(r, 0));

  lastSendMessageCall.callback({ success: false, error: 'ModuleFactory not set' });

  const res = await promise;
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'ModuleFactory not set');
});

await runTestCase('DETECT_FACES resolves { success: false, error } when chrome.runtime.lastError is set on the relay', async () => {
  const promise = invokeListener({ type: 'DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) });
  await new Promise((r) => setTimeout(r, 0));

  global.chrome.runtime.lastError = { message: 'Receiving end does not exist' };
  lastSendMessageCall.callback(undefined);
  global.chrome.runtime.lastError = undefined;

  const res = await promise;
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'Receiving end does not exist');
});

console.log(`\n--- ALL ${passCount} / ${totalCount} BACKGROUND FACE-DETECTION RELAY TESTS PASSED SUCCESSFULLY ---`);
