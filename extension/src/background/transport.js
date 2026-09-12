console.log('transport.js loaded');
import { validateActionResponse } from '../shared/schemas.js';

import { assertSafeToSend } from '../../dev2/leakage-auditor.js';
import { assertChannelsConsistent } from '../../dev2/channel-consistency-check.js';
import { detectPII } from '../../dev2/pii-patterns.js';

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
          sendToBackend(message.payload)
              .then(action => {
                  sendResponse({ success: true, action });
              })
              .catch(error => {
                  sendResponse({ success: false, error: error.message, errorType: error.name });
              });
          return true; // Keep message channel open for async response
      }

      if (message.type === 'END_SESSION') {
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
