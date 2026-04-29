(function () {
  const socket = io();
  let scoreboards = [];
  let activeLogId = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderGrid() {
    const grid = document.getElementById('scoreboard-grid');
    if (scoreboards.length === 0) {
      grid.innerHTML = '<div class="empty-state">No scoreboards yet. Click "+ Add Scoreboard" to create one.</div>';
      return;
    }
    grid.innerHTML = scoreboards.map(sb => `
      <div class="server-card ${sb.running ? 'online' : 'offline'}" data-id="${sb.id}">
        <div class="card-header">
          <h3>${escapeHtml(sb.name)}</h3>
          <span class="status-dot ${sb.running ? 'online' : 'offline'}"></span>
        </div>
        <div class="card-meta">
          <div><span class="meta-label">Script:</span> <span class="script-badge script-${escapeHtml(sb.script_type)}">${escapeHtml(sb.script_type)}</span></div>
          <div><span class="meta-label">Scoreboard ID:</span></div>
          <div class="meta-mono">${escapeHtml(sb.scoreboard_id)}</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm btn-view" data-id="${sb.id}">View Logs</button>
          <button class="btn btn-sm btn-danger btn-delete" data-id="${sb.id}">Delete</button>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.btn-view').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openLogs(btn.dataset.id);
      });
    });
    grid.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteScoreboard(btn.dataset.id);
      });
    });
    grid.querySelectorAll('.server-card').forEach(card => {
      card.addEventListener('click', () => openLogs(card.dataset.id));
    });
  }

  function loadScoreboards() {
    fetch('/api/scoreboards')
      .then(r => r.json())
      .then(list => {
        scoreboards = list;
        renderGrid();
      });
  }

  function deleteScoreboard(id) {
    if (!confirm('Delete this scoreboard? Process will be stopped.')) return;
    fetch(`/api/scoreboards/${id}`, { method: 'DELETE' })
      .then(r => {
        if (!r.ok) throw new Error('Failed to delete');
        loadScoreboards();
      })
      .catch(err => alert('Error: ' + err.message));
  }

  function openAddModal() {
    document.getElementById('form-sb-name').value = '';
    document.getElementById('form-sb-id').value = '';
    document.getElementById('form-sb-script').value = 'mission';
    document.getElementById('modal-add-scoreboard').classList.remove('hidden');
  }

  function closeAddModal() {
    document.getElementById('modal-add-scoreboard').classList.add('hidden');
  }

  function handleAddSubmit(e) {
    e.preventDefault();
    const body = {
      name: document.getElementById('form-sb-name').value.trim(),
      scoreboard_id: document.getElementById('form-sb-id').value.trim(),
      script_type: document.getElementById('form-sb-script').value,
    };
    fetch('/api/scoreboards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'Failed'); });
        return r.json();
      })
      .then(() => {
        closeAddModal();
        loadScoreboards();
      })
      .catch(err => alert('Error: ' + err.message));
  }

  // --- Logs Modal ---
  function openLogs(id) {
    const sb = scoreboards.find(s => s.id === id);
    if (!sb) return;
    activeLogId = id;
    document.getElementById('sb-log-name').textContent = sb.name;
    const content = document.getElementById('sb-log-content');
    content.innerHTML = '<div class="log-line-out">Loading...</div>';
    document.getElementById('modal-sb-logs').classList.remove('hidden');

    fetch(`/api/scoreboards/${id}/logs?lines=2000`)
      .then(r => r.json())
      .then(logs => {
        content.innerHTML = '';
        for (const log of logs) appendLogLine(log.stream, log.message);
        content.scrollTop = content.scrollHeight;
      })
      .catch(err => {
        content.innerHTML = `<div class="log-line-error">Error: ${escapeHtml(err.message)}</div>`;
      });
  }

  function closeLogs() {
    activeLogId = null;
    document.getElementById('modal-sb-logs').classList.add('hidden');
    document.getElementById('sb-log-content').innerHTML = '';
    const modalContent = document.querySelector('#modal-sb-logs .modal-content');
    modalContent.classList.remove('modal-fullscreen');
    document.getElementById('btn-fullscreen-sb-logs').textContent = '⛶ Fullscreen';
  }

  function buildLogEntry(stream, message) {
    const entry = document.createElement('div');
    entry.className = 'log-entry log-type-' + (stream === 'stderr' ? 'err' : (stream === 'system' ? 'system' : 'out'));
    const text = document.createElement('span');
    text.className = 'log-line-text';
    text.textContent = message;
    entry.appendChild(text);
    return entry;
  }

  function appendLogLine(stream, message) {
    document.getElementById('sb-log-content').appendChild(buildLogEntry(stream, message));
  }

  function appendLogLines(stream, lines) {
    const content = document.getElementById('sb-log-content');
    const frag = document.createDocumentFragment();
    for (const m of lines) frag.appendChild(buildLogEntry(stream, m));
    content.appendChild(frag);
  }

  function bindSocket() {
    socket.on('scoreboard:log', ({ scoreboardId, stream, lines, message }) => {
      if (scoreboardId !== activeLogId) return;
      const content = document.getElementById('sb-log-content');
      const wasAtBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 50;
      const arr = Array.isArray(lines) ? lines : (message != null ? [message] : []);
      if (arr.length === 0) return;
      appendLogLines(stream, arr);
      if (wasAtBottom) content.scrollTop = content.scrollHeight;
    });

    socket.on('scoreboard:status', ({ scoreboardId, running }) => {
      const sb = scoreboards.find(s => s.id === scoreboardId);
      if (sb) {
        sb.running = running;
        renderGrid();
      }
    });
  }

  function bindUI() {
    document.getElementById('btn-add-scoreboard').addEventListener('click', openAddModal);
    document.getElementById('btn-cancel-sb').addEventListener('click', closeAddModal);
    document.getElementById('form-scoreboard').addEventListener('submit', handleAddSubmit);
    document.getElementById('btn-close-sb-logs').addEventListener('click', closeLogs);
    document.getElementById('modal-add-scoreboard').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) closeAddModal();
    });

    document.getElementById('btn-fullscreen-sb-logs').addEventListener('click', () => {
      const modalContent = document.querySelector('#modal-sb-logs .modal-content');
      const btn = document.getElementById('btn-fullscreen-sb-logs');
      const isFs = modalContent.classList.toggle('modal-fullscreen');
      btn.textContent = isFs ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
      const content = document.getElementById('sb-log-content');
      content.scrollTop = content.scrollHeight;
    });

    document.getElementById('btn-restart-sb').addEventListener('click', () => {
      if (!activeLogId) return;
      fetch(`/api/scoreboards/${activeLogId}/restart`, { method: 'POST' })
        .catch(err => alert('Error: ' + err.message));
    });
  }

  bindUI();
  bindSocket();
  loadScoreboards();
})();
