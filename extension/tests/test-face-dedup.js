import assert from 'assert';
import { dedupFaces } from '../src/vision/faceDedup.js';

console.log('=== RUNNING PHASE B.5 FACE-DEDUP TEST SUITE ===\n');

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

runTestCase('two heavily-overlapping boxes for one face are merged down to the higher-confidence one (the angled_1.jpg motivating case)', () => {
  const faces = [
    { bounding_box: { x: 100, y: 100, w: 200, h: 200 }, confidence: 0.6 },
    { bounding_box: { x: 105, y: 95, w: 195, h: 205 }, confidence: 0.9 }, // near-identical, higher confidence
  ];
  const result = dedupFaces(faces, 0.5);
  assert.strictEqual(result.length, 1, 'expected the two overlapping boxes to merge into one');
  assert.strictEqual(result[0].confidence, 0.9, 'the higher-confidence box must be the one kept');
});

runTestCase('two genuinely separate faces (low IoU) are both kept', () => {
  const faces = [
    { bounding_box: { x: 0, y: 0, w: 100, h: 100 }, confidence: 0.8 },
    { bounding_box: { x: 500, y: 500, w: 100, h: 100 }, confidence: 0.7 },
  ];
  const result = dedupFaces(faces, 0.5);
  assert.strictEqual(result.length, 2, 'non-overlapping faces must not be deduped away');
});

runTestCase('a threshold of 0 (falsy) disables dedup entirely — returns input unchanged', () => {
  const faces = [
    { bounding_box: { x: 100, y: 100, w: 200, h: 200 }, confidence: 0.6 },
    { bounding_box: { x: 105, y: 95, w: 195, h: 205 }, confidence: 0.9 },
  ];
  const result = dedupFaces(faces, 0);
  assert.strictEqual(result.length, 2, 'dedupIouThreshold=0/undefined must be a no-op, matching todays shipped (no-dedup) behavior');
});

runTestCase('three-way overlap keeps only the single highest-confidence box', () => {
  const faces = [
    { bounding_box: { x: 100, y: 100, w: 200, h: 200 }, confidence: 0.5 },
    { bounding_box: { x: 102, y: 98, w: 198, h: 202 }, confidence: 0.95 },
    { bounding_box: { x: 98, y: 102, w: 202, h: 198 }, confidence: 0.7 },
  ];
  const result = dedupFaces(faces, 0.5);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].confidence, 0.95);
});

runTestCase('a union-of-two-models scenario: duplicate detections from two different models for the same face collapse to one', () => {
  // Simulates Step 2: short_range and full_range both detecting the same
  // real face with slightly different box coordinates.
  const shortRangeFace = { bounding_box: { x: 200, y: 150, w: 180, h: 180 }, confidence: 0.82 };
  const fullRangeFace = { bounding_box: { x: 195, y: 155, w: 190, h: 175 }, confidence: 0.77 };
  const distinctSecondFace = { bounding_box: { x: 900, y: 800, w: 100, h: 100 }, confidence: 0.65 };
  const result = dedupFaces([shortRangeFace, fullRangeFace, distinctSecondFace], 0.5);
  assert.strictEqual(result.length, 2, 'the duplicate should merge; the genuinely distinct second face must survive');
  assert.ok(result.some((f) => f.confidence === 0.82), 'the higher-confidence duplicate must be the one kept');
});

console.log(`\n--- ALL ${passCount} / ${totalCount} FACE-DEDUP TESTS PASSED SUCCESSFULLY ---`);
