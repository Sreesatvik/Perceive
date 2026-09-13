/**
 * Phase 3.2 — lightweight, per-origin sensitivity memory.
 *
 * Stores, per site origin, which field labels the user has previously
 * confirmed as sensitive (by approving a risky action against them via the
 * confirmation UI). This is explicitly NOT a policy agent: on a repeat
 * visit within the same browser session it is used ONLY as a confidence
 * boost on an already-independently-detected sensitive field — it never
 * creates sensitivity out of nothing, and detection (DOM heuristics +
 * vision channels) always runs in full regardless of what this module
 * remembers. See dev2/redaction-engine.js for where the boost is applied.
 *
 * Storage: chrome.storage.session ONLY (never .local), matching the
 * session-scoped lifecycle of the token vault itself — this memory must not
 * outlive the browser session. Falls back to an in-memory Map when
 * chrome.storage is unavailable (Node tests, the plain-webpage test
 * harness), so the same code path is exercised either way.
 */

const memoryFallback = new Map(); // origin -> Set<string>

function hasChromeSessionStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session;
}

function storageKey(origin) {
  return `perceive_origin_profile:${origin}`;
}

/**
 * Records that `label` was confirmed sensitive by the user for `origin`.
 * @param {string} origin
 * @param {string} label
 */
export async function recordConfirmedSensitiveLabel(origin, label) {
  if (!origin || !label) return;

  if (hasChromeSessionStorage()) {
    const key = storageKey(origin);
    const existing = await chrome.storage.session.get(key);
    const set = new Set(Array.isArray(existing[key]) ? existing[key] : []);
    set.add(label);
    await chrome.storage.session.set({ [key]: Array.from(set) });
    return;
  }

  if (!memoryFallback.has(origin)) memoryFallback.set(origin, new Set());
  memoryFallback.get(origin).add(label);
}

/**
 * Returns the list of field labels previously confirmed sensitive for this
 * origin. An empty array (including on any storage error) is always a safe
 * return value — callers must treat this purely as an optional confidence
 * boost, never as a substitute for real detection.
 * @param {string} origin
 * @returns {Promise<string[]>}
 */
export async function getConfirmedSensitiveLabels(origin) {
  if (!origin) return [];

  if (hasChromeSessionStorage()) {
    try {
      const key = storageKey(origin);
      const existing = await chrome.storage.session.get(key);
      return Array.isArray(existing[key]) ? existing[key] : [];
    } catch (_e) {
      return [];
    }
  }

  return Array.from(memoryFallback.get(origin) || []);
}

/**
 * Clears the remembered profile for one origin (or, with no argument, all
 * origins). Exposed for session teardown and for tests that need to
 * simulate a corrupted/cleared memory mid-session — redaction must remain
 * correct with or without this data (Phase 3.3).
 * @param {string} [origin]
 */
export async function clearOriginProfile(origin) {
  if (hasChromeSessionStorage()) {
    if (origin) {
      await chrome.storage.session.remove(storageKey(origin));
    } else {
      await chrome.storage.session.clear();
    }
    return;
  }

  if (origin) {
    memoryFallback.delete(origin);
  } else {
    memoryFallback.clear();
  }
}
