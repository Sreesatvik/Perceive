console.log('transport.js loaded');
import { validateActionResponse } from '../shared/schemas.js';

import { assertSafeToSend } from '../../dev2/leakage-auditor.js';
import { assertChannelsConsistent } from '../../dev2/channel-consistency-check.js';
import { detectPII } from '../../dev2/pii-patterns.js';

const BACKEND_URL = 'http://localhost:8000';
const ANALYZE_ENDPOINT = '/analyze';
const TIMEOUT_MS = 30000;

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
        const response = await fetch(`${BACKEND_URL}${ANALYZE_ENDPOINT}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
        validateActionResponse(actionResponse);  
        
        return actionResponse;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new TransportError('Request timed out');
        }
        throw err;
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
  });
}
