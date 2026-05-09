(function() {
  const state = {
    serverId: null,
    socket: null,
    notificationsEnabled: false,
  };

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B','KB','MB','GB','TB']; let i=0; while (n>=1024 && i<u.length-1){n/=1024;i++;}
    return `${n.toFixed(1)} ${u[i]}`;
  }
  function fmtPct(n) { return n == null ? '—' : `${Number(n).toFixed(1)}%`; }
  function classifyPct(p, warn, crit) {
    if (p == null) return 'ok';
    if (p >= crit) return 'critical';
    if (p >= warn) return 'warn';
    return 'ok';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function $(selector) { return document.querySelector(selector); }

  async function loadHealth(serverId) {
    state.serverId = serverId;
    if (!serverId) return;
    try {
      const res = await fetch(`/api/servers/${serverId}/health`);
      if (!res.ok) return;
      const data = await res.json();
      renderStatusGrid(data);
      renderIncidents(data.open_incidents || []);
      loadIncidentHistory();
      loadVersions();
    } catch (err) {
      console.error('[health] loadHealth failed:', err);
    }
  }

  function renderStatusGrid(data) {
    const root = $('.health-status-grid');
    if (!root) return;
    const host = data.latest_host_health ? data.latest_host_health.payload : {};
    const ext = data.latest_ext_deps ? data.latest_ext_deps.payload : {};

    const cards = [];

    if (Array.isArray(host.disk)) {
      for (const d of host.disk) {
        cards.push(card(`Disk ${d.mount}`, fmtPct(d.percent), `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`, classifyPct(d.percent, 85, 95)));
      }
    }

    if (host.ram) {
      const ramPct = host.ram.total ? (host.ram.used / host.ram.total) * 100 : 0;
      const swapPct = host.ram.swap_total ? (host.ram.swap_used / host.ram.swap_total) * 100 : 0;
      const oom = host.oom_events || 0;
      cards.push(card('RAM', fmtPct(ramPct), `Swap ${fmtPct(swapPct)} • OOM(5min): ${oom}`, classifyPct(ramPct, 85, 95)));
    }

    if (host.gpu) {
      if (host.gpu.lost) {
        cards.push(card('GPU', 'LOST', (host.gpu.errors || []).join('; '), 'critical'));
      } else {
        const memPct = host.gpu.mem_total ? (host.gpu.mem_used / host.gpu.mem_total) * 100 : 0;
        const tempCls = host.gpu.temp >= 90 ? 'critical' : host.gpu.temp >= 85 ? 'warn' : 'ok';
        cards.push(card('GPU', `${host.gpu.util}% util`, `Mem ${fmtPct(memPct)} • ${host.gpu.temp}°C`, tempCls));
      }
    }

    for (const [name, status] of Object.entries(ext)) {
      if (!status) continue;
      cards.push(card(name, status.ok ? 'OK' : 'FAIL', status.error || '', status.ok ? 'ok' : 'critical'));
    }

    if (cards.length === 0) {
      root.innerHTML = '<p style="color:#64748b">No health data yet. Enable agent health module in agent-config.json.</p>';
    } else {
      root.innerHTML = cards.join('');
    }
  }

  function card(label, value, sub, cls) {
    return `<div class="health-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></div>`;
  }

  function renderIncidents(incidents) {
    const root = $('.health-incidents');
    if (!root) return;
    if (incidents.length === 0) {
      root.innerHTML = '<p style="color:#64748b">No active incidents.</p>';
      return;
    }
    root.innerHTML = incidents.map(incidentHtml).join('');
    root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', onActionClick);
    });
  }

  function incidentHtml(inc) {
    const actions = (inc.suggested_actions || []).map((a) =>
      `<button data-action="exec" data-incident="${inc.id}" data-cmd="${encodeURIComponent(a.command)}">${escapeHtml(a.label)}</button>`
    ).join('');
    return `<div class="incident-banner ${inc.severity}">
      <strong>${escapeHtml(inc.title)}</strong> <small>(${escapeHtml(inc.kind)})</small>
      <div class="actions">
        ${inc.acked_at ? '' : `<button data-action="ack" data-incident="${inc.id}">Acknowledge</button>`}
        <button data-action="close" data-incident="${inc.id}">Close</button>
        ${actions}
      </div>
    </div>`;
  }

  async function onActionClick(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    const id = btn.dataset.incident;
    if (action === 'ack') {
      await fetch(`/api/incidents/${id}/ack`, { method: 'POST' });
      loadHealth(state.serverId);
    } else if (action === 'close') {
      await fetch(`/api/incidents/${id}/close`, { method: 'POST' });
      loadHealth(state.serverId);
    } else if (action === 'exec') {
      const cmd = decodeURIComponent(btn.dataset.cmd);
      if (!confirm(`Run on server?\n\n${cmd}`)) return;
      btn.disabled = true;
      btn.textContent = 'Running…';
      try {
        const res = await fetch(`/api/incidents/${id}/run-action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();
        alert(res.ok ? (data.output || '(no output)') : `Error: ${data.error}\n${data.output || ''}`);
      } catch (err) {
        alert('Request failed: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Done';
      }
    }
  }

  async function loadIncidentHistory() {
    const root = $('.health-history');
    if (!root) return;
    const res = await fetch(`/api/servers/${state.serverId}/incidents?range=30`);
    const items = await res.json();
    if (items.length === 0) { root.innerHTML = '<h4>History (30d)</h4><p style="color:#64748b">No history.</p>'; return; }
    root.innerHTML = '<h4>History (30d)</h4>' + items.map(i => `
      <div class="health-history-row">
        <span class="sev-${i.severity}">${escapeHtml(i.severity)}</span>
        <strong>${escapeHtml(i.title)}</strong>
        <small>${new Date(i.opened_at*1000).toLocaleString()} ${i.closed_at?'→ '+new Date(i.closed_at*1000).toLocaleString():'(open)'}</small>
      </div>
    `).join('');
  }

  async function loadVersions() {
    const root = $('.health-versions');
    if (!root) return;
    const [curRes, baseRes] = await Promise.all([
      fetch(`/api/servers/${state.serverId}/versions/current`),
      fetch(`/api/servers/${state.serverId}/baselines`)
    ]);
    const current = await curRes.json();
    const baselines = await baseRes.json();
    const active = baselines.find(b => b.active === 1) || null;

    if (!current) {
      root.innerHTML = '<h4>Versions</h4><p style="color:#64748b">No version snapshot yet.</p>';
      return;
    }

    root.innerHTML = `
      <h4>Versions <small style="color:#64748b">(${new Date(current.ts*1000).toLocaleString()})</small></h4>
      <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
        <button id="hb-save-baseline" class="btn btn-sm">${active ? 'Save new baseline' : 'Save current as baseline'}</button>
        <span style="color:#94a3b8;font-size:12px">${active ? 'Active baseline: '+(active.label||new Date(active.created_at*1000).toLocaleDateString()) : 'No active baseline'}</span>
      </div>
      <div class="versions-grid">
        <div class="version-col"><h5>System</h5>${diffTable(active && active.system_pkgs, current.system_pkgs)}</div>
        <div class="version-col"><h5>Pip (per venv)</h5>${pipDiffHtml(active && active.pip_freeze, current.pip_freeze)}</div>
        <div class="version-col"><h5>Node</h5>${diffTable(active && active.node_pkgs, current.node_pkgs)}</div>
      </div>
    `;

    const btn = document.getElementById('hb-save-baseline');
    if (btn) btn.addEventListener('click', async () => {
      if (!confirm('Save current versions as the active baseline?')) return;
      await fetch(`/api/servers/${state.serverId}/baselines`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({})
      });
      loadVersions();
      loadHealth(state.serverId);
    });
  }

  function diffTable(baseline, current) {
    if (!current || Object.keys(current).length === 0) return '<i style="color:#64748b">(empty)</i>';
    const all = new Set([...Object.keys(baseline || {}), ...Object.keys(current || {})]);
    const rows = [];
    for (const pkg of [...all].sort()) {
      const b = baseline ? baseline[pkg] : undefined;
      const c = current[pkg];
      let cls = '', mark = '';
      if (b == null && c != null) { cls = 'pkg-added'; mark = '+ '; }
      else if (b != null && c == null) { cls = 'pkg-removed'; mark = '− '; }
      else if (b !== c) { cls = 'pkg-changed'; mark = '~ '; }
      const display = c != null ? c : b;
      rows.push(`<div class="pkg-line ${cls}">${mark}${escapeHtml(pkg)}: ${escapeHtml(display)}${b !== c && b != null && c != null ? ` (was ${escapeHtml(b)})` : ''}</div>`);
    }
    return rows.join('');
  }

  function pipDiffHtml(baselinePip, currentPip) {
    const venvs = new Set([...Object.keys(baselinePip || {}), ...Object.keys(currentPip || {})]);
    if (venvs.size === 0) return '<i style="color:#64748b">(none)</i>';
    return [...venvs].map(venv =>
      `<div><strong style="font-size:11px">${escapeHtml(venv)}</strong>${diffTable(baselinePip && baselinePip[venv], currentPip && currentPip[venv])}</div>`
    ).join('');
  }

  function onSocketHealthUpdate(msg) {
    if (msg.serverId !== state.serverId) return;
    loadHealth(state.serverId);
  }

  function onSocketHealthIncident(msg) {
    if (msg.serverId !== state.serverId) return;
    loadHealth(state.serverId);
    if (state.notificationsEnabled && msg.change === 'open' && msg.incident && msg.incident.severity === 'critical') {
      try { new Notification(msg.incident.title, { body: msg.incident.kind }); } catch {}
    }
  }

  window.HealthTab = {
    init(socket) {
      state.socket = socket;
      if (socket) {
        socket.on('health:update', onSocketHealthUpdate);
        socket.on('health:incident', onSocketHealthIncident);
      }
      try {
        const stored = localStorage.getItem('hb-notif-enabled');
        state.notificationsEnabled = stored === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
      } catch {}

      const refreshBtn = document.getElementById('btn-health-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', () => loadHealth(state.serverId));
      const notifBtn = document.getElementById('btn-health-notif');
      if (notifBtn) notifBtn.addEventListener('click', () => this.enableNotifications());
    },
    show(serverId) { loadHealth(serverId); },
    enableNotifications() {
      if (typeof Notification === 'undefined') return alert('Notifications not supported');
      Notification.requestPermission().then(p => {
        state.notificationsEnabled = p === 'granted';
        try { localStorage.setItem('hb-notif-enabled', p === 'granted' ? '1' : '0'); } catch {}
        const btn = document.getElementById('btn-health-notif');
        if (btn) btn.textContent = p === 'granted' ? '🔔 Notifications ON' : '🔔 Enable notifications';
      });
    }
  };
})();
