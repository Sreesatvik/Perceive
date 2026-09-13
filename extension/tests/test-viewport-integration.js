// Phase E.2 — integration-level proof that orchestrator.js's actual
// element-collection line (`document.querySelectorAll('input, button,
// select, textarea').filter(isRectInViewport(...))`) really filters
// off-screen elements out, using a real jsdom page with elements both
// inside and outside a mocked viewport. The pure-predicate unit tests live
// in dev2/test-viewport-filtering.js; this test instead exercises the same
// querySelectorAll+filter composition orchestrator.js uses, against real
// DOM nodes, so a future refactor of orchestrator.js's collection line
// can't silently drop the filter without a test noticing.
import assert from 'assert';
import { JSDOM } from 'jsdom';
import { isRectInViewport } from '../../dev2/dom-heuristics.js';

console.log('=== RUNNING PHASE E.2 VIEWPORT INTEGRATION TEST SUITE ===\n');

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

const VIEWPORT_W = 1024;
const VIEWPORT_H = 768;

runTestCase('A real jsdom page with a long scrollable form: the SAME querySelectorAll+filter composition orchestrator.js uses keeps only in-viewport fields', () => {
  const dom = new JSDOM(`
    <form>
      <input id="name" />
      <input id="email" />
      <input id="address" />
      <input id="submit-far-below" />
    </form>
  `);
  const { document } = dom.window;

  // jsdom does not implement real layout, so getBoundingClientRect() always
  // returns a zero rect — mock it per-element exactly as a long scrollable
  // form would lay out (first two fields above the fold, the rest requiring
  // scroll), the same technique used for jsdom rect-dependent tests
  // elsewhere in this suite.
  const rects = {
    name: { left: 20, top: 20, right: 300, bottom: 50 },
    email: { left: 20, top: 70, right: 300, bottom: 100 },
    address: { left: 20, top: 2000, right: 300, bottom: 2030 }, // far below the fold
    'submit-far-below': { left: 20, top: 2100, right: 300, bottom: 2140 }, // far below the fold
  };
  for (const [id, rect] of Object.entries(rects)) {
    document.getElementById(id).getBoundingClientRect = () => rect;
  }

  // This mirrors orchestrator.js's captureOnce() collection line exactly:
  // `Array.from(document.querySelectorAll(...)).filter((el) => isRectInViewport(el.getBoundingClientRect(), W, H))`
  const elements = Array.from(document.querySelectorAll('input, button, select, textarea'))
    .filter((el) => isRectInViewport(el.getBoundingClientRect(), VIEWPORT_W, VIEWPORT_H));

  assert.deepStrictEqual(elements.map((el) => el.id), ['name', 'email']);
});

runTestCase('An SPA drawer/menu positioned off-canvas (large negative left) is excluded even though it exists in the DOM', () => {
  const dom = new JSDOM(`<div><button id="visible-btn">Save</button><button id="offcanvas-btn">Hidden drawer action</button></div>`);
  const { document } = dom.window;
  document.getElementById('visible-btn').getBoundingClientRect = () => ({ left: 10, top: 10, right: 100, bottom: 40 });
  document.getElementById('offcanvas-btn').getBoundingClientRect = () => ({ left: -9999, top: 10, right: -9899, bottom: 40 });

  const elements = Array.from(document.querySelectorAll('input, button, select, textarea'))
    .filter((el) => isRectInViewport(el.getBoundingClientRect(), VIEWPORT_W, VIEWPORT_H));

  assert.deepStrictEqual(elements.map((el) => el.id), ['visible-btn']);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} VIEWPORT INTEGRATION TESTS PASSED SUCCESSFULLY ---`);
