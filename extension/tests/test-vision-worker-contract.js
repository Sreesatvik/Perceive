import assert from 'assert';

console.log('=== RUNNING FACE-DETECTION WORKER CONTRACT TEST SUITE ===\n');

let passCount = 0;
let totalCount = 0;

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

// A fake canvas-like image source: exposes width/height and getContext('2d')
// with a getImageData() that returns deterministic RGBA data, mirroring what
// visionPipeline.js's extractImageData() expects from a real canvas.
function makeFakeCanvas(width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(128);
  return {
    width,
    height,
    getContext(kind) {
      assert.strictEqual(kind, '2d');
      return {
        getImageData(x, y, w, h) {
          assert.strictEqual(w, width);
          assert.strictEqual(h, height);
          return { data };
        },
      };
    },
  };
}

// Captures every postMessage call and lets the test script the worker's
// replies. Mirrors the subset of the Worker interface visionPipeline.js
// actually uses: constructor(url, opts), postMessage(msg, transfer),
// onmessage/onerror assignment, terminate().
class FakeWorker {
  constructor(url, opts) {
    FakeWorker.instances.push(this);
    this.url = url;
    this.opts = opts;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }
  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  // Test helper: simulate the worker replying.
  emit(data) {
    if (this.onmessage) this.onmessage({ data });
  }
  emitError(message) {
    if (this.onerror) this.onerror({ message });
  }
}
FakeWorker.instances = [];

async function freshVisionPipeline() {
  // Cache-bust so each test gets its own module-level `worker`/`pending`
  // singleton state instead of leaking across test cases.
  const mod = await import(`../src/vision/visionPipeline.js?t=${Date.now()}-${Math.random()}`);
  return mod;
}

await runAsyncTestCase('detectFaces posts a "detect" message with width/height/pixels and transfers the buffer', async () => {
  global.Worker = FakeWorker;
  FakeWorker.instances.length = 0;
  const { detectFaces } = await freshVisionPipeline();

  const canvas = makeFakeCanvas(4, 3);
  const detectPromise = detectFaces(canvas);

  // Let the microtask queue advance so the worker gets constructed and the
  // message posted before we inspect it.
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(FakeWorker.instances.length, 1, 'exactly one worker should be spawned');
  const w = FakeWorker.instances[0];
  assert.strictEqual(w.posted.length, 1);
  const { msg, transfer } = w.posted[0];
  assert.strictEqual(msg.type, 'detect');
  assert.strictEqual(msg.width, 4);
  assert.strictEqual(msg.height, 3);
  assert.ok(msg.pixels instanceof ArrayBuffer);
  assert.ok(typeof msg.requestId === 'number');
  assert.deepStrictEqual(transfer, [msg.pixels], 'the pixel buffer must be passed as a transferable');

  // Resolve it so nothing is left hanging.
  w.emit({ type: 'result', requestId: msg.requestId, faces: [] });
  const faces = await detectPromise;
  assert.deepStrictEqual(faces, []);
});

await runAsyncTestCase('detectFaces resolves with the faces array from a "result" message, matched by requestId', async () => {
  global.Worker = FakeWorker;
  FakeWorker.instances.length = 0;
  const { detectFaces } = await freshVisionPipeline();

  const canvas = makeFakeCanvas(2, 2);
  const detectPromise = detectFaces(canvas);
  await new Promise((r) => setTimeout(r, 0));

  const w = FakeWorker.instances[0];
  const requestId = w.posted[0].msg.requestId;
  const fakeFaces = [{ bounding_box: { x: 1, y: 2, w: 10, h: 10 }, confidence: 0.9 }];
  w.emit({ type: 'result', requestId, faces: fakeFaces });

  const faces = await detectPromise;
  assert.deepStrictEqual(faces, fakeFaces);
});

await runAsyncTestCase('detectFaces returns [] (never throws) when the worker sends an "error" message', async () => {
  global.Worker = FakeWorker;
  FakeWorker.instances.length = 0;
  const { detectFaces } = await freshVisionPipeline();

  const canvas = makeFakeCanvas(2, 2);
  const detectPromise = detectFaces(canvas);
  await new Promise((r) => setTimeout(r, 0));

  const w = FakeWorker.instances[0];
  const requestId = w.posted[0].msg.requestId;
  w.emit({ type: 'error', requestId, message: 'ModuleFactory not set' });

  const faces = await detectPromise;
  assert.deepStrictEqual(faces, [], 'fail-open: a worker-reported error must yield [] to the caller, not a throw');
});

await runAsyncTestCase('detectFaces returns [] (never throws) when the worker itself crashes (onerror), and clears the worker for retry', async () => {
  global.Worker = FakeWorker;
  FakeWorker.instances.length = 0;
  const { detectFaces } = await freshVisionPipeline();

  const canvas = makeFakeCanvas(2, 2);
  const detectPromise = detectFaces(canvas);
  await new Promise((r) => setTimeout(r, 0));

  const w = FakeWorker.instances[0];
  w.emitError('Failed to load worker script');

  const faces = await detectPromise;
  assert.deepStrictEqual(faces, []);
  assert.strictEqual(w.terminated, true, 'a crashed worker should be terminated rather than left hanging around');
});

await runAsyncTestCase('detectFaces returns [] immediately for a falsy imageSource without touching the worker', async () => {
  global.Worker = FakeWorker;
  FakeWorker.instances.length = 0;
  const { detectFaces } = await freshVisionPipeline();

  const faces = await detectFaces(null);
  assert.deepStrictEqual(faces, []);
  assert.strictEqual(FakeWorker.instances.length, 0);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} FACE-DETECTION WORKER CONTRACT TESTS PASSED SUCCESSFULLY ---`);
if (passCount !== totalCount) process.exit(1);
