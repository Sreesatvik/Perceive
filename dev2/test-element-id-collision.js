// Phase E.2 — getElementId() collision fuzz test.
//
// getElementId()'s generated-ID scheme (`ext-el-${Date.now()}-${counter}`)
// looks trivially collision-resistant by construction (a monotonically
// increasing in-process counter can never repeat within one page's
// lifetime), but per this project's standing discipline of proving rather
// than assuming correctness, this test actually fuzzes it: 50 runs, each
// against a fresh page of 10+ structurally IDENTICAL, repeated component
// elements (the shape most likely to expose a hidden collision — e.g. a
// list of near-identical product/result cards, all missing native ids),
// checking real collisions rather than reasoning about the code in the
// abstract.
import assert from 'assert';
import { getElementId } from './dom-heuristics.js';

console.log('=== RUNNING PHASE E.2 getElementId() COLLISION FUZZ TEST ===\n');

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

const RUNS = 50;
const CARDS_PER_RUN = 12; // "10+ structurally-repeated component patterns"

/** A mock element with the minimal interface getElementId() actually uses,
 * structurally IDENTICAL to every other card in the run (no native id, no
 * pre-existing data-ext-id) — deliberately the worst case for any scheme
 * that might accidentally rely on element identity/content rather than a
 * genuinely fresh generated value. */
function mockCard() {
  const attrs = {};
  return {
    id: '',
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = value; },
  };
}

runTestCase(`${RUNS} runs x ${CARDS_PER_RUN} structurally-identical repeated cards -> zero ID collisions across all ${RUNS * CARDS_PER_RUN} generated IDs`, () => {
  const allGeneratedIds = new Set();
  let totalGenerated = 0;

  for (let run = 0; run < RUNS; run++) {
    const cards = Array.from({ length: CARDS_PER_RUN }, mockCard);
    for (const card of cards) {
      const id = getElementId(card);
      totalGenerated++;
      assert.ok(!allGeneratedIds.has(id), `COLLISION DETECTED: id "${id}" was generated more than once (run ${run}, out of ${totalGenerated} generated so far)`);
      allGeneratedIds.add(id);
    }
  }

  assert.strictEqual(allGeneratedIds.size, RUNS * CARDS_PER_RUN);
  assert.strictEqual(allGeneratedIds.size, totalGenerated, 'every generated id must be unique — set size must equal total count');
});

runTestCase('Calling getElementId() twice on the SAME element returns the SAME id (idempotent via data-ext-id), not a fresh collision-prone one each time', () => {
  const card = mockCard();
  const first = getElementId(card);
  const second = getElementId(card);
  assert.strictEqual(first, second, 'a second call on the same element must reuse its now-tagged data-ext-id, not generate a new one');
});

runTestCase('An element with a genuine native id never gets a generated ext-el- id, even under fuzzing pressure', () => {
  for (let i = 0; i < RUNS; i++) {
    const card = mockCard();
    card.id = `real-id-${i}`;
    assert.strictEqual(getElementId(card), `real-id-${i}`);
  }
});

console.log(`\n--- ALL ${passCount} / ${totalCount} getElementId() COLLISION TESTS PASSED SUCCESSFULLY ---`);
