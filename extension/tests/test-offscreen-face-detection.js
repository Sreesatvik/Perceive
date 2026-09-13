import assert from 'assert';

console.log('=== RUNNING OFFSCREEN-DOCUMENT FACE-DETECTION WORKER TEST SUITE ===\n');

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

// --- Mock chrome + Worker BEFORE importing offscreenFaceDetection.js ---
//
// This is the actual worker-owning logic that used to live directly in
// transport.js (the background service worker) — moved here because Chrome
// does not support spawning a Worker from within a Service Worker context
// at all. This file runs inside a real window/DOM context (the offscreen
// document), which CAN spawn a classic Worker, so this test's mocking setup
// (global.Worker = FakeWorker) mirrors what the OLD transport.js test used
// to do, just against the new home for this logic.
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
};

function invokeListener(message) {
  return new Promise((resolve) => {
    registeredMessageListener(message, {}, resolve);
  });
}

await import('../src/background/offscreenFaceDetection.js');
assert.ok(registeredMessageListener, 'offscreenFaceDetection.js must register a chrome.runtime.onMessage listener');

await runTestCase('a non-OFFSCREEN_DETECT_FACES message is ignored (listener returns false, no response sent)', async () => {
  let responded = false;
  const result = registeredMessageListener({ type: 'SOMETHING_ELSE' }, {}, () => { responded = true; });
  assert.strictEqual(result, false);
  assert.strictEqual(responded, false);
});

await runTestCase('OFFSCREEN_DETECT_FACES spawns the worker (via chrome.runtime.getURL) and posts a detect message with a transfer list', async () => {
  const pixels = btoa(String.fromCharCode(...new Array(16).fill(128)));
  const config = { model: 'full_range', dedupIouThreshold: 0.5 };
  const promise = invokeListener({ type: 'OFFSCREEN_DETECT_FACES', width: 2, height: 2, pixels, config });
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(FakeWorker.instances.length, 1);
  const w = FakeWorker.instances[0];
  assert.strictEqual(w.url, 'chrome-extension://fake-id/dist/faceDetectionWorker.bundle.js');
  assert.strictEqual(w.posted.length, 1);
  const { msg, transfer } = w.posted[0];
  assert.strictEqual(msg.type, 'detect');
  assert.strictEqual(msg.width, 2);
  assert.strictEqual(msg.height, 2);
  assert.deepStrictEqual(msg.config, config);
  assert.ok(msg.pixels instanceof ArrayBuffer);
  assert.deepStrictEqual(new Uint8Array(msg.pixels), new Uint8Array(new Array(16).fill(128)));
  assert.deepStrictEqual(transfer, [msg.pixels]);

  const appliedConfig = { model: 'full_range', models_loaded: ['full_range'] };
  w.emit({ type: 'result', requestId: msg.requestId, faces: [], config_actually_applied: appliedConfig });
  const res = await promise;
  assert.deepStrictEqual(res, { success: true, faces: [], config_actually_applied: appliedConfig });
});

await runTestCase('OFFSCREEN_DETECT_FACES resolves { success: true, faces } from the worker\'s result message, and reuses the same worker instance', async () => {
  const promise = invokeListener({ type: 'OFFSCREEN_DETECT_FACES', width: 3, height: 3, pixels: new ArrayBuffer(36) });
  await new Promise((r) => setTimeout(r, 0));

  // Only one FakeWorker spawned across the whole suite (offscreenFaceDetection.js
  // caches it module-wide, same as transport.js used to) — grab the latest.
  assert.strictEqual(FakeWorker.instances.length, 1, 'worker must be reused, not re-spawned per request');
  const w = FakeWorker.instances[FakeWorker.instances.length - 1];
  const requestId = w.posted[w.posted.length - 1].msg.requestId;
  const fakeFaces = [{ bounding_box: { x: 5, y: 5, w: 20, h: 20 }, confidence: 0.7 }];
  w.emit({ type: 'result', requestId, faces: fakeFaces });

  const res = await promise;
  assert.deepStrictEqual(res, { success: true, faces: fakeFaces });
});

await runTestCase('OFFSCREEN_DETECT_FACES resolves { success: false, error } when the worker reports an error', async () => {
  const promise = invokeListener({ type: 'OFFSCREEN_DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) });
  await new Promise((r) => setTimeout(r, 0));

  const w = FakeWorker.instances[FakeWorker.instances.length - 1];
  const requestId = w.posted[w.posted.length - 1].msg.requestId;
  w.emit({ type: 'error', requestId, message: 'ModuleFactory not set' });

  const res = await promise;
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'ModuleFactory not set');
});

await runTestCase('OFFSCREEN_DETECT_FACES resolves { success: false, error } when the worker itself crashes (onerror), and clears it for retry', async () => {
  const promise = invokeListener({ type: 'OFFSCREEN_DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) });
  await new Promise((r) => setTimeout(r, 0));

  const w = FakeWorker.instances[FakeWorker.instances.length - 1];
  w.emitError('Face detection worker crashed');

  const res = await promise;
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'Face detection worker crashed');

  // Next call must spawn a fresh worker instance, not reuse the crashed one.
  const promise2 = invokeListener({ type: 'OFFSCREEN_DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(FakeWorker.instances.length, 2, 'a crashed worker must be replaced with a fresh one');
  const w2 = FakeWorker.instances[1];
  const requestId2 = w2.posted[w2.posted.length - 1].msg.requestId;
  w2.emit({ type: 'result', requestId: requestId2, faces: [] });
  await promise2;
});

console.log(`\n--- ALL ${passCount} / ${totalCount} OFFSCREEN FACE-DETECTION TESTS PASSED SUCCESSFULLY ---`);
