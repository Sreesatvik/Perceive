import assert from 'assert';

console.log('=== RUNNING BACKGROUND-OWNED FACE-DETECTION WORKER TEST SUITE ===\n');

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

// --- Mock chrome + Worker BEFORE importing transport.js ---
let registeredMessageListener = null;

class FakeWorker {
  constructor(url) {
    FakeWorker.instances.push(this);
    this.url = url;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }
  postMessage(msg, transfer) { this.posted.push({ msg, transfer }); }
  terminate() { this.terminated = true; }
  emit(data) { if (this.onmessage) this.onmessage({ data }); }
  emitError(message) { if (this.onerror) this.onerror({ message }); }
}
FakeWorker.instances = [];
global.Worker = FakeWorker;

global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { registeredMessageListener = fn; } },
    getURL: (p) => `chrome-extension://fake-id/${p}`,
  },
  storage: { local: { get: async () => ({ backendApiKey: 'test-key' }) } },
  tabs: { onRemoved: { addListener: () => {} } },
};
global.fetch = async () => { throw new Error('unused in this test file'); };

function invokeListener(message, sender = { tab: { id: 1 }, frameId: 0 }) {
  return new Promise((resolve) => {
    registeredMessageListener(message, sender, resolve);
  });
}

await import('../src/background/transport.js');
assert.ok(registeredMessageListener, 'transport.js must register a chrome.runtime.onMessage listener');

await runTestCase('DETECT_FACES spawns the worker (via chrome.runtime.getURL) and posts a detect message with a transfer list', async () => {
  const pixels = new ArrayBuffer(16);
  const promise = invokeListener({ type: 'DETECT_FACES', width: 2, height: 2, pixels });
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(FakeWorker.instances.length, 1);
  const w = FakeWorker.instances[0];
  assert.strictEqual(w.url, 'chrome-extension://fake-id/dist/faceDetectionWorker.bundle.js');
  assert.strictEqual(w.posted.length, 1);
  const { msg, transfer } = w.posted[0];
  assert.strictEqual(msg.type, 'detect');
  assert.strictEqual(msg.width, 2);
  assert.strictEqual(msg.height, 2);
  assert.deepStrictEqual(transfer, [pixels]);

  w.emit({ type: 'result', requestId: msg.requestId, faces: [] });
  const res = await promise;
  assert.deepStrictEqual(res, { success: true, faces: [] });
});

await runTestCase('DETECT_FACES resolves { success: true, faces } from the worker\'s result message', async () => {
  const promise = invokeListener({ type: 'DETECT_FACES', width: 3, height: 3, pixels: new ArrayBuffer(36) });
  await new Promise((r) => setTimeout(r, 0));

  // Same worker instance is reused (only one FakeWorker spawned across the
  // whole suite, since transport.js caches it module-wide) — grab the latest.
  const w = FakeWorker.instances[FakeWorker.instances.length - 1];
  const requestId = w.posted[w.posted.length - 1].msg.requestId;
  const fakeFaces = [{ bounding_box: { x: 5, y: 5, w: 20, h: 20 }, confidence: 0.7 }];
  w.emit({ type: 'result', requestId, faces: fakeFaces });

  const res = await promise;
  assert.deepStrictEqual(res, { success: true, faces: fakeFaces });
});

await runTestCase('DETECT_FACES resolves { success: false, error } when the worker reports an error', async () => {
  const promise = invokeListener({ type: 'DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) });
  await new Promise((r) => setTimeout(r, 0));

  const w = FakeWorker.instances[FakeWorker.instances.length - 1];
  const requestId = w.posted[w.posted.length - 1].msg.requestId;
  w.emit({ type: 'error', requestId, message: 'ModuleFactory not set' });

  const res = await promise;
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'ModuleFactory not set');
});

console.log(`\n--- ALL ${passCount} / ${totalCount} BACKGROUND FACE-DETECTION TESTS PASSED SUCCESSFULLY ---`);
