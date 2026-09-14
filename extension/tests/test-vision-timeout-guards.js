// Fake-timer regression tests for the three vision/OCR timeout sites added
// on top of the 9.5.4 sendMessageAsync fix (see orchestrator.js's
// sendMessageAsync): buildSanitizedPayload's Promise.all([detectFaces(),
// runOcr()]) previously had no bound on either channel, so a stalled worker
// or network fetch anywhere in that chain hung the whole step forever,
// never reaching the ALREADY-timeout-guarded SEND_PAYLOAD call.
//
// jsdom cannot simulate a real Worker hang or a real network stall, so
// these tests instead simulate "never calls back" / "calls back late" at
// each site's own boundary (chrome.runtime.sendMessage's callback, or
// tesseract.js's createWorker() promise) and use node:test's mock.timers to
// advance virtual time past VISION_TIMEOUT_MS instantly, rather than
// waiting 30 real seconds per test.
//
// Requires --experimental-test-module-mocks (see package.json's test
// script) for mock.module(), used only in the site-3 (modelLoader.js)
// tests to intercept the 'tesseract.js' import.
import assert from 'assert';
import { mock } from 'node:test';

console.log('=== RUNNING VISION/OCR TIMEOUT GUARD TEST SUITE ===\n');

let passCount = 0;
let totalCount = 0;

async function runTestCase(name, fn) {
  totalCount++;
  try {
    await fn();
    passCount++;
    console.log(`[PASS] Test ${totalCount}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Test ${totalCount}: ${name}\n  Error: ${err.stack || err.message}`);
    throw err;
  }
}

// Flushes pending microtasks (real Promise .then chains, e.g. an `await
// ensureOffscreenDocument()`) without depending on the (possibly faked)
// setTimeout — several rounds is enough for the handful of `await`s in the
// production code between "message received" and "timer/sendMessage armed".
async function flushMicrotasks(rounds = 5) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// Watches for unhandled rejections during one test's execution — proves a
// timeout-raced promise that later settles a second time (the thing the
// settled-flag guards exist to prevent) never surfaces as a process-level
// unhandled rejection.
async function withUnhandledRejectionGuard(fn) {
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on('unhandledRejection', handler);
  try {
    await fn();
    // Give any same-tick unhandled rejection a chance to be reported.
    await flushMicrotasks(3);
  } finally {
    process.off('unhandledRejection', handler);
  }
  assert.strictEqual(seen.length, 0, `expected no unhandled rejections, got: ${seen.map((e) => e && e.message).join(', ')}`);
}

function makeFakeCanvas(width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(128);
  return {
    width,
    height,
    getContext(kind) {
      assert.strictEqual(kind, '2d');
      return { getImageData: () => ({ data }) };
    },
  };
}

const { VISION_TIMEOUT_MS } = await import('../src/shared/constants.js');

// =====================================================================
// Site 1: visionPipeline.js's detectViaBackground (exercised via the
// public detectFaces() API, same convention as test-vision-background-relay.js)
// =====================================================================

await runTestCase('Site 1 (visionPipeline.js detectViaBackground): a DETECT_FACES sendMessage that never calls back times out at VISION_TIMEOUT_MS and detectFaces() fails open to [] (not a hang, not a throw)', async () => {
  await withUnhandledRejectionGuard(async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let capturedCallback = null;
      global.chrome = {
        runtime: {
          lastError: null,
          sendMessage(message, callback) {
            capturedCallback = callback; // never invoked — simulates a hung background worker
          },
          getURL: (p) => p,
        },
      };

      const { detectFaces } = await import(`../src/vision/visionPipeline.js?t=${Date.now()}-${Math.random()}`);
      const resultPromise = detectFaces(makeFakeCanvas(2, 2));

      await flushMicrotasks();
      mock.timers.tick(VISION_TIMEOUT_MS);

      const faces = await resultPromise;
      assert.deepStrictEqual(faces, [], 'detectFaces() must fail open to [] on a DETECT_FACES timeout, never hang or throw');
      assert.ok(capturedCallback, 'sendMessage must have been called (proves the request was actually attempted)');

      // Late-arriving response after the timeout already fired: must be a
      // pure no-op (no throw, no second resolve/reject observable to the
      // caller — the promise already settled above).
      assert.doesNotThrow(() => capturedCallback({ success: true, faces: [{ bounding_box: { x: 0, y: 0, w: 1, h: 1 }, confidence: 0.9 } ]}));

      delete global.chrome;
    } finally {
      mock.timers.reset();
    }
  });
});

// =====================================================================
// Site 2: transport.js's detectFacesInBackground (exercised via the
// chrome.runtime.onMessage listener it registers for DETECT_FACES, same
// convention as test-transport-face-detection.js)
// =====================================================================

await runTestCase('Site 2 (transport.js detectFacesInBackground): offscreen document creation succeeds but the OFFSCREEN_DETECT_FACES relay never calls back — times out at VISION_TIMEOUT_MS and resolves { success: false } (not a hang)', async () => {
  await withUnhandledRejectionGuard(async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let registeredMessageListener = null;
      let lastSendMessageCall = null;
      let hasDocumentReturnValue = false;

      global.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => { registeredMessageListener = fn; } },
          getURL: (p) => `chrome-extension://fake-id/${p}`,
          sendMessage: (message, callback) => {
            lastSendMessageCall = { message, callback }; // never invoked — simulates a hung offscreen worker/model load
          },
          lastError: undefined,
        },
        storage: { local: { get: async () => ({ backendApiKey: 'test-key' }) } },
        tabs: { onRemoved: { addListener: () => {} } },
        offscreen: {
          hasDocument: async () => hasDocumentReturnValue,
          createDocument: async () => { hasDocumentReturnValue = true; },
        },
      };
      global.fetch = async () => { throw new Error('unused in this test'); };

      await import(`../src/background/transport.js?t=${Date.now()}-${Math.random()}`);
      assert.ok(registeredMessageListener, 'transport.js must register a chrome.runtime.onMessage listener');

      const resultPromise = new Promise((resolve) => {
        registeredMessageListener(
          { type: 'DETECT_FACES', width: 2, height: 2, pixels: new ArrayBuffer(16) },
          { tab: { id: 1 }, frameId: 0 },
          resolve
        );
      });

      // Let ensureOffscreenDocument()'s real (unmocked) await chain run to
      // completion and the OFFSCREEN_DETECT_FACES sendMessage actually fire
      // before advancing the fake clock.
      await flushMicrotasks();
      assert.ok(lastSendMessageCall, 'the OFFSCREEN_DETECT_FACES relay must have been attempted before the timeout fires');
      assert.strictEqual(lastSendMessageCall.message.type, 'OFFSCREEN_DETECT_FACES');

      mock.timers.tick(VISION_TIMEOUT_MS);

      const res = await resultPromise;
      assert.strictEqual(res.success, false, 'must resolve { success: false }, not hang, when the offscreen relay never responds');
      assert.match(res.error, /timed out after \d+ms/);

      // Late-arriving response after timeout: must be a no-op, not a
      // duplicate resolve/reject.
      assert.doesNotThrow(() => lastSendMessageCall.callback({ success: true, faces: [] }));

      delete global.chrome;
      delete global.fetch;
    } finally {
      mock.timers.reset();
    }
  });
});

// =====================================================================
// Site 3: modelLoader.js's loadOcrWorker (tesseract.js's createWorker
// mocked via node:test's mock.module — requires
// --experimental-test-module-mocks)
// =====================================================================

await runTestCase('Site 3 (modelLoader.js loadOcrWorker): a createWorker() that never resolves times out at VISION_TIMEOUT_MS and rejects with a readable error (not a hang)', async () => {
  await withUnhandledRejectionGuard(async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const moduleMock = mock.module('tesseract.js', {
      exports: { createWorker: () => new Promise(() => {}) }, // never resolves
    });
    try {
      const { loadOcrWorker } = await import(`../src/vision/modelLoader.js?t=${Date.now()}-${Math.random()}`);
      const resultPromise = loadOcrWorker();

      await flushMicrotasks();
      mock.timers.tick(VISION_TIMEOUT_MS);

      await assert.rejects(
        resultPromise,
        /OCR worker initialization timed out after \d+ms/,
        'loadOcrWorker() must reject with a readable timeout error, not hang forever'
      );
    } finally {
      moduleMock.restore();
      mock.timers.reset();
    }
  });
});

await runTestCase('Site 3 (modelLoader.js loadOcrWorker): a createWorker() that resolves AFTER the timeout already fired terminates the now-orphaned worker instead of leaking it', async () => {
  await withUnhandledRejectionGuard(async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let resolveCreateWorker;
    let terminateCalls = 0;
    const fakeWorker = { terminate: async () => { terminateCalls++; } };

    const moduleMock = mock.module('tesseract.js', {
      exports: {
        createWorker: () => new Promise((resolve) => { resolveCreateWorker = resolve; }),
      },
    });
    try {
      const { loadOcrWorker } = await import(`../src/vision/modelLoader.js?t=${Date.now()}-${Math.random()}`);
      const resultPromise = loadOcrWorker();

      await flushMicrotasks();
      mock.timers.tick(VISION_TIMEOUT_MS);
      await assert.rejects(resultPromise, /OCR worker initialization timed out/);

      assert.strictEqual(terminateCalls, 0, 'terminate() must not be called before the late resolution actually arrives');

      // The "hung" createWorker() call finally resolves, well after this
      // module already gave up and moved on.
      resolveCreateWorker(fakeWorker);
      await flushMicrotasks();

      assert.strictEqual(terminateCalls, 1, 'the orphaned worker must be terminated exactly once when it resolves late');
    } finally {
      moduleMock.restore();
      mock.timers.reset();
    }
  });
});

console.log(`\n--- ALL ${passCount} / ${totalCount} VISION/OCR TIMEOUT GUARD TESTS PASSED SUCCESSFULLY ---`);
