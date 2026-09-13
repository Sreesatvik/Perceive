document.getElementById('dashboard-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/panel/auditDashboard.html') });
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