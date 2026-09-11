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