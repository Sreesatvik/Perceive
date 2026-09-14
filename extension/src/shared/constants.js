export const ACTION_TYPES = {
    CLICK: 'click',
    TYPE: 'type',
    SCROLL: 'scroll',
    WAIT: 'wait',
    ASK_USER_CONFIRMATION: 'ask_user_confirmation',
    TASK_COMPLETE: 'task_complete',
    TASK_FAILED: 'task_failed'
};

export const RISK_TIERS = {
    SAFE: 'safe',
    RISKY: 'risky'
};

export const RETRY_CONFIG = {
    MAX_STEPS: 20,
    MAX_RETRIES_PER_STEP: 3,
    STEP_TIMEOUT_MS: 20000,
    POST_ACTION_DELAY_MS: 800,
    // Bug found live: a real false-positive face detection correctly
    // triggered dev2/channel-consistency-check.js's mismatch guard
    // (FIREWALL_BLOCK), which orchestrator.js retried — but with NO delay
    // before the retry's re-capture, unlike the success path above. Chrome's
    // own chrome.tabs.captureVisibleTab has an internal rate quota (~2
    // calls/second, i.e. captures need >=500ms apart to reliably succeed);
    // retrying instantly blew through that quota, and the resulting
    // capture_failed masked the real root cause entirely. Deliberately
    // LONGER than POST_ACTION_DELAY_MS (not just reused) for two reasons:
    // (1) POST_ACTION_DELAY_MS exists to let a successful action's page
    // transition settle, a different concern than clearing an external API
    // rate quota; (2) a failure retry may follow a burst of recent capture
    // attempts, not a single completed step, so extra margin beyond the
    // bare 500ms floor is warranted rather than just barely clearing it.
    POST_FAILURE_RETRY_DELAY_MS: 1500
};

// Separate from RETRY_CONFIG.STEP_TIMEOUT_MS deliberately, not just reused:
// STEP_TIMEOUT_MS bounds a simple background-worker IPC round trip
// (CAPTURE_TAB_STATE / SEND_PAYLOAD), and its timeout is a hard step failure
// that consumes a retry. The vision/OCR pipeline (detectFaces/runOcr) is
// architecturally allowed to just fail open — see dev2/channel-consistency-
// check.js's union-only mergeSensitivityChannels(), which already treats an
// empty vision channel as "nothing to add", never as a mismatch — so a
// timeout here should degrade that ONE channel, not fail the step. It also
// covers a materially different, legitimately slower workload: cold-start
// model/WASM loading and first-run asset fetches (MediaPipe's .tflite model,
// Tesseract's eng.traineddata) rather than a same-origin extension message.
export const VISION_TIMEOUT_MS = 30000;

// Phase D.1b: demo-mode instrumentation, NOT a feature. When true, the
// background service worker (see demoCapture.js) persists the PRE-redaction
// ORIGINAL screenshot locally via chrome.downloads, purely for producing
// side-by-side before/after proof during a deliberate demo run. This must
// default to false in every shipped build — flip it only for a controlled
// local demo, never leave it on. See extension/tests/test-demo-capture.js
// for the regression test enforcing this default.
export const DEMO_MODE_ENABLED = false;
