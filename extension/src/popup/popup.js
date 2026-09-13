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
        status.textContent = '⚠ ' + chrome.runtime.lastError.message;
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