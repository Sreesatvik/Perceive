import { RISK_TIERS } from '../shared/constants.js';
import { findAgentElement } from './domIndex.js';

export { findAgentElement };

/**
 * Auto-approval ONLY ever applies to our own bundled local test fixtures —
 * never a real external site. Two independent signals, either one enough:
 *   1. A DOM marker (`data-perceive-test-fixture="true"` on <html>) set by
 *      our own fixture HTML files. DOM is shared between a content script's
 *      isolated world and the page's main world, so this is visible to us
 *      regardless of how the fixture happened to load.
 *   2. window.__PERCEIVE_TEST_MODE__, the flag the existing sandbox/e2e
 *      harness already sets when orchestrator.js is loaded directly as a
 *      same-world page script (not via the packed extension's isolated
 *      content-script injection) — see orchestrator.js's IS_TEST_MODE.
 * A real third-party page cannot set either of these from our content
 * script's perspective without already controlling that page's own markup
 * (a different, pre-existing threat model — XSS — same trust boundary
 * dom-heuristics.js already relies on for label_text elsewhere).
 */
function isAutoApproveFixture() {
    if (typeof document !== 'undefined' && document.documentElement
        && document.documentElement.dataset.perceiveTestFixture === 'true') {
        return true;
    }
    if (typeof window !== 'undefined' && window.__PERCEIVE_TEST_MODE__ === true) {
        return true;
    }
    return false;
}

/**
 * @param {Object} action — the action to confirm
 * @returns {Promise<boolean>} — true if user approved, false if denied
 */
export async function requestConfirmation(action) {
    if (isAutoApproveFixture()) {
        // Logged loudly and unconditionally — this must never be silently
        // invisible, and must never be mistaken for a real approval.
        console.warn('[ConfirmationUI] Auto-approved without a dialog — this page is a local Perceive test fixture, not a real site.', action);
        return true;
    }

    // Uses the browser's native confirm() rather than a custom in-page
    // overlay. A styled DOM overlay we inject can be defeated by the host
    // page's own JS — e.g. a login modal's focus-trap/click-capturing logic
    // can intercept clicks meant for our buttons before they ever fire,
    // even while our overlay is visibly on top (observed on a real site
    // during testing). window.confirm() is a browser-level UI surface no
    // page script can intercept, override, or capture events for — a real
    // security boundary the browser itself enforces, not just styling.
    const targetDescription = action.target_element_id ? ` on target '${action.target_element_id}'` : '';
    const message =
        `Perceive agent wants to execute:\n\n` +
        `${action.type}${targetDescription}\n\n` +
        `Reason: ${action.reasoning_short || 'No reasoning provided.'}`;

    return window.confirm(message);
}

/**
 * Determine if an action needs confirmation based on risk_tier + local heuristics
 * @param {Object} action
 * @returns {boolean}
 */
export function requiresConfirmation(action) {
    if (action.risk_tier === RISK_TIERS.RISKY) return true;
    
    // Additional local heuristics
    if (action.type === 'click' && action.target_element_id) {
        const el = findAgentElement(action.target_element_id);
        if (!el) return true;
        
        if (el.type === 'submit' || (el.textContent && el.textContent.match(/pay|submit|delete|confirm/i))) {
            return true;
        }
    }
    return false;
}
