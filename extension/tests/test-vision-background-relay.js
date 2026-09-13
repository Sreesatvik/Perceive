import assert from 'assert';

console.log('=== RUNNING VISION BACKGROUND-RELAY TEST SUITE ===\n');

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

async function freshVisionPipeline() {
  const mod = await import(`../src/vision/visionPipeline.js?t=${Date.now()}-${Math.random()}`);
  return mod;
}

await runAsyncTestCase('detectFaces routes through chrome.runtime.sendMessage (DETECT_FACES) when a real extension runtime is present', async () => {
  let sentMessage = null;
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        sentMessage = message;
        callback({ success: true, faces: [{ bounding_box: { x: 1, y: 2, w: 3, h: 4 }, confidence: 0.8 }] });
      },
      getURL: (p) => p,
    },
  };

  const { detectFaces } = await freshVisionPipeline();
  const faces = await detectFaces(makeFakeCanvas(2, 2));

  assert.ok(sentMessage, 'chrome.runtime.sendMessage must have been called');
  assert.strictEqual(sentMessage.type, 'DETECT_FACES');
  assert.strictEqual(sentMessage.width, 2);
  assert.strictEqual(sentMessage.height, 2);
  assert.strictEqual(typeof sentMessage.pixels, 'string');
  assert.strictEqual(atob(sentMessage.pixels), String.fromCharCode(...new Array(16).fill(128)));
  assert.deepStrictEqual(faces, [{ bounding_box: { x: 1, y: 2, w: 3, h: 4 }, confidence: 0.8 }]);

  delete global.chrome;
});

await runAsyncTestCase('detectFaces fails open ([]) when the background reports success:false', async () => {
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        callback({ success: false, error: 'Face detection worker crashed' });
      },
      getURL: (p) => p,
    },
  };

  const { detectFaces } = await freshVisionPipeline();
  const faces = await detectFaces(makeFakeCanvas(2, 2));
  assert.deepStrictEqual(faces, []);

  delete global.chrome;
});

await runAsyncTestCase('detectFaces fails open ([]) when chrome.runtime.lastError is set (e.g. no listener / extension context invalidated)', async () => {
  global.chrome = {
    runtime: {
      get lastError() { return { message: 'Extension context invalidated.' }; },
      sendMessage(message, callback) {
        callback(undefined);
      },
      getURL: (p) => p,
    },
  };

  const { detectFaces } = await freshVisionPipeline();
  const faces = await detectFaces(makeFakeCanvas(2, 2));
  assert.deepStrictEqual(faces, []);

  delete global.chrome;
});

console.log(`\n--- ALL ${passCount} / ${totalCount} VISION BACKGROUND-RELAY TESTS PASSED SUCCESSFULLY ---`);
