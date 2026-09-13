// Phase E.2 — viewport/off-screen element filtering.
//
// Before isRectInViewport existed, orchestrator.js's element collection
// (`document.querySelectorAll('input, button, select, textarea')`) had NO
// viewport filtering at all: every matching element in the whole document
// was included in the DOM summary sent to the server, regardless of scroll
// position — an element far below the fold (never actually rendered in the
// captured screenshot) was reported as if it were on-screen. This suite
// tests the pure predicate directly (no real browser needed — plain
// {left, right, top, bottom} rects, same style as this file's sibling
// tests for classifyElement/getElementId).
import assert from 'assert';
import { isRectInViewport } from './dom-heuristics.js';

console.log('=== RUNNING PHASE E.2 VIEWPORT-FILTERING TEST SUITE ===\n');

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

const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

runTestCase('An element fully inside the viewport is in-viewport', () => {
  assert.strictEqual(isRectInViewport({ left: 10, top: 10, right: 200, bottom: 60 }, VIEWPORT_W, VIEWPORT_H), true);
});

runTestCase('An element far below the fold (top/bottom both past viewport height) is NOT in-viewport', () => {
  assert.strictEqual(isRectInViewport({ left: 10, top: 5000, right: 200, bottom: 5060 }, VIEWPORT_W, VIEWPORT_H), false);
});

runTestCase('An element far to the right of the viewport (e.g. an off-canvas SPA drawer) is NOT in-viewport', () => {
  assert.strictEqual(isRectInViewport({ left: 2000, top: 10, right: 2200, bottom: 60 }, VIEWPORT_W, VIEWPORT_H), false);
});

runTestCase('An element entirely above the viewport (negative bottom, scrolled past) is NOT in-viewport', () => {
  assert.strictEqual(isRectInViewport({ left: 10, top: -200, right: 200, bottom: -140 }, VIEWPORT_W, VIEWPORT_H), false);
});

runTestCase('An element entirely to the left of the viewport (negative right) is NOT in-viewport', () => {
  assert.strictEqual(isRectInViewport({ left: -300, top: 10, right: -100, bottom: 60 }, VIEWPORT_W, VIEWPORT_H), false);
});

runTestCase('An element straddling the bottom edge (partially visible) IS in-viewport (intersects at all, not fully contained)', () => {
  assert.strictEqual(isRectInViewport({ left: 10, top: 790, right: 200, bottom: 850 }, VIEWPORT_W, VIEWPORT_H), true);
});

runTestCase('An element straddling the left edge (partially visible, e.g. scrolled horizontally) IS in-viewport', () => {
  assert.strictEqual(isRectInViewport({ left: -50, top: 10, right: 50, bottom: 60 }, VIEWPORT_W, VIEWPORT_H), true);
});

runTestCase('A collapsed/display:none element (0x0 rect at origin) is NOT in-viewport (zero-area rects never intersect)', () => {
  assert.strictEqual(isRectInViewport({ left: 0, top: 0, right: 0, bottom: 0 }, VIEWPORT_W, VIEWPORT_H), false);
});

runTestCase('A null/undefined rect is treated as NOT in-viewport rather than throwing', () => {
  assert.strictEqual(isRectInViewport(null, VIEWPORT_W, VIEWPORT_H), false);
  assert.strictEqual(isRectInViewport(undefined, VIEWPORT_W, VIEWPORT_H), false);
});

runTestCase('A real-shaped scrollable-form scenario: 3 fields above the fold, 2 far below it — only the 3 in-viewport survive a filter pass', () => {
  const fields = [
    { name: 'name', rect: { left: 20, top: 20, right: 300, bottom: 50 } },
    { name: 'email', rect: { left: 20, top: 70, right: 300, bottom: 100 } },
    { name: 'phone', rect: { left: 20, top: 120, right: 300, bottom: 150 } },
    { name: 'address-below-fold', rect: { left: 20, top: 3000, right: 300, bottom: 3030 } },
    { name: 'submit-below-fold', rect: { left: 20, top: 3100, right: 300, bottom: 3140 } },
  ];
  const visible = fields.filter((f) => isRectInViewport(f.rect, VIEWPORT_W, VIEWPORT_H));
  assert.deepStrictEqual(visible.map((f) => f.name), ['name', 'email', 'phone']);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} VIEWPORT-FILTERING TESTS PASSED SUCCESSFULLY ---`);
