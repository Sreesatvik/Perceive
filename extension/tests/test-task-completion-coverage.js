// Bug found live: "Log in with username 'testuser' and password
// 'TestPass123!', then go to the profile page and update the phone number
// to 9876543210" — the LLM called task_complete right after login
// succeeded, never attempting the remaining sub-goals, forcing the user to
// manually re-type a fresh instruction per page. The system prompt
// (server/app/llm_client.py's MULTI-STEP INSTRUCTIONS block) is advisory
// only and was not reliably followed live, so orchestrator.js's
// verifyTaskCompletion() now HARD-BLOCKS task_complete on a non-null
// coverage result (same bounded retry path as its existing visible-error
// check), rather than merely warning. That enforcement isn't directly
// unit-testable here without a real LLM call (needs a live re-run — see
// the report); this file tests the underlying pure signal function,
// checkInstructionCoverageAgainstDom(), which orchestrator.js now treats
// as blocking rather than advisory.
import assert from 'assert';
import { checkInstructionCoverageAgainstDom } from '../src/content/taskCompletionCoverage.js';

console.log('=== RUNNING TASK-COMPLETION COVERAGE WARNING TEST SUITE ===\n');

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

const DASHBOARD_DOM = {
  // Deliberately contains nothing echoing "profile"/"phone" — this is the
  // exact DOM state at the moment the live bug occurred: the login step
  // just succeeded, the page shows the dashboard, and neither later
  // sub-goal is reflected here yet.
  url: 'http://localhost:8080/dashboard.html',
  elements: [
    { element_id: 'balance-canvas', label_text: null },
  ],
};

const PROFILE_DOM = {
  url: 'http://localhost:8080/profile.html',
  elements: [
    { element_id: 'phone', label_text: 'Phone number' },
    { element_id: 'update-btn', label_text: 'Update' },
  ],
};

runTestCase('Reproduces the exact live bug: multi-step instruction, but the current DOM is still just the dashboard (task_complete right after login) -> warns about the uncovered later steps', () => {
  const instruction = "Log in with username 'testuser' and password 'TestPass123!', then go to the profile page and update the phone number to 9876543210";
  const warning = checkInstructionCoverageAgainstDom(instruction, DASHBOARD_DOM);

  assert.ok(warning, 'expected a coverage warning when the DOM is still the dashboard but the instruction names a profile-page/phone-number step');
  assert.ok(/profile|phone/i.test(warning), `warning should reference the uncovered profile/phone sub-goal, got: ${warning}`);
});

runTestCase('Same multi-step instruction, but the current DOM IS the profile page with a phone field -> no warning (later sub-goal IS reflected in the DOM)', () => {
  const instruction = "Log in with username 'testuser' and password 'TestPass123!', then go to the profile page and update the phone number to 9876543210";
  const warning = checkInstructionCoverageAgainstDom(instruction, PROFILE_DOM);

  assert.strictEqual(warning, null, `expected no warning once the DOM reflects the later sub-goal, got: ${warning}`);
});

runTestCase('A single-goal instruction (no sequencing language) never warns, regardless of DOM content', () => {
  const warning = checkInstructionCoverageAgainstDom('log in with username tomsmith and password Password123', DASHBOARD_DOM);
  assert.strictEqual(warning, null);
});

runTestCase('An instruction using "and then" as the connector is also recognized (not just "then"/commas)', () => {
  const instruction = 'log in and then go to the profile page';
  const warning = checkInstructionCoverageAgainstDom(instruction, DASHBOARD_DOM);
  assert.ok(warning, 'expected "and then" to be recognized as a sequencing connector');
});

runTestCase('A comma-separated multi-step instruction is recognized even without "then"', () => {
  const instruction = 'log in, go to the profile page';
  const warning = checkInstructionCoverageAgainstDom(instruction, DASHBOARD_DOM);
  assert.ok(warning, 'expected a bare comma to be treated as a sub-goal separator');
});

runTestCase('Empty/missing inputs never throw', () => {
  assert.doesNotThrow(() => checkInstructionCoverageAgainstDom('', DASHBOARD_DOM));
  assert.doesNotThrow(() => checkInstructionCoverageAgainstDom(undefined, DASHBOARD_DOM));
  assert.doesNotThrow(() => checkInstructionCoverageAgainstDom('log in, then go to profile', undefined));
  assert.doesNotThrow(() => checkInstructionCoverageAgainstDom('log in, then go to profile', {}));
});

runTestCase('page_status_text (e.g. a confirmation banner or page heading) counts as coverage evidence too, not just element label_text', () => {
  const instruction = "Log in with username 'testuser' and password 'TestPass123!', then go to the profile page and update the phone number to 9876543210";
  const domWithStatusText = {
    url: 'http://localhost:8080/dashboard.html',
    elements: [{ element_id: 'balance-canvas', label_text: null }],
    page_status_text: 'Profile — Update Phone Number | Phone number updated.',
  };
  const warning = checkInstructionCoverageAgainstDom(instruction, domWithStatusText);
  assert.strictEqual(warning, null, `expected page_status_text alone to satisfy coverage for the profile/phone sub-goal, got: ${warning}`);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} TASK-COMPLETION COVERAGE TESTS PASSED SUCCESSFULLY ---`);
