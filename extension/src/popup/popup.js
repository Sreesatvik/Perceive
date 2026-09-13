document.getElementById('dashboard-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/panel/auditDashboard.html') });
});

// Backend API key settings — previously there was no UI for this at all;
// transport.js/orchestrator.js only ever read it from chrome.storage.local
// with nothing anywhere to write it, so every real request failed with
// "No backend API key configured" until it was set manually via the
// console. This exposes it as a normal settings field instead.
(async () => {
  const keyInput = document.getElementById('api-key-input');
  const keyStatus = document.getElementById('key-status');
  const settingsDetails = document.getElementById('settings-details');
  if (!keyInput) return;

  const stored = await chrome.storage.local.get('backendApiKey');
  if (stored.backendApiKey) {
    keyInput.value = stored.backendApiKey;
  } else {
    // Nudge the user to notice this on first use, since a missing key is
    // the single most common reason a task silently fails.
    settingsDetails.open = true;
    keyStatus.textContent = 'Not set — tasks will fail without this.';
    keyStatus.style.color = '#f08a8a';
  }
})();

document.getElementById('save-key-btn').addEventListener('click', async () => {
  const keyInput = document.getElementById('api-key-input');
  const keyStatus = document.getElementById('key-status');
  const value = keyInput.value.trim();

  if (!value) {
    keyStatus.textContent = 'Enter a key first';
    keyStatus.style.color = '#f08a8a';
    return;
  }

  await chrome.storage.local.set({ backendApiKey: value });
  keyStatus.textContent = '✓ Saved';
  keyStatus.style.color = '#7fd77f';
});

// Chrome never injects content scripts into these pages at all (chrome://,
// the Web Store, PDF viewer, etc.), so chrome.tabs.sendMessage below fails
// with the SAME generic "Could not establish connection. Receiving end does
// not exist." error Chrome also produces for an ordinary, supported page
// whose content script just isn't there yet (a real, separate gotcha: the
// tab was open before the extension was installed/reloaded). That error
// string alone can't tell the two apart — but tab.url can: <all_urls> is
// already a persistent host_permission in manifest.json, so tab.url is
// always populated here, letting us check the URL scheme itself rather
// than guess from Chrome's identical wording for both cases.
const RESTRICTED_URL_PATTERNS = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^edge:\/\//i,
  /^about:/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/chromewebstore\.google\.com/i,
  /\.pdf(\?|#|$)/i,
];

function isKnownRestrictedUrl(url) {
  if (!url) return true; // no URL at all (e.g. a not-yet-loaded tab) — treat conservatively as unsupported
  return RESTRICTED_URL_PATTERNS.some((re) => re.test(url));
}

function isNoContentScriptError(message) {
  return /Receiving end does not exist|Could not establish connection/i.test(message || '');
}

document.getElementById('run-btn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const taskInput = document.getElementById('task-input');
  const taskInstruction = taskInput ? taskInput.value.trim() : '';

  if (!taskInstruction) {
    if (status) status.textContent = 'Enter a task first';
    return;
  }

  status.textContent = '● Running...';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(
    tab.id,
    {
      type: 'RUN_TASK',
      taskInstruction: taskInstruction
    },
    (response) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message;
        if (isNoContentScriptError(errorMessage) && isKnownRestrictedUrl(tab.url)) {
          status.textContent = "⚠ Perceive can't run on this page (browser internal pages, the Chrome Web Store, and PDF viewers are not supported).";
        } else if (isNoContentScriptError(errorMessage)) {
          status.textContent = '⚠ Perceive couldn\'t start on this tab — try refreshing the page and running the task again.';
        } else {
          // Not a "no content script" failure — an unrelated connection
          // error should still surface verbatim, not be swallowed or
          // misdiagnosed as one of the two cases above.
          status.textContent = '⚠ ' + errorMessage;
        }
        return;
      }
      status.textContent = response && response.started ? '● Task started' : '⚠ Failed to start';
    }
  );
});

// A running task can finish with an UNRESOLVED_SENSITIVE_REFERENCE reason
// when the instruction implies a login but no credential value could be
// found. Rather than silently proceeding with an ambiguous instruction
// (or leaving the user guessing why the task stopped), surface it here so
// they can retype the task with an explicit credential.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'TASK_RESULT' && !message.result.success) {
    const status = document.getElementById('status');
    if (!status) return;
    if (message.result.reason === 'UNRESOLVED_SENSITIVE_REFERENCE') {
      status.textContent = '⚠ ' + message.result.message;
    } else {
      status.textContent = '⚠ Task failed: ' + (message.result.reason || 'unknown error');
    }
  }
});