import assert from 'assert';
import { validateActionResponse } from '../src/shared/schemas.js';

console.log('=== RUNNING PHASE 1.2 CLIENT RESPONSE/SESSION BINDING TEST SUITE ===\n');

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

const validResponse = {
  session_id: 'session-abc',
  step_number: 2,
  action: { type: 'wait', risk_tier: 'safe' },
};

runTestCase('Response with correct session_id/step -> passes through', () => {
  assert.strictEqual(validateActionResponse(validResponse, 'session-abc', 1), true);
});

runTestCase('Response with a different session_id -> rejected (stale/cross-session response)', () => {
  assert.throws(
    () => validateActionResponse({ ...validResponse, session_id: 'session-xyz' }, 'session-abc', 1),
    /Session mismatch/
  );
});

runTestCase('Response with step_number != expectedStep + 1 -> rejected', () => {
  assert.throws(
    () => validateActionResponse({ ...validResponse, step_number: 5 }, 'session-abc', 1),
    /Step mismatch/
  );
});

runTestCase('Response missing action -> rejected', () => {
  const { action, ...withoutAction } = validResponse;
  assert.throws(
    () => validateActionResponse(withoutAction, 'session-abc', 1),
    /Missing action/
  );
});

runTestCase('Response with an invalid action type -> rejected', () => {
  assert.throws(
    () => validateActionResponse(
      { ...validResponse, action: { type: 'delete_everything', risk_tier: 'safe' } },
      'session-abc',
      1
    ),
    /Invalid action type/
  );
});

runTestCase('Response with an invalid risk_tier value -> rejected', () => {
  assert.throws(
    () => validateActionResponse(
      { ...validResponse, action: { type: 'wait', risk_tier: 'medium' } },
      'session-abc',
      1
    ),
    /Invalid risk tier/
  );
});

runTestCase('Non-object / null response -> rejected', () => {
  assert.throws(() => validateActionResponse(null, 'session-abc', 1), /Invalid response/);
  assert.throws(() => validateActionResponse('not-an-object', 'session-abc', 1), /Invalid response/);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} SCHEMA/SESSION-BINDING TESTS PASSED SUCCESSFULLY ---`);
