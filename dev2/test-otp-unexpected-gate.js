// Phase F / Step 3 — proves checkForUnanticipatedOtpField() actually fires:
// given a DOM snapshot with a newly-appeared OTP-typed field and no OTP
// value anywhere in the original task instruction, the system raises
// UnresolvedSensitiveReferenceError (the SAME mechanism as the existing
// credential-parsing fail-closed path) rather than proceeding, guessing, or
// fabricating a code.
import assert from 'assert';
import { checkForUnanticipatedOtpField, UnresolvedSensitiveReferenceError } from './task-entity-extractor.js';

console.log('=== RUNNING PHASE F OTP-UNEXPECTED-GATE TEST SUITE ===\n');

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

const otpFieldElement = { element_id: 'otp-field', is_sensitive: true, sensitivity_type: 'OTP' };
const nonSensitiveElement = { element_id: 'submit-btn', is_sensitive: false, sensitivity_type: null };

runTestCase('An OTP field appears mid-flow, with no code anywhere in the original instruction -> raises UnresolvedSensitiveReferenceError', () => {
  assert.throws(
    () => checkForUnanticipatedOtpField('update my phone number to 9876543210', [nonSensitiveElement, otpFieldElement]),
    UnresolvedSensitiveReferenceError
  );
});

runTestCase('The raised error names the OTP scenario specifically (not a generic/misleading message)', () => {
  try {
    checkForUnanticipatedOtpField('update my phone number', [otpFieldElement]);
    assert.fail('expected checkForUnanticipatedOtpField to throw');
  } catch (err) {
    assert.ok(err instanceof UnresolvedSensitiveReferenceError);
    assert.ok(/otp|verification.code/i.test(err.message), `error message should describe the OTP scenario, got: ${err.message}`);
  }
});

runTestCase('No OTP field present in the DOM snapshot -> does not throw (the common case: most steps have nothing to gate on)', () => {
  assert.doesNotThrow(() => checkForUnanticipatedOtpField('update my phone number', [nonSensitiveElement]));
});

runTestCase('An OTP field present AND a real OTP value already anticipated in the instruction -> does not throw (the user planned for it up front)', () => {
  assert.doesNotThrow(() =>
    checkForUnanticipatedOtpField('update my phone number, the verification code is 482913', [otpFieldElement])
  );
});

runTestCase('An OTP field present, instruction mentions "code" but with no actual digits -> still throws (mentioning the word is not the same as anticipating a real value)', () => {
  assert.throws(
    () => checkForUnanticipatedOtpField('update my phone number, I might need a verification code', [otpFieldElement]),
    UnresolvedSensitiveReferenceError
  );
});

runTestCase('Empty/missing DOM elements array -> does not throw (nothing to gate on, never a crash)', () => {
  assert.doesNotThrow(() => checkForUnanticipatedOtpField('update my phone number', []));
  assert.doesNotThrow(() => checkForUnanticipatedOtpField('update my phone number', undefined));
  assert.doesNotThrow(() => checkForUnanticipatedOtpField('update my phone number', null));
});

console.log(`\n--- ALL ${passCount} / ${totalCount} OTP-UNEXPECTED-GATE TESTS PASSED SUCCESSFULLY ---`);
