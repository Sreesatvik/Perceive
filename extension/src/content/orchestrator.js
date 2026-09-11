import { executeAction } from './actionExecutor.js';
import { requiresConfirmation, requestConfirmation } from './confirmationUI.js';
import { RETRY_CONFIG } from '../shared/constants.js';
import { sendToBackend } from '../background/transport.js';

import { getVaultForSession, endSession } from '../../dev2/session-vault-manager.js';
import { processPageForRedaction } from '../../dev2/redaction-engine.js';

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
  let sanitizedInstruction = taskInstruction;

  // Match: username 'X' or username "X"
  sanitizedInstruction = sanitizedInstruction.replace(
    /username\s+['"]([^'"]+)['"]/i,
    (match, value) => {
      const token = vault.getOrCreateToken(value, 'NAME');
      return `username ${token}`;
    }
  );

  // Match: password 'X' or password "X"
  sanitizedInstruction = sanitizedInstruction.replace(
    /password\s+['"]([^'"]+)['"]/i,
    (match, value) => {
      const token = vault.getOrCreateToken(value, 'PASSWORD');
      return `password ${token}`;
    }
  );

  return sanitizedInstruction;
}

async function buildSanitizedPayload(snapshot, sessionId, taskInstruction, stepNumber) {
  // ASSUMPTION: snapshot has shape { elements: HTMLElement[], canvas: HTMLCanvasElement }
  // TODO: confirm this matches Dev 1's real capture module output once available
  const vault = getVaultForSession(sessionId);

  // Tokenize any credentials embedded in the task instruction BEFORE sending
  // it anywhere, so raw values never reach the LLM. The LLM will see the
  // token names ([NAME_1], [PASSWORD_1], etc.) and must reference those
  // tokens in its "type" actions instead of raw values.
  const sanitizedInstruction = tokenizeCredentialsInInstruction(taskInstruction, vault);

  const result = await processPageForRedaction(snapshot.elements, snapshot.canvas, vault);
  return {
    session_id: sessionId,
    task_instruction: sanitizedInstruction,
    step_number: stepNumber,
    ...result
  };
}

const BACKEND_URL = 'http://localhost:8000';

const delay = ms => new Promise(res => setTimeout(res, ms));

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

    // Step 2: Notify backend
    try {
        fetch(`${BACKEND_URL}/session/${sessionId}/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        }).catch(() => {}); // Fire and forget
    } catch (e) {
        // non-fatal, swallow silently
    }

    // Step 3: Emit event
    window.dispatchEvent(new CustomEvent('agent-session-end', {
        detail: { sessionId, reason }
    }));
}

export async function runTaskLoop(taskInstruction, captureOverride = null) {
    const sessionId = crypto.randomUUID();
    let stepNumber = 0;
    
    // Track active vaults for E2E testing
    if (window.__activeVaults === undefined) window.__activeVaults = 0;
    window.__activeVaults++;

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

                    // 3. Send to backend (mocking transport logic directly here for testability without a real backend)
                    // TODO: In the real extension, content scripts cannot directly import background/transport.js — must use chrome.runtime.sendMessage({ type: 'SEND_PAYLOAD', payload }) instead and await the response via callback/promise wrapper. Direct import only works in this test harness context (plain webpage, no extension runtime).
                    let actionResponse = null;
                    
                    // --- MOCK BACKEND RESPONSES FOR E2E ---
                    if (window.__mockBackendResponse) {
                        actionResponse = window.__mockBackendResponse(stepNumber, payload);
                    } else {
                        actionResponse = await sendToBackend(payload);
                    }
                    // --------------------------------------

                    // 4. Check for terminal actions
                    if (actionResponse.action.type === 'task_complete') {
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
                        result = await executeAction(actionResponse.action, resolveToken);
                    }

                    if (result.success) {
                        stepSuccess = true;
                        await delay(RETRY_CONFIG.POST_ACTION_DELAY_MS);
                    } else {
                        console.warn(`[Orchestrator] Step ${stepNumber} execution failed:`, result.error);
                        retriesLeft--;
                    }
                } catch (err) {
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
window.__runTaskLoop = runTaskLoop;

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
    runTaskLoop(message.taskInstruction, capture);
    sendResponse({ started: true });
    return true;
  }
});