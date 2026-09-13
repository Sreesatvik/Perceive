import assert from 'assert';

console.log('=== RUNNING PHASE 5.2/5.3 TRANSPORT RESILIENCE TEST SUITE ===\n');

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

// --- Mock chrome + fetch BEFORE importing transport.js, since it registers
// its listeners and reads chrome.* at module-load time. ---
let registeredMessageListener = null;
let registeredTabRemovedListener = null;

global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { registeredMessageListener = fn; } },
  },
  storage: {
    local: { get: async () => ({ backendApiKey: 'test-key' }) },
  },
  tabs: {
    onRemoved: { addListener: (fn) => { registeredTabRemovedListener = fn; } },
  },
};

let fetchQueue = []; // array of () => Response, consumed in order
let fetchCallCount = 0;
global.fetch = async () => {
  fetchCallCount++;
  const next = fetchQueue.shift();
  if (!next) throw new Error('Test bug: fetch called more times than expected');
  return next();
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function successBody(sessionId, stepNumber) {
  return {
    session_id: sessionId,
    step_number: stepNumber + 1,
    action: { type: 'wait', risk_tier: 'safe' },
    confidence: 0.9,
  };
}

function samplePayload(sessionId, stepNumber = 1) {
  return {
    session_id: sessionId,
    task_instruction: 'wait',
    step_number: stepNumber,
    dom_summary: { url: 'http://test.com', elements: [] },
  };
}

function invokeListener(message, sender) {
  return new Promise((resolve) => {
    const keepChannelOpen = registeredMessageListener(message, sender, resolve);
    assert.strictEqual(keepChannelOpen, true, 'Listener must return true to keep the async channel open');
  });
}

const mod = await import('../src/background/transport.js');
assert.ok(registeredMessageListener, 'transport.js must register a chrome.runtime.onMessage listener');
assert.ok(registeredTabRemovedListener, 'transport.js must register a chrome.tabs.onRemoved listener');

// --- 5.2: session context binding ---

await runTestCase('5.2: first SEND_PAYLOAD for a session_id binds it to that sender tab/frame', async () => {
  fetchQueue = [() => jsonResponse(200, successBody('sess-a', 1))];
  const res = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-a', 1) },
    { tab: { id: 10 }, frameId: 0 }
  );
  assert.strictEqual(res.success, true);
});

await runTestCase('5.2: a SEND_PAYLOAD for the SAME session_id from a DIFFERENT tab is rejected before touching the network', async () => {
  const callsBefore = fetchCallCount;
  const res = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-a', 2) },
    { tab: { id: 99 }, frameId: 0 } // different tab than the one that bound sess-a
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'session_context_mismatch');
  assert.strictEqual(fetchCallCount, callsBefore, 'A rejected mismatch must never reach the network at all');
});

await runTestCase('5.2: the SAME session_id from the SAME tab/frame continues to work normally', async () => {
  fetchQueue = [() => jsonResponse(200, successBody('sess-a', 2))];
  const res = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-a', 2) },
    { tab: { id: 10 }, frameId: 0 }
  );
  assert.strictEqual(res.success, true);
});

// --- 5.3: bounded exponential backoff + jitter on retryable provider errors ---

await runTestCase('5.3: a 429 is retried with backoff and eventually succeeds', async () => {
  fetchQueue = [
    () => jsonResponse(429, { detail: 'Rate limit exceeded' }),
    () => jsonResponse(429, { detail: 'Rate limit exceeded' }),
    () => jsonResponse(200, successBody('sess-retry-1', 1)),
  ];
  const before = fetchCallCount;
  const res = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-retry-1', 1) },
    { tab: { id: 20 }, frameId: 0 }
  );
  assert.strictEqual(res.success, true, 'Must eventually succeed after transient 429s');
  assert.strictEqual(fetchCallCount - before, 3, 'Must have made exactly 3 fetch calls (2 failed + 1 success)');
});

await runTestCase('5.3: retries are exhausted after MAX_NETWORK_RETRIES_PER_STEP and the failure surfaces', async () => {
  fetchQueue = [
    () => jsonResponse(503, { detail: 'unavailable' }),
    () => jsonResponse(503, { detail: 'unavailable' }),
    () => jsonResponse(503, { detail: 'unavailable' }),
    () => jsonResponse(503, { detail: 'unavailable' }), // 1 initial + 3 retries = 4 total
  ];
  const before = fetchCallCount;
  const res = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-retry-2', 1) },
    { tab: { id: 21 }, frameId: 0 }
  );
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('503'), `Expected the final error to mention 503, got: ${res.error}`);
  assert.strictEqual(fetchCallCount - before, 4, 'Must stop after the per-step retry budget is exhausted, not retry forever');
});

await runTestCase('5.3: a non-retryable status (e.g. 400) is NOT retried at all', async () => {
  fetchQueue = [() => jsonResponse(400, { detail: 'bad request' })];
  const before = fetchCallCount;
  const res = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-non-retry', 1) },
    { tab: { id: 22 }, frameId: 0 }
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(fetchCallCount - before, 1, 'A non-retryable status must fail immediately on the first attempt');
});

// --- 5.3: teardown-on-tab-destruction ---

await runTestCase('5.3: tab destruction clears local session bookkeeping so a later re-use is treated as a fresh binding, not a mismatch', async () => {
  fetchQueue = [() => jsonResponse(200, successBody('sess-teardown', 1))];
  const first = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-teardown', 1) },
    { tab: { id: 55 }, frameId: 0 }
  );
  assert.strictEqual(first.success, true);

  // Simulate the tab closing. This also fires a fire-and-forget
  // notification POST to the backend (endSessionOnBackend) — queue a
  // response for THAT call and let it settle before queuing the next
  // test's response, so the two fetch consumers don't race for the same
  // queue entry.
  fetchQueue = [() => jsonResponse(200, { status: 'session_ended' })];
  registeredTabRemovedListener(55);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A later message reusing the same session_id, even from the SAME tab id
  // (extremely unlikely in practice since Chrome doesn't reuse tab ids, but
  // this proves the bookkeeping was actually deleted rather than merely
  // stale) must be treated as a fresh binding, not rejected as a mismatch.
  fetchQueue = [() => jsonResponse(200, successBody('sess-teardown', 2))];
  const second = await invokeListener(
    { type: 'SEND_PAYLOAD', payload: samplePayload('sess-teardown', 2) },
    { tab: { id: 55 }, frameId: 0 }
  );
  assert.strictEqual(second.success, true);
  assert.notStrictEqual(second.error, 'session_context_mismatch');
});

console.log(`\n--- ALL ${passCount} / ${totalCount} TRANSPORT RESILIENCE TESTS PASSED SUCCESSFULLY ---`);
