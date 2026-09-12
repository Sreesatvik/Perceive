import assert from 'assert';
import { createTokenVault } from './token-vault.js';
import {
  resolveCredentialTokens,
  UnresolvedSensitiveReferenceError,
} from './task-entity-extractor.js';

console.log('=== RUNNING PHASE 1.1 TASK-ENTITY-EXTRACTOR TEST SUITE ===\n');

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

// Plan test-case table 1.1, row 1: fast-path regression — must still pass.
runTestCase("\"username 'tomsmith' and password 'x'\" -> fast-path regex match, tokenized correctly", () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens("username 'tomsmith' and password 'x'", vault);
  assert.ok(/username \[NAME_[a-z0-9]{10}\]/.test(result), `Expected a NAME token, got: ${result}`);
  assert.ok(/password \[PASSWORD_[a-z0-9]{10}\]/.test(result), `Expected a PASSWORD token, got: ${result}`);
  assert.strictEqual(result.includes('tomsmith'), false, 'Raw username must not remain in the sanitized instruction');
});

// Row 2: informal delimiter fallback.
runTestCase('"log in with my usual account, tom / x" -> fallback extractor matches informal delimiter, tokenizes correctly', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('log in with my usual account, tom / x', vault);
  assert.strictEqual(result.includes('tom'), false, 'Raw informal username must not remain');
  assert.strictEqual(result.includes(' x'), false, 'Raw informal password must not remain');
  assert.ok(/\[NAME_[a-z0-9]{10}\]/.test(result), `Expected a NAME token, got: ${result}`);
  assert.ok(/\[PASSWORD_[a-z0-9]{10}\]/.test(result), `Expected a PASSWORD token, got: ${result}`);
});

// Row 4: no credentials anywhere -> fail closed, no silent proceed.
runTestCase('"log in" (no creds anywhere) -> raises UnresolvedSensitiveReferenceError instead of proceeding', () => {
  const vault = createTokenVault();
  assert.throws(
    () => resolveCredentialTokens('log in', vault),
    UnresolvedSensitiveReferenceError
  );
});

// Additional: an ordinary instruction with no login intent must pass through untouched.
runTestCase('"scroll down and read the article" -> no credential intent, passes through unchanged', () => {
  const vault = createTokenVault();
  const result = resolveCredentialTokens('scroll down and read the article', vault);
  assert.strictEqual(result, 'scroll down and read the article');
});

// Additional: sign in phrasing is also recognized as credential intent.
runTestCase('"please sign in" (no creds) -> also fails closed', () => {
  const vault = createTokenVault();
  assert.throws(
    () => resolveCredentialTokens('please sign in', vault),
    UnresolvedSensitiveReferenceError
  );
});

console.log(`\n--- ALL ${passCount} / ${totalCount} TASK-ENTITY-EXTRACTOR TESTS PASSED SUCCESSFULLY ---`);
