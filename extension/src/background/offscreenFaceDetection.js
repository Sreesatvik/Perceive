/**
 * Runs inside the offscreen document (src/background/offscreen.html) — a
 * real window/DOM context, NOT a Service Worker.
 *
 * WHY THIS FILE EXISTS: Chrome does not support creating a dedicated
 * `Worker` from within a Service Worker context at all (there is no polyfill
 * or workaround inside the service worker itself — `Worker` is simply not
 * defined there). transport.js's background service worker previously tried
 * to own `faceDetectionWorker.bundle.js` directly (see its own history:
 * moved there from the content script specifically to dodge a real
 * cross-origin CSP SecurityError on some sites), which silently failed with
 * "Worker is not defined" — a real regression found in live Chrome testing.
 *
 * A `chrome.offscreen` document is the Chrome-recommended fix for exactly
 * this class of problem: it is a real DOM/window context (so it CAN spawn a
 * classic Worker, unlike a service worker) that lives at the extension's own
 * chrome-extension:// origin (so it is never subject to any host page's CSP,
 * unlike a content script). transport.js relays DETECT_FACES requests here
 * via OFFSCREEN_DETECT_FACES instead of spawning the worker itself.
 *
 * This is otherwise a straight copy of the worker-ownership logic that used
 * to live in transport.js's getFaceWorker()/detectFacesInBackground() (and,
 * before that, visionPipeline.js's local-fallback path) — same protocol,
 * same worker bundle, just hosted in a context that can actually run it.
 */
let faceWorker = null;
let nextRequestId = 1;
const pending = new Map();

function getFaceWorker() {
    if (faceWorker) return faceWorker;

    faceWorker = new Worker(chrome.runtime.getURL('dist/faceDetectionWorker.bundle.js'));

    faceWorker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'log') {
            const level = msg.level === 'warn' ? console.warn : console.log;
            level(msg.message);
            return;
        }
        const entry = pending.get(msg.requestId);
        if (!entry) return;
        pending.delete(msg.requestId);
        if (msg.type === 'result') {
            entry.resolve(msg.faces || []);
        } else if (msg.type === 'error') {
            entry.reject(new Error(msg.message || 'Face detection worker error'));
        }
    };

    faceWorker.onerror = (event) => {
        const err = new Error((event && event.message) || 'Face detection worker crashed');
        for (const { reject } of pending.values()) reject(err);
        pending.clear();
        try { faceWorker.terminate(); } catch (_e) { /* noop */ }
        faceWorker = null;
    };

    return faceWorker;
}

function detectFacesInWorker(width, height, pixels) {
    return new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        pending.set(requestId, { resolve, reject });
        getFaceWorker().postMessage(
            { type: 'detect', requestId, width, height, pixels },
            [pixels]
        );
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'OFFSCREEN_DETECT_FACES') return false;

    detectFacesInWorker(message.width, message.height, message.pixels)
        .then((faces) => sendResponse({ success: true, faces }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
});
