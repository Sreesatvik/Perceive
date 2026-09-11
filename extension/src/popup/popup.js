document.getElementById('run-btn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = '● Running...';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(
    tab.id,
    {
      type: 'RUN_TASK',
      taskInstruction: "Log in to this website using username 'tomsmith' and password 'SuperSecretPassword!', then confirm the login was successful."
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