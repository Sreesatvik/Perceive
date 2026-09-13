import assert from 'assert';
import { DEMO_MODE_ENABLED } from '../src/shared/constants.js';

console.log('=== RUNNING PHASE D.1b DEMO-MODE CAPTURE TEST SUITE ===\n');

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

async function freshDemoCapture() {
  return import(`../src/background/demoCapture.js?t=${Date.now()}-${Math.random()}`);
}

runTestCaseSync('DEMO_MODE_ENABLED defaults to false in the shipped build', () => {
  assert.strictEqual(DEMO_MODE_ENABLED, false);
});

function runTestCaseSync(name, fn) {
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

await runAsyncTestCase('maybeSaveDemoScreenshot is a no-op when demo mode is off (default): chrome.downloads never called', async () => {
  let downloadCalled = false;
  global.chrome = {
    downloads: {
      download: () => { downloadCalled = true; },
    },
  };
  const { maybeSaveDemoScreenshot } = await freshDemoCapture();
  await maybeSaveDemoScreenshot('session-1', 1, 'data:image/png;base64,abc');
  assert.strictEqual(downloadCalled, false, 'chrome.downloads.download must never be called while DEMO_MODE_ENABLED is false');
  delete global.chrome;
});

await runAsyncTestCase('maybeSaveDemoScreenshot never transmits the original anywhere over the network (no fetch/XHR call inside it)', async () => {
  let networkCalled = false;
  const originalFetch = global.fetch;
  global.fetch = () => { networkCalled = true; return Promise.reject(new Error('should never be called')); };
  global.chrome = {
    downloads: {
      download: () => { /* would only be reached if DEMO_MODE_ENABLED were true */ },
    },
  };
  const { maybeSaveDemoScreenshot } = await freshDemoCapture();
  await maybeSaveDemoScreenshot('session-1', 1, 'data:image/png;base64,abc');
  assert.strictEqual(networkCalled, false, 'demo capture must be purely local (chrome.downloads), never a network call');
  global.fetch = originalFetch;
  delete global.chrome;
});

console.log(`\n--- ALL ${passCount} / ${totalCount} DEMO-MODE CAPTURE TESTS PASSED SUCCESSFULLY ---`);
