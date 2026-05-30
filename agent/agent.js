const { io } = require('socket.io-client');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const healthCollector = require('./health-collector');

// Load config
const configPath = path.join(__dirname, 'agent-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const DASHBOARD_URL = config.dashboard_url;
const INTERVAL = config.interval || 10000;
const SERVER_NAME = config.server_name || os.hostname();
const GPU_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let lastGpuCheckAt = 0;
let lastGpuCheck = null;

console.log(`[Agent] Connecting to ${DASHBOARD_URL}...`);

const socket = io(DASHBOARD_URL, {
  path: '/agent',
  reconnection: true,
  reconnectionDelay: 5000,
  reconnectionDelayMax: 30000,
});

// Detect server IP: custom_ip > Tailscale > LAN IP > fallback
function getServerIp() {
  // 1. Use custom IP from config if provided
  if (config.custom_ip && config.custom_ip.trim()) {
    return config.custom_ip.trim();
  }

  // 2. Try Tailscale IP
  try {
    const output = execSync('tailscale ip -4 2>/dev/null || ip addr show tailscale0 2>/dev/null | grep inet | awk \'{print $2}\' | cut -d/ -f1', { encoding: 'utf8' });
    const ip = output.trim().split('\n')[0];
    if (ip && ip !== '') return ip;
  } catch { /* no tailscale */ }

  // 3. Try to get LAN IP from network interfaces
  try {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address;
        }
      }
    }
  } catch { /* ignore */ }

  return '0.0.0.0';
}

// CPU usage from /proc/stat (overall + per-core)
const prevCpuData = {}; // key -> { idle, total }

function getCpuInfo() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const lines = stat.split('\n');

    let cpuPercent = 0;
    const cores = [];

    for (const line of lines) {
      if (!line.startsWith('cpu')) continue;
      const parts = line.trim().split(/\s+/);
      const key = parts[0];
      const values = parts.slice(1).map(Number);
      const idle = values[3] + (values[4] || 0);
      const total = values.reduce((a, b) => a + b, 0);

      if (prevCpuData[key]) {
        const idleDiff = idle - prevCpuData[key].idle;
        const totalDiff = total - prevCpuData[key].total;
        const percent = totalDiff > 0 ? ((1 - idleDiff / totalDiff) * 100) : 0;

        if (key === 'cpu') {
          cpuPercent = Math.round(percent * 10) / 10;
        } else {
          cores.push({ core: parseInt(key.replace('cpu', '')), percent: Math.round(percent * 10) / 10 });
        }
      }

      prevCpuData[key] = { idle, total };
    }

    return { cpu_percent: cpuPercent, cpu_cores: cores };
  } catch {
    return { cpu_percent: 0, cpu_cores: [] };
  }
}

// CPU temperature from thermal zones
function getCpuTemp() {
  try {
    const zones = fs.readdirSync('/sys/class/thermal/');
    // First pass: look for CPU-specific zone
    for (const zone of zones) {
      if (!zone.startsWith('thermal_zone')) continue;
      try {
        const type = fs.readFileSync(`/sys/class/thermal/${zone}/type`, 'utf8').trim();
        if (type.includes('x86_pkg') || type.includes('coretemp') || type === 'cpu' || type.includes('cpu')) {
          const temp = parseInt(fs.readFileSync(`/sys/class/thermal/${zone}/temp`, 'utf8').trim());
          return Math.round(temp / 100) / 10; // millidegrees -> degrees, 1 decimal
        }
      } catch { continue; }
    }
    // Fallback: first thermal zone
    const temp = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim());
    return Math.round(temp / 100) / 10;
  } catch {
    return null;
  }
}

// RAM from /proc/meminfo
function getRamInfo() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const lines = meminfo.split('\n');
    let total = 0, available = 0;
    for (const line of lines) {
      if (line.startsWith('MemTotal:')) total = parseInt(line.split(/\s+/)[1]) * 1024;
      if (line.startsWith('MemAvailable:')) available = parseInt(line.split(/\s+/)[1]) * 1024;
    }
    return { ram_total: total, ram_used: total - available };
  } catch {
    return { ram_total: 0, ram_used: 0 };
  }
}

// iGPU (Intel)
function getIgpuInfo() {
  try {
    const output = execSync('timeout 2 intel_gpu_top -J -s 1000 -l 1 2>/dev/null', { encoding: 'utf8' });
    let parsed = JSON.parse(output);
    const sample = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    const engines = sample.engines || {};

    let igpu_percent = 0;
    if (engines['Render/3D'] !== undefined) {
      if (typeof engines['Render/3D'] === 'object') {
        const busy = engines['Render/3D'].busy;
        igpu_percent = (busy === undefined || busy === null) ? 0 : busy;
      } else {
        igpu_percent = engines['Render/3D'];
      }
    } else {
      let totalBusy = 0, count = 0;
      for (const engine of Object.values(engines)) {
        const busy = typeof engine === 'object' ? engine.busy : engine;
        if (busy !== undefined) { totalBusy += busy; count++; }
      }
      igpu_percent = count > 0 ? totalBusy / count : 0;
    }
    return { igpu_percent, igpu_mem_used: 0 };
  } catch {
    return { igpu_percent: null, igpu_mem_used: null };
  }
}

function getGpuCheck() {
  const now = Date.now();
  if (lastGpuCheck && now - lastGpuCheckAt < GPU_CHECK_INTERVAL_MS) {
    return lastGpuCheck;
  }

  const ts = Math.floor(now / 1000);
  try {
    const output = execSync('timeout 5 nvidia-smi -L 2>/dev/null', { encoding: 'utf8' }).trim();
    lastGpuCheck = output
      ? { gpu_check_available: true, gpu_check_message: output.split('\n')[0].trim(), gpu_check_ts: ts }
      : { gpu_check_available: false, gpu_check_message: 'nvidia-smi returned no GPUs', gpu_check_ts: ts };
  } catch {
    lastGpuCheck = { gpu_check_available: false, gpu_check_message: 'nvidia-smi not found or failed', gpu_check_ts: ts };
  }
  lastGpuCheckAt = now;
  return lastGpuCheck;
}

// PM2 logs
function getPm2Logs() {
  try {
    const output = execSync('pm2 logs --nostream --lines 50 2>/dev/null', { encoding: 'utf8' });
    const logs = {};
    for (const line of output.split('\n')) {
      const match = line.match(/^(\d+)\|(\S+)\s*\|\s*(.*)$/);
      if (match) {
        const appName = match[2];
        const message = match[3];
        if (!logs[appName]) logs[appName] = [];
        logs[appName].push(message);
      }
    }
    return logs;
  } catch {
    return {};
  }
}

// PM2 processes
function getPm2Apps() {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const raw = JSON.parse(output);
    return raw.map(p => ({
      pm_id: p.pm_id,
      name: p.name,
      status: p.pm2_env ? p.pm2_env.status : 'unknown',
      cpu: p.monit ? p.monit.cpu : 0,
      memory: p.monit ? p.monit.memory : 0,
      uptime: p.pm2_env ? (Date.now() - p.pm2_env.pm_uptime) : 0,
      restarts: p.pm2_env ? p.pm2_env.restart_time : 0
    }));
  } catch {
    return [];
  }
}

// Socket events
const serverIp = getServerIp();

socket.on('connect', () => {
  console.log(`[Agent] Connected! Registering as ${SERVER_NAME} (${serverIp})`);
  socket.emit('register', { hostname: SERVER_NAME, ip: serverIp });
  if (config.health && config.health.enabled) {
    healthCollector.start(socket, config.health);
  }
});

socket.on('disconnect', (reason) => {
  console.log(`[Agent] Disconnected: ${reason}`);
  healthCollector.stop();
});

socket.on('connect_error', (err) => {
  console.log(`[Agent] Connection error: ${err.message}`);
});

// Execute command handler (for PM2 actions)
socket.on('execute', (data, callback) => {
  const { command } = data;
  console.log(`[Agent] Execute command: ${command}`);

  // Only allow pm2 commands for safety
  if (!command.startsWith('pm2 ')) {
    callback({ error: 'Only pm2 commands are allowed' });
    return;
  }

  const { execSync } = require('child_process');
  try {
    const output = execSync(command, { encoding: 'utf8', timeout: 10000 });
    callback({ output });
  } catch (err) {
    callback({ error: err.stderr || err.message, output: err.stdout || '' });
  }
});

// Git pull command handler
socket.on('git:pull', (data) => {
  const { pullId, repoPath } = data;
  console.log(`[Agent] Git pull requested for ${repoPath} (pullId: ${pullId})`);

  // Validate repo path exists
  if (!fs.existsSync(repoPath)) {
    socket.emit('git:pull:log', {
      pullId,
      logType: 'stderr',
      message: `Error: Repository path does not exist: ${repoPath}`
    });
    socket.emit('git:pull:complete', {
      pullId,
      exitCode: 1,
      output: `Error: Repository path does not exist: ${repoPath}`
    });
    return;
  }

  // Spawn git pull process
  const gitProcess = spawn('git', ['pull'], {
    cwd: repoPath,
    shell: true
  });

  let output = '';

  gitProcess.stdout.on('data', (data) => {
    const message = data.toString();
    output += message;
    socket.emit('git:pull:log', {
      pullId,
      logType: 'stdout',
      message: message.trim()
    });
  });

  gitProcess.stderr.on('data', (data) => {
    const message = data.toString();
    output += message;
    socket.emit('git:pull:log', {
      pullId,
      logType: 'stderr',
      message: message.trim()
    });
  });

  gitProcess.on('close', (exitCode) => {
    console.log(`[Agent] Git pull completed with exit code ${exitCode}`);
    socket.emit('git:pull:complete', {
      pullId,
      exitCode,
      output
    });
  });

  gitProcess.on('error', (err) => {
    console.error(`[Agent] Git pull error:`, err);
    socket.emit('git:pull:log', {
      pullId,
      logType: 'stderr',
      message: `Error: ${err.message}`
    });
    socket.emit('git:pull:complete', {
      pullId,
      exitCode: 1,
      output: `Error: ${err.message}`
    });
  });
});

// Heartbeat loop
setInterval(() => {
  if (!socket.connected) return;

  const { cpu_percent, cpu_cores } = getCpuInfo();
  const cpu_temp = getCpuTemp();
  const { ram_total, ram_used } = getRamInfo();
  const { igpu_percent, igpu_mem_used } = getIgpuInfo();
  const gpuCheck = getGpuCheck();
  const pm2 = getPm2Apps();

  socket.emit('heartbeat', {
    metrics: { cpu_percent, cpu_cores, cpu_temp, ram_total, ram_used, igpu_percent, igpu_mem_used, ...gpuCheck },
    pm2
  });

  // Send PM2 logs
  const pm2Logs = getPm2Logs();
  for (const [appName, lines] of Object.entries(pm2Logs)) {
    socket.emit('logs', { appName, logType: 'out', lines });
  }

  const tempStr = cpu_temp != null ? ` ${cpu_temp}°C` : '';
  console.log(`[Agent] Heartbeat sent — CPU: ${cpu_percent.toFixed(1)}%${tempStr} (${cpu_cores.length} cores), RAM: ${(ram_used/1073741824).toFixed(1)}GB, PM2: ${pm2.length} apps`);
}, INTERVAL);

console.log(`[Agent] Started. Heartbeat every ${INTERVAL/1000}s`);
