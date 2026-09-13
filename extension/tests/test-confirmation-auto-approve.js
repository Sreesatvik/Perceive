import assert from 'assert';
import { JSDOM } from 'jsdom';

console.log('=== RUNNING CONFIRMATION AUTO-APPROVE FIXTURE TEST SUITE ===\n');

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

async function withFreshDom(html, fn) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
  const modUrl = `../src/content/confirmationUI.js?t=${Date.now()}-${Math.random()}`;
  const mod = await import(modUrl);
  try {
    await fn(mod);
  } finally {
    delete global.window;
    delete global.document;
    delete global.CSS;
  }
}

await runTestCase('requestConfirmation auto-approves instantly on a page marked data-perceive-test-fixture="true", no dialog shown', async () => {
  await withFreshDom(`<html data-perceive-test-fixture="true"><body></body></html>`, async (mod) => {
    const result = await mod.requestConfirmation({ type: 'click', target_element_id: 'x', reasoning_short: 'test' });
    assert.strictEqual(result, true);
    // The dialog overlay must never have been created for an auto-approved fixture.
    assert.strictEqual(document.getElementById('confirmation-allow'), null);
  });
});

await runTestCase('requestConfirmation calls the native window.confirm() (not a custom DOM overlay) on an ordinary page', async () => {
  await withFreshDom(`<html><body></body></html>`, async (mod) => {
    let calledWith = null;
    global.window.confirm = (message) => { calledWith = message; return true; };

    const result = await mod.requestConfirmation({ type: 'click', target_element_id: 'x', reasoning_short: 'test reason' });

    assert.strictEqual(result, true);
    assert.ok(calledWith, 'window.confirm() must have been called');
    assert.ok(calledWith.includes('click'), 'The confirm message must mention the action type');
    assert.ok(calledWith.includes('test reason'), 'The confirm message must mention the reasoning');
    // Proves this is NOT the old custom overlay — no such elements exist.
    assert.strictEqual(document.getElementById('confirmation-allow'), null);
  });
});

await runTestCase('requestConfirmation returns false when window.confirm() is dismissed/denied', async () => {
  await withFreshDom(`<html><body></body></html>`, async (mod) => {
    global.window.confirm = () => false;
    const result = await mod.requestConfirmation({ type: 'click', target_element_id: 'x', reasoning_short: 'test' });
    assert.strictEqual(result, false);
  });
});

await runTestCase('window.__PERCEIVE_TEST_MODE__ also triggers auto-approval (same-world sandbox harness path)', async () => {
  await withFreshDom(`<html><body></body></html>`, async (mod) => {
    global.window.__PERCEIVE_TEST_MODE__ = true;
    const result = await mod.requestConfirmation({ type: 'click', target_element_id: 'x', reasoning_short: 'test' });
    assert.strictEqual(result, true);
    assert.strictEqual(document.getElementById('confirmation-allow'), null);
  });
});

console.log(`\n--- ALL ${passCount} / ${totalCount} CONFIRMATION AUTO-APPROVE TESTS PASSED SUCCESSFULLY ---`);
