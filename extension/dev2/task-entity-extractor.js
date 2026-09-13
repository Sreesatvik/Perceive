/**
 * Fallback, informal-phrasing credential extractor (Phase 1.1).
 *
 * The orchestrator's fast-path regex only recognizes explicitly-quoted
 * patterns like `username 'tomsmith' and password 'x'`. That breaks the
 * moment a judge (or any real user) phrases a task naturally — e.g.
 * "log in with my usual account, tom / x" — which was the single
 * highest-risk item for a live demo per the implementation plan.
 *
 * This module is a deliberately narrow, best-effort fallback: it only
 * fires when the fast-path regex found nothing. It never itself decides
 * to proceed with an empty/ambiguous credential — that decision belongs
 * to the orchestrator's fail-closed UNRESOLVED_SENSITIVE_REFERENCE path.
 */

// Phase C.1 baseline (docs/task-parsing-baseline.md) found "log into"/"sign
// into"/"log me into" did not match this pattern at all — \blog\s*in\b
// requires a word boundary immediately after "in", which fails inside
// "into" (no boundary between "in" and "to"). That's not just a missed
// extraction: it means impliesCredentialNeed() returns false, so the whole
// module never even attempts to look for credentials, and no
// UnresolvedSensitiveReferenceError is ever raised for phrasing this
// common — a real "silent wrong guess" risk. Fixed with an optional "to"
// directly after "in" (no word boundary requirement between them).
const CREDENTIAL_INTENT_PATTERN = /\b(log\s*in(?:to)?|log\s*me\s*in(?:to)?|sign\s*in(?:to)?)\b/i;

// Label-word synonym sets for natural phrasing variants, including common
// abbreviations/misspellings found in Phase C.1's stress test (usr, uname,
// pswd, passwrd). Longer/more specific phrases are listed first — though
// JS regex alternation backtracks through subsequent required tokens
// anyway, listing the most specific variant first keeps the intent
// readable.
//
// Unlike the pre-Phase-C version of this file, ALL five fields are now
// wired into extraction below (extractLabeledField()) — Phase C.1 found
// email/phone/name were previously undetected by this module entirely
// (name has no fallback anywhere else in the pipeline either, since
// dev2/pii-patterns.js only does value-SHAPE detection, not label-based
// extraction).
export const LABEL_SYNONYMS = {
  username: ['user id', 'userid', 'user name', 'username', 'user', 'usr', 'uname', 'login'],
  password: ['password', 'pass', 'pwd', 'pswd', 'passwrd'],
  email: ['email address', 'e-mail', 'email'],
  phone: ['phone number', 'contact number', 'mobile number', 'mobile', 'number', 'phone'],
  name: ['full name', 'name'],
};

// Common generic continuation words that the unquoted-value pattern must
// NEVER accept as a value. Phase C.1 found two real hallucinations this
// way: "type Password123 into the password field" tokenized the word
// "field" itself as the password (the real value, appearing BEFORE the
// label, was missed entirely) — same bug for "fill username field with
// tomsmith". See extractLabeledField() below for the fix: a dedicated
// value-BEFORE-label pattern is tried first for this exact phrasing shape,
// and this stoplist is a defensive backstop regardless.
// "to" added after a real bug found running the stress test against this
// very fix: "update my phone number to 9876543210" tokenized the word "to"
// itself as the phone value (the real value comes AFTER "to", a phrasing
// shape the label-before-value pattern doesn't cover — see
// updateFieldToValuePattern below for the actual fix; this stoplist entry
// is the same defense-in-depth backstop as "field"/"box"/etc.).
const GENERIC_CONTINUATION_STOPWORDS = new Set(['field', 'box', 'input', 'section', 'textbox', 'value', 'to']);

// Word-boundary-wrapped: a real bug found running the stress test against
// this very fix. Without \b around the whole alternation, the bare "name"
// synonym matched as a SUBSTRING of "username" (e.g. "enter username:
// tomsmith" — after the username pass tokenized "tomsmith", the
// UNGUARDED 'name' pass then matched "...user[name]: [NAME_1]..." and
// re-tokenized the already-inserted token itself). \b anchors the whole
// alternation group so a synonym can only match as its own word/phrase.
function labelAlternation(field) {
  const alt = LABEL_SYNONYMS[field]
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');
  return `\\b(?:${alt})\\b`;
}

// The connective between a label and its value covers three real, observed
// phrasing styles: "username is tomsmith" / "username: tomsmith" /
// "username tomsmith" — plus an optional possessive ("username's
// tomsmith"), found missing in Phase C.1's stress test (contractions like
// "my password's Password123").
function labelConnective() {
  return `(?:'s)?(?:\\s*:\\s*|\\s+)(?:is\\s+)?`;
}

// Matches a quoted value next to a label synonym, optionally preceded by
// "my" — e.g. `username 'tom'`, `my password is "x"`, `password: "x"`.
// Quoted values are higher-confidence than the unquoted variant below, so
// callers try this first.
function quotedValuePattern(field) {
  return new RegExp(`(?:my\\s+)?(?:${labelAlternation(field)})${labelConnective()}['"]([^'"]+)['"]`, 'id');
}

// Unquoted counterpart — e.g. `username tomsmith`, `my username is
// tomsmith and password is Password123`, `password: Password123`.
// Deliberately only tried when the quoted pattern above found nothing,
// since an unquoted single token is a weaker, more ambiguous signal.
//
// `name` gets one extra optional word ("Priya Shah", not just "Priya") —
// a real gap found running the stress test: a bare single-token capture
// left the surname raw and untokenized, with no downstream PII-shape
// fallback to catch it later (unlike email/phone). Capped at exactly one
// extra word so it doesn't greedily swallow into the next clause (e.g.
// "...name Priya Shah, email x@y.com" must not capture "Shah, email").
function unquotedValuePattern(field) {
  const valueCapture = field === 'name' ? '([^\\s,]+(?:\\s+[^\\s,]+)?)' : '([^\\s,]+)';
  return new RegExp(`(?:my\\s+)?(?:${labelAlternation(field)})${labelConnective()}${valueCapture}`, 'id');
}

// Value-BEFORE-label phrasing — imperative DOM-action style, e.g. "type
// Password123 into the password field", "enter tomsmith into the username
// box". Tried BEFORE the label-before-value unquotedValuePattern for this
// exact shape, since that pattern would otherwise grab whatever word
// follows the label ("field"/"box") as if it were the value — a real
// hallucination found in Phase C.1 (see GENERIC_CONTINUATION_STOPWORDS).
function valueBeforeLabelPattern(field) {
  return new RegExp(`(?:type|enter)\\s+(['"]?)([^\\s,'"]+)\\1\\s+(?:in|into)\\s+(?:the\\s+)?(?:${labelAlternation(field)})\\b`, 'id');
}

// The other common imperative shape: "fill (the) username field with
// tomsmith" — label appears before the value here too, but with "field/
// box" as noise BETWEEN the label and "with", which is exactly what made
// the generic unquotedValuePattern hallucinate on this phrasing (it would
// match "username" + whitespace + capture "field").
function fillFieldWithValuePattern(field) {
  return new RegExp(`fill\\s+(?:the\\s+|in\\s+the\\s+)?(?:${labelAlternation(field)})\\s*(?:field|box|input)?\\s+with\\s+(['"]?)([^\\s,'"]+)\\1`, 'id');
}

// "update my LABEL to VALUE" / "change my LABEL to VALUE" — the value
// comes after "to", not immediately after the label, so the generic
// label-before-value pattern would otherwise capture "to" itself (a real
// hallucination found running the stress test against this very fix).
function updateFieldToValuePattern(field) {
  const valueCapture = field === 'name' ? '([^\\s,\'"]+(?:\\s+[^\\s,\'"]+)?)' : '([^\\s,\'"]+)';
  return new RegExp(`(?:update|change)\\s+(?:my\\s+)?(?:${labelAlternation(field)})\\s+to\\s+(['"]?)${valueCapture}\\1`, 'id');
}

// (pattern-builder, capture-group-index-of-the-value) pairs, tried in
// priority order by extractAndTokenizeField() below.
function labeledFieldPatterns(field) {
  return [
    [quotedValuePattern(field), 1],
    [valueBeforeLabelPattern(field), 2],
    [fillFieldWithValuePattern(field), 2],
    [updateFieldToValuePattern(field), 2],
    [unquotedValuePattern(field), 1],
  ];
}

/**
 * Finds and tokenizes a single field's value in the instruction, trying
 * (in order): quoted label-then-value, unquoted value-before-label
 * (imperative "type X into the Y field" / "fill Y field with X" shapes),
 * then unquoted label-then-value. A match whose captured value is a
 * generic continuation word (GENERIC_CONTINUATION_STOPWORDS) is rejected
 * — the defensive backstop against the Phase C.1 hallucination bug — and
 * the next pattern in priority order is tried instead.
 * @returns {{ sanitizedInstruction: string, matched: boolean }}
 */
function extractAndTokenizeField(taskInstruction, field, vault, tokenType) {
  for (const [pattern, valueGroupIndex] of labeledFieldPatterns(field)) {
    const match = pattern.exec(taskInstruction);
    if (!match) continue;
    const value = match[valueGroupIndex];
    if (GENERIC_CONTINUATION_STOPWORDS.has(value.toLowerCase())) continue;

    const token = vault.getOrCreateToken(value, tokenType);
    // Splice only the value's own span (from the 'd' flag's match.indices),
    // not the whole match — preserves surrounding label words ("username
    // [NAME_1]", not just "[NAME_1]") exactly as the pre-Phase-C version
    // of this function did, so the LLM still sees which field each token
    // belongs to via its context, not just its type name. If the value was
    // quoted, expand the span by one character on each side to consume
    // the quote marks too (matches the pre-Phase-C behavior of
    // quotedValuePattern, which replaced them along with the value —
    // regression caught by the existing test-task-entity-extractor.js
    // suite, which asserts on `username [NAME_x]` with no stray quotes).
    let [start, end] = match.indices[valueGroupIndex];
    if (taskInstruction[start - 1] === "'" || taskInstruction[start - 1] === '"') start -= 1;
    if (taskInstruction[end] === "'" || taskInstruction[end] === '"') end += 1;
    const sanitizedInstruction = taskInstruction.slice(0, start) + token + taskInstruction.slice(end);
    return { sanitizedInstruction, matched: true };
  }
  return { sanitizedInstruction: taskInstruction, matched: false };
}

const FIELD_TOKEN_TYPES = {
  username: 'NAME',
  password: 'PASSWORD',
  email: 'EMAIL',
  phone: 'PHONE',
  name: 'NAME',
};

/**
 * Returns true if the instruction implies the user wants to authenticate,
 * regardless of whether concrete credential values are present.
 * @param {string} taskInstruction
 * @returns {boolean}
 */
export function impliesCredentialNeed(taskInstruction) {
  if (typeof taskInstruction !== 'string' || !taskInstruction) return false;
  return CREDENTIAL_INTENT_PATTERN.test(taskInstruction);
}

// Matches informal "account, X / Y" / "account: X and Y" / "creds X, Y" style
// phrasing, where X is treated as the username-like value and Y as the
// password-like value. Deliberately conservative: two short, unquoted,
// whitespace-free tokens separated by a slash/comma/"and", anchored to a
// nearby credential-referring word so we don't accidentally grab unrelated
// text out of an ordinary sentence.
// 'd' flag (match.indices) lets the caller splice out exactly the matched
// span by position rather than searching for the matched text again later —
// important because a naive second search for e.g. a single-character
// password like "x" could accidentally hit an unrelated "x" that happens to
// land inside a PREVIOUSLY-inserted token's own random suffix (tokens are
// CSPRNG-random lowercase alphanumeric per Phase 1.3, so this is a real,
// not theoretical, collision risk once more than one value is tokenized).
// Phase C.1 found the second capture group's exclusion of "!" truncates a
// real password ending in "!" (e.g. "Passw0rd!" -> captured as "Passw0rd",
// leaking the "!" character raw into the sanitized output right next to
// the token). "!" is now allowed inside the value; "." "," "?" stay
// excluded as likely sentence-ending punctuation.
const INFORMAL_DELIMITER_PATTERN =
  /\b(?:account|credentials|creds|login|log ?in)\b[,:]?\s+([^\s,/]+)\s*(?:\/|,|\band\b)\s*([^\s,/.?]+)/id;

// Trailing-anchor variant: the same conservative "X / Y" / "X and Y" pair
// shape, but for phrasing where the login-intent word comes AFTER the pair
// instead of before it, e.g. "use tomsmith / Password123 to log in". Tried
// only if the leading-anchor pattern above finds nothing.
const INFORMAL_DELIMITER_PATTERN_TRAILING_ANCHOR =
  /\b([^\s,/]+)\s*(?:\/|,|\band\b)\s*([^\s,/.?]+?)\s+(?:to\s+)?(?:log\s*in(?:to)?|log\s*me\s*in(?:to)?|sign\s*in(?:to)?)\b/id;

// "sign in using X and Y" / "log in using X and Y" — Phase C.1 found the
// leading-anchor pattern above requires the anchor word immediately before
// the pair, so "using" as the connective word (a common, natural phrasing)
// wasn't covered by either existing pattern. Narrow and explicit (requires
// "log in"/"sign in" + "using" together, not bare "using" alone) to avoid
// false-positiving on unrelated "using" phrases elsewhere in a sentence.
const INFORMAL_DELIMITER_PATTERN_USING =
  /\b(?:log\s*in(?:to)?|sign\s*in(?:to)?)\s+using\b[,:]?\s+([^\s,/]+)\s*(?:\/|,|\band\b)\s*([^\s,/.?]+)/id;

/**
 * Best-effort extraction of a (username, password)-shaped pair from
 * informally-phrased text, e.g. "log in with my usual account, tom / x".
 * @param {string} taskInstruction
 * @returns {{ username: string, password: string, usernameSpan: [number,number], passwordSpan: [number,number] } | null}
 */
export function extractInformalCredentials(taskInstruction) {
  if (typeof taskInstruction !== 'string' || !taskInstruction) return null;

  const match =
    INFORMAL_DELIMITER_PATTERN.exec(taskInstruction) ||
    INFORMAL_DELIMITER_PATTERN_USING.exec(taskInstruction) ||
    INFORMAL_DELIMITER_PATTERN_TRAILING_ANCHOR.exec(taskInstruction);
  if (!match) return null;

  const [, first, second] = match;
  if (!first || !second) return null;

  return {
    username: first,
    password: second,
    usernameSpan: match.indices[1],
    passwordSpan: match.indices[2],
  };
}

/**
 * Full credential-extraction pipeline: fast-path regex, then the informal
 * fallback, then fail-closed. Pulled out of orchestrator.js so it can be
 * unit-tested directly (orchestrator.js touches `chrome.*` at module load
 * time and can only run inside a browser/extension context).
 *
 * @param {string} taskInstruction
 * @param {{ getOrCreateToken: (raw: string, type: string) => string }} vault
 * @returns {string} the instruction with any credentials replaced by tokens
 * @throws {UnresolvedSensitiveReferenceError} if a login is implied but no
 *   credential value could be found anywhere in the instruction.
 */
export function resolveCredentialTokens(taskInstruction, vault) {
  let sanitizedInstruction = taskInstruction;
  let usernameMatched = false;
  let passwordMatched = false;

  ({ sanitizedInstruction, matched: usernameMatched } =
    extractAndTokenizeField(sanitizedInstruction, 'username', vault, FIELD_TOKEN_TYPES.username));
  ({ sanitizedInstruction, matched: passwordMatched } =
    extractAndTokenizeField(sanitizedInstruction, 'password', vault, FIELD_TOKEN_TYPES.password));

  // Phase C.2(b): email/phone/name are now extracted the same way as
  // username/password — Phase C.1 found this module previously had zero
  // extraction for these three fields at all (only documented as
  // synonyms). Independent of fastPathMatched below, since a multi-field
  // form ("name X, email Y, phone Z") is not a login and must never throw
  // UnresolvedSensitiveReferenceError just because these three are absent.
  ({ sanitizedInstruction } = extractAndTokenizeField(sanitizedInstruction, 'email', vault, FIELD_TOKEN_TYPES.email));
  ({ sanitizedInstruction } = extractAndTokenizeField(sanitizedInstruction, 'phone', vault, FIELD_TOKEN_TYPES.phone));
  ({ sanitizedInstruction } = extractAndTokenizeField(sanitizedInstruction, 'name', vault, FIELD_TOKEN_TYPES.name));

  const fastPathMatched = usernameMatched || passwordMatched;

  if (!fastPathMatched && impliesCredentialNeed(sanitizedInstruction)) {
    const informal = extractInformalCredentials(sanitizedInstruction);
    if (informal) {
      const usernameToken = vault.getOrCreateToken(informal.username, 'NAME');
      const passwordToken = vault.getOrCreateToken(informal.password, 'PASSWORD');

      // Splice by exact index, later span first, so replacing one span
      // never shifts the offsets of the other.
      const [uStart, uEnd] = informal.usernameSpan;
      const [pStart, pEnd] = informal.passwordSpan;
      const spans = [
        { start: uStart, end: uEnd, token: usernameToken },
        { start: pStart, end: pEnd, token: passwordToken },
      ].sort((a, b) => b.start - a.start);

      for (const { start, end, token } of spans) {
        sanitizedInstruction =
          sanitizedInstruction.slice(0, start) + token + sanitizedInstruction.slice(end);
      }
    } else {
      throw new UnresolvedSensitiveReferenceError(
        'Task implies a login is required, but no credential value could be found in the instruction. ' +
        "Please specify it explicitly, e.g. \"username 'yourname' and password 'yourpassword'\"."
      );
    }
  }

  return sanitizedInstruction;
}

/**
 * Returns true if the instruction contains no username/password-shaped
 * content anywhere — neither a labeled quoted/unquoted value nor an
 * informal "X / Y" / "X and Y" credential-shaped pair. Covers phrasing
 * like "log me in" or "check my most recent transaction" where no
 * concrete credential was given at all.
 *
 * This is a separate, weaker signal than impliesCredentialNeed(): it says
 * nothing about whether the task WANTS credentials, only whether any were
 * supplied. Callers combine it with page-level context (e.g. a sensitive
 * input actually present in the DOM) to decide whether to ask the user.
 * @param {string} taskInstruction
 * @returns {boolean}
 */
function fieldIsPresent(taskInstruction, field) {
  for (const [pattern, valueGroupIndex] of labeledFieldPatterns(field)) {
    const match = pattern.exec(taskInstruction);
    if (match && !GENERIC_CONTINUATION_STOPWORDS.has(match[valueGroupIndex].toLowerCase())) return true;
  }
  return false;
}

export function isCredentialFree(taskInstruction) {
  if (typeof taskInstruction !== 'string' || !taskInstruction) return true;

  const hasUsername = fieldIsPresent(taskInstruction, 'username');
  const hasPassword = fieldIsPresent(taskInstruction, 'password');
  const hasInformalPair = extractInformalCredentials(taskInstruction) !== null;

  return !(hasUsername || hasPassword || hasInformalPair);
}

// Common English function words excluded when guessing at "value-like"
// tokens for the server-mediated fallback (extractCandidateValueSlots).
// Deliberately small and conservative — this is a coarse heuristic, not a
// real POS tagger; it only needs to skip obviously-structural words so
// real candidate values (usernames, passwords, ordinary short strings)
// aren't accidentally excluded.
const SLOT_CANDIDATE_STOPWORDS = new Set([
  'my', 'is', 'and', 'using', 'use', 'to', 'log', 'in', 'into', 'sign',
  'with', 'the', 'a', 'an', 'please', 'can', 'you', 'for', 'me', 'account',
  'your', 'kindly', 'could', 'would', 'i', 'want', 'need', 'this', 'that',
  'of', 'on', 'as', 'or', 'it', 'be', 'do', 'does', 'am', 'are',
]);

const MAX_CANDIDATE_SLOTS = 2;

/**
 * Phase C.2(c) — identifies up to MAX_CANDIDATE_SLOTS "value-like" tokens
 * in the instruction (a coarse stopword-based heuristic) and replaces each
 * with an opaque, per-call placeholder (<<SLOT_1>>, <<SLOT_2>>, ...),
 * returning the slot-substituted instruction plus a LOCAL map of slot id
 * to the real raw value.
 *
 * This is the client-side half of the privacy boundary for the
 * server-mediated fallback: the raw values in slotValues are NEVER sent
 * anywhere by this function — only the caller decides what to do with
 * them, after the server has classified each slot's FIELD PURPOSE from
 * context alone (see server/app/llm_client.py's generate_field_mapping).
 * Only called when the normal fast path (extractAndTokenizeField,
 * extractInformalCredentials) already found nothing — see orchestrator.js.
 *
 * @param {string} taskInstruction
 * @returns {{ slotInstruction: string, slotValues: Record<string,string> } | null}
 *   null if fewer than 1 candidate token was found.
 */
export function extractCandidateValueSlots(taskInstruction) {
  if (typeof taskInstruction !== 'string' || !taskInstruction) return null;

  // Reuse the same conservative pairing shapes as extractInformalCredentials
  // first (X/Y, X and Y) since those are the highest-confidence "this is a
  // pair of values" signal — but WITHOUT requiring a recognized anchor word
  // immediately adjacent, since the whole point of this fallback is to
  // catch phrasing the anchor-based fast path couldn't.
  const pairMatch = /([^\s,/]+)\s*(?:\/|,|\band\b)\s*([^\s,/.?]+)/.exec(taskInstruction);

  let candidates;
  if (pairMatch) {
    candidates = [
      { value: pairMatch[1], start: pairMatch.index, end: pairMatch.index + pairMatch[1].length },
      {
        value: pairMatch[2],
        start: taskInstruction.indexOf(pairMatch[2], pairMatch.index + pairMatch[1].length),
      },
    ];
    candidates[1].end = candidates[1].start + pairMatch[2].length;
  } else {
    // Fall back to single stray tokens: any word not in the stopword list,
    // not pure punctuation, in order of appearance.
    candidates = [];
    const wordPattern = /[^\s,.!?;:]+/g;
    let m;
    while ((m = wordPattern.exec(taskInstruction)) && candidates.length < MAX_CANDIDATE_SLOTS) {
      const word = m[0];
      if (SLOT_CANDIDATE_STOPWORDS.has(word.toLowerCase())) continue;
      candidates.push({ value: word, start: m.index, end: m.index + word.length });
    }
  }

  candidates = candidates.slice(0, MAX_CANDIDATE_SLOTS).filter((c) => c.value);
  if (candidates.length === 0) return null;

  // Splice by position, later span first, so earlier replacements don't
  // shift the offsets of ones still pending.
  const sorted = [...candidates].sort((a, b) => b.start - a.start);
  let slotInstruction = taskInstruction;
  const slotValues = {};
  const slotIdByStart = new Map();
  candidates.forEach((c, i) => slotIdByStart.set(c.start, `SLOT_${i + 1}`));

  for (const c of sorted) {
    const slotId = slotIdByStart.get(c.start);
    slotValues[slotId] = c.value;
    slotInstruction = slotInstruction.slice(0, c.start) + `<<${slotId}>>` + slotInstruction.slice(c.end);
  }

  return { slotInstruction, slotValues };
}

/**
 * Thrown when the task instruction clearly implies a credential is needed
 * but no value can be extracted or matched to a known vault entry. Callers
 * must fail closed on this — never send the ambiguous/empty instruction to
 * the LLM — and instead surface it to the user for clarification.
 */
export class UnresolvedSensitiveReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnresolvedSensitiveReferenceError';
  }
}

// Phase F / Step 3: "the system pauses rather than guesses if an OTP is
// unexpectedly required." Distinct from the credential-parsing checks
// above (which run once, at task-instruction parse time, before any DOM
// exists) — an OTP field is a mid-flow surprise: it doesn't exist in the
// DOM until AFTER some earlier action (e.g. clicking "Update") triggers
// the site to reveal it. So this runs per-step, against that step's real
// DOM snapshot, called from orchestrator.js right after
// processPageForRedaction() produces dom_summary.elements — see
// orchestrator.js's buildSanitizedPayload().
import { detectPII } from './pii-patterns.js';

/**
 * @param {string} taskInstruction - the ORIGINAL task instruction (not
 *   sanitized/tokenized) — checked for a real OTP-shaped value the user
 *   already anticipated and supplied up front.
 * @param {Array<{is_sensitive?: boolean, sensitivity_type?: string}>} domSummaryElements
 * @throws {UnresolvedSensitiveReferenceError} if an OTP-typed sensitive
 *   field is present in this step's DOM snapshot and no OTP value exists
 *   anywhere in the original instruction — reuses the exact same
 *   fail-closed mechanism as the credential-parsing path above, rather
 *   than inventing a parallel error type for what is the same underlying
 *   policy: never guess or fabricate a sensitive value that isn't there.
 */
export function checkForUnanticipatedOtpField(taskInstruction, domSummaryElements) {
  const otpFieldPresent = Array.isArray(domSummaryElements) &&
    domSummaryElements.some((el) => el && el.is_sensitive && el.sensitivity_type === 'OTP');
  if (!otpFieldPresent) return;

  // Reuses pii-patterns.js's OTP detection (a 4-6 digit number near an
  // "otp"/"code"/"verification" context word) so "was an OTP value
  // anticipated" is judged by the exact same rule everywhere in the
  // codebase, rather than a second, potentially-drifting definition here.
  const otpValueAnticipated = detectPII(taskInstruction || '').some((m) => m.type === 'OTP');
  if (otpValueAnticipated) return;

  throw new UnresolvedSensitiveReferenceError(
    'An OTP/verification-code field just appeared that was not anticipated by the original task instruction, ' +
    'and no code value was provided. Pausing rather than guessing — please provide the code explicitly ' +
    '(e.g. "the code is 123456") and try again.'
  );
}
