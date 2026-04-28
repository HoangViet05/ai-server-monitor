const Logs = (() => {
  let currentServerId = null;
  let currentAppName = null;

  function open(serverId, appName) {
    currentServerId = serverId;
    currentAppName = appName;

    document.getElementById('log-viewer').classList.remove('hidden');
    document.getElementById('log-app-name').textContent = appName;
    document.getElementById('log-content').innerHTML = '<div class="log-line-out">Loading...</div>';

    fetch(`/api/servers/${serverId}/logs/${appName}?lines=200`)
      .then(r => r.json())
      .then(logs => {
        const container = document.getElementById('log-content');
        container.innerHTML = '';
        for (const log of logs) {
          appendLine(log.log_type, log.message);
        }
        container.scrollTop = container.scrollHeight;
      });
  }

  function close() {
    currentServerId = null;
    currentAppName = null;
    document.getElementById('log-viewer').classList.add('hidden');
  }

  function appendLine(logType, message) {
    const container = document.getElementById('log-content');
    if (!container) return;

    const div = document.createElement('div');
    div.className = logType === 'error' ? 'log-line-error' : 'log-line-out';
    div.textContent = message;
    container.appendChild(div);

    // Auto-scroll
    container.scrollTop = container.scrollHeight;
  }

  function handleNewLog(serverId, appName, logType, message) {
    if (serverId === currentServerId && appName === currentAppName) {
      appendLine(logType, message);
    }
  }

  return { open, close, handleNewLog };
})();
