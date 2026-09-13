/**
 * Phase 5.1 — SPA/DOM mutation resilience.
 *
 * The audit's recommendation was to re-index a stale element lookup,
 * triggered by "the existing MutationObserver" — but no MutationObserver
 * existed anywhere in the codebase before this (screen capture is still
 * Dev 1's `mockDev1` placeholder). This module supplies the real thing:
 * it tracks DOM mutations so callers/tests can see whether the page has
 * changed since an element was last indexed, AND provides the actual
 * re-indexing fallback that runs when a direct data-ext-id/id lookup goes
 * stale (a common SPA behavior — React/Vue/etc. re-render and regenerate
 * DOM nodes, silently dropping any attribute — like our data-ext-id tag —
 * that isn't part of their own virtual-DOM state).
 */

let observer = null;
let mutationCount = 0;

/**
 * Starts observing document.body for mutations. Idempotent — calling it
 * more than once (e.g. once per task) is safe and a no-op after the first.
 */
export function startMutationTracking() {
  if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;

  observer = new MutationObserver(() => {
    mutationCount++;
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}

export function stopMutationTracking() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

/** @returns {number} total mutations observed since tracking started (or last reset) */
export function getMutationCount() {
  return mutationCount;
}

/** Test-only helper: resets the counter without touching the observer itself. */
export function resetMutationCount() {
  mutationCount = 0;
}

const INTERACTIVE_SELECTOR = 'input, button, select, textarea, [role="button"]';

function normalizeLabel(el) {
  const raw = el.getAttribute('aria-label')
    || (el.labels && el.labels[0] && el.labels[0].textContent)
    || el.innerText
    || el.textContent
    || el.placeholder
    || '';
  return raw.trim().toLowerCase();
}

/**
 * Direct fast-path lookup only — no re-indexing. Kept separate from
 * findAgentElementResilient() so confirmationUI.js's existing callers
 * (hover/display positioning, not action execution) keep their original,
 * cheap behavior.
 * @param {string} elementId
 * @returns {Element|null}
 */
export function findAgentElement(elementId) {
  if (!elementId || typeof document === 'undefined') return null;
  const escaped = CSS.escape(elementId);
  return (
    document.querySelector(`[data-ext-id="${escaped}"]`) ||
    document.getElementById(elementId)
  );
}

/**
 * Resilient lookup for action execution: tries the fast path first: if
 * that element is missing OR no longer matches what was perceived (tag +
 * label mismatch — the classic sign a re-render replaced it with something
 * else entirely), falls back to re-indexing — scanning interactive
 * elements for one whose real current tag+label matches what was
 * perceived, and re-tagging it with the same data-ext-id so future lookups
 * in this step (and subsequent steps) hit the fast path again.
 *
 * Returns null (never throws) when nothing can be resolved — callers
 * already handle a null target as 'target_element_not_found'.
 *
 * @param {string} elementId
 * @param {{ tag?: string, label_text?: string|null } | null} perceivedElement
 * @returns {{ element: Element|null, reindexed: boolean }}
 */
export function findAgentElementResilient(elementId, perceivedElement) {
  const direct = findAgentElement(elementId);

  if (direct && perceivedElement) {
    const tagMismatch = direct.tagName.toLowerCase() !== (perceivedElement.tag || '').toLowerCase();
    const labelMismatch = normalizeLabel(direct) !== (perceivedElement.label_text || '').trim().toLowerCase();
    if (!(tagMismatch && labelMismatch)) {
      // Either it matches, or only one signal differs (ambiguous enough
      // to trust the direct hit rather than risk a wrong re-index) —
      // same conservative rule actionExecutor.js already used.
      return { element: direct, reindexed: false };
    }
  } else if (direct) {
    return { element: direct, reindexed: false };
  }

  // Stale lookup: direct hit missing entirely, or looked-up element no
  // longer resembles what was perceived. Try to re-index by scanning for
  // a real match on tag + label among current interactive elements.
  if (!perceivedElement || typeof document === 'undefined') {
    return { element: null, reindexed: false };
  }

  const wantedTag = (perceivedElement.tag || '').toLowerCase();
  const wantedLabel = (perceivedElement.label_text || '').trim().toLowerCase();
  if (!wantedLabel) {
    return { element: null, reindexed: false };
  }

  const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
    (el) => el.tagName.toLowerCase() === wantedTag && normalizeLabel(el) === wantedLabel
  );

  if (candidates.length !== 1) {
    // Zero matches: genuinely gone. More than one: ambiguous — re-tagging
    // the wrong one would be worse than failing closed with
    // target_element_not_found.
    return { element: null, reindexed: false };
  }

  const reindexedElement = candidates[0];
  reindexedElement.setAttribute('data-ext-id', elementId);
  return { element: reindexedElement, reindexed: true };
}
