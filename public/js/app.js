const App = (() => {
  const socket = io();
  let servers = [];
  let selectedServerId = null;
  let currentPullId = null;
  let currentPullServerId = null;
  let sshTerm = null;
  let sshFitAddon = null;
  let sshSessionActive = false;
  let currentDetailMetrics = [];
  let tempChartVisible = false;

  // --- Init ---
  function init() {
    loadServers();
    bindEvents();
    bindSocket();
  }

  // --- Data Loading ---
  function loadServers() {
    fetch('/api/servers')
      .then(r => r.json())
      .then(data => {
        servers = data;
        renderGrid();
      });
  }

  // --- Render Server Grid ---
  function renderGrid() {
    const grid = document.getElementById('server-grid');
    grid.innerHTML = '';

    for (const s of servers) {
      const card = document.createElement('div');
      card.className = `server-card ${s.status}`;
      card.dataset.id = s.id;

      const lastSeen = s.last_seen > 0
        ? new Date(s.last_seen * 1000).toLocaleString()
        : 'Never';

      card.innerHTML = `
        <div class="card-header">
          <h3>${esc(s.name)}</h3>
          <span class="status-dot ${s.status}"></span>
        </div>
        <div class="card-metrics" id="card-metrics-${s.id}">
          <div class="metric">
            <div class="metric-label">CPU</div>
            <div class="metric-value" id="card-cpu-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">Access</div>
            <div class="metric-value access-value" id="card-access-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">RAM</div>
            <div class="metric-value" id="card-ram-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">Temp</div>
            <div class="metric-value" id="card-temp-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">Disk</div>
            <div class="metric-value" id="card-disk-${s.id}">--</div>
          </div>
          <div class="metric" id="card-igpu-wrap-${s.id}" style="display:none">
            <div class="metric-label" id="card-igpu-label-${s.id}">iGPU</div>
            <div class="metric-value" id="card-igpu-${s.id}">--</div>
          </div>
          <div class="metric" id="card-dgpu-wrap-${s.id}" style="display:none">
            <div class="metric-label" id="card-dgpu-label-${s.id}">dGPU</div>
            <div class="metric-value" id="card-dgpu-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">PM2 Apps</div>
            <div class="metric-value" id="card-pm2-${s.id}">--</div>
          </div>
          <div class="metric card-net-metric" id="card-net-wrap-${s.id}">
            <div class="metric-label">Network</div>
            <div class="metric-value metric-net" id="card-net-${s.id}">--</div>
          </div>
          <div class="metric" id="card-cpupwr-wrap-${s.id}" style="display:none">
            <div class="metric-label">CPU Pwr</div>
            <div class="metric-value" id="card-cpupwr-${s.id}">--</div>
          </div>
          <div class="metric" id="card-dgpupwr-wrap-${s.id}" style="display:none">
            <div class="metric-label">GPU Pwr</div>
            <div class="metric-value" id="card-dgpupwr-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">GPU Check</div>
            <div class="metric-value gpu-check-value" id="card-gpucheck-${s.id}">--</div>
          </div>
        </div>
        <div class="card-footer">
          <span>${s.status === 'offline' ? 'Last seen: ' + lastSeen : 'Mode: ' + s.mode}</span>
          ${s.mode === 'ssh' ? '<button class="btn btn-sm btn-reconnect" data-reconnect="' + s.id + '">Reconnect</button>' : ''}
        </div>
      `;

      // Reconnect button handler
      const reconnectBtn = card.querySelector('[data-reconnect]');
      if (reconnectBtn) {
        reconnectBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleReconnect(s.id, reconnectBtn);
        });
      }

      card.addEventListener('click', () => openDetail(s.id));
      grid.appendChild(card);

      // Load latest metrics for card
      loadCardMetrics(s.id);
    }
  }

  function loadCardMetrics(serverId) {
    fetch(`/api/servers/${serverId}/metrics?range=1`)
      .then(r => r.json())
      .then(metrics => {
        if (metrics.length > 0) {
          const m = metrics[metrics.length - 1];
          updateCardMetrics(serverId, m);
        }
      });

    fetch(`/api/servers/${serverId}/pm2`)
      .then(r => r.json())
      .then(apps => {
        const el = document.getElementById(`card-pm2-${serverId}`);
        if (el) el.textContent = apps.length;
      });
  }

  async function handleReconnect(serverId, btn) {
    const originalText = btn.textContent;
    btn.textContent = 'Connecting...';
    btn.disabled = true;
    btn.classList.add('reconnecting');

    try {
      const resp = await fetch(`/api/servers/${serverId}/reconnect`, { method: 'POST' });
      const data = await resp.json();

      if (data.success) {
        btn.textContent = 'Connected';
        btn.classList.remove('reconnecting');
        btn.classList.add('reconnect-success');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
          btn.classList.remove('reconnect-success');
        }, 2000);
      } else {
        btn.textContent = data.error || 'Failed';
        btn.classList.remove('reconnecting');
        btn.classList.add('reconnect-failed');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
          btn.classList.remove('reconnect-failed');
        }, 3000);
      }
    } catch {
      btn.textContent = 'Error';
      btn.classList.remove('reconnecting');
      btn.classList.add('reconnect-failed');
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
        btn.classList.remove('reconnect-failed');
      }, 3000);
    }
  }

  function updateCardMetrics(serverId, m) {
    const cpuEl = document.getElementById(`card-cpu-${serverId}`);
    const accessEl = document.getElementById(`card-access-${serverId}`);
    const ramEl = document.getElementById(`card-ram-${serverId}`);
    const tempEl = document.getElementById(`card-temp-${serverId}`);
    const diskEl = document.getElementById(`card-disk-${serverId}`);
    const igpuEl = document.getElementById(`card-igpu-${serverId}`);
    const dgpuEl = document.getElementById(`card-dgpu-${serverId}`);
    const gpuCheckEl = document.getElementById(`card-gpucheck-${serverId}`);
    if (cpuEl) cpuEl.textContent = m.cpu_percent != null ? m.cpu_percent.toFixed(1) + '%' : '--';
    if (accessEl) {
      accessEl.textContent = formatAccessValue(m);
      accessEl.classList.toggle('access-active', (m.access_active_devices || 0) > 0);
      accessEl.classList.toggle('access-full', m.access_capacity != null && m.access_active_devices >= m.access_capacity);
      accessEl.title = formatAccessTitle(m);
    }
    if (ramEl) ramEl.textContent = m.ram_used != null ? (m.ram_used / 1073741824).toFixed(1) + '/' + (m.ram_total / 1073741824).toFixed(1) + ' GB' : '--';
    if (tempEl) {
      const temp = m.cpu_temp;
      tempEl.textContent = temp != null ? temp + '°C' : 'N/A';
      tempEl.style.color = temp >= 80 ? '#ff1744' : temp >= 60 ? '#ff9100' : '#00e676';
    }
    if (diskEl) {
      if (m.disk_total != null && m.disk_used != null && m.disk_total > 0) {
        const usedGB = (m.disk_used / 1073741824).toFixed(0);
        const totalGB = (m.disk_total / 1073741824).toFixed(0);
        const pct = (m.disk_used / m.disk_total) * 100;
        diskEl.textContent = `${usedGB}/${totalGB} GB (${pct.toFixed(0)}%)`;
        diskEl.style.color = pct >= 90 ? '#ff1744' : pct >= 75 ? '#ff9100' : '#00e676';
      } else {
        diskEl.textContent = '--';
        diskEl.style.color = '';
      }
    }
    // iGPU
    if (igpuEl) {
      if (m.igpu_percent != null) {
        igpuEl.textContent = m.igpu_percent.toFixed(1) + '%';
        const wrap = document.getElementById(`card-igpu-wrap-${serverId}`);
        if (wrap) wrap.style.display = '';
      } else {
        igpuEl.textContent = 'N/A';
      }
    }
    // dGPU
    if (dgpuEl) {
      if (m.dgpu_percent != null) {
        dgpuEl.textContent = m.dgpu_percent.toFixed(1) + '%';
        const wrap = document.getElementById(`card-dgpu-wrap-${serverId}`);
        if (wrap) wrap.style.display = '';
      }
    }
    if (gpuCheckEl) {
      if (m.gpu_check_available != null) {
        const available = m.gpu_check_available === true || m.gpu_check_available === 1;
        gpuCheckEl.textContent = available ? 'OK' : 'LOST';
        gpuCheckEl.title = formatGpuCheckTitle(m);
        gpuCheckEl.classList.toggle('gpu-check-ok', available);
        gpuCheckEl.classList.toggle('gpu-check-lost', !available);
      } else {
        gpuCheckEl.textContent = '--';
        gpuCheckEl.title = '';
        gpuCheckEl.classList.remove('gpu-check-ok', 'gpu-check-lost');
      }
    }
    // Network
    const netEl = document.getElementById(`card-net-${serverId}`);
    if (netEl) {
      if (m.net_rx_bytes != null && m.net_tx_bytes != null) {
        netEl.innerHTML = `<span class="net-rx">↓ ${formatNetSpeed(m.net_rx_bytes)}</span> <span class="net-tx">↑ ${formatNetSpeed(m.net_tx_bytes)}</span>`;
      } else {
        netEl.textContent = '--';
      }
    }
    // CPU Power (RAPL)
    const cpuPwrEl = document.getElementById(`card-cpupwr-${serverId}`);
    const cpuPwrWrap = document.getElementById(`card-cpupwr-wrap-${serverId}`);
    if (cpuPwrEl) {
      if (m.cpu_watts != null) {
        cpuPwrEl.textContent = m.cpu_watts.toFixed(1) + ' W';
        cpuPwrEl.style.color = m.cpu_watts >= 95 ? '#ff1744' : m.cpu_watts >= 65 ? '#ff9100' : '#e0e0e0';
        if (cpuPwrWrap) cpuPwrWrap.style.display = '';
      }
    }
    // GPU Power (NVIDIA)
    const dgpuPwrEl = document.getElementById(`card-dgpupwr-${serverId}`);
    const dgpuPwrWrap = document.getElementById(`card-dgpupwr-wrap-${serverId}`);
    if (dgpuPwrEl) {
      if (m.dgpu_watts != null) {
        dgpuPwrEl.textContent = m.dgpu_watts.toFixed(1) + ' W';
        dgpuPwrEl.style.color = m.dgpu_watts >= 200 ? '#ff1744' : m.dgpu_watts >= 120 ? '#ff9100' : '#e0e0e0';
        if (dgpuPwrWrap) dgpuPwrWrap.style.display = '';
      }
    }
    // Update GPU labels with short names from gpu_names
    const gpuNames = m.gpu_names || getServerGpuNames(serverId);
    if (gpuNames) {
      if (gpuNames.igpu) {
        const label = document.getElementById(`card-igpu-label-${serverId}`);
        if (label) label.textContent = shortenGpuName(gpuNames.igpu, 'iGPU');
        const wrap = document.getElementById(`card-igpu-wrap-${serverId}`);
        if (wrap) wrap.style.display = '';
      }
      if (gpuNames.dgpu) {
        const label = document.getElementById(`card-dgpu-label-${serverId}`);
        if (label) label.textContent = shortenGpuName(gpuNames.dgpu, 'dGPU');
        const wrap = document.getElementById(`card-dgpu-wrap-${serverId}`);
        if (wrap) wrap.style.display = '';
      }
    }
  }

  function formatAccessValue(m) {
    if (!m || m.access_active_devices == null || m.access_capacity == null) return '--';
    return `${m.access_active_devices}/${m.access_capacity}`;
  }

  function formatAccessTitle(m) {
    if (!m || m.access_active_devices == null) return '';
    const parts = [`${m.access_model_label || 'Access'}: ${m.access_active_devices}/${m.access_capacity} devices`];
    if (m.access_active_cores != null) parts.push(`Active cores: ${m.access_active_cores}`);
    return parts.join('\n');
  }

  function getServerAccessModel(server) {
    if (!server) return 'gt1030';
    if (server.access_model_effective) return server.access_model_effective;
    if (server.access_model === 'gtx1660s') return 'gtx1660s';
    const gpuNames = getServerGpuNames(server.id);
    const name = [server.name, gpuNames && gpuNames.igpu, gpuNames && gpuNames.dgpu].filter(Boolean).join(' ').toLowerCase();
    if (/\b1660\s*(s|super)?\b/.test(name) || /\b5\s*cam\b/.test(name)) return 'gtx1660s';
    return server.access_model || 'gt1030';
  }

  function getServerAccessLabel(server) {
    return getServerAccessModel(server) === 'gtx1660s' ? 'GTX 1660S' : 'GT 1030';
  }

  // Get gpu_names from cached server data
  function getServerGpuNames(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (server && server.gpu_names) {
      try { return typeof server.gpu_names === 'string' ? JSON.parse(server.gpu_names) : server.gpu_names; } catch { return null; }
    }
    return null;
  }

  // Shorten GPU name for card display (e.g. "Intel Corporation UHD Graphics 630" -> "UHD 630")
  function shortenGpuName(name, fallback) {
    if (!name) return fallback;
    // NVIDIA: "NVIDIA GeForce RTX 3060" -> "RTX 3060"
    let m = name.match(/RTX\s*\d+\s*\w*/i) || name.match(/GTX\s*\d+\s*\w*/i) || name.match(/Tesla\s*\w+/i) || name.match(/A\d{3,4}/i);
    if (m) return m[0];
    // Intel: "Intel Corporation UHD Graphics 630" -> "UHD 630"
    m = name.match(/(UHD|Iris|HD)\s*(Graphics\s*)?(\w*)/i);
    if (m) return (m[1] + ' ' + (m[3] || '')).trim();
    // AMD: try to extract model
    m = name.match(/Radeon\s*(RX\s*)?\w+/i);
    if (m) return m[0];
    // Fallback: last meaningful part
    return name.length > 15 ? name.substring(name.length - 15) : name;
  }

  // Format network speed from bytes/sec to human-readable
  function formatNetSpeed(bytesPerSec) {
    if (bytesPerSec == null) return '--';
    if (bytesPerSec >= 1073741824) return (bytesPerSec / 1073741824).toFixed(1) + ' GB/s';
    if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
    if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
    return bytesPerSec + ' B/s';
  }

  // --- Server Detail ---
  function openDetail(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;

    const detailPanel = document.getElementById('server-detail');
    const isAlreadyOpen = !detailPanel.classList.contains('hidden');

    // If switching between servers
    if (isAlreadyOpen && selectedServerId !== serverId) {
      // Remove any existing animation classes
      detailPanel.classList.remove('opening', 'switching');
      
      // Force reflow to restart animation
      void detailPanel.offsetWidth;
      
      // Add switching animation
      detailPanel.classList.add('switching');
      
      // Update content at midpoint of animation
      setTimeout(() => {
        updateDetailContent(server, serverId);
      }, 200);
      
      // Remove animation class after it completes
      setTimeout(() => {
        detailPanel.classList.remove('switching');
      }, 400);
    } else if (!isAlreadyOpen) {
      // First time opening
      detailPanel.classList.remove('hidden');
      detailPanel.classList.add('opening');
      updateDetailContent(server, serverId);
      
      // Remove opening class after animation
      setTimeout(() => {
        detailPanel.classList.remove('opening');
      }, 350);
    } else {
      // Same server, just update
      updateDetailContent(server, serverId);
    }

    selectedServerId = serverId;
  }

  function formatGpuCheckTitle(m) {
    const parts = [];
    if (m.gpu_check_message) parts.push(m.gpu_check_message);
    if (m.gpu_check_ts) parts.push('Checked: ' + new Date(m.gpu_check_ts * 1000).toLocaleString());
    return parts.join('\n');
  }

  function updateDetailContent(server, serverId) {
    document.getElementById('detail-server-name').textContent = server.name;

    const badge = document.getElementById('detail-server-status');
    badge.textContent = server.status;
    badge.className = `status-badge ${server.status}`;

    const accessBadge = document.getElementById('detail-access-status');
    if (accessBadge) {
      accessBadge.textContent = `${getServerAccessLabel(server)} access: --`;
      accessBadge.className = 'access-badge';
    }

    // Show/hide SSH button for SSH-mode servers
    const sshBtn = document.getElementById('btn-ssh');
    if (server.mode === 'ssh') {
      sshBtn.classList.remove('hidden');
      sshBtn.disabled = server.status === 'offline';
    } else {
      sshBtn.classList.add('hidden');
    }

    // Show/hide Pull Code button based on git_repo_path
    const pullBtn = document.getElementById('btn-pull-code');
    if (server.git_repo_path && server.git_repo_path.trim() !== '') {
      pullBtn.classList.remove('hidden');
      pullBtn.disabled = server.status === 'offline';
    } else {
      pullBtn.classList.add('hidden');
    }

    // Load charts
    Charts.createChart('chart-cpu', 'CPU %', '#00e676', '%');
    Charts.createChart('chart-temp', 'Temperature', '#ff9100', '\u00b0C');
    Charts.createChart('chart-ram', 'RAM', '#448aff', 'GB');
    tempChartVisible = false;
    currentDetailMetrics = [];

    // Build dynamic GPU chart containers based on detected GPUs
    buildGpuCharts(server);

    // Initialize time filter UI
    bindTimeFilterEvents();

    // Restore previous time range selection if available
    const currentRange = Charts.getCurrentTimeRange();
    updateActiveFilter(currentRange);

    // Clear cores section
    document.getElementById('cpu-cores-grid').innerHTML = '';
    document.getElementById('cpu-overall').textContent = '';
    document.getElementById('cpu-temp').textContent = '';

    fetch(`/api/servers/${serverId}/metrics?range=48`)
      .then(r => r.json())
      .then(metrics => {
        currentDetailMetrics = Array.isArray(metrics) ? metrics : [];
        Charts.updateChart('chart-cpu', metrics, 'cpu_percent');
        Charts.updateChart('chart-temp', metrics, 'cpu_temp');
        Charts.updateChart('chart-ram', metrics, 'ram_used');

        // Update GPU charts if they exist
        if (Charts.hasChart('chart-igpu')) {
          Charts.updateChart('chart-igpu', metrics, 'igpu_percent');
        }
        if (Charts.hasChart('chart-dgpu')) {
          updateDgpuChart(metrics);
        }

        // Auto-detect GPUs from historical data if gpu_names not yet available
        if (!server.gpu_names) {
          autoDetectGpuChartsFromMetrics(metrics, server);
        }

        // Show latest per-core data
        if (metrics.length > 0) {
          const latest = metrics[metrics.length - 1];
          let cores = latest.cpu_cores;
          if (typeof cores === 'string') cores = JSON.parse(cores);
          if (cores && cores.length > 0) renderCores(cores);
          updateCpuHeader(latest.cpu_percent, latest.cpu_temp);
          updateAccessBadge(latest);
        }
      });

    // Load PM2 apps
    loadPm2Apps(serverId);

    // Close log modal if open
    if (App.LogModal.getState().isOpen) {
      App.LogModal.close();
    }
  }

  function buildGpuCharts(server) {
    const container = document.getElementById('gpu-charts-container');
    if (!container) return;
    container.innerHTML = '';

    const gpuNames = getServerGpuNames(server.id);
    const hasIgpu = gpuNames && gpuNames.igpu;
    const hasDgpu = gpuNames && gpuNames.dgpu;

    const igpuBox = createGpuChartBox('chart-igpu', 'iGPU', gpuNames && gpuNames.igpu ? gpuNames.igpu : '', '#ff9100');
    const dgpuBox = createGpuChartBox('chart-dgpu', 'dGPU', gpuNames && gpuNames.dgpu ? gpuNames.dgpu : '', '#e040fb');
    container.appendChild(igpuBox);
    container.appendChild(dgpuBox);

    Charts.createChart('chart-igpu', 'iGPU %', '#ff9100', '%');
    Charts.createMultiChart('chart-dgpu', [
      { label: 'GPU0 %', color: '#e040fb' },
      { label: 'GPU0 mem%', color: '#00e5ff' }
    ], '%');

    igpuBox.style.display = 'none';
    dgpuBox.style.display = 'none';

    if (hasDgpu) {
      dgpuBox.style.display = '';
    } else if (hasIgpu) {
      igpuBox.style.display = '';
    }
  }

  function createGpuChartBox(canvasId, type, fullName, color) {
    const box = document.createElement('div');
    box.className = 'chart-box';
    box.id = canvasId + '-box';
    const title = fullName ? `${type} % — ${fullName}` : `${type} %`;
    const displayTitle = type === 'dGPU'
      ? (fullName ? `GPU0 % + GPU0 mem% - ${fullName}` : 'GPU0 % + GPU0 mem%')
      : title;
    box.innerHTML = `<h3 style="color:${color}">${esc(displayTitle)}</h3><canvas id="${canvasId}"></canvas>`;
    return box;
  }

  function getDgpuMemPercent(m) {
    if (!m || m.dgpu_mem_used == null || m.dgpu_mem_total == null || m.dgpu_mem_total <= 0) {
      return null;
    }
    return (m.dgpu_mem_used / m.dgpu_mem_total) * 100;
  }

  function updateDgpuChart(metrics) {
    Charts.updateMultiChart('chart-dgpu', metrics, [
      { key: 'dgpu_percent' },
      { value: getDgpuMemPercent }
    ]);
  }

  // Auto-detect GPU types from metric data when gpu_names is not yet available
  function autoDetectGpuChartsFromMetrics(metrics, server) {
    if (!metrics || metrics.length === 0) return;

    const hasIgpuData = metrics.some(m => m.igpu_percent != null);
    const hasDgpuData = metrics.some(m => m.dgpu_percent != null || getDgpuMemPercent(m) != null);

    const igpuBox = document.getElementById('chart-igpu-box');
    const dgpuBox = document.getElementById('chart-dgpu-box');

    if (hasDgpuData) {
      if (dgpuBox) dgpuBox.style.display = '';
      if (igpuBox) igpuBox.style.display = 'none';
    } else if (hasIgpuData) {
      if (igpuBox) igpuBox.style.display = '';
      if (dgpuBox) dgpuBox.style.display = 'none';
    } else {
      if (igpuBox) igpuBox.style.display = 'none';
      if (dgpuBox) dgpuBox.style.display = 'none';
    }
  }

  function updateActiveFilter(range) {
    const buttons = document.querySelectorAll('.time-filter-btn');
    buttons.forEach(btn => {
      if (btn.dataset.range === range) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function bindTimeFilterEvents() {
    const buttons = document.querySelectorAll('.time-filter-btn');
    buttons.forEach(btn => {
      // Remove existing listeners by cloning
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);
      
      // Add new listener
      newBtn.addEventListener('click', () => {
        const range = newBtn.dataset.range;
        Charts.setTimeRange(range);
        updateActiveFilter(range);
      });
    });
  }

  function showTempChart() {
    const modal = document.getElementById('modal-temp-chart');
    if (!modal) return;
    tempChartVisible = true;
    modal.classList.remove('hidden');
    const tempEl = document.getElementById('cpu-temp');
    tempEl?.classList.add('active');
    if (tempEl) tempEl.title = 'Hide temperature chart';
    if (!Charts.hasChart('chart-temp')) {
      Charts.createChart('chart-temp', 'Temperature', '#ff9100', '\u00b0C');
    }
    Charts.updateChart('chart-temp', currentDetailMetrics, 'cpu_temp');
  }

  function hideTempChart() {
    const modal = document.getElementById('modal-temp-chart');
    tempChartVisible = false;
    if (modal) modal.classList.add('hidden');
    const tempEl = document.getElementById('cpu-temp');
    tempEl?.classList.remove('active');
    if (tempEl) tempEl.title = 'Show temperature chart';
  }

  function toggleTempChart() {
    if (tempChartVisible) {
      hideTempChart();
    } else {
      showTempChart();
    }
  }

  function closeDetail() {
    selectedServerId = null;
    const detailPanel = document.getElementById('server-detail');
    
    // Add slide out animation
    detailPanel.style.animation = 'slideOutDown 0.3s cubic-bezier(0.7, 0, 0.84, 0) forwards';
    
    setTimeout(() => {
      detailPanel.classList.add('hidden');
      detailPanel.style.animation = '';
      Charts.destroyAll();
      if (App.LogModal.getState().isOpen) {
        App.LogModal.close();
      }
    }, 300);
  }

  function loadPm2Apps(serverId) {
    fetch(`/api/servers/${serverId}/pm2`)
      .then(r => r.json())
      .then(apps => renderPm2Table(serverId, apps));
  }

  function renderPm2Table(serverId, apps) {
    const tbody = document.getElementById('pm2-tbody');
    tbody.innerHTML = '';

    for (const app of apps) {
      const tr = document.createElement('tr');
      const uptime = formatUptime(app.uptime);
      const mem = (app.memory / 1048576).toFixed(1) + ' MB';

      tr.innerHTML = `
        <td>${app.pm_id}</td>
        <td>${esc(app.name)}</td>
        <td><span class="pm2-status ${app.status}">${app.status}</span></td>
        <td>${app.cpu.toFixed(1)}%</td>
        <td>${mem}</td>
        <td>${uptime}</td>
        <td>${app.restarts}</td>
        <td class="pm2-actions">
          <button class="btn btn-sm btn-restart" data-app="${esc(app.name)}">Restart</button>
          <button class="btn btn-sm btn-stop" data-app="${esc(app.name)}">Stop</button>
          <button class="btn btn-sm btn-delete" data-app="${esc(app.name)}">Delete</button>
          <button class="btn btn-sm btn-logs" data-app="${esc(app.name)}">Logs</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    // Bind action buttons
    bindPM2ActionButtons(serverId, tbody);
  }

  // --- PM2 Action Handlers ---
  function bindPM2ActionButtons(serverId, tbody) {
    // Restart buttons
    tbody.querySelectorAll('.btn-restart').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlePM2Restart(serverId, btn.dataset.app, btn);
      });
    });

    // Stop buttons
    tbody.querySelectorAll('.btn-stop').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlePM2Stop(serverId, btn.dataset.app, btn);
      });
    });

    // Delete buttons
    tbody.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlePM2Delete(serverId, btn.dataset.app, btn);
      });
    });

    // Logs buttons
    tbody.querySelectorAll('.btn-logs').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        App.LogModal.open(serverId, btn.dataset.app);
      });
    });
  }

  async function handlePM2Restart(serverId, appName, button) {
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Restarting...';

    try {
      const response = await fetch(`/api/servers/${serverId}/pm2/${appName}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Restart failed');
      }

      // Success - UI will update via Socket.IO event
    } catch (error) {
      alert('Error: ' + error.message);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function handlePM2Stop(serverId, appName, button) {
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Stopping...';

    try {
      const response = await fetch(`/api/servers/${serverId}/pm2/${appName}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Stop failed');
      }

      // Success - UI will update via Socket.IO event
    } catch (error) {
      alert('Error: ' + error.message);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function handlePM2Delete(serverId, appName, button) {
    if (!confirm(`Delete PM2 process "${appName}"? This cannot be undone.`)) {
      return;
    }

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Deleting...';

    try {
      const response = await fetch(`/api/servers/${serverId}/pm2/${appName}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Delete failed');
      }

      // Success - UI will update via Socket.IO event
    } catch (error) {
      alert('Error: ' + error.message);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  // --- Modal ---
  function openAddModal() {
    document.getElementById('modal-title').textContent = 'Add Server';
    document.getElementById('form-server-id').value = '';
    document.getElementById('form-name').value = '';
    document.getElementById('form-ip').value = '';
    document.getElementById('form-mode').value = 'agent';
    document.getElementById('form-access-model').value = 'gt1030';
    document.getElementById('form-ssh-user').value = '';
    document.getElementById('form-ssh-key').value = '';
    document.getElementById('form-ssh-password').value = '';
    document.getElementById('form-git-repo').value = '';
    document.getElementById('ssh-fields').classList.add('hidden');
    document.getElementById('modal-add-server').classList.remove('hidden');
  }

  function openEditModal(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;

    document.getElementById('modal-title').textContent = 'Edit Server';
    document.getElementById('form-server-id').value = server.id;
    document.getElementById('form-name').value = server.name;
    document.getElementById('form-ip').value = server.ip;
    document.getElementById('form-mode').value = server.mode;
    document.getElementById('form-access-model').value = getServerAccessModel(server);
    document.getElementById('form-ssh-user').value = server.ssh_user || '';
    document.getElementById('form-ssh-key').value = server.ssh_key_path || '';
    document.getElementById('form-ssh-password').value = '';
    document.getElementById('form-git-repo').value = server.git_repo_path || '';
    document.getElementById('ssh-fields').classList.toggle('hidden', server.mode !== 'ssh');
    document.getElementById('modal-add-server').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modal-add-server').classList.add('hidden');
    const saveBtn = document.querySelector('#form-server .btn-primary');
    const statusEl = document.getElementById('form-connection-status');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('form-server-id').value;
    const gitRepoPath = document.getElementById('form-git-repo').value.trim();
    
    // Validate git_repo_path if provided
    if (gitRepoPath && !gitRepoPath.startsWith('/')) {
      alert('Git repository path must be absolute (start with /)');
      return;
    }
    
    const body = {
      name: document.getElementById('form-name').value,
      ip: document.getElementById('form-ip').value,
      mode: document.getElementById('form-mode').value,
      access_model: document.getElementById('form-access-model').value,
      ssh_user: document.getElementById('form-ssh-user').value || null,
      ssh_key_path: document.getElementById('form-ssh-key').value || null,
      ssh_password: document.getElementById('form-ssh-password').value || null,
      git_repo_path: gitRepoPath || null,
    };

    const url = id ? `/api/servers/${id}` : '/api/servers';
    const method = id ? 'PUT' : 'POST';

    const saveBtn = document.querySelector('#form-server .btn-primary');
    const statusEl = document.getElementById('form-connection-status');

    fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error); });
        return r.status === 204 ? null : r.json();
      })
      .then(savedServer => {
        // Non-SSH path: close immediately (preserve existing behavior)
        if (body.mode !== 'ssh') {
          closeModal();
          loadServers();
          return;
        }

        // SSH path: test connection before closing
        const serverId = savedServer ? savedServer.id : id;
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Testing connection...'; }
        if (statusEl) { statusEl.textContent = 'Connecting to server...'; statusEl.className = 'connection-testing'; }

        return fetch(`/api/servers/${serverId}/test-connection`, { method: 'POST' })
          .then(r => r.json())
          .then(result => {
            if (result.success) {
              closeModal();
              loadServers();
            } else {
              // Keep form open, show specific error
              if (statusEl) { statusEl.textContent = result.error || 'Connection failed'; statusEl.className = 'connection-error'; }
              if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
            }
          });
      })
      .catch(err => {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
        alert('Error: ' + err.message);
      });
  }

  function handleDelete() {
    if (!selectedServerId) return;
    if (!confirm('Delete this server?')) return;

    fetch(`/api/servers/${selectedServerId}`, { method: 'DELETE' })
      .then(r => {
        if (!r.ok) throw new Error('Failed to delete');
        closeDetail();
        loadServers();
      })
      .catch(err => alert('Error: ' + err.message));
  }

  // --- Socket.IO ---
  function bindSocket() {
    socket.on('server:update', (data) => {
      const { serverId, metrics, pm2 } = data;
      const server = servers.find(s => s.id === serverId);
      if (server && metrics.access_model) {
        server.access_model_effective = metrics.access_model;
        server.access_model_label = metrics.access_model_label;
        server.access_capacity = metrics.access_capacity;
      }

      // Update card
      updateCardMetrics(serverId, metrics);
      const pm2El = document.getElementById(`card-pm2-${serverId}`);
      // Only update PM2 count when we have actual data (not null/undefined)
      // null means cache is empty - don't overwrite a valid count with 0
      if (pm2El && pm2 != null) pm2El.textContent = pm2.length;

      // If gpu_names arrived, cache them on the server object and rebuild charts if needed
      if (metrics.gpu_names) {
        if (server) {
          const prev = server.gpu_names;
          server.gpu_names = typeof metrics.gpu_names === 'string' ? metrics.gpu_names : JSON.stringify(metrics.gpu_names);
          server.access_model_effective = metrics.access_model || getServerAccessModel(server);
          // Rebuild GPU charts if this is the first time we got GPU names for the open detail
          if (!prev && serverId === selectedServerId) {
            buildGpuCharts(server);
            // Re-fetch metrics to populate newly created charts
            fetch(`/api/servers/${serverId}/metrics?range=48`)
              .then(r => r.json())
              .then(hist => {
                if (Charts.hasChart('chart-igpu')) Charts.updateChart('chart-igpu', hist, 'igpu_percent');
                if (Charts.hasChart('chart-dgpu')) updateDgpuChart(hist);
              });
          }
        }
      }

      // Update detail if open
      if (serverId === selectedServerId) {
        const ts = Math.floor(Date.now() / 1000);
        Charts.appendPoint('chart-cpu', ts, metrics.cpu_percent);
        Charts.appendPoint('chart-temp', ts, metrics.cpu_temp);
        Charts.appendPoint('chart-ram', ts, metrics.ram_used);
        if (metrics.cpu_temp != null) {
          currentDetailMetrics.push({ timestamp: ts, cpu_temp: metrics.cpu_temp });
          if (currentDetailMetrics.length > 17280) currentDetailMetrics.shift();
        }
        if (metrics.igpu_percent != null) {
          Charts.appendPoint('chart-igpu', ts, metrics.igpu_percent);
        }
        if (metrics.dgpu_percent != null || getDgpuMemPercent(metrics) != null) {
          Charts.appendMultiPoint('chart-dgpu', ts, [metrics.dgpu_percent, getDgpuMemPercent(metrics)]);
        }
        // Update per-core bars
        if (metrics.cpu_cores && metrics.cpu_cores.length > 0) {
          renderCores(metrics.cpu_cores);
        }
        updateCpuHeader(metrics.cpu_percent, metrics.cpu_temp);
        updateAccessBadge(metrics);
        if (pm2 != null) renderPm2Table(serverId, pm2);
      }
    });

    socket.on('server:status', (data) => {
      const { serverId, status } = data;
      const server = servers.find(s => s.id === serverId);
      if (!server) return;

      const prevStatus = server.status;
      server.status = status;

      // Update card classes + dot in-place; only do a full re-render if status actually changed
      const card = document.querySelector(`.server-card[data-id="${serverId}"]`);
      if (card) {
        card.classList.remove('online', 'offline');
        card.classList.add(status);
        const dot = card.querySelector('.status-dot');
        if (dot) {
          dot.classList.remove('online', 'offline');
          dot.classList.add(status);
        }
      }

      // Only re-render whole grid if status changed (footer text differs online vs offline)
      if (prevStatus !== status) {
        renderGrid();
      }

      if (serverId === selectedServerId) {
        const badge = document.getElementById('detail-server-status');
        badge.textContent = status;
        badge.className = `status-badge ${status}`;
      }
    });

    socket.on('server:log', (data) => {
      App.LogModal.handleNewLog(data.serverId, data.appName, data.logType, data.message);
    });

    // Git pull events
    socket.on('git:pull:log', (data) => {
      handlePullLog(data);
    });

    socket.on('git:pull:complete', (data) => {
      handlePullComplete(data);
    });

    socket.on('git:pull:status', (data) => {
      updatePullStatus(data.serverId, data.status);
    });

    // SSH terminal events
    socket.on('ssh:data', (data) => {
      if (sshTerm && sshSessionActive) {
        sshTerm.write(data.data);
      }
    });

    socket.on('ssh:error', (data) => {
      if (sshTerm) {
        sshTerm.writeln('\r\n\x1b[31m' + data.error + '\x1b[0m');
      }
      sshSessionActive = false;
    });

    socket.on('ssh:close', () => {
      if (sshTerm && sshSessionActive) {
        sshTerm.writeln('\r\n\x1b[33mConnection closed.\x1b[0m');
      }
      sshSessionActive = false;
    });

    // PM2 update events
    socket.on('pm2:update', (data) => {
      const { serverId, pm2Apps } = data;
      
      // Update PM2 table if detail panel is open for this server
      if (serverId === selectedServerId) {
        renderPm2Table(serverId, pm2Apps);
      }
      
      // Update PM2 count on server card
      const pm2El = document.getElementById(`card-pm2-${serverId}`);
      if (pm2El) pm2El.textContent = pm2Apps.length;
    });
  }

  // --- Event Bindings ---
  function bindEvents() {
    document.getElementById('btn-add-server').addEventListener('click', openAddModal);
    document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
    document.getElementById('form-server').addEventListener('submit', handleFormSubmit);
    document.getElementById('btn-close-detail').addEventListener('click', closeDetail);
    document.getElementById('btn-edit-server').addEventListener('click', () => openEditModal(selectedServerId));
    document.getElementById('btn-delete-server').addEventListener('click', handleDelete);
    document.getElementById('btn-close-pm2-logs').addEventListener('click', () => App.LogModal.close());
    document.getElementById('btn-fullscreen-pm2-logs').addEventListener('click', () => {
      const content = document.querySelector('#modal-pm2-logs .modal-content');
      const btn = document.getElementById('btn-fullscreen-pm2-logs');
      const isFs = content.classList.toggle('modal-fullscreen');
      btn.textContent = isFs ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
      const logContent = document.getElementById('log-modal-content');
      logContent.scrollTop = logContent.scrollHeight;
    });
    document.getElementById('btn-ssh').addEventListener('click', handleOpenSSH);
    document.getElementById('btn-close-ssh').addEventListener('click', handleCloseSSH);
    document.getElementById('btn-pull-code').addEventListener('click', handlePullCode);
    document.getElementById('btn-pull-all').addEventListener('click', handlePullAll);
    document.getElementById('btn-close-pull-logs').addEventListener('click', closePullLogs);
    document.getElementById('cpu-temp')?.removeAttribute('title');
    document.getElementById('btn-close-temp-chart')?.addEventListener('click', hideTempChart);

    document.getElementById('form-mode').addEventListener('change', (e) => {
      document.getElementById('ssh-fields').classList.toggle('hidden', e.target.value !== 'ssh');
    });

    // Close modal on backdrop click
    document.getElementById('modal-add-server').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) closeModal();
    });
    
    document.getElementById('modal-pull-logs').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) closePullLogs();
    });

    document.getElementById('modal-ssh').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) handleCloseSSH();
    });

    document.getElementById('modal-pm2-logs').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) App.LogModal.close();
    });

    document.getElementById('modal-temp-chart')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) hideTempChart();
    });

    // ESC key to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (tempChartVisible) {
          hideTempChart();
          return;
        }
        if (App.LogModal.getState().isOpen) {
          App.LogModal.close();
        }
      }
    });
  }

  // --- Git Pull Operations ---
  function handlePullCode() {
    if (!selectedServerId) return;

    const btn = document.getElementById('btn-pull-code');
    btn.disabled = true;

    // Open log modal immediately so we don't miss streamed events
    currentPullServerId = selectedServerId;
    currentPullId = null;
    openPullLogs(selectedServerId);

    fetch(`/api/servers/${selectedServerId}/pull`, { method: 'POST' })
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error); });
        return r.json();
      })
      .then(data => {
        currentPullId = data.pullId;
      })
      .catch(err => {
        // Show error in pull log modal instead of alert
        const logContent = document.getElementById('pull-log-content');
        if (logContent) {
          const errLine = document.createElement('div');
          errLine.style.color = '#ff5252';
          errLine.style.fontWeight = 'bold';
          errLine.textContent = 'Error: ' + err.message;
          logContent.appendChild(errLine);
        }
        btn.disabled = false;
      });
  }

  function handlePullAll() {
    const btn = document.getElementById('btn-pull-all');
    btn.disabled = true;
    btn.textContent = 'Pulling...';
    
    fetch('/api/pull-all', { method: 'POST' })
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error); });
        return r.json();
      })
      .then(data => {
        const { operations } = data;
        const success = operations.filter(op => op.status === 'started').length;
        const failed = operations.filter(op => op.status === 'error').length;
        alert(`Pull initiated on ${success} servers. ${failed > 0 ? failed + ' failed.' : ''}`);
      })
      .catch(err => {
        alert('Error: ' + err.message);
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = 'Pull All Servers';
      });
  }

  function openPullLogs(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;
    
    document.getElementById('pull-log-server-name').textContent = server.name;
    document.getElementById('pull-log-content').innerHTML = '';
    document.getElementById('pull-log-status').classList.add('hidden');
    document.getElementById('pull-conflict-warning').classList.add('hidden');
    document.getElementById('modal-pull-logs').classList.remove('hidden');
  }

  function closePullLogs() {
    document.getElementById('modal-pull-logs').classList.add('hidden');
    currentPullId = null;
    currentPullServerId = null;

    // Re-enable pull button
    const btn = document.getElementById('btn-pull-code');
    btn.disabled = false;
  }

  function handlePullLog(data) {
    // Match by serverId when pullId not yet known (race condition fix)
    if (currentPullId && data.pullId !== currentPullId) return;
    if (!currentPullId && data.serverId !== currentPullServerId) return;
    
    const logContent = document.getElementById('pull-log-content');
    const line = document.createElement('div');
    line.className = `log-line log-${data.logType}`;
    line.textContent = data.message;
    
    // Highlight conflict markers
    if (data.message.includes('CONFLICT') || data.message.includes('Automatic merge failed')) {
      line.classList.add('log-conflict');
    }
    
    logContent.appendChild(line);
    logContent.scrollTop = logContent.scrollHeight;
  }

  function handlePullComplete(data) {
    if (currentPullId && data.pullId !== currentPullId) return;
    if (!currentPullId && data.serverId !== currentPullServerId) return;
    
    const statusEl = document.getElementById('pull-log-status');
    statusEl.classList.remove('hidden');
    
    if (data.status === 'success') {
      statusEl.textContent = '✓ Pull completed successfully';
      statusEl.className = 'pull-status pull-success';
    } else if (data.status === 'conflict') {
      statusEl.textContent = '⚠ Pull completed with conflicts';
      statusEl.className = 'pull-status pull-conflict';
      document.getElementById('pull-conflict-warning').classList.remove('hidden');
    } else if (data.status === 'timeout') {
      statusEl.textContent = '⏱ Pull operation timed out';
      statusEl.className = 'pull-status pull-failed';
    } else {
      statusEl.textContent = '✗ Pull failed';
      statusEl.className = 'pull-status pull-failed';
    }
    
    // Re-enable pull button
    setTimeout(() => {
      const btn = document.getElementById('btn-pull-code');
      btn.disabled = false;
    }, 1000);
  }

  function updatePullStatus(serverId, status) {
    const card = document.querySelector(`.server-card[data-id="${serverId}"]`);
    if (!card) return;
    
    // Remove existing pull status badges
    const existingBadge = card.querySelector('.pull-status-badge');
    if (existingBadge) existingBadge.remove();
    
    if (status === 'pulling') {
      const badge = document.createElement('span');
      badge.className = 'pull-status-badge pulling';
      badge.textContent = '⟳';
      card.querySelector('.card-header').appendChild(badge);
    } else if (status === 'success') {
      const badge = document.createElement('span');
      badge.className = 'pull-status-badge success';
      badge.textContent = '✓';
      card.querySelector('.card-header').appendChild(badge);
      setTimeout(() => badge.remove(), 5000);
    } else if (status === 'failed') {
      const badge = document.createElement('span');
      badge.className = 'pull-status-badge failed';
      badge.textContent = '✗';
      card.querySelector('.card-header').appendChild(badge);
      setTimeout(() => badge.remove(), 5000);
    }
  }

  // --- SSH Terminal ---
  function handleOpenSSH() {
    if (!selectedServerId) return;
    const server = servers.find(s => s.id === selectedServerId);
    if (!server) return;

    document.getElementById('ssh-server-name').textContent = server.name;
    document.getElementById('modal-ssh').classList.remove('hidden');

    // Create xterm instance
    if (sshTerm) {
      sshTerm.dispose();
    }

    sshTerm = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: {
        background: '#0a0a0a',
        foreground: '#e0e0e0',
        cursor: '#00e5ff',
        selectionBackground: 'rgba(124, 77, 255, 0.3)',
      },
    });

    sshFitAddon = new FitAddon.FitAddon();
    sshTerm.loadAddon(sshFitAddon);

    const container = document.getElementById('ssh-terminal');
    container.innerHTML = '';
    sshTerm.open(container);

    // Auto-copy selected text to clipboard
    sshTerm.onSelectionChange(() => {
      const sel = sshTerm.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    });

    // Ctrl+C: copy if text selected, otherwise send SIGINT
    // Ctrl+V: paste from clipboard
    sshTerm.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'c') {
        const sel = sshTerm.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          sshTerm.clearSelection();
          return false; // don't send to shell
        }
        return true; // no selection, send SIGINT
      }
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') {
        e.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text && sshSessionActive) {
            socket.emit('ssh:input', { serverId: selectedServerId, data: text });
          }
        });
        return false;
      }
      return true;
    });

    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (text && sshSessionActive) {
          socket.emit('ssh:input', { serverId: selectedServerId, data: text });
        }
      });
    });

    // Fit after a short delay to let modal render
    setTimeout(() => {
      sshFitAddon.fit();
    }, 100);

    sshSessionActive = true;
    sshTerm.writeln('Connecting to ' + server.name + ' (' + server.ip + ')...');

    // Timeout if no data received within 15s
    const sshTimeout = setTimeout(() => {
      if (sshSessionActive && sshTerm) {
        sshTerm.writeln('\r\n\x1b[31mConnection timed out. Check server logs.\x1b[0m');
        sshSessionActive = false;
      }
    }, 15000);

    // Clear timeout on first data
    const origHandler = socket.listeners('ssh:data');
    socket.once('ssh:data', () => clearTimeout(sshTimeout));
    socket.once('ssh:error', () => clearTimeout(sshTimeout));
    socket.once('ssh:close', () => clearTimeout(sshTimeout));

    // Tell backend to open SSH shell
    socket.emit('ssh:open', {
      serverId: selectedServerId,
      cols: sshTerm.cols,
      rows: sshTerm.rows,
    });

    // Send terminal input to backend
    sshTerm.onData((data) => {
      if (sshSessionActive) {
        socket.emit('ssh:input', { serverId: selectedServerId, data });
      }
    });

    // Handle terminal resize
    sshTerm.onResize(({ cols, rows }) => {
      if (sshSessionActive) {
        socket.emit('ssh:resize', { serverId: selectedServerId, cols, rows });
      }
    });

    // Handle window resize
    window._sshResizeHandler = () => {
      if (sshFitAddon) sshFitAddon.fit();
    };
    window.addEventListener('resize', window._sshResizeHandler);
  }

  function handleCloseSSH() {
    sshSessionActive = false;
    socket.emit('ssh:close', { serverId: selectedServerId });
    document.getElementById('modal-ssh').classList.add('hidden');
    if (sshTerm) {
      sshTerm.dispose();
      sshTerm = null;
      sshFitAddon = null;
    }
    if (window._sshResizeHandler) {
      window.removeEventListener('resize', window._sshResizeHandler);
      window._sshResizeHandler = null;
    }
  }

  // --- CPU Cores ---
  function getCoreColor(percent) {
    if (percent < 40) return '#00e676';
    if (percent < 70) return '#ffab00';
    if (percent < 90) return '#ff6d00';
    return '#ff1744';
  }

  function renderCores(cores) {
    const grid = document.getElementById('cpu-cores-grid');
    if (!grid) return;

    // Reuse existing DOM elements if count matches, otherwise rebuild
    if (grid.children.length !== cores.length) {
      grid.innerHTML = '';
      for (const c of cores) {
        const row = document.createElement('div');
        row.className = 'core-row';
        row.id = `core-row-${c.core}`;
        row.innerHTML = `
          <span class="core-label">C${c.core}</span>
          <div class="core-bar-track">
            <div class="core-bar-fill" id="core-fill-${c.core}"></div>
          </div>
          <span class="core-percent" id="core-pct-${c.core}">${c.percent.toFixed(1)}%</span>
        `;
        grid.appendChild(row);
      }
    }

    // Update values
    for (const c of cores) {
      const fill = document.getElementById(`core-fill-${c.core}`);
      const pct = document.getElementById(`core-pct-${c.core}`);
      if (fill) {
        fill.style.width = c.percent + '%';
        fill.style.backgroundColor = getCoreColor(c.percent);
      }
      if (pct) {
        pct.textContent = c.percent.toFixed(1) + '%';
        pct.style.color = getCoreColor(c.percent);
      }
    }
  }

  function updateCpuHeader(cpuPercent, cpuTemp) {
    const overallEl = document.getElementById('cpu-overall');
    const tempEl = document.getElementById('cpu-temp');

    if (overallEl && cpuPercent != null) {
      overallEl.textContent = 'Overall: ' + cpuPercent.toFixed(1) + '%';
    }
    if (tempEl) {
      if (cpuTemp != null) {
        tempEl.textContent = cpuTemp + '°C';
        tempEl.className = 'cpu-temp' + (cpuTemp >= 80 ? ' hot' : cpuTemp < 50 ? ' cool' : '') + (tempChartVisible ? ' active' : '');
      } else {
        tempEl.textContent = '';
      }
    }
  }

  function updateAccessBadge(m) {
    const el = document.getElementById('detail-access-status');
    if (!el) return;
    if (!m || m.access_active_devices == null || m.access_capacity == null) {
      el.textContent = 'Access: --';
      el.className = 'access-badge';
      el.title = '';
      return;
    }
    el.textContent = `${m.access_model_label || 'Access'}: ${m.access_active_devices}/${m.access_capacity}`;
    el.className = 'access-badge' + ((m.access_active_devices || 0) > 0 ? ' active' : '') + (m.access_active_devices >= m.access_capacity ? ' full' : '');
    el.title = formatAccessTitle(m);
  }

  // --- Helpers ---
  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatUptime(ms) {
    if (!ms || ms <= 0) return '--';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // --- PM2 Log Modal ---
  const LogModal = (() => {
    let currentServerId = null;
    let currentAppName = null;
    let isOpen = false;

    function open(serverId, appName) {
      currentServerId = serverId;
      currentAppName = appName;
      isOpen = true;
      lineCounter = 0;

      const modal = document.getElementById('modal-pm2-logs');
      modal.classList.remove('hidden');

      document.getElementById('log-modal-app-name').textContent = appName;
      const logContent = document.getElementById('log-modal-content');
      logContent.innerHTML = '<div class="log-line-out">Loading...</div>';

      // Fetch historical logs
      fetch(`/api/servers/${serverId}/logs/${appName}?lines=2000`)
        .then(r => r.json())
        .then(logs => {
          logContent.innerHTML = '';
          for (const log of logs) {
            appendLine(log.log_type, log.message);
          }
          logContent.scrollTop = logContent.scrollHeight;
        })
        .catch(err => {
          logContent.innerHTML = `<div class="log-line-error">Error loading logs: ${escapeHtml(err.message)}</div>`;
        });
    }

    function close() {
      currentServerId = null;
      currentAppName = null;
      isOpen = false;
      document.getElementById('modal-pm2-logs').classList.add('hidden');
      document.getElementById('log-modal-content').innerHTML = '';
      const content = document.querySelector('#modal-pm2-logs .modal-content');
      content.classList.remove('modal-fullscreen');
      const fsBtn = document.getElementById('btn-fullscreen-pm2-logs');
      if (fsBtn) fsBtn.textContent = '⛶ Fullscreen';
    }

    let lineCounter = 0;

    function detectLogLevel(message) {
      if (!message) return null;
      const upper = message.toUpperCase();
      if (upper.includes('| ERROR |') || upper.includes('| ERROR|') || upper.includes('[ERROR]') || upper.includes('Traceback')) return 'error';
      if (upper.includes('| WARNING |') || upper.includes('| WARNING|') || upper.includes('[WARNING]') || upper.includes('[WARN]')) return 'warning';
      if (upper.includes('| SUCCESS |') || upper.includes('| SUCCESS|') || upper.includes('[SUCCESS]')) return 'success';
      if (upper.includes('| INFO |') || upper.includes('| INFO|') || upper.includes('[INFO]')) return 'info';
      return null;
    }

    function highlightMessage(message) {
      let html = escapeHtml(message);
      // Highlight timestamps: 2026-03-30 05:02:03.836
      html = html.replace(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g, '<span class="log-timestamp">$1</span>');
      // Highlight log level badges
      html = html.replace(/\|\s*(ERROR)\s*\|/gi, '| <span class="log-badge log-badge-error">$1</span> |');
      html = html.replace(/\|\s*(WARNING)\s*\|/gi, '| <span class="log-badge log-badge-warning">$1</span> |');
      html = html.replace(/\|\s*(SUCCESS)\s*\|/gi, '| <span class="log-badge log-badge-success">$1</span> |');
      html = html.replace(/\|\s*(INFO)\s*\|/gi, '| <span class="log-badge log-badge-info">$1</span> |');
      return html;
    }

    function appendLine(logType, message) {
      const logContent = document.getElementById('log-modal-content');
      lineCounter++;
      const level = detectLogLevel(message);

      const entry = document.createElement('div');
      entry.className = 'log-entry log-type-' + logType;
      if (level) entry.classList.add('log-level-' + level);

      const numSpan = document.createElement('span');
      numSpan.className = 'log-line-num';
      numSpan.textContent = lineCounter;

      const textSpan = document.createElement('span');
      textSpan.className = 'log-line-text';
      textSpan.innerHTML = highlightMessage(message);

      entry.appendChild(numSpan);
      entry.appendChild(textSpan);
      logContent.appendChild(entry);
    }

    function handleNewLog(serverId, appName, logType, message) {
      if (!isOpen || serverId !== currentServerId || appName !== currentAppName) {
        return;
      }

      appendLine(logType, message);
      
      // Auto-scroll to bottom
      const logContent = document.getElementById('log-modal-content');
      logContent.scrollTop = logContent.scrollHeight;
    }

    function getState() {
      return { isOpen, serverId: currentServerId, appName: currentAppName };
    }

    return { open, close, handleNewLog, getState };
  })();

  return { init, LogModal };
})();

document.addEventListener('DOMContentLoaded', App.init);
