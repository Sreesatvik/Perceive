import { executeAction } from './actionExecutor.js';
import { requiresConfirmation, requestConfirmation } from './confirmationUI.js';
import { startMutationTracking, stopMutationTracking } from './domIndex.js';
import { RETRY_CONFIG } from '../shared/constants.js';

import { getVaultForSession, endSession } from '../../dev2/session-vault-manager.js';
import { processPageForRedaction } from '../../dev2/redaction-engine.js';
import { canvasToBase64 } from '../../dev2/redaction-renderer.js';
import { detectPII } from '../../dev2/pii-patterns.js';
import {
  resolveCredentialTokens,
  UnresolvedSensitiveReferenceError,
} from '../../dev2/task-entity-extractor.js';
import { detectFaces } from '../vision/visionPipeline.js';
import { runOcr } from '../vision/ocrPipeline.js';
import { getVisionResultCached, clearVisionCache } from '../vision/visionCache.js';
import {
  getConfirmedSensitiveLabels,
  recordConfirmedSensitiveLabel,
} from '../../dev2/origin-sensitivity-profile.js';

const IS_TEST_MODE = typeof window !== 'undefined' && window.__PERCEIVE_TEST_MODE__ === true;

// TODO: replace with Dev 1's real capture module once available
const mockDev1 = {
    captureCurrentState: async () => ({ dom: {}, screenshot: "mock_screenshot_data" })
};

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
    const [faceResults, ocrResults] = await Promise.all([
      detectFaces(snapshot.canvas),
      runOcr(snapshot.canvas),
    ]);
    return { faces: faceResults, ocrLines: ocrResults };
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

  mark('perceive:step:total:end');
  measure('perceive:step:total', 'perceive:step:total:start', 'perceive:step:total:end');

  // originalImageBase64 is for the Phase 4 audit dashboard ONLY — it is the
  // pre-redaction screenshot and must NEVER be included in the payload sent
  // to the backend (that would defeat the entire on-device redaction
  // architecture). Kept as a separate return value specifically so it can
  // never accidentally get merged into the network payload object below.
  const originalImageBase64 = canvasToBase64(snapshot.canvas);

  return {
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
function broadcastAuditUpdate(sessionId, stepNumber, payload, originalImageBase64, action) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  const metrics = (typeof performance !== 'undefined' && performance.getEntriesByType)
    ? performance.getEntriesByType('measure')
        .filter(m => m.name.startsWith('perceive:step:'))
        .map(m => ({ name: m.name, durationMs: Math.round(m.duration * 100) / 100 }))
    : [];

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
 */
function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve(null); // Signal: no extension runtime available
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
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

function verifyTaskCompletion() {
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

  return {
    verified: !hasVisibleError && !hasErrorRoleElement,
    reason: hasVisibleError
      ? 'Visible error text detected on page'
      : hasErrorRoleElement
        ? 'Element with error role/class detected'
        : null,
  };
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
                    // 1. Capture
                    const snapshot = captureOverride ? await captureOverride() : await mockDev1.captureCurrentState();

                    // 2. Redact + build payload. Requests the NEXT server-side
                    // step number (not the logical/retry-attempt stepNumber)
                    // and includes feedback about the previous attempt's
                    // execution failure, if any.
                    const requestStepNumber = backendStepNumber + 1;
                    const { payload, originalImageBase64 } = await buildSanitizedPayload(snapshot, sessionId, taskInstruction, requestStepNumber, lastActionError);

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
                    broadcastAuditUpdate(sessionId, stepNumber, payload, originalImageBase64, actionResponse.action);

                    // 4. Check for terminal actions
                    if (actionResponse.action.type === 'task_complete') {
                        const verification = verifyTaskCompletion();
                        if (!verification.verified) {
                            console.warn('[Orchestrator] task_complete rejected — postcondition check failed:', verification.reason);
                            lastActionError = `Previous task_complete was rejected: ${verification.reason}`;
                            retriesLeft--;
                            if (retriesLeft === 0) {
                                await finalizeTask(sessionId, 'max_retries_exceeded');
                                return { success: false, reason: `Step ${stepNumber} failed after max retries: ${verification.reason}` };
                            }
                            continue;
                        }
                        await finalizeTask(sessionId, 'completed');
                        return { success: true, steps: stepNumber };
                    }
                    if (actionResponse.action.type === 'task_failed') {
                        // Full action object, not just the reason string, so
                        // DevTools alone (no dashboard needed) shows exactly
                        // what the LLM decided and why after the fact.
                        console.error(`[Orchestrator] task_failed at step ${stepNumber} (session ${sessionId}):`, actionResponse.action);
                        await finalizeTask(sessionId, 'failed_by_server');
                        return { success: false, reason: actionResponse.action.reasoning_short, steps: stepNumber };
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

                    if (result.success) {
                        stepSuccess = true;
                        lastActionError = null;
                        await delay(RETRY_CONFIG.POST_ACTION_DELAY_MS);
                    } else {
                        console.warn(`[Orchestrator] Step ${stepNumber} execution failed:`, result.error);
                        lastActionError = `Previous action (${actionResponse.action.type}${actionResponse.action.target_element_id ? ` on ${actionResponse.action.target_element_id}` : ''}) failed to execute: ${result.error}`;
                        retriesLeft--;
                    }
                } catch (err) {
                    if (err instanceof UnresolvedSensitiveReferenceError) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_TASK') {
    const capture = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      return {
        elements: Array.from(document.querySelectorAll('input, button, select, textarea')),
        canvas
      };
    };
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