import { executeAction } from './actionExecutor.js';
import { requiresConfirmation, requestConfirmation } from './confirmationUI.js';
import { RETRY_CONFIG } from '../shared/constants.js';

import { getVaultForSession, endSession } from '../../dev2/session-vault-manager.js';
import { processPageForRedaction } from '../../dev2/redaction-engine.js';
import { detectPII } from '../../dev2/pii-patterns.js';
import {
  resolveCredentialTokens,
  UnresolvedSensitiveReferenceError,
} from '../../dev2/task-entity-extractor.js';
import { detectFaces } from '../vision/visionPipeline.js';
import { runOcr } from '../vision/ocrPipeline.js';
import { getVisionResultCached, clearVisionCache } from '../vision/visionCache.js';

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

async function buildSanitizedPayload(snapshot, sessionId, taskInstruction, stepNumber) {
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

  mark('perceive:step:dom-and-redaction:start');
  const result = processPageForRedaction(snapshot.elements, snapshot.canvas, vault, { faces, ocrLines });
  mark('perceive:step:dom-and-redaction:end');
  measure('perceive:step:dom-and-redaction', 'perceive:step:dom-and-redaction:start', 'perceive:step:dom-and-redaction:end');

  mark('perceive:step:total:end');
  measure('perceive:step:total', 'perceive:step:total:start', 'perceive:step:total:end');

  return {
    session_id: sessionId,
    task_instruction: sanitizedInstruction,
    step_number: stepNumber,
    ...result
  };
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
    
    // Track active vaults for E2E testing
    if (IS_TEST_MODE) {
        if (window.__activeVaults === undefined) window.__activeVaults = 0;
        window.__activeVaults++;
    }

    // Obtain vault ONCE at task start
    const vault = getVaultForSession(sessionId);
    const resolveToken = vault.resolveToken.bind(vault);

    try {
        while (stepNumber < RETRY_CONFIG.MAX_STEPS) {
            stepNumber++;
            let retriesLeft = RETRY_CONFIG.MAX_RETRIES_PER_STEP;
            let stepSuccess = false;

            while (retriesLeft > 0 && !stepSuccess) {
                try {
                    // 1. Capture
                    const snapshot = captureOverride ? await captureOverride() : await mockDev1.captureCurrentState();

                    // 2. Redact + build payload
                    const payload = await buildSanitizedPayload(snapshot, sessionId, taskInstruction, stepNumber);

                    // 3. Send to backend via background worker to avoid CORS issues in content script context
                    let actionResponse = null;
                    
                    // --- MOCK BACKEND RESPONSES FOR E2E ---
                    if (window.__mockBackendResponse) {
                        actionResponse = window.__mockBackendResponse(stepNumber, payload);
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

                    // 4. Check for terminal actions
                    if (actionResponse.action.type === 'task_complete') {
                        const verification = verifyTaskCompletion();
                        if (!verification.verified) {
                            console.warn('[Orchestrator] task_complete rejected — postcondition check failed:', verification.reason);
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
                        await delay(RETRY_CONFIG.POST_ACTION_DELAY_MS);
                    } else {
                        console.warn(`[Orchestrator] Step ${stepNumber} execution failed:`, result.error);
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