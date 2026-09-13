const MIN_VALID_DATA_URL_LENGTH = 1000;
const BLANK_CAPTURE_RETRY_DELAY_MS = 150;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function captureVisibleTabAsync(windowId, options) {
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(dataUrl);
            }
        });
    });
}

function tabGetAsync(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(tab);
            }
        });
    });
}

function isRestrictedPageError(err) {
    const message = (err && err.message) || '';
    return message.includes('chrome://') || /restricted|cannot be scripted|cannot capture/i.test(message);
}

/**
 * Captures the visible tab as a PNG data URL. Must be called from the
 * background service worker — content scripts cannot call
 * chrome.tabs.captureVisibleTab directly.
 */
export async function captureTabState(tabId, windowId) {
    try {
        // The tab may have closed between the content script's message and
        // this handler running — checking here avoids a confusing generic
        // failure from captureVisibleTab further down.
        try {
            await tabGetAsync(tabId);
        } catch (_e) {
            return { success: false, error: 'tab_closed' };
        }

        let dataUrl;
        try {
            dataUrl = await captureVisibleTabAsync(windowId, { format: 'png' });
        } catch (err) {
            if (isRestrictedPageError(err)) {
                return { success: false, error: 'restricted_page', message: err.message };
            }
            throw err;
        }

        // Known quirk: captureVisibleTab occasionally returns a blank frame
        // (very short data URL) if it fires before the tab has painted.
        if (!dataUrl || dataUrl.length < MIN_VALID_DATA_URL_LENGTH) {
            await delay(BLANK_CAPTURE_RETRY_DELAY_MS);
            try {
                dataUrl = await captureVisibleTabAsync(windowId, { format: 'png' });
            } catch (err) {
                if (isRestrictedPageError(err)) {
                    return { success: false, error: 'restricted_page', message: err.message };
                }
                throw err;
            }
        }

        return {
            success: true,
            screenshotDataUrl: dataUrl,
            capturedAt: Date.now(),
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
