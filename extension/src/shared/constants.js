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
    POST_ACTION_DELAY_MS: 800
};

// Phase D.1b: demo-mode instrumentation, NOT a feature. When true, the
// background service worker (see demoCapture.js) persists the PRE-redaction
// ORIGINAL screenshot locally via chrome.downloads, purely for producing
// side-by-side before/after proof during a deliberate demo run. This must
// default to false in every shipped build — flip it only for a controlled
// local demo, never leave it on. See extension/tests/test-demo-capture.js
// for the regression test enforcing this default.
export const DEMO_MODE_ENABLED = false;
