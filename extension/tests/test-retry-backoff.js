// Bug found live: a real false-positive face detection triggered a
// channel-consistency mismatch, which threw inside the retry loop's try
// block and was caught by orchestrator.js's generic `catch (err)` handler
// — which retried, but with NO delay before the retry's re-capture,
// unlike the success path (RETRY_CONFIG.POST_ACTION_DELAY_MS). Retrying
// instantly blew through Chrome's chrome.tabs.captureVisibleTab rate
// quota (~2 calls/second), and the resulting capture_failed masked the
// real root cause entirely.
//
// This test drives the REAL runTaskLoop() (via its
// window.__PERCEIVE_TEST_MODE__ + captureOverride test hooks — already
// built into orchestrator.js for exactly this kind of harness-driven
// testing) and measures the actual wall-clock gap between consecutive
// capture invocations across a retry. The retry is triggered by a REAL
// thrown exception inside buildSanitizedPayload (jsdom's canvas 2D context
// rejects a non-Image/Canvas drawImage source, an incidental but genuine
// error under jsdom) landing in the exact same generic `catch (err)`
// block the live bug's channel-consistency mismatch also lands in — so
// this exercises the real cascade path, not a synthetic stand-in for it.
import assert from 'assert';
import { JSDOM } from 'jsdom';

console.log('=== RUNNING RETRY BACKOFF DELAY TEST SUITE ===\n');

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

// Deliberately NOT a real HTMLCanvasElement — jsdom's real
// CanvasRenderingContext2D.drawImage() rejects this, throwing inside
// buildSanitizedPayload on every attempt. That's used here on purpose (see
// header comment) rather than worked around, since it reliably exercises
// the generic catch-and-retry path this test targets.
const mockCanvas = {
  getContext: () => ({
    fillRect: () => {}, clearRect: () => {}, drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }),
  toDataURL: () => 'data:image/png;base64,' + 'A'.repeat(150),
};

async function withFreshOrchestrator(fn) {
  const dom = new JSDOM(`<html><body></body></html>`, { runScripts: 'outside-only' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.MutationObserver = dom.window.MutationObserver;
  global.CustomEvent = dom.window.CustomEvent;
  global.performance = dom.window.performance || global.performance;
  global.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
  global.window.__PERCEIVE_TEST_MODE__ = true;
  // orchestrator.js unconditionally registers a chrome.runtime.onMessage
  // listener at module load time — a minimal stub (no sendMessage) is
  // enough to satisfy that, and every runtime CALL site elsewhere in the
  // file already guards on `chrome.runtime.sendMessage` before using it,
  // so leaving sendMessage undefined correctly exercises the same
  // "plain webpage test harness" fallback paths that pattern is designed for.
  global.chrome = { runtime: { onMessage: { addListener: () => {} } } };

  const modUrl = `../src/content/orchestrator.js?t=${Date.now()}-${Math.random()}`;
  const mod = await import(modUrl);
  try {
    await fn(mod);
  } finally {
    delete global.window;
    delete global.document;
    delete global.MutationObserver;
    delete global.CustomEvent;
    delete global.CSS;
    delete global.chrome;
  }
}

await runTestCase('retry-after-thrown-error waits at least RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS before the next capture (proves the fix — this exact gap was previously ~0ms and caused the live capture-quota cascade)', async () => {
  await withFreshOrchestrator(async (mod) => {
    const captureTimestamps = [];
    const captureOverride = async () => {
      captureTimestamps.push(Date.now());
      return { elements: [], canvas: mockCanvas };
    };

    const result = await mod.runTaskLoop('click the button', captureOverride);

    // MAX_RETRIES_PER_STEP = 3, every attempt throws inside
    // buildSanitizedPayload -> the step exhausts all 3 attempts and the
    // task fails — expected and fine; what's being measured is the TIMING
    // between the resulting capture attempts.
    assert.strictEqual(result.success, false);
    assert.ok(captureTimestamps.length >= 2, `expected at least 2 capture attempts to compare timing, got ${captureTimestamps.length}`);

    const { RETRY_CONFIG } = await import('../src/shared/constants.js');
    for (let i = 1; i < captureTimestamps.length; i++) {
      const gap = captureTimestamps[i] - captureTimestamps[i - 1];
      assert.ok(
        gap >= RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS - 50, // small tolerance for timer scheduling jitter
        `capture attempt ${i + 1} fired only ${gap}ms after attempt ${i} — must wait at least ${RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS}ms (this is exactly the bug: retrying faster than Chrome's capture quota)`
      );
    }
  });
});

console.log(`\n--- ALL ${passCount} / ${totalCount} RETRY BACKOFF TESTS PASSED SUCCESSFULLY ---`);
