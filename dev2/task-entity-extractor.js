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

const CREDENTIAL_INTENT_PATTERN = /\b(log\s*in|log\s*me\s*in|sign\s*in)\b/i;

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
const INFORMAL_DELIMITER_PATTERN =
  /\b(?:account|credentials|creds|login|log ?in)\b[,:]?\s+([^\s,/]+)\s*(?:\/|,|\band\b)\s*([^\s,/.!?]+)/id;

/**
 * Best-effort extraction of a (username, password)-shaped pair from
 * informally-phrased text, e.g. "log in with my usual account, tom / x".
 * @param {string} taskInstruction
 * @returns {{ username: string, password: string, usernameSpan: [number,number], passwordSpan: [number,number] } | null}
 */
export function extractInformalCredentials(taskInstruction) {
  if (typeof taskInstruction !== 'string' || !taskInstruction) return null;

  const match = INFORMAL_DELIMITER_PATTERN.exec(taskInstruction);
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
  let fastPathMatched = false;

  sanitizedInstruction = sanitizedInstruction.replace(
    /username\s+['"]([^'"]+)['"]/i,
    (match, value) => {
      fastPathMatched = true;
      const token = vault.getOrCreateToken(value, 'NAME');
      return `username ${token}`;
    }
  );

  sanitizedInstruction = sanitizedInstruction.replace(
    /password\s+['"]([^'"]+)['"]/i,
    (match, value) => {
      fastPathMatched = true;
      const token = vault.getOrCreateToken(value, 'PASSWORD');
      return `password ${token}`;
    }
  );

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
