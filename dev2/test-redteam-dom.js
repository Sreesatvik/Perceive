import assert from 'assert';
import { classifyElement } from './dom-heuristics.js';

console.log('=== RUNNING PHASE 4.3 RED-TEAM DOM-LAYER TEST SUITE ===\n');

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

function makeButton({ ariaLabel = null, visibleText = '' } = {}) {
  return {
    tagName: 'BUTTON',
    innerText: visibleText,
    textContent: visibleText,
    getAttribute: (attr) => {
      if (attr === 'aria-label') return ariaLabel;
      return null;
    },
  };
}

runTestCase('classifyElement reads the REAL aria-label, not the deceptive visible text, for the red-team fake button', () => {
  // Mirrors extension/tests/redteam/redteam-page.html's #fake-continue-btn:
  // visible text says "Continue ->", but the real accessible label says
  // what the button actually does. Found (and fixed) via Phase 4 red-team
  // testing: dom-heuristics.js's button branch previously read
  // innerText/textContent directly, never checking aria-label at all —
  // meaning this exact deception would have slipped through undetected.
  const fakeButton = makeButton({ ariaLabel: 'Delete Account Permanently', visibleText: 'Continue →' });

  const result = classifyElement(fakeButton);

  assert.strictEqual(result.tag, 'button');
  assert.strictEqual(result.label_text, 'Delete Account Permanently',
    'label_text must reflect the real aria-label, not the deceptive visible caption');
});

runTestCase('classifyElement still falls back to visible text for an ordinary button with no aria-label (regression)', () => {
  const ordinaryButton = makeButton({ ariaLabel: null, visibleText: 'Save changes' });

  const result = classifyElement(ordinaryButton);

  assert.strictEqual(result.label_text, 'Save changes');
});

console.log(`\n--- ALL ${passCount} / ${totalCount} RED-TEAM DOM-LAYER TESTS PASSED SUCCESSFULLY ---`);
