// Bug found live: a real multi-step task ("log in, THEN go to the profile
// page, THEN update the phone number") had the LLM call task_complete
// right after the login step succeeded — orchestrator.js's
// verifyTaskCompletion() only looks for DOM error signals (broken login,
// visible error text), so it has no way to know the instruction named
// further sub-goals that were never attempted. The real fix is the system
// prompt (server/app/llm_client.py's new MULTI-STEP INSTRUCTIONS block),
// but per this project's standing "never trust the LLM alone" philosophy,
// this is a client-side, defense-in-depth SIGNAL for the same failure
// mode. Kept in its own pure/DOM-free module (unlike verifyTaskCompletion
// itself, which touches document.body/document.querySelector) so it's
// directly unit-testable without importing orchestrator.js's much heavier
// dependency tree.

// Deliberately small and generic (not tuned to any specific site's
// vocabulary), since this check must work across arbitrary task
// instructions.
const INSTRUCTION_COVERAGE_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'and', 'then', 'with', 'for', 'my', 'on', 'in',
  'at', 'of', 'is', 'go', 'update', 'set', 'click', 'type', 'enter', 'use',
  'using', 'it', 'that', 'this', 'now', 'please', 'new',
]);

/**
 * Deliberately a WARNING signal, not a hard block: this is a coarse
 * heuristic (splits the instruction into rough sub-goal segments on
 * sequencing words/commas, then checks whether each later segment's
 * non-stopword content words appear anywhere in the current DOM
 * snapshot's url/label text) and is prone to false positives — a
 * legitimate single-page task phrased with a comma, or a sub-goal phrased
 * with synonyms the DOM doesn't literally echo, would both trigger it
 * without actually being a bug. Hard-blocking task_complete on a heuristic
 * this coarse would risk turning false positives into stuck/failed tasks,
 * which is worse than a logged warning an operator can review.
 * @param {string} taskInstruction
 * @param {{url?: string, elements?: Array<{label_text?: string|null}>}} domSummary
 * @returns {string|null} a warning message, or null if nothing looks uncovered
 */
export function checkInstructionCoverageAgainstDom(taskInstruction, domSummary) {
  const segments = (taskInstruction || '')
    .split(/\b(?:then|and then|after that)\b|,/i)
    .map((s) => s.trim())
    .filter(Boolean);

  // A single segment means this wasn't phrased as a multi-step instruction
  // in any way this heuristic can detect — nothing to check.
  if (segments.length < 2) return null;

  const domText = [
    domSummary?.url || '',
    ...((domSummary?.elements || []).map((el) => el.label_text || '')),
  ].join(' ').toLowerCase();

  // Skip the FIRST segment — it's the sub-goal presumably just being
  // worked on/completed, not a later one to check coverage for.
  const uncoveredSegments = segments.slice(1).filter((segment) => {
    const contentWords = (segment.toLowerCase().match(/[a-z0-9']+/g) || [])
      .filter((w) => w.length > 2 && !INSTRUCTION_COVERAGE_STOPWORDS.has(w));
    if (contentWords.length === 0) return false; // nothing meaningful to check in this segment
    return !contentWords.some((w) => domText.includes(w));
  });

  if (uncoveredSegments.length === 0) return null;
  return `Task instruction mentions further step(s) not reflected anywhere in the current page (url/labels): "${uncoveredSegments.join('", "')}" — task_complete may be premature.`;
}
