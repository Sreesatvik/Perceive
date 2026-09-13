console.log('transport.js loaded');
import { validateActionResponse } from '../shared/schemas.js';

import { assertSafeToSend } from '../../dev2/leakage-auditor.js';
import { assertChannelsConsistent } from '../../dev2/channel-consistency-check.js';
import { detectPII } from '../../dev2/pii-patterns.js';
import { captureTabState } from './captureService.js';
import { maybeSaveDemoScreenshot } from './demoCapture.js';

const BACKEND_URL = 'http://localhost:8000';
const ANALYZE_ENDPOINT = '/analyze';
const TIMEOUT_MS = 30000;

async function getBackendApiKey() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return null; // test harness / non-extension context
    }
    const result = await chrome.storage.local.get('backendApiKey');
    return result.backendApiKey || null;
}

class PayloadLeakageError extends Error {
    constructor(message) {
        super(message);
        this.name = "PayloadLeakageError";
    }
}

class TransportError extends Error {
    constructor(message) {
        super(message);
        this.name = "TransportError";
    }
}

/**
 * Sends sanitized payload to backend and returns action response.
 */
export async function sendToBackend(payload) {
    try {
      assertSafeToSend(payload, detectPII);
      if (payload.redacted_regions) {
        assertChannelsConsistent(payload, payload.redacted_regions);
      }
    } catch (err) {
      throw new PayloadLeakageError(err.message);
    }

    const jsonString = JSON.stringify(payload);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const apiKey = await getBackendApiKey();
        if (!apiKey) {
            console.error('[Transport] No backend API key configured \u2014 set one via the extension options page');
            throw new TransportError('No backend API key configured');
        }

        const response = await fetch(`${BACKEND_URL}${ANALYZE_ENDPOINT}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: jsonString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            let errorDetail = '';
            try {
                const errorBody = await response.json();
                errorDetail = JSON.stringify(errorBody);
            } catch (e) {
                errorDetail = await response.text().catch(() => '(could not read error body)');
            }
            console.error('[Transport] Backend rejected request:', response.status, errorDetail);
            throw new TransportError(`Server returned ${response.status}: ${errorDetail}`);
        }

        const actionResponse = await response.json();
        
        // Schema validation
        validateActionResponse(actionResponse, payload.session_id, payload.step_number);  
        
        return actionResponse;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new TransportError('Request timed out');
        }
        throw err;
    }
}

// --- Phase 5.2: multi-tab/frame session binding ---
//
// Everything reaching this background service worker arrives via
// chrome.runtime.onMessage, which is global across every tab/frame the
// content script runs in — nothing previously stopped a message CLAIMING
// to be for session X from actually being processed regardless of which
// tab/frame it came from. This binds each session_id to the (tabId,
// frameId) that first used it, and rejects anything else claiming that
// session afterwards.
const sessionContext = new Map(); // session_id -> { tabId, frameId, networkBudget: { remaining } }

const MAX_TASK_NETWORK_RETRIES = 8; // Phase 5.3: task-level ceiling, shared across every step's retries

function bindOrVerifySessionContext(sessionId, sender) {
  const senderTabId = sender && sender.tab ? sender.tab.id : undefined;
  const senderFrameId = sender ? sender.frameId : undefined;

  const existing = sessionContext.get(sessionId);
  if (!existing) {
    sessionContext.set(sessionId, {
      tabId: senderTabId,
      frameId: senderFrameId,
      networkBudget: { remaining: MAX_TASK_NETWORK_RETRIES },
    });
    return { ok: true, budget: sessionContext.get(sessionId).networkBudget };
  }

  if (existing.tabId !== senderTabId || existing.frameId !== senderFrameId) {
    return { ok: false };
  }
  return { ok: true, budget: existing.networkBudget };
}

// --- Phase 5.3: network/provider resilience ---
//
// Distinct from the server's own hallucination-retry loop (main.py retries
// malformed LLM JSON up to MAX_RETRIES with no client involvement at all).
// This handles transient PROVIDER/NETWORK failures the client can see —
// the server returning 429 (rate limited) or, if ever fronted by a proxy,
// 502/503/504 — with bounded exponential backoff and jitter, instead of
// the previous behavior of immediately looping again with zero delay.
const RETRYABLE_STATUS_CODES = [429, 502, 503, 504];
const MAX_NETWORK_RETRIES_PER_STEP = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

function parseStatusCodeFromTransportError(err) {
  const match = /Server returned (\d+)/.exec(err && err.message || '');
  return match ? parseInt(match[1], 10) : null;
}

function backoffDelayMs(attempt) {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exp + Math.random() * exp * 0.3; // + up to 30% jitter
}

/**
 * Wraps sendToBackend with bounded exponential backoff + jitter for
 * retryable provider errors, gated by a shared per-task budget in addition
 * to this call's own per-step cap — whichever runs out first stops retrying.
 * @param {object} payload
 * @param {{ remaining: number }} [taskBudget] - shared across a session's steps
 */
export async function sendToBackendWithRetry(payload, taskBudget) {
  let attempt = 0;
  for (;;) {
    try {
      return await sendToBackend(payload);
    } catch (err) {
      const status = err instanceof TransportError ? parseStatusCodeFromTransportError(err) : null;
      const retryable = RETRYABLE_STATUS_CODES.includes(status);
      const taskBudgetLeft = taskBudget ? taskBudget.remaining : 0;

      if (!retryable || attempt >= MAX_NETWORK_RETRIES_PER_STEP || taskBudgetLeft <= 0) {
        throw err;
      }

      if (taskBudget) taskBudget.remaining--;
      const delayMs = backoffDelayMs(attempt);
      attempt++;
      console.warn(`[Transport] Retryable provider error (${status}) — backing off ${Math.round(delayMs)}ms (attempt ${attempt}/${MAX_NETWORK_RETRIES_PER_STEP}, task budget ${taskBudgetLeft - 1} left)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// --- Face detection: worker owned by an OFFSCREEN DOCUMENT ---
//
// Two real, empirically-found bugs shaped this, in order:
//
// 1. Spawning `new Worker(chrome-extension://.../faceDetectionWorker.bundle.js)`
//    directly from a content script broke on a real, security-conscious site
//    (observed live on leetcode.com):
//      SecurityError: Failed to construct 'Worker': Script at
//      'chrome-extension://.../faceDetectionWorker.bundle.js' cannot be
//      accessed from origin 'https://leetcode.com'.
//    This is the HOST PAGE's own CSP (worker-src) rejecting a cross-origin
//    worker script — independent of manifest.json's web_accessible_resources,
//    which only controls whether the extension PERMITS the resource to be
//    fetched, not whether the page's own CSP allows constructing a Worker
//    from it. This is what motivated moving worker ownership OUT of the
//    content script.
//
// 2. Moving it into THIS file (the background service worker) instead was
//    also wrong, found in later live Chrome testing: Chrome does not support
//    creating a dedicated Worker from within a Service Worker context AT
//    ALL — `new Worker(...)` here throws `ReferenceError: Worker is not
//    defined` synchronously. (manifest.json declares this service worker as
//    `"type": "module"`, but the restriction is on Service Workers spawning
//    Workers in general, not specific to module-type ones.) That failure was
//    silently swallowed by detectFaces()'s own fail-open catch in
//    visionPipeline.js, so face detection ran with zero faces detected on
//    every single page, with no visible error apart from a console log in
//    the CONTENT SCRIPT's console (where that catch block executes) reading
//    "Worker is not defined" — which is easy to misread as a content-script
//    bug when the actual throw happened here.
//
// The fix: a chrome.offscreen document (src/background/offscreen.html +
// offscreenFaceDetection.js) is a real window/DOM context — unlike a
// service worker, it CAN spawn a classic Worker — and it lives at the
// extension's own chrome-extension:// origin, so it is never subject to any
// host page's CSP like a content script is. This file's job shrinks to:
// ensure that document exists, then relay the request to it and forward its
// response back exactly as it did when it owned the worker directly, so
// visionPipeline.js's DETECT_FACES contract is unchanged.
const OFFSCREEN_DOCUMENT_URL = 'src/background/offscreen.html';
let creatingOffscreenDocument = null;

async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) return;

    if (creatingOffscreenDocument) {
        await creatingOffscreenDocument;
        return;
    }

    creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_URL,
        reasons: ['WORKERS'],
        justification: 'Service workers cannot spawn a dedicated Worker; MediaPipe face detection needs a real window/DOM context to run its classic Worker.',
    });
    try {
        await creatingOffscreenDocument;
    } finally {
        creatingOffscreenDocument = null;
    }
}

async function detectFacesInBackground(width, height, pixels) {
    await ensureOffscreenDocument();

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            { type: 'OFFSCREEN_DETECT_FACES', width, height, pixels },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!response || !response.success) {
                    reject(new Error((response && response.error) || 'Offscreen face detection failed'));
                    return;
                }
                resolve(response.faces || []);
            }
        );
    });
}

/**
 * Sends a fire-and-forget POST to /session/{sessionId}/end in the background.
 */
async function endSessionOnBackend(sessionId, reason) {
    try {
        const apiKey = await getBackendApiKey();
        if (!apiKey) {
            console.error('[Transport] No backend API key configured \u2014 set one via the extension options page');
            return;
        }

        const response = await fetch(`${BACKEND_URL}/session/${sessionId}/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: JSON.stringify({ reason }),
        });
        if (!response.ok) {
            console.warn('[Transport] END_SESSION backend call failed:', response.status);
        }
    } catch (err) {
        console.warn('[Transport] END_SESSION fetch error:', err.message);
    }
}

// Background script message listener for passing messages from content script
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'SEND_PAYLOAD') {
          const sessionId = message.payload && message.payload.session_id;
          const binding = bindOrVerifySessionContext(sessionId, sender);

          if (!binding.ok) {
              // Phase 5.2: a message claiming an existing session_id from a
              // DIFFERENT tab/frame than the one that started it is rejected
              // outright — never forwarded to the backend at all.
              console.error(`[Transport] Rejected SEND_PAYLOAD for session ${sessionId}: sender tab/frame does not match the session's bound context`);
              sendResponse({ success: false, error: 'session_context_mismatch', errorType: 'SessionContextError' });
              return true;
          }

          sendToBackendWithRetry(message.payload, binding.budget)
              .then(action => {
                  sendResponse({ success: true, action });
              })
              .catch(error => {
                  sendResponse({ success: false, error: error.message, errorType: error.name });
              });
          return true; // Keep message channel open for async response
      }

      if (message.type === 'CAPTURE_TAB_STATE') {
          const tabId = sender && sender.tab ? sender.tab.id : undefined;
          const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
          captureTabState(tabId, windowId)
              .then(result => {
                  if (result.success) {
                      // Best-effort, gated by DEMO_MODE_ENABLED (default off)
                      // inside demoCapture.js — never blocks or affects the
                      // response either way.
                      maybeSaveDemoScreenshot(message.sessionId, message.stepNumber, result.screenshotDataUrl)
                          .catch(() => { /* already logged inside demoCapture.js */ });
                  }
                  sendResponse(result);
              })
              .catch(error => sendResponse({ success: false, error: error.message }));
          return true; // Keep message channel open for async response
      }

      if (message.type === 'DETECT_FACES') {
          detectFacesInBackground(message.width, message.height, message.pixels)
              .then(faces => {
                  sendResponse({ success: true, faces });
              })
              .catch(error => {
                  sendResponse({ success: false, error: error.message });
              });
          return true; // Keep message channel open for async response
      }

      if (message.type === 'END_SESSION') {
          sessionContext.delete(message.sessionId);
          endSessionOnBackend(message.sessionId, message.reason)
              .then(() => {
                  sendResponse({ success: true });
              })
              .catch(error => {
                  sendResponse({ success: false, error: error.message });
              });
          return true; // Keep message channel open for async response
      }
  });
}

// Phase 5.3: teardown-on-tab-destruction. If a tab closes mid-task, its
// content-script JS realm (and the in-memory token vault living there) is
// already torn down by the browser automatically — but this background
// service worker's OWN bookkeeping (the session binding + retry budget
// above) is not, and would otherwise leak or go stale. Local cleanup here
// is unconditional and synchronous; the best-effort backend notification
// is fire-and-forget and never gates it.
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((closedTabId) => {
    for (const [sessionId, ctx] of sessionContext.entries()) {
      if (ctx.tabId === closedTabId) {
        sessionContext.delete(sessionId);
        endSessionOnBackend(sessionId, 'tab_destroyed').catch(() => {
          // Local state above is already cleared regardless of this outcome.
        });
      }
    }
  });
}
