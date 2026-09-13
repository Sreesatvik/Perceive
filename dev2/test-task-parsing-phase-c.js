import assert from 'assert';
import { createTokenVault } from './token-vault.js';
import {
  resolveCredentialTokens,
  isCredentialFree,
  impliesCredentialNeed,
  extractCandidateValueSlots,
  UnresolvedSensitiveReferenceError,
} from './task-entity-extractor.js';

console.log('=== RUNNING PHASE C.1/C.2 TASK-PARSING FIX TEST SUITE ===\n');

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

// --- Regression tests for the three real bugs found in Phase C.1's baseline ---

runTestCase('BUG FIX: "log into"/"sign into" are now recognized as login intent (word-boundary bug)', () => {
  assert.strictEqual(impliesCredentialNeed('please can you log into my account for me'), true);
  assert.strictEqual(impliesCredentialNeed('please log me into my saved account'), true);
  // Before the fix, neither of these implied credential need at all, so
  // resolveCredentialTokens silently passed them through with zero
  // credentials and never raised UNRESOLVED — the single worst finding in
  // docs/task-parsing-baseline.md. Both must now fail closed.
  const vault = createTokenVault();
  assert.throws(
    () => resolveCredentialTokens('please can you log into my account for me', vault),
    UnresolvedSensitiveReferenceError
  );
});

runTestCase('BUG FIX: "type X into the Y field" no longer hallucinates the word "field" as the value', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('type Password123 into the password field', vault);
  assert.ok(result.includes('into the password field'), `expected "field" to remain literal text, got: ${result}`);
  assert.ok(/password \[PASSWORD_[a-z0-9]{10}\]/.test(result) === false, 'the real fix inserts the token before "into", not after "password"');
  assert.ok(!result.includes('Password123'), 'raw password must not remain in the sanitized instruction');
});

runTestCase('BUG FIX: "fill X field with Y" no longer hallucinates the word "field" as the value', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('fill username field with tomsmith', vault);
  assert.ok(!result.includes('tomsmith'), 'raw username must not remain in the sanitized instruction');
  assert.ok(result.includes('username field with'), `expected "field" to remain literal text, got: ${result}`);
});

runTestCase('BUG FIX: a trailing "!" in a password is no longer truncated/leaked', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('sign in with my account tom.smith@example.com / Passw0rd!', vault);
  assert.ok(!result.includes('Passw0rd'), `raw password fragment must not remain, got: ${result}`);
  assert.ok(!result.includes('!'), `trailing "!" must be tokenized away, not leaked, got: ${result}`);
});

runTestCase('BUG FIX (critical): the bare "name" synonym no longer matches as a substring of "username" and double-tokenizes an already-inserted token', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('enter username: tomsmith, password: Password123', vault);
  assert.ok(!/\[NAME_[a-z0-9]{10}\]\)?\]/.test(result), `a token must never be re-wrapped in another token, got: ${result}`);
  assert.strictEqual((result.match(/\[NAME_[a-z0-9]{10}\]/g) || []).length, 1, `expected exactly one NAME token, got: ${result}`);
});

runTestCase('BUG FIX: "update my X to Y" no longer hallucinates the word "to" as the value', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('update my phone number to 9876543210', vault);
  assert.ok(!result.includes('9876543210'), `raw phone number must not remain, got: ${result}`);
  assert.ok(result.includes('phone number to'), `expected "to" to remain literal text, got: ${result}`);
});

// --- New field coverage (email/phone/name), previously entirely absent ---

runTestCase('NEW: multi-field form extraction (name/email/phone all tokenized in one pass)', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('fill in the form with name Priya Shah, email priya@x.com, phone 9876543210', vault);
  assert.ok(!result.includes('Priya Shah'), 'raw name must not remain');
  assert.ok(!result.includes('priya@x.com'), 'raw email must not remain');
  assert.ok(!result.includes('9876543210'), 'raw phone must not remain');
  assert.ok(/\[NAME_[a-z0-9]{10}\]/.test(result), 'expected a NAME token');
  assert.ok(/\[EMAIL_[a-z0-9]{10}\]/.test(result), 'expected an EMAIL token');
  assert.ok(/\[PHONE_[a-z0-9]{10}\]/.test(result), 'expected a PHONE token');
});

runTestCase('NEW: a multi-word name ("Priya Shah") is captured in full, not just the first word', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('change my name to Priya Shah', vault);
  assert.ok(!result.includes('Priya'), 'raw first name must not remain');
  assert.ok(!result.includes('Shah'), 'raw surname must not remain — this was a real leak in an earlier iteration of this fix');
});

// --- extractCandidateValueSlots: the client-side half of the Phase C.2(c) privacy boundary ---

runTestCase('extractCandidateValueSlots never includes the real raw values anywhere in the returned slotInstruction', () => {
  const rawUsername = 'tom';
  const rawPassword = 'SuperSecretPassword!';
  const instruction = `sign in using ${rawUsername} and ${rawPassword}`;
  const result = extractCandidateValueSlots(instruction);
  assert.ok(result, 'expected candidate slots to be found for this phrasing');
  assert.ok(!result.slotInstruction.includes(rawUsername), `raw username leaked into slotInstruction: ${result.slotInstruction}`);
  assert.ok(!result.slotInstruction.includes(rawPassword), `raw password leaked into slotInstruction: ${result.slotInstruction}`);
  assert.ok(/<<SLOT_1>>/.test(result.slotInstruction) && /<<SLOT_2>>/.test(result.slotInstruction));
  // The real values are only ever available in the LOCAL return value,
  // never sent anywhere by this function itself.
  assert.strictEqual(result.slotValues.SLOT_1, rawUsername);
  assert.strictEqual(result.slotValues.SLOT_2, rawPassword);
});

runTestCase('extractCandidateValueSlots returns null when no candidate tokens exist at all', () => {
  assert.strictEqual(extractCandidateValueSlots('log me in'), null);
  assert.strictEqual(extractCandidateValueSlots(''), null);
});

runTestCase('isCredentialFree correctly reports false once email/phone/name extraction is wired in (regression: must not report free when a value IS present)', () => {
  assert.strictEqual(isCredentialFree("log in with username 'tomsmith' and password 'x'"), false);
  assert.strictEqual(isCredentialFree('log me in'), true);
  assert.strictEqual(isCredentialFree('click submit'), true);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} PHASE C TASK-PARSING FIX TESTS PASSED SUCCESSFULLY ---`);
