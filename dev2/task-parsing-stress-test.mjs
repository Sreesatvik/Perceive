// Phase C.1/C.2 — reusable stress-test harness for
// dev2/task-entity-extractor.js's client-side fast path. Run with no args
// for a human-readable report; pass an output path to also write the full
// structured results as JSON (used to produce the committed
// docs/task-parsing-baseline.json / docs/task-parsing-after-fix.json
// artifacts, so the before/after comparison in Step 2 is a real diff of
// real runs, not a claim).
import { resolveCredentialTokens, isCredentialFree, impliesCredentialNeed } from './task-entity-extractor.js';
import fs from 'fs';
import { pathToFileURL } from 'url';

function mockVault() {
  let n = 0;
  const tokens = [];
  return {
    getOrCreateToken(raw, type) {
      n++;
      const t = `[${type}_${n}]`;
      tokens.push({ raw, type, token: t });
      return t;
    },
    tokens,
  };
}

// 27 phrasings: the 9 given in the prompt, plus 18 more chosen for real
// diversity — verbose/polite, missing credentials, ambiguous references,
// multi-field forms, read-only intents, misspellings/typos, colon/
// possessive delimiter styles, and imperative DOM-action phrasing.
export const STRESS_TEST_CASES = [
  { text: "log in with username tomsmith and password Password123", expect: "username=tomsmith, password=Password123" },
  { text: "sign in, my username is tomsmith and password is Password123", expect: "username=tomsmith, password=Password123" },
  { text: "use tomsmith / Password123 to log in", expect: "username=tomsmith, password=Password123" },
  { text: "log me in", expect: "no credentials given — should raise UNRESOLVED (or resolve via vault, if C.3 is implemented)" },
  { text: "fill in the form with name Priya Shah, email priya@x.com, phone 9876543210", expect: "name=Priya Shah, email=priya@x.com, phone=9876543210" },
  { text: "update my phone number to 9876543210", expect: "phone=9876543210" },
  { text: "check my most recent transaction", expect: "no fields — read-only, should pass through unchanged, no throw" },
  { text: "click submit", expect: "no fields — should pass through unchanged, no throw" },
  { text: "please can you log into my account for me", expect: "no credentials given — should raise UNRESOLVED" },
  { text: "could you kindly sign into the site using my email priya@x.com and password Secret!23", expect: "email-as-username=priya@x.com, password=Secret!23" },
  { text: "log in using my usr tomsmith and pwd Password123", expect: "username=tomsmith, password=Password123 (misspelled labels: usr/pwd)" },
  { text: "enter username: tomsmith, password: Password123", expect: "username=tomsmith, password=Password123 (colon-delimited)" },
  { text: "sign in with my account tom.smith@example.com / Passw0rd!", expect: "username=tom.smith@example.com, password=Passw0rd!" },
  { text: "update my email address to newmail@example.com", expect: "email=newmail@example.com" },
  { text: "change my name to Priya Shah", expect: "name=Priya Shah" },
  // Intentional fail-closed behavior — a misspelled/unmatched field label
  // must never be silently guessed. This is the ONE case in this 27-phrase
  // set the fast path (a+b) does not resolve, and it is expected to throw
  // UnresolvedSensitiveReferenceError, not resolve it: 26/27, not a bug,
  // by design (see docs/task-parsing-after-fastpath-fix.md). The
  // server-mediated fallback (c) is what's meant to catch this case next —
  // see test-task-parsing-fallback-e2e.mjs for that real, end-to-end proof.
  { text: "log in — usename is tomsmith, paswrod is Password123", expect: "INTENTIONAL fail-closed: typo'd labels (usename/paswrod) correctly raise UnresolvedSensitiveReferenceError rather than guess — not a bug" },
  { text: "please log me into my saved account", expect: "no credentials given — should raise UNRESOLVED (or resolve via vault, if C.3 is implemented)" },
  { text: "sign in as tomsmith", expect: "username=tomsmith, no password given" },
  { text: "type Password123 into the password field", expect: "password=Password123" },
  { text: "fill username field with tomsmith", expect: "username=tomsmith" },
  { text: "log in with my usual credentials", expect: "no concrete value — should raise UNRESOLVED" },
  { text: "sign in using tom and 12345", expect: "username=tom, password=12345 (no anchor word immediately before the pair)" },
  { text: "complete the checkout without logging in", expect: "explicit negation of login — should NOT raise UNRESOLVED, no fields" },
  { text: "view my order history", expect: "no fields, no login intent — should pass through unchanged" },
  { text: "my username's tomsmith, and my password's Password123", expect: "username=tomsmith, password=Password123 (contractions)" },
  { text: "please enter phone number 9876543210 and email priya@x.com to register", expect: "phone=9876543210, email=priya@x.com" },
  { text: "log in with User ID tomsmith and Pass Password123", expect: "username=tomsmith, password=Password123 (capitalized synonyms: User ID / Pass)" },
];

function run() {
  const results = [];
  for (const [i, c] of STRESS_TEST_CASES.entries()) {
    const vault = mockVault();
    let outcome;
    try {
      const sanitized = resolveCredentialTokens(c.text, vault);
      outcome = {
        index: i + 1, input: c.text, expected: c.expect,
        result: 'RETURNED', sanitized, tokens_created: vault.tokens,
        impliesCredentialNeed: impliesCredentialNeed(c.text),
        isCredentialFree: isCredentialFree(c.text),
      };
    } catch (err) {
      outcome = {
        index: i + 1, input: c.text, expected: c.expect,
        result: 'THREW', error_name: err.name, error_message: err.message,
        impliesCredentialNeed: impliesCredentialNeed(c.text),
        isCredentialFree: isCredentialFree(c.text),
      };
    }
    results.push(outcome);
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = run();
  for (const r of results) {
    console.log(`${r.index}. "${r.input}"`);
    console.log(`   expected: ${r.expected}`);
    if (r.result === 'RETURNED') {
      console.log(`   ACTUAL: "${r.sanitized}" | tokens: ${JSON.stringify(r.tokens_created)}`);
    } else {
      console.log(`   ACTUAL: THREW ${r.error_name}: ${r.error_message}`);
    }
    console.log();
  }
  const outPath = process.argv[2];
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`Results written to ${outPath}`);
  }
}
