import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('=== RUNNING POPUP NO-CONTENT-SCRIPT ERROR HANDLING TEST SUITE ===\n');

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

const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'popup.html'), 'utf-8');
const popupJsUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'popup', 'popup.js')).href;

/**
 * Loads a fresh popup.js module instance against a fresh jsdom document and
 * a chrome mock that fails chrome.tabs.sendMessage with the given
 * lastError message. Real popup.js registers its click listener at import
 * time, so each test case needs its own DOM + chrome mock + fresh import
 * (via a cache-busting query string, same trick used elsewhere in this
 * suite for orchestrator.js) rather than one shared module instance.
 */
async function loadPopupWithMockedSendMessage({ tabUrl, lastErrorMessage }) {
  const dom = new JSDOM(popupHtml, { runScripts: 'outside-only' });
  global.window = dom.window;
  global.document = dom.window.document;

  global.chrome = {
    tabs: {
      query: async () => [{ id: 1, url: tabUrl }],
      sendMessage: (tabId, message, callback) => {
        global.chrome.runtime.lastError = { message: lastErrorMessage };
        callback(undefined);
        global.chrome.runtime.lastError = undefined;
      },
      create: () => {},
    },
    runtime: {
      lastError: undefined,
      onMessage: { addListener: () => {} },
      getURL: (p) => `chrome-extension://fake-id/${p}`,
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  };

  await import(`${popupJsUrl}?t=${Date.now()}-${Math.random()}`);

  document.getElementById('task-input').value = 'click the button';
  document.getElementById('run-btn').dispatchEvent(new dom.window.Event('click'));

  // Let the async click handler's microtasks (tabs.query, sendMessage callback) settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  return document.getElementById('status').textContent;
}

await runTestCase('a known-restricted tab URL (chrome://) gets the purpose-built "can\'t run on this page" message, not the raw Chrome error', async () => {
  const status = await loadPopupWithMockedSendMessage({
    tabUrl: 'chrome://extensions/',
    lastErrorMessage: 'Could not establish connection. Receiving end does not exist.',
  });
  assert.ok(status.includes("can't run on this page"), `expected the restricted-page message, got: ${status}`);
  assert.ok(!status.includes('Receiving end does not exist'), 'raw Chrome error text must not leak through');
});

await runTestCase('a PDF viewer tab URL also gets the restricted-page message', async () => {
  const status = await loadPopupWithMockedSendMessage({
    tabUrl: 'https://example.com/some-document.pdf',
    lastErrorMessage: 'Could not establish connection. Receiving end does not exist.',
  });
  assert.ok(status.includes("can't run on this page"), `expected the restricted-page message, got: ${status}`);
});

await runTestCase('an ordinary https:// tab with the same error gets the "try refreshing" message instead (stale content script, not a restricted page)', async () => {
  const status = await loadPopupWithMockedSendMessage({
    tabUrl: 'https://example.com/some-normal-page',
    lastErrorMessage: 'Could not establish connection. Receiving end does not exist.',
  });
  assert.ok(status.includes('try refreshing'), `expected the stale-tab message, got: ${status}`);
  assert.ok(!status.includes("can't run on this page"), 'an ordinary page must not be misdiagnosed as restricted');
});

await runTestCase('an unrelated connection error on an ordinary page is NOT swallowed or misdiagnosed — it surfaces verbatim', async () => {
  const status = await loadPopupWithMockedSendMessage({
    tabUrl: 'https://example.com/some-normal-page',
    lastErrorMessage: 'Some completely different Chrome error',
  });
  assert.ok(status.includes('Some completely different Chrome error'), `expected the raw error to surface, got: ${status}`);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} POPUP CONNECTION-ERROR TESTS PASSED SUCCESSFULLY ---`);
