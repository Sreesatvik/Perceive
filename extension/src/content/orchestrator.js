import { executeAction } from './actionExecutor.js';
import { requiresConfirmation, requestConfirmation } from './confirmationUI.js';
import { startMutationTracking, stopMutationTracking } from './domIndex.js';
import { checkInstructionCoverageAgainstDom } from './taskCompletionCoverage.js';
import { RETRY_CONFIG } from '../shared/constants.js';

import { getVaultForSession, endSession } from '../../dev2/session-vault-manager.js';
import { processPageForRedaction } from '../../dev2/redaction-engine.js';
import { canvasToBase64 } from '../../dev2/redaction-renderer.js';
import { detectPII } from '../../dev2/pii-patterns.js';
import { isRectInViewport } from '../../dev2/dom-heuristics.js';
import {
  resolveCredentialTokens,
  isCredentialFree,
  impliesCredentialNeed,
  extractCandidateValueSlots,
  checkForUnanticipatedOtpField,
  UnresolvedSensitiveReferenceError,
} from '../../dev2/task-entity-extractor.js';
import { detectFaces } from '../vision/visionPipeline.js';
import { runOcr } from '../vision/ocrPipeline.js';
import { getVisionResultCached, clearVisionCache } from '../vision/visionCache.js';
import {
  getConfirmedSensitiveLabels,
  recordConfirmedSensitiveLabel,
} from '../../dev2/origin-sensitivity-profile.js';
import { summarizeVisionStatus, countFindings, summarizeRawPiiStatus } from '../panel/dashboardUtils.js';

// Phase D.3: last-known vision engine status, carried forward across steps
// where getVisionResultCached() skips re-running detection (Phase 2.7 cache
// hit) — the dashboard should keep showing the last REAL observation, not
// silently reset to "unknown" just because this particular step reused a
// cached result. Never touches visionPipeline.js/ocrPipeline.js themselves
// (out of scope for D.3) — it only observes their known, distinctly-
// prefixed console.error() failure messages from the outside.
let lastVisionStatus = { faceDetectionFailed: false, ocrFailed: false };

const IS_TEST_MODE = typeof window !== 'undefined' && window.__PERCEIVE_TEST_MODE__ === true;

const USE_MOCK_CAPTURE = false; // set true only for local headless testing

// TEST-ONLY MOCK CAPTURE PATH. Kept for two narrow, legitimate cases: (a) the
// USE_MOCK_CAPTURE flag below, for local headless testing, and (b) the
// automatic fallback in captureOnce() when no chrome extension runtime
// exists at all (the plain-webpage/e2e test harness — see
// extension/tests/e2e/e2eRunner.js). It must never fire in a real demo or
// real Chrome session; the loud console.warn below (not just this comment)
// is what makes that operationally impossible to miss if it ever does.
const mockDev1 = {
    captureCurrentState: async () => {
        console.warn('[Orchestrator] TEST-MODE MOCK CAPTURE ACTIVE — this must never run in a real demo');
        return { dom: {}, screenshot: "mock_screenshot_data" };
    }
};

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load captured screenshot image'));
    img.src = dataUrl;
  });
}

const CAPTURE_DOM_SKEW_THRESHOLD_MS = 150;

/**
 * One capture attempt: sends CAPTURE_TAB_STATE, draws the screenshot onto a
 * canvas, then runs the existing DOM traversal — timestamped on both ends so
 * the caller can detect a stale pairing (screenshot and DOM snapshot taken
 * too far apart, e.g. because of a slow background worker or a re-rendering
 * SPA in between).
 *
 * sessionId/stepNumber are passed through to the background worker so it
 * can key an optional demo-mode screenshot save (see demoCapture.js) —
 * they have no effect on the capture itself.
 */
async function captureOnce(sessionId, stepNumber) {
  const captureStartTime = Date.now();
  const bgResponse = await sendMessageAsync({ type: 'CAPTURE_TAB_STATE', sessionId, stepNumber });

  if (bgResponse === null) {
    // Fallback: plain-webpage test harness — no background worker available
    return { snapshot: await mockDev1.captureCurrentState(), captureStartTime, domSnapshotTime: Date.now() };
  }

  if (!bgResponse.success) {
    return { snapshot: { success: false, error: bgResponse.error }, captureStartTime, domSnapshotTime: Date.now() };
  }

  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  try {
    const img = await loadImage(bgResponse.screenshotDataUrl);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  } catch (err) {
    return { snapshot: { success: false, error: err.message }, captureStartTime, domSnapshotTime: Date.now() };
  }

  // Existing DOM traversal. Phase E.2: filtered to elements whose bounding
  // box actually intersects the viewport — previously every matching
  // element in the whole document was included regardless of scroll
  // position, so an element far below the fold (never actually rendered in
  // the captured screenshot) was reported to the server as if it were
  // visible, with a bounding_box the screenshot canvas never drew anything
  // at. See dev2/dom-heuristics.js's isRectInViewport for the pure
  // predicate and extension/tests/test-dom-index.js for its test.
  const elements = Array.from(document.querySelectorAll('input, button, select, textarea'))
    .filter((el) => isRectInViewport(el.getBoundingClientRect(), window.innerWidth, window.innerHeight));
  const domSnapshotTime = Date.now();

  return { snapshot: { elements, canvas }, captureStartTime, domSnapshotTime };
}

/**
 * Real screen + DOM capture. Screenshotting must happen in the background
 * service worker (content scripts cannot call chrome.tabs.captureVisibleTab
 * directly), so this relays the request via CAPTURE_TAB_STATE and draws the
 * returned data URL onto a canvas, preserving the { elements, canvas } shape
 * buildSanitizedPayload() expects.
 */
async function captureRealTabState(sessionId, stepNumber) {
  let { snapshot, captureStartTime, domSnapshotTime } = await captureOnce(sessionId, stepNumber);

  const skewMs = domSnapshotTime - captureStartTime;
  if (Math.abs(skewMs) > CAPTURE_DOM_SKEW_THRESHOLD_MS) {
    console.warn('[Orchestrator] Screenshot/DOM timing skew:', skewMs, 'ms — recapturing');
    ({ snapshot, captureStartTime, domSnapshotTime } = await captureOnce(sessionId, stepNumber));
  }

  return snapshot;
}

/**
 * Finds credential-like values in the raw task instruction (e.g. username 'X',
 * password 'Y') and replaces them with vault-backed semantic tokens BEFORE the
 * instruction is ever sent to the backend/LLM. This ensures raw credentials
 * never leave the browser, while giving the LLM valid token names it can
 * reference in its "type" actions — which resolveToken() can then resolve
 * back to the real value at execution time.
 */
function tokenizeCredentialsInInstruction(taskInstruction, vault) {
  // Stage A/B/C (fast-path regex, informal-phrasing fallback, then
  // fail-closed) live in dev2/task-entity-extractor.js so they can be
  // unit-tested directly. May throw UnresolvedSensitiveReferenceError,
  // which callers must handle without retrying.
  let sanitizedInstruction = resolveCredentialTokens(taskInstruction, vault);

  const piiMatches = detectPII(sanitizedInstruction);
  const sortedMatches = [...piiMatches].sort((a, b) => b.startIndex - a.startIndex);
  for (const match of sortedMatches) {
    const token = vault.getOrCreateToken(match.match, match.type);
    sanitizedInstruction = sanitizedInstruction.substring(0, match.startIndex) + token + sanitizedInstruction.substring(match.endIndex);
  }

  const finalCheck = detectPII(sanitizedInstruction);
  if (finalCheck.length > 0) {
    const err = new Error('Unresolved sensitive pattern in task instruction');
    err.name = 'InstructionLeakageError';
    throw err;
  }

  return sanitizedInstruction;
}

function mark(name) {
  if (typeof performance !== 'undefined' && performance.mark) performance.mark(name);
}
function measure(name, start, end) {
  if (typeof performance !== 'undefined' && performance.measure) {
    try { performance.measure(name, start, end); } catch (_e) { /* noop */ }
  }
}

async function buildSanitizedPayload(snapshot, sessionId, taskInstruction, stepNumber, lastActionError = null) {
  // ASSUMPTION: snapshot has shape { elements: HTMLElement[], canvas: HTMLCanvasElement }
  // TODO: confirm this matches Dev 1's real capture module output once available
  const vault = getVaultForSession(sessionId);

  mark('perceive:step:total:start');

  // Tokenize any credentials embedded in the task instruction BEFORE sending
  // it anywhere, so raw values never reach the LLM. The LLM will see the
  // token names ([NAME_1], [PASSWORD_1], etc.) and must reference those
  // tokens in its "type" actions instead of raw values.
  const sanitizedInstruction = tokenizeCredentialsInInstruction(taskInstruction, vault);

  // Phase 2.3: one capture feeds both channels — face detection and OCR run
  // concurrently via Promise.all since they're independent of each other and
  // of the (synchronous, near-instant) DOM heuristics pass below. Phase 2.7:
  // skip re-running them if the captured frame is unchanged since last step.
  mark('perceive:step:vision-total:start');
  const { faces, ocrLines } = await getVisionResultCached(sessionId, snapshot.canvas, async () => {
    // Phase D.3: observe (without modifying) visionPipeline.js/ocrPipeline.js's
    // known failure logging to distinguish "engine ran and found nothing"
    // from "engine crashed and failed open to []" — both currently return
    // the same empty array, which the dashboard must not conflate. Scoped
    // strictly to this call and always restored in `finally`.
    const originalConsoleError = console.error;
    let faceDetectionFailed = false;
    let ocrFailed = false;
    console.error = (...args) => {
      const first = args[0];
      if (typeof first === 'string') {
        if (first.includes('Face detection failed')) faceDetectionFailed = true;
        if (first.includes('OCR failed')) ocrFailed = true;
      }
      originalConsoleError.apply(console, args);
    };
    try {
      const [faceResults, ocrResults] = await Promise.all([
        detectFaces(snapshot.canvas),
        runOcr(snapshot.canvas),
      ]);
      lastVisionStatus = { faceDetectionFailed, ocrFailed };
      return { faces: faceResults, ocrLines: ocrResults };
    } finally {
      console.error = originalConsoleError;
    }
  });
  mark('perceive:step:vision-total:end');
  measure('perceive:step:vision-total', 'perceive:step:vision-total:start', 'perceive:step:vision-total:end');

  // Phase 3.2: a confidence boost only, never a bypass — DOM+vision
  // detection above still runs in full regardless of what this returns.
  const currentOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const originConfirmedLabels = await getConfirmedSensitiveLabels(currentOrigin);

  mark('perceive:step:dom-and-redaction:start');
  const result = processPageForRedaction(snapshot.elements, snapshot.canvas, vault, { faces, ocrLines }, originConfirmedLabels);
  mark('perceive:step:dom-and-redaction:end');
  measure('perceive:step:dom-and-redaction', 'perceive:step:dom-and-redaction:start', 'perceive:step:dom-and-redaction:end');

  // Bug found live: give the LLM a real, DOM-grounded completion signal
  // (see extractPageStatusText() above) instead of leaving it to infer
  // page state purely from form-control labels + url.
  const pageStatusText = extractPageStatusText();
  if (pageStatusText) {
    result.dom_summary.page_status_text = pageStatusText;
  }

  // Phase F / Step 3: an OTP field appearing in THIS step's real DOM
  // snapshot that wasn't anticipated by the original task instruction
  // (e.g. clicking "Update" on a profile page reveals a verification-code
  // field mid-flow) must pause rather than let the LLM guess or fabricate
  // a code. Checked against the ORIGINAL taskInstruction (not
  // sanitizedInstruction) since tokenization only replaces credential-like
  // values already present, not the underlying question of "did the user
  // anticipate a code at all". Throws UnresolvedSensitiveReferenceError —
  // caught by the same catch handler as the existing credential-parsing
  // fail-closed path, in the caller below.
  checkForUnanticipatedOtpField(taskInstruction, result.dom_summary.elements);

  mark('perceive:step:total:end');
  measure('perceive:step:total', 'perceive:step:total:start', 'perceive:step:total:end');

  // originalImageBase64 is for the Phase 4 audit dashboard ONLY — it is the
  // pre-redaction screenshot and must NEVER be included in the payload sent
  // to the backend (that would defeat the entire on-device redaction
  // architecture). Kept as a separate return value specifically so it can
  // never accidentally get merged into the network payload object below.
  const originalImageBase64 = canvasToBase64(snapshot.canvas);

  return {
    visionStatus: summarizeVisionStatus(lastVisionStatus),
    payload: {
      session_id: sessionId,
      task_instruction: sanitizedInstruction,
      step_number: stepNumber,
      // Real bug found in live testing: the server's Session.add_step()
      // requires strict step_number == last_step + 1 sequencing. If a
      // step's /analyze call succeeds (server advances its history) but
      // the CLIENT's subsequent DOM execution then fails (e.g. a stale
      // element on a re-rendering SPA), the old retry loop resent the
      // SAME step_number — which the server correctly rejects with a
      // ValueError, surfacing as a generic 500 that has nothing to do
      // with the LLM's judgment. Fixed below by tracking a separate
      // server-facing counter (backendStepNumber) that only advances
      // after a successful /analyze call, independent of execution
      // outcome. last_action_error tells the LLM the previous attempt's
      // execution failed, so it doesn't blindly repeat it.
      last_action_error: lastActionError || undefined,
      ...result
    },
    originalImageBase64,
  };
}

/**
 * Phase 4.1/4.2 — best-effort broadcast of one step's full audit data (both
 * screenshots, every redacted region with its reason, the LLM's action and
 * server-assigned risk_tier, and this step's latency marks) to the audit
 * dashboard page, if one is open. Never throws — a missing listener (no
 * dashboard tab open) is the normal case, not an error.
 */
function broadcastAuditUpdate(sessionId, stepNumber, payload, originalImageBase64, action, visionStatus, firewallBlockedThisStep = false) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  const metrics = (typeof performance !== 'undefined' && performance.getEntriesByType)
    ? performance.getEntriesByType('measure')
        .filter(m => m.name.startsWith('perceive:step:'))
        .map(m => ({ name: m.name, durationMs: Math.round(m.duration * 100) / 100 }))
    : [];

  // Phase D.3: derived, at-a-glance metrics the dashboard renders directly
  // (see extension/src/panel/dashboardUtils.js for the pure logic, unit
  // tested in extension/tests/test-dashboard-utils.js).
  const { domFindings, visionFindings } = countFindings(payload.dom_summary, payload.detection_confidence_notes);
  const elementsRedacted = Array.isArray(payload.redacted_regions) ? payload.redacted_regions.length : 0;
  const rawPiiStatus = summarizeRawPiiStatus(firewallBlockedThisStep);

  try {
    chrome.runtime.sendMessage({
      type: 'AUDIT_STEP_UPDATE',
      data: {
        sessionId,
        stepNumber,
        originalImageBase64,
        redactedImageBase64: payload.redacted_image_base64,
        domSummary: payload.dom_summary,
        redactedRegions: payload.redacted_regions,
        confidenceNotes: payload.detection_confidence_notes,
        action,
        metrics,
        visionStatus,
        domFindings,
        visionFindings,
        elementsRedacted,
        rawPiiStatus,
        executed: null, // patched in place once execution actually completes — see AUDIT_STEP_EXECUTION_RESULT below
        timestamp: Date.now(),
      },
    }, () => { void chrome.runtime.lastError; });
  } catch (_e) {
    // No dashboard listener open — non-fatal, expected the common case.
  }

  // Clear this step's marks so a long-running task doesn't accumulate an
  // unbounded performance timeline.
  if (typeof performance !== 'undefined' && performance.clearMarks && performance.clearMeasures) {
    performance.clearMarks();
    performance.clearMeasures();
  }
}

/**
 * Phase D.3: fire-and-forget patch of an already-broadcast step card with
 * the real DOM-execution outcome. Sent as its own message (rather than
 * delaying broadcastAuditUpdate until after execution) because
 * broadcastAuditUpdate must still fire for task_complete/task_failed steps,
 * which never reach actionExecutor.js at all.
 */
function broadcastAuditExecutionResult(sessionId, stepNumber, executed) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
  try {
    chrome.runtime.sendMessage({
      type: 'AUDIT_STEP_EXECUTION_RESULT',
      data: { sessionId, stepNumber, executed },
    }, () => { void chrome.runtime.lastError; });
  } catch (_e) {
    // No dashboard listener open — non-fatal, expected the common case.
  }
}

// Fallback BACKEND_URL used only outside the extension runtime (plain-webpage test harness)
const BACKEND_URL = 'http://localhost:8000';

async function getBackendApiKey() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    return null; // test harness / non-extension context
  }
  const result = await chrome.storage.local.get('backendApiKey');
  return result.backendApiKey || null;
}

const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Wraps chrome.runtime.sendMessage in a Promise.
 * Falls back to null if chrome runtime is unavailable (test harness).
 *
 * Raced against RETRY_CONFIG.STEP_TIMEOUT_MS: chrome.runtime.sendMessage's
 * callback is never guaranteed to fire (e.g. the MV3 background service
 * worker terminates mid-flight), so without an explicit timeout an
 * unresolved call here hangs the caller — and everything upstream of it
 * (the step retry loop, the whole task) — forever. On timeout this rejects
 * with a normal Error, so it flows through the exact same catch/backoff
 * path (RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS, then a string `reason` on
 * exhaustion) as every other step failure — see the catch block in
 * runTaskLoop below.
 */
function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve(null); // Signal: no extension runtime available
      return;
    }

    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `No response to "${message.type}" after ${RETRY_CONFIG.STEP_TIMEOUT_MS}ms ` +
        `(background service worker may have terminated mid-flight)`
      ));
    }, RETRY_CONFIG.STEP_TIMEOUT_MS);

    chrome.runtime.sendMessage(message, (response) => {
      if (settled) return; // already timed out — ignore a late-arriving response
      settled = true;
      clearTimeout(timeoutId);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

const FIELD_MAPPING_CANDIDATE_PURPOSES = ['username', 'password', 'email', 'phone', 'name'];

/**
 * Phase C.2(c) — narrow, structural-only server-mediated fallback for task
 * text the client-side fast path (a+b) couldn't structurally resolve.
 *
 * Privacy guarantee: extractCandidateValueSlots() replaces every candidate
 * raw value with an opaque, per-call placeholder BEFORE this function ever
 * builds a network payload — the real values (slots.slotValues) are only
 * ever read back LOCALLY, after the server has returned its structural
 * mapping, never sent anywhere. Reuses the existing authenticated
 * SEND_PAYLOAD -> /analyze channel (same auth/rate-limit as every other
 * request) rather than opening a new, unaudited path — the request is
 * just a normal ClientPayload with field_mapping_request populated
 * instead of a real dom_summary/redaction payload.
 *
 * @returns {string|null} a patched task instruction with resolved fields
 *   rewritten as `<purpose> "<value>"` (so the fast path will tokenize
 *   them correctly on the caller's retry), or null if nothing was
 *   resolved and the caller should fall through to UNRESOLVED_SENSITIVE_REFERENCE.
 */
async function tryServerMediatedFieldMapping(taskInstruction, sessionId, stepNumber) {
  const slots = extractCandidateValueSlots(taskInstruction);
  if (!slots) return null;

  const slotIds = Object.keys(slots.slotValues);

  let response;
  try {
    response = await sendMessageAsync({
      type: 'SEND_PAYLOAD',
      payload: {
        session_id: sessionId,
        task_instruction: slots.slotInstruction,
        step_number: stepNumber,
        // No real DOM context is needed for a purely structural
        // slot->field-purpose classification — a minimal, valid
        // dom_summary satisfies the schema without redoing redaction.
        dom_summary: { url: (typeof window !== 'undefined' && window.location) ? window.location.href : '', elements: [] },
        field_mapping_request: {
          slot_ids: slotIds,
          candidate_field_purposes: FIELD_MAPPING_CANDIDATE_PURPOSES,
        },
      },
    });
  } catch (e) {
    console.warn('[Orchestrator] Field-mapping fallback request failed:', e.message);
    return null;
  }

  if (!response || !response.success) return null;
  const mapping = response.action && response.action.field_mapping;
  if (!mapping || typeof mapping !== 'object') return null;

  let patched = slots.slotInstruction;
  let anyResolved = false;
  for (const slotId of slotIds) {
    const purpose = mapping[slotId];
    if (!purpose || !FIELD_MAPPING_CANDIDATE_PURPOSES.includes(purpose)) continue;
    const rawValue = slots.slotValues[slotId];
    patched = patched.replace(`<<${slotId}>>`, `${purpose} "${rawValue}"`);
    anyResolved = true;
  }

  return anyResolved ? patched : null;
}

/**
 * Orchestrator-owned task cleanup. Called on EVERY exit path.
 * 
 * Three steps, in order:
 *   1. endSession(sessionId) — Dev 2's vault cleanup (session-scoped)
 *   2. POST /session/{id}/end — notify backend (fire-and-forget)
 *   3. Emit agent-session-end — for Dev 5's audit log
 */
async function finalizeTask(sessionId, reason) {
    console.log(`[Orchestrator] Finalizing task ${sessionId}. Reason: ${reason}`);
    
    // Step 1: Clear Dev 2's vault
    endSession(sessionId);
    clearVisionCache(sessionId);
    stopMutationTracking();

    // Step 2: Notify backend via background worker (avoids CORS in content script context)
    try {
        const response = await sendMessageAsync({ type: 'END_SESSION', sessionId, reason });
        if (response === null) {
            // Fallback: plain-webpage test harness — direct fetch is acceptable
          const apiKey = await getBackendApiKey();
          if (!apiKey) {
            console.error('[Transport] No backend API key configured \u2014 set one via the extension options page');
          } else {
            fetch(`${BACKEND_URL}/session/${sessionId}/end`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
              body: JSON.stringify({ reason }),
            }).catch(() => {}); // Fire and forget
          }
        }
    } catch (e) {
        // non-fatal, swallow silently
    }

    // Step 3: Emit event
    window.dispatchEvent(new CustomEvent('agent-session-end', {
        detail: { sessionId, reason }
    }));
}

function verifyTaskCompletion(taskInstruction, domSummary) {
  // Heuristic postcondition check — looks for common failure signals
  // still visible in the DOM. This is a best-effort check, not a
  // site-specific guarantee.
  const bodyText = (document.body?.innerText || '').toLowerCase();
  const failureSignals = [
    'invalid username', 'invalid password', 'login failed',
    'incorrect password', 'error', 'try again', 'access denied'
  ];
  const hasVisibleError = failureSignals.some(signal => bodyText.includes(signal));

  const hasErrorRoleElement = !!document.querySelector(
    '[role="alert"], .error, .alert-danger, [aria-invalid="true"]'
  );

  // Real bug found live: this was previously a non-blocking WARNING only
  // ("logged but never enforced"), which meant a multi-step instruction
  // ("log in, THEN go to the profile page, THEN update the phone number")
  // could still have task_complete accepted right after the FIRST sub-goal
  // succeeded — the LLM's own system-prompt guidance (server/app/
  // llm_client.py's MULTI-STEP INSTRUCTIONS block) is advisory, not
  // enforced, and in live testing the LLM did not reliably follow it,
  // forcing the user to manually re-type a fresh instruction for every
  // remaining page instead of one instruction running end-to-end. Promoted
  // to a hard, fail-closed block — reusing the exact same bounded
  // retry/backoff path already used for the visible-error check above, so
  // a false positive from this coarse heuristic (documented risk in
  // checkInstructionCoverageAgainstDom's own comment) costs at most
  // RETRY_CONFIG.MAX_RETRIES_PER_STEP retries before failing closed with a
  // readable reason, never an infinite loop and never a silent early stop.
  const coverageWarning = checkInstructionCoverageAgainstDom(taskInstruction, domSummary);
  if (coverageWarning) {
    console.warn('[Orchestrator] task_complete rejected — instruction coverage check failed:', coverageWarning);
  }

  return {
    verified: !hasVisibleError && !hasErrorRoleElement && !coverageWarning,
    reason: hasVisibleError
      ? 'Visible error text detected on page'
      : hasErrorRoleElement
        ? 'Element with error role/class detected'
        : coverageWarning
          ? coverageWarning
          : null,
    coverageWarning,
  };
}

// Bug found live: buildSanitizedPayload()'s dom_summary only ever contains
// form-control elements (input/button/select/textarea — see captureOnce
// above), so the LLM has literally no way to see plain confirmation/status
// text like "Phone number updated." or a page heading like "Account
// Dashboard" — both are ordinary text nodes, not form controls. This is
// the real root cause of two live symptoms: (1) the LLM not recognizing a
// just-completed sub-goal and redundantly re-clicking/re-scrolling instead
// of calling task_complete, and (2) the coverage check above having weaker
// signal than it could, since domText for the coverage heuristic was built
// only from url + element label_text. Deliberately narrow and generic (no
// site-specific selectors beyond common ARIA/status conventions), capped
// short, and re-run through detectPII() defensively — a heading/status
// banner should never legitimately contain PII, but if this ever matched
// something that does, it is dropped entirely rather than sent, per this
// project's fail-closed principle.
function isElementVisible(el) {
  if (!el) return false;
  // Deliberately style-only (no getBoundingClientRect check): jsdom
  // (used by this project's own unit tests) never computes real layout,
  // so rect width/height is always 0 there regardless of actual CSS,
  // which would make this always report "not visible" under test even
  // though the exact same markup renders fine in real Chrome. Computed
  // display/visibility is sufficient for this function's actual job
  // (was a toggled status banner shown or not?) and works identically in
  // both environments.
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function extractPageStatusText() {
  if (typeof document === 'undefined') return null;

  const parts = [];
  if (document.title) parts.push(document.title.trim());

  const heading = document.querySelector('h1, h2');
  if (heading && isElementVisible(heading) && heading.textContent) parts.push(heading.textContent.trim());

  // Real bug found live (2nd pass): the first version of this selector
  // only matched ARIA roles / a fixed class list (.success/.confirmation/
  // etc). The actual test fixture's confirmation banner is
  // `<div id="status" style="display:none">Phone number updated.</div>`,
  // toggled to display:block on click — matching NEITHER role NOR class,
  // so page_status_text was silently always empty and this whole fix did
  // nothing. Broadened to also match common id/class SUBSTRING
  // conventions (status/message/confirm/success/error/alert/notice), and
  // — critically — now requires the element to actually be VISIBLE
  // (display != none, visibility != hidden, non-zero box) before its text
  // counts, since querySelector finds a hidden element just fine and this
  // must never report "updated" before the update actually happened.
  const STATUS_SELECTOR =
    '[role="status"], [role="alert"], [aria-live], ' +
    '[id*="status" i], [id*="message" i], [id*="confirm" i], [id*="success" i], [id*="error" i], [id*="alert" i], [id*="notice" i], ' +
    '[class*="status"], [class*="message"], [class*="confirm"], [class*="success"], [class*="error"], [class*="alert"], [class*="notice"]';
  const statusEl = Array.from(document.querySelectorAll(STATUS_SELECTOR))
    .find((el) => isElementVisible(el) && el.textContent && el.textContent.trim());
  if (statusEl) parts.push(statusEl.textContent.trim());

  const combined = parts.filter(Boolean).join(' | ').slice(0, 300);
  if (!combined) return null;

  // Defense in depth: never forward this if it happens to contain
  // anything PII-shaped (e.g. a raw credential leaking into a heading on
  // some unexpected page) — drop the whole field rather than partially
  // redact free text we don't control the shape of.
  if (detectPII(combined).length > 0) return null;

  return combined;
}

export async function runTaskLoop(taskInstruction, captureOverride = null) {
    const sessionId = crypto.randomUUID();
    let stepNumber = 0;
    // Tracks what the SERVER's session history actually expects next
    // (Session.add_step() requires strict last_step+1 sequencing). This is
    // deliberately separate from `stepNumber` (which bounds MAX_STEPS and
    // drives logging/UI): stepNumber counts logical steps including
    // execution-retry attempts, but a retry after a successful /analyze
    // call whose EXECUTION then failed must NOT resend the same
    // step_number — the server already advanced past it. Only advanced
    // once, right after a successful /analyze call, regardless of whether
    // the action's execution afterward succeeds or fails.
    let backendStepNumber = 0;
    // Set whenever a step's execution fails (or an exception occurs, or a
    // task_complete's postcondition check fails) so the NEXT /analyze call
    // can tell the LLM its previous action didn't work, instead of it
    // seeing an unchanged DOM with no explanation. Cleared on success.
    let lastActionError = null;

    // Track active vaults for E2E testing
    if (IS_TEST_MODE) {
        if (window.__activeVaults === undefined) window.__activeVaults = 0;
        window.__activeVaults++;
    }

    // Obtain vault ONCE at task start
    const vault = getVaultForSession(sessionId);
    const resolveToken = vault.resolveToken.bind(vault);

    // Phase 5.1: start observing DOM mutations for this task, so a stale
    // element lookup during action execution has a real re-indexing path
    // instead of failing outright on the first SPA re-render.
    startMutationTracking();

    try {
        while (stepNumber < RETRY_CONFIG.MAX_STEPS) {
            stepNumber++;
            let retriesLeft = RETRY_CONFIG.MAX_RETRIES_PER_STEP;
            let stepSuccess = false;

            while (retriesLeft > 0 && !stepSuccess) {
                try {
                    // Computed here (moved ahead of capture) so it can be
                    // passed through to CAPTURE_TAB_STATE for demo-mode
                    // artifact naming — same value used for the backend
                    // request in step 2 below.
                    const requestStepNumber = backendStepNumber + 1;

                    // 1. Capture
                    const snapshot = captureOverride
                        ? await captureOverride(sessionId, requestStepNumber)
                        : (USE_MOCK_CAPTURE ? await mockDev1.captureCurrentState() : await captureRealTabState(sessionId, requestStepNumber));

                    if (snapshot && snapshot.success === false) {
                        console.error(`[Orchestrator] Screenshot capture failed: ${snapshot.error}`);
                        await finalizeTask(sessionId, 'capture_failed');
                        return { success: false, reason: 'capture_failed', message: snapshot.error };
                    }

                    // 2. Redact + build payload. Requests the NEXT server-side
                    // step number (not the logical/retry-attempt stepNumber)
                    // and includes feedback about the previous attempt's
                    // execution failure, if any.
                    const { payload, originalImageBase64, visionStatus } = await buildSanitizedPayload(snapshot, sessionId, taskInstruction, requestStepNumber, lastActionError);

                    // 2.5. Client-side missing-credential check, using the raw
                    // taskInstruction (not the sanitized/tokenized one) so a
                    // credential that was already tokenized above doesn't
                    // look "missing" here.
                    const credentialsMissing = isCredentialFree(taskInstruction);
                    const domHasSensitiveField = payload.dom_summary?.elements?.some(el => el.is_sensitive) ?? false;

                    // The extra !impliesCredentialNeed(taskInstruction) guard
                    // is deliberate, not from the original spec: when a login
                    // IS implied by the wording but no value was found,
                    // buildSanitizedPayload's tokenizeCredentialsInInstruction
                    // call above already threw UnresolvedSensitiveReferenceError
                    // (caught below, fail-closed) before we ever reach this
                    // line. Without this guard, an instruction like "Log in
                    // and complete checkout" that supplies credentials via a
                    // pre-seeded vault instead of instruction text would be
                    // wrongly treated as missing credentials here. This check
                    // is for the complementary case: no login wording at all,
                    // yet the page still shows a sensitive field (e.g. "check
                    // my most recent transaction" after a session timeout
                    // re-shows a login form).
                    if (credentialsMissing && domHasSensitiveField && !impliesCredentialNeed(taskInstruction)) {
                        // Reuses requestConfirmation() from confirmationUI.js —
                        // the same native window.confirm()-based prompt already
                        // used below for risky-action confirmation — passing it
                        // an action-shaped object of type 'ask_user_confirmation'
                        // (extension/src/shared/constants.js:
                        // ACTION_TYPES.ASK_USER_CONFIRMATION) so its message
                        // formatting logic works unchanged.
                        const proceedAnyway = await requestConfirmation({
                            type: 'ask_user_confirmation',
                            reasoning_short: 'This task needs a username/password but none was found in your instruction — please provide it and try again.',
                        });
                        if (!proceedAnyway) {
                            // Matches the existing early-exit pattern used
                            // elsewhere in this loop (e.g. 'denied_by_user'):
                            // finalizeTask() then return without ever calling
                            // sendMessageAsync({ type: 'SEND_PAYLOAD', ... }).
                            await finalizeTask(sessionId, 'missing_credentials');
                            return {
                                success: false,
                                reason: 'MISSING_CREDENTIALS',
                                message: 'This task needs a username/password but none was found in your instruction — please provide it and try again.',
                            };
                        }
                    }

                    // 3. Send to backend via background worker to avoid CORS issues in content script context
                    let actionResponse = null;

                    // --- MOCK BACKEND RESPONSES FOR E2E ---
                    if (window.__mockBackendResponse) {
                        actionResponse = window.__mockBackendResponse(requestStepNumber, payload);
                    } else {
                        const bgResponse = await sendMessageAsync({ type: 'SEND_PAYLOAD', payload });
                        if (bgResponse === null) {
                            // Fallback: plain-webpage test harness — import sendToBackend dynamically
                            const { sendToBackend } = await import('../background/transport.js');
                            actionResponse = await sendToBackend(payload);
                        } else if (!bgResponse.success) {
                            throw new Error(bgResponse.error || 'Background transport failed');
                        } else {
                            actionResponse = bgResponse.action;
                        }
                    }
                    // --------------------------------------

                    // The /analyze call itself succeeded — the server's
                    // session history has now advanced to requestStepNumber
                    // regardless of what happens with execution below, so
                    // commit it here, not after execution.
                    backendStepNumber = requestStepNumber;

                    // Phase 4.1/4.2: broadcast this step's full audit data to
                    // the dashboard (if open) BEFORE the terminal/confirmation
                    // branches below, so task_complete/task_failed steps are
                    // logged too, not just successful intermediate ones.
                    broadcastAuditUpdate(sessionId, stepNumber, payload, originalImageBase64, actionResponse.action, visionStatus);

                    // 4. Check for terminal actions
                    if (actionResponse.action.type === 'task_complete') {
                        const verification = verifyTaskCompletion(taskInstruction, payload.dom_summary);
                        if (!verification.verified) {
                            console.warn('[Orchestrator] task_complete rejected — postcondition check failed:', verification.reason);
                            lastActionError = `Previous task_complete was rejected: ${verification.reason}`;
                            retriesLeft--;
                            if (retriesLeft === 0) {
                                await finalizeTask(sessionId, 'max_retries_exceeded');
                                return { success: false, reason: `Step ${stepNumber} failed after max retries: ${verification.reason}` };
                            }
                            // Bug found live: retry-after-failure paths had no
                            // delay before re-capturing, unlike the success
                            // path — see RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS.
                            await delay(RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS);
                            continue;
                        }
                        await finalizeTask(sessionId, 'completed');
                        return { success: true, steps: stepNumber };
                    }
                    if (actionResponse.action.type === 'task_failed') {
                        // Bug found live: this previously logged the raw
                        // `actionResponse.action` object as a separate
                        // console.error argument only — readable in a real
                        // DevTools console, but if this line's output is ever
                        // captured/relayed as flat text (log aggregation,
                        // copy-paste, a non-DevTools viewer), an object
                        // argument silently collapses to the literal string
                        // "[object Object]", losing the actual reason
                        // entirely. Now the reasoning_short STRING is always
                        // interpolated directly into the log message itself
                        // — the full object is still passed as a trailing
                        // arg too, for DevTools' expandable-object view when
                        // that IS available.
                        const reasoningText = (actionResponse.action && typeof actionResponse.action.reasoning_short === 'string')
                            ? actionResponse.action.reasoning_short
                            : '(no reasoning_short provided)';
                        console.error(`[Orchestrator] task_failed at step ${stepNumber} (session ${sessionId}): ${reasoningText}`, actionResponse.action);
                        await finalizeTask(sessionId, 'failed_by_server');
                        return { success: false, reason: reasoningText, steps: stepNumber };
                    }

                    // 5. Risk-tier confirmation
                    if (requiresConfirmation(actionResponse.action)) {
                        const approved = await requestConfirmation(actionResponse.action);
                        if (!approved) {
                            await finalizeTask(sessionId, 'denied_by_user');
                            return { success: false, reason: 'User denied risky action', steps: stepNumber };
                        }

                        // Phase 3.2: the user just explicitly approved a risky
                        // action against this field — remember its label for
                        // this origin as a future confidence boost. Never a
                        // bypass: detection still runs in full on every visit.
                        const confirmedEl = payload.dom_summary?.elements?.find(
                            el => el.element_id === actionResponse.action.target_element_id
                        );
                        if (confirmedEl && confirmedEl.is_sensitive && confirmedEl.label_text) {
                            try {
                                await recordConfirmedSensitiveLabel(window.location.origin, confirmedEl.label_text);
                            } catch (_e) {
                                // non-fatal: memory is an optimization, not a requirement
                            }
                        }
                    }

                    // 6. Execute
                    let result;
                    if (window.__forceExecuteFailure) {
                        result = { success: false, error: 'forced_failure' };
                    } else {
                        const perceivedElement = payload.dom_summary?.elements?.find(el => el.element_id === actionResponse.action.target_element_id) || null;
                        result = await executeAction(actionResponse.action, resolveToken, perceivedElement);
                    }

                    // Phase D.3: patch the dashboard card already broadcast above
                    // with the real execution outcome — this is the only point
                    // in the pipeline where "executed: yes/no" is actually known.
                    broadcastAuditExecutionResult(sessionId, stepNumber, result.success);

                    if (result.success) {
                        stepSuccess = true;
                        lastActionError = null;
                        // Phase D.2: the only point in the whole pipeline where
                        // the action has genuinely been executed against the
                        // real DOM (actionExecutor.js just returned success) —
                        // report it so the server's audit chain has a record
                        // of it (see transport.js's REPORT_PIPELINE_EVENT
                        // relay). Fire-and-forget: never awaited, never
                        // allowed to affect step timing or control flow.
                        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                            chrome.runtime.sendMessage({
                                type: 'REPORT_PIPELINE_EVENT',
                                sessionId,
                                stepNumber,
                                eventType: 'ACTION_EXECUTED',
                                details: { action_type: actionResponse.action.type },
                            }, () => { void chrome.runtime.lastError; });
                        }
                        await delay(RETRY_CONFIG.POST_ACTION_DELAY_MS);
                    } else {
                        console.warn(`[Orchestrator] Step ${stepNumber} execution failed:`, result.error);
                        lastActionError = `Previous action (${actionResponse.action.type}${actionResponse.action.target_element_id ? ` on ${actionResponse.action.target_element_id}` : ''}) failed to execute: ${result.error}`;
                        retriesLeft--;
                        // Bug found live: see RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS
                        // — only worth waiting if this loop will actually retry.
                        if (retriesLeft > 0) {
                            await delay(RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS);
                        }
                    }
                } catch (err) {
                    if (err instanceof UnresolvedSensitiveReferenceError) {
                        // Phase C.2(c): before giving up and prompting the
                        // user (d), try the narrow server-mediated fallback —
                        // the fast path (a+b) may have correctly sensed a
                        // login is needed but couldn't structurally identify
                        // which part of the instruction is which field (e.g.
                        // typo'd labels). Every candidate raw value is
                        // replaced with an opaque, per-request placeholder
                        // BEFORE this ever reaches the network — see
                        // extractCandidateValueSlots — so the server only
                        // ever sees placeholders + surrounding words, never
                        // real values, regardless of what it resolves.
                        const resolvedViaFallback = await tryServerMediatedFieldMapping(taskInstruction, sessionId, stepNumber);
                        if (resolvedViaFallback) {
                            console.log('[Orchestrator] Resolved via server-mediated field mapping, retrying step');
                            taskInstruction = resolvedViaFallback;
                            lastActionError = null;
                            retriesLeft--;
                            // Bug found live: see RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS.
                            await delay(RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS);
                            continue;
                        }

                        // Fail-closed, no retries: an ambiguous credential
                        // reference must never be sent to the LLM. Surface a
                        // distinct reason so the popup can prompt the user
                        // for an explicit value instead of retrying blindly.
                        console.warn(`[Orchestrator] Unresolved sensitive reference:`, err.message);
                        await finalizeTask(sessionId, 'unresolved_sensitive_reference');
                        return {
                            success: false,
                            reason: 'UNRESOLVED_SENSITIVE_REFERENCE',
                            message: err.message,
                        };
                    }
                    console.error(`[Orchestrator] Error during step ${stepNumber}:`, err);
                    lastActionError = `Previous attempt raised an error before completing: ${err.message}`;
                    retriesLeft--;
                    if (retriesLeft === 0) {
                        await finalizeTask(sessionId, 'max_retries_exceeded');
                        return { success: false, reason: `Step ${stepNumber} failed after max retries: ${err.message}` };
                    }
                    // Bug found live: this is the exact cascade path — a
                    // channel-consistency mismatch (dev2/channel-consistency-
                    // check.js) throws here, and without this delay the loop
                    // re-captured instantly, blowing through Chrome's capture
                    // quota and masking the real error behind a generic
                    // capture_failed. See RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS.
                    await delay(RETRY_CONFIG.POST_FAILURE_RETRY_DELAY_MS);
                }
            }
            
            if (!stepSuccess) {
                // Should be unreachable due to exception throwing inside loop but kept for safety
                await finalizeTask(sessionId, 'max_retries_exceeded');
                return { success: false, reason: 'Max retries exceeded' };
            }
        }

        // Max steps reached
        await finalizeTask(sessionId, 'max_steps_exceeded');
        return { success: false, reason: 'Max steps exceeded' };

    } catch (fatalError) {
        console.error("[Orchestrator] Fatal error:", fatalError);
        await finalizeTask(sessionId, 'fatal_error');
        throw fatalError;
    }
}

// Expose for testing
if (IS_TEST_MODE) {
    window.__runTaskLoop = runTaskLoop;
}

console.log(`[Orchestrator] Capture mode: ${USE_MOCK_CAPTURE ? 'MOCK' : 'REAL'}`);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_TASK') {
    const capture = USE_MOCK_CAPTURE ? () => mockDev1.captureCurrentState() : captureRealTabState;
    runTaskLoop(message.taskInstruction, capture).then((result) => {
      // Best-effort notification to the popup (if still open) so the user
      // learns why a task stopped rather than being left guessing —
      // particularly for UNRESOLVED_SENSITIVE_REFERENCE, which requires
      // them to retype the task with an explicit credential.
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ type: 'TASK_RESULT', result }, () => {
            // Swallow "Receiving end does not exist" when the popup is closed.
            void chrome.runtime.lastError;
          });
        } catch (_e) {
          // Non-fatal: no listener currently attached.
        }
      }
    }).catch((err) => {
      console.error('[Orchestrator] runTaskLoop rejected:', err);
    });
    sendResponse({ started: true });
    return true;
  }
});