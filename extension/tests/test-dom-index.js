import assert from 'assert';
import { JSDOM } from 'jsdom';

console.log('=== RUNNING PHASE 5.1 DOM-INDEX RESILIENCE TEST SUITE ===\n');

let passCount = 0;
let totalCount = 0;

function runTestCase(name, fn) {
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

// Fresh jsdom + fresh module import per test case, since domIndex.js's
// MutationObserver/document references are captured at import time via
// globals — isolating each test avoids cross-test DOM state leaking.
async function withFreshDom(html, fn) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.MutationObserver = dom.window.MutationObserver;
  // jsdom doesn't implement the CSS.escape() spec — minimal polyfill
  // sufficient for the simple ids used in these tests.
  global.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };

  const modUrl = `../src/content/domIndex.js?t=${Date.now()}-${Math.random()}`;
  const mod = await import(modUrl);
  try {
    await fn(mod);
  } finally {
    delete global.window;
    delete global.document;
    delete global.MutationObserver;
    delete global.CSS;
  }
}

await (async () => {
  await withFreshDom(
    `<button data-ext-id="btn-1">Save</button>`,
    (mod) => {
      runTestCase('findAgentElement: direct data-ext-id hit', () => {
        const el = mod.findAgentElement('btn-1');
        assert.ok(el, 'Element must be found');
        assert.strictEqual(el.textContent, 'Save');
      });
    }
  );
})();

await (async () => {
  await withFreshDom(
    `<button id="btn-2">Cancel</button>`,
    (mod) => {
      runTestCase('findAgentElement: falls back to plain id when no data-ext-id matches', () => {
        const el = mod.findAgentElement('btn-2');
        assert.ok(el);
        assert.strictEqual(el.id, 'btn-2');
      });
    }
  );
})();

await (async () => {
  await withFreshDom(
    `<button data-ext-id="btn-3">Continue</button>`,
    (mod) => {
      runTestCase('findAgentElementResilient: stable match (no mutation) uses fast path, not reindexed', () => {
        const result = mod.findAgentElementResilient('btn-3', { tag: 'button', label_text: 'Continue' });
        assert.ok(result.element);
        assert.strictEqual(result.reindexed, false);
      });
    }
  );
})();

await (async () => {
  // Simulates an SPA re-render: the original data-ext-id="btn-4" element is
  // GONE (framework tore it down), replaced by a fresh <button> with the
  // same tag+label but no data-ext-id at all.
  await withFreshDom(
    `<div id="app"><button>Submit order</button></div>`,
    (mod) => {
      runTestCase('findAgentElementResilient: re-indexes after a stale (missing) lookup by matching tag+label', () => {
        const result = mod.findAgentElementResilient('btn-4', { tag: 'button', label_text: 'Submit order' });
        assert.ok(result.element, 'Must find the re-rendered element by tag+label');
        assert.strictEqual(result.reindexed, true);
        assert.strictEqual(result.element.getAttribute('data-ext-id'), 'btn-4',
          'Re-indexed element must be re-tagged so future lookups hit the fast path');
      });
    }
  );
})();

await (async () => {
  // The direct id exists but now points at a COMPLETELY different element
  // (both tag and label differ) — e.g. the framework recycled the DOM node
  // for something else. The real "Delete" button lives elsewhere.
  await withFreshDom(
    `<div>
       <input data-ext-id="target-5" type="text" placeholder="unrelated recycled node">
       <button aria-label="Delete item">Delete</button>
     </div>`,
    (mod) => {
      runTestCase('findAgentElementResilient: re-indexes when the direct hit has been recycled into something unrelated', () => {
        const result = mod.findAgentElementResilient('target-5', { tag: 'button', label_text: 'Delete item' });
        assert.ok(result.element);
        assert.strictEqual(result.reindexed, true);
        assert.strictEqual(result.element.tagName.toLowerCase(), 'button');
      });
    }
  );
})();

await (async () => {
  await withFreshDom(
    `<div><button aria-label="X">A</button><button aria-label="X">B</button></div>`,
    (mod) => {
      runTestCase('findAgentElementResilient: ambiguous re-index (2+ candidates) fails closed, not a guess', () => {
        const result = mod.findAgentElementResilient('missing-id', { tag: 'button', label_text: 'X' });
        assert.strictEqual(result.element, null);
        assert.strictEqual(result.reindexed, false);
      });
    }
  );
})();

await (async () => {
  await withFreshDom(`<div></div>`, (mod) => {
    runTestCase('findAgentElementResilient: nothing found anywhere returns null, not a throw', () => {
      const result = mod.findAgentElementResilient('ghost-id', { tag: 'button', label_text: 'Nonexistent' });
      assert.strictEqual(result.element, null);
    });
  });
})();

await (async () => {
  await withFreshDom(`<div id="root"></div>`, async (mod) => {
    await runAsyncTestCase('startMutationTracking/getMutationCount: observes real DOM changes', async () => {
      mod.startMutationTracking();
      mod.resetMutationCount();
      assert.strictEqual(mod.getMutationCount(), 0);

      const btn = document.createElement('button');
      document.getElementById('root').appendChild(btn);

      // MutationObserver callbacks are microtask-queued; flush them.
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.ok(mod.getMutationCount() > 0, 'A real DOM mutation must be observed');
      mod.stopMutationTracking();
    });
  });
})();

console.log(`\n--- ALL ${passCount} / ${totalCount} DOM-INDEX RESILIENCE TESTS PASSED SUCCESSFULLY ---`);
