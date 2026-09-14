// Phase G / G.2 Row 2 — CSS-trickery field-type spoofing.
//
// Confirms classifyElement() (dom-heuristics.js) never inspects computed
// CSS style at all — grepped the file for getComputedStyle/`.style` and
// found zero references, so this was already architecturally immune, but
// per this project's standing discipline of proving rather than assuming,
// this test constructs the two adversarial directions explicitly:
//   (a) a real type="text" field styled with -webkit-text-security to
//       LOOK like a password visually — must NOT be classified sensitive
//       (a real attacker trying to make a password-harvesting field look
//       like it's "just text" to a naive visual scan would want the
//       OPPOSITE of this, but this direction proves style alone can't
//       manufacture false sensitivity either way).
//   (b) a real type="password" field styled to visually look like plain
//       text (e.g. text-security:none, or just a misleading class name) —
//       MUST still be classified sensitive/PASSWORD, since a real
//       attacker trying to visually disguise a password field as an
//       innocuous text field to fool a human reviewer must not also fool
//       the detector.
// Classification must depend only on real DOM signals (type attribute,
// autocomplete attribute, label/placeholder text) — never on how the
// field happens to render.
import assert from 'assert';
import { classifyElement } from './dom-heuristics.js';

console.log('=== RUNNING PHASE G ROW 2: CSS-TRICKERY FIELD-TYPE SPOOFING TEST SUITE ===\n');

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

function mockInput({ type, autocomplete = null, placeholder = null, style = null, labelText = null }) {
  return {
    tagName: 'INPUT',
    labels: labelText ? [{ textContent: labelText }] : [],
    getAttribute: (attr) => {
      if (attr === 'type') return type;
      if (attr === 'autocomplete') return autocomplete;
      if (attr === 'placeholder') return placeholder;
      if (attr === 'style') return style; // present, but must be IGNORED by classifyElement
      return null;
    },
    hasAttribute: () => false,
  };
}

runTestCase('A real type="text" field styled with -webkit-text-security (visually LOOKS like a password) is NOT classified sensitive — style is ignored, only the real type attribute matters', () => {
  const spoofedField = mockInput({
    type: 'text',
    style: '-webkit-text-security: disc; -moz-text-security: disc;',
    labelText: 'Comments',
  });

  const result = classifyElement(spoofedField);

  assert.strictEqual(result.is_sensitive, false);
  assert.strictEqual(result.sensitivity_type, 'UNKNOWN');
});

runTestCase('A real type="password" field styled to visually look like plain text (misleading class/style) IS STILL classified sensitive/PASSWORD — visual disguise cannot suppress real detection', () => {
  const disguisedPasswordField = mockInput({
    type: 'password',
    style: '-webkit-text-security: none; font-family: inherit; border: none; background: transparent;',
    labelText: 'Comments', // even a misleading, innocuous-looking label
  });

  const result = classifyElement(disguisedPasswordField);

  assert.strictEqual(result.is_sensitive, true);
  assert.strictEqual(result.sensitivity_type, 'PASSWORD');
});

runTestCase('Control: an ordinary, unstyled type="password" field is classified sensitive (proves the test harness itself is meaningful, not just always returning false)', () => {
  const plainPasswordField = mockInput({ type: 'password', labelText: 'Password' });
  const result = classifyElement(plainPasswordField);
  assert.strictEqual(result.is_sensitive, true);
  assert.strictEqual(result.sensitivity_type, 'PASSWORD');
});

runTestCase('Control: an ordinary, unstyled type="text" field with no PII-suggestive label is classified NOT sensitive', () => {
  const plainTextField = mockInput({ type: 'text', labelText: 'Comments' });
  const result = classifyElement(plainTextField);
  assert.strictEqual(result.is_sensitive, false);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} CSS-TRICKERY SPOOFING TESTS PASSED SUCCESSFULLY ---`);
