const { NodeSSH } = require('node-ssh');
const db = require('./db');
const accessManager = require('./access-manager');

const connections = new Map(); // serverId -> { ssh, failCount }
const prevCpuData = new Map(); // serverId -> { cpu: {idle,total}, cores: { cpu0: {idle,total}, ... } }
const activeStreams = new Map(); // serverId -> true
const lastLogLines = new Map(); // serverId:appName -> last line message (dedup)
const gpuNamesCache = new Map(); // serverId -> { igpu: "...", dgpu: "..." }
const gpuCheckCache = new Map(); // serverId -> { available: boolean, message: string, ts: number }
let browserIo = null;

function init(_browserIo) {
  browserIo = _browserIo;
}

function startPolling(server) {
  if (activeStreams.has(server.id)) return;
  console.log(`[SSH] Start streaming ${server.name} (${server.ip})`);
  activeStreams.set(server.id, true);
  startStream(server);
}

function stopPolling(serverId) {
  activeStreams.delete(serverId);
  prevCpuData.delete(serverId);
  gpuNamesCache.delete(serverId);
  gpuCheckCache.delete(serverId);
  // Clean up lastLogLines entries for this server
  for (const key of lastLogLines.keys()) {
    if (key.startsWith(serverId + ':')) {
      lastLogLines.delete(key);
    }
  }
  const conn = connections.get(serverId);
  if (conn && conn.ssh) {
    conn.ssh.dispose();
    connections.delete(serverId);
  }
}

async function getConnection(server) {
  let conn = connections.get(server.id);
  if (conn && conn.ssh && conn.ssh.isConnected()) return conn.ssh;

  const ssh = new NodeSSH();
  const config = {
    host: server.ip,
    username: server.ssh_user || 'root',
    readyTimeout: 10000,
    keepaliveInterval: 60000,
  };

  if (server.ssh_key_path) {
    config.privateKeyPath = server.ssh_key_path;
    // If a password is also provided alongside a key, treat it as the key passphrase
    if (server.ssh_password) config.passphrase = server.ssh_password;
  } else if (server.ssh_password) {
    config.password = server.ssh_password;
  }

  await ssh.connect(config);

  // Catch errors on the underlying ssh2 Client to prevent process crash
  if (ssh.connection) {
    ssh.connection.on('error', (err) => {
      console.error(`[SSH] Connection error for ${server.name}: ${err.message}`);
      // Dispose and let reconnect logic handle it
      try { ssh.dispose(); } catch {}
      connections.delete(server.id);
    });
  }

  connections.set(server.id, { ssh, failCount: 0 });
  return ssh;
}

// Build the streaming shell script that runs on the remote server
function buildStreamScript() {
  return [
    // Detect CPU core count and taskset availability
    'NCORES=$(nproc 2>/dev/null || echo 1)',
    'if [ "$NCORES" -ge 2 ] && command -v taskset >/dev/null 2>&1; then',
    '  LAST=$((NCORES - 1))',
    '  PREV=$((NCORES - 2))',
    '  TASKSET_CMD="taskset -c $PREV,$LAST"',
    'else',
    '  TASKSET_CMD=""',
    'fi',
    '',
    // Detect GPU names once at startup via lspci
    'IGPU_NAME=""',
    'DGPU_NAME=""',
    'if command -v lspci >/dev/null 2>&1; then',
    '  IGPU_NAME=$(lspci | grep -iE "vga|display|3d" | grep -i intel | head -1 | sed "s/.*: //")',
    '  DGPU_NAME=$(lspci | grep -iE "vga|display|3d" | grep -iv intel | head -1 | sed "s/.*: //")',
    'fi',
    // Fallback: get NVIDIA GPU name from nvidia-smi if lspci missed it
    'if [ -z "$DGPU_NAME" ] && command -v nvidia-smi >/dev/null 2>&1; then',
    '  DGPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)',
    'fi',
    '',
    // Background iGPU sampling -- pinned to last 2 cores if taskset available
    'if command -v intel_gpu_top >/dev/null 2>&1; then',
    '  (while true; do ${TASKSET_CMD:+$TASKSET_CMD} timeout 3 intel_gpu_top -J -s 1800 -l 1 > /tmp/.smon_gpu_$$ 2>/dev/null || sleep 2; done) &',
    '  GPID=$!',
    '  trap "kill $GPID 2>/dev/null; rm -f /tmp/.smon_gpu_$$ /tmp/.smon_net_$$ /tmp/.smon_rapl_$$" EXIT',
    'else',
    '  trap "rm -f /tmp/.smon_net_$$ /tmp/.smon_rapl_$$" EXIT',
    'fi',
    '',
    // Main loop function -- run under taskset if available
    'run_loop() {',
    '  C=0',
    '  while true; do',
    '    echo "===TICK==="',
    // Lightweight: CPU, RAM, Temp -- every tick (2s)
    '    cat /proc/stat',
    '    echo "===MEMINFO==="',
    '    cat /proc/meminfo',
    '    echo "===TEMP==="',
    '    for z in /sys/class/thermal/thermal_zone*; do t=$(cat "$z/type" 2>/dev/null); v=$(cat "$z/temp" 2>/dev/null); echo "$t:$v"; done 2>/dev/null',
    // Disk usage of root filesystem -- every tick (df is cheap)
    '    echo "===DISK==="',
    '    df -B1 -P / 2>/dev/null | tail -n 1',
    // Network throughput -- delta between current and previous tick snapshot
    '    echo "===NET==="',
    '    if [ -f /tmp/.smon_net_$$ ]; then cat /tmp/.smon_net_$$; fi',
    '    echo "---NET_SNAP---"',
    '    awk \'NR>2{print $1,$2,$10}\' /proc/net/dev 2>/dev/null | tee /tmp/.smon_net_$$',
    // Power consumption -- CPU via RAPL (powercap), GPU via nvidia-smi
    '    echo "===POWER==="',
    // CPU RAPL: read previous snapshot from file, then write current snapshot
    // Delta between ticks (~2s) gives accurate watts
    '    RAPL_DIR=/sys/class/powercap',
    '    if [ -d "$RAPL_DIR" ]; then',
    '      if [ -f /tmp/.smon_rapl_$$ ]; then',
    '        cat /tmp/.smon_rapl_$$',
    '      fi',
    '    fi',
    '    echo "---POWER_SNAP---"',
    '    if [ -d "$RAPL_DIR" ]; then',
    '      rm -f /tmp/.smon_rapl_$$',
    '      for d in "$RAPL_DIR"/intel-rapl:*; do',
    '        [ -f "$d/name" ] || continue',
    '        name=$(cat "$d/name" 2>/dev/null)',
    '        uj=$(cat "$d/energy_uj" 2>/dev/null)',
    '        [ -n "$uj" ] && echo "rapl:$name:$uj" | tee -a /tmp/.smon_rapl_$$',
    '      done',
    '    fi',
    // GPU power via nvidia-smi -- filter out N/A values
    '    if command -v nvidia-smi >/dev/null 2>&1; then',
    '      pw=$(nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d " ")',
    '      case "$pw" in [0-9]*) echo "dgpu_power:$pw" ;; esac',
    '    fi',
    // iGPU: read from temp file -- every tick (instant read, no spawn)
    '    echo "===GPU==="',
    '    cat /tmp/.smon_gpu_$$ 2>/dev/null',
    // dGPU: nvidia-smi is fast (~50ms), run inline
    '    echo "===DGPU==="',
    '    if command -v nvidia-smi >/dev/null 2>&1; then',
    '      nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null',
    '    fi',
    // GPU names detected at startup
    '    echo "===GPUNAMES==="',
    '    echo "igpu:$IGPU_NAME"',
    '    echo "dgpu:$DGPU_NAME"',
    '    C=$((C+1))',
    // GPU availability check -- every 150 ticks (~5 minutes), plus first tick
    '    if [ "$C" -eq 1 ] || [ $((C % 150)) -eq 0 ]; then',
    '      echo "===GPUCHECK==="',
    '      TS=$(date +%s)',
    '      if command -v nvidia-smi >/dev/null 2>&1; then',
    '        GPU_LIST=$(nvidia-smi -L 2>/dev/null)',
    '        if [ -n "$GPU_LIST" ]; then',
    '          FIRST_GPU=$(printf "%s\\n" "$GPU_LIST" | head -1)',
    '          echo "available:1"',
    '          echo "ts:$TS"',
    '          echo "message:$FIRST_GPU"',
    '        else',
    '          echo "available:0"',
    '          echo "ts:$TS"',
    '          echo "message:nvidia-smi returned no GPUs"',
    '        fi',
    '      else',
    '        echo "available:0"',
    '        echo "ts:$TS"',
    '        echo "message:nvidia-smi not found"',
    '      fi',
    '    fi',
    // PM2 process list -- every 3rd tick (6s)
    '    if [ $((C % 3)) -eq 0 ]; then',
    '      echo "===PM2==="',
    // Resolve pm2 binary: check common locations for nvm/npm global installs
    '      PM2_BIN=$(command -v pm2 2>/dev/null || ls $HOME/.nvm/versions/node/*/bin/pm2 2>/dev/null | tail -1 || ls /usr/local/bin/pm2 /usr/bin/pm2 2>/dev/null | head -1)',
    '      if [ -n "$PM2_BIN" ]; then "$PM2_BIN" jlist 2>/dev/null; fi',
    '    fi',
    // PM2 logs -- every 5th tick (10s)
    '    if [ $((C % 5)) -eq 0 ]; then',
    '      echo "===PM2LOGS==="',
    '      tail -n 500 -v $HOME/.pm2/logs/*.log 2>/dev/null',
    '    fi',
    '    echo "===END==="',
    '    sleep 2',
    '  done',
    '}',
    '',
    'if [ -n "$TASKSET_CMD" ]; then',
    '  $TASKSET_CMD sh -c "$(declare -f run_loop); run_loop"',
    'else',
    '  run_loop',
    'fi',
  ].join('\n');
}

async function startStream(server) {
  if (!activeStreams.has(server.id)) return;

  try {
    const ssh = await getConnection(server);

    if (!ssh.connection) throw new Error('SSH connection not available');

    // Eager PM2 fetch: Execute pm2 jlist immediately after connection
    // This populates the database cache before the first tick arrives
    // Fixes bug where PM2 count shows 0 on initial page load
    try {
      console.log(`[SSH] Fetching PM2 data for ${server.name} on connection...`);
      // Use same shell invocation as the streaming script to ensure pm2 is in PATH
      // Resolve pm2 binary across common install locations (nvm, npm global, system)
      const pm2Result = await ssh.execCommand(
        'PM2_BIN=$(command -v pm2 2>/dev/null || ls $HOME/.nvm/versions/node/*/bin/pm2 2>/dev/null | tail -1 || ls /usr/local/bin/pm2 /usr/bin/pm2 2>/dev/null | head -1); ' +
        'if [ -n "$PM2_BIN" ]; then "$PM2_BIN" jlist 2>/dev/null; fi'
      );
      
      console.log(`[SSH] PM2 fetch stdout length: ${pm2Result.stdout?.length || 0}, stderr: ${pm2Result.stderr?.substring(0, 100) || ''}`);
      
      if (pm2Result.stdout && pm2Result.stdout.trim()) {
        // pm2 jlist may output debug lines before the JSON array
        // Find the JSON array by looking for the first '[' character
        const stdout = pm2Result.stdout.trim();
        const jsonStart = stdout.indexOf('[');
        const jsonStr = jsonStart >= 0 ? stdout.substring(jsonStart) : stdout;
        
        try {
          const raw = JSON.parse(jsonStr);
          const pm2Apps = raw.map(p => ({
            pm_id: p.pm_id,
            name: p.name,
            status: p.pm2_env ? p.pm2_env.status : 'unknown',
            cpu: p.monit ? p.monit.cpu : 0,
            memory: p.monit ? p.monit.memory : 0,
            uptime: p.pm2_env ? (Date.now() - p.pm2_env.pm_uptime) : 0,
            restarts: p.pm2_env ? p.pm2_env.restart_time : 0
          }));
          
          // Populate database cache immediately
          db.upsertPm2Apps(server.id, pm2Apps);
          console.log(`[SSH] PM2 cache populated for ${server.name}: ${pm2Apps.length} apps`);
          
          // Emit initial server:update event with PM2 data
          // This ensures frontend receives PM2 data immediately
          if (browserIo) {
            browserIo.emit('server:update', { 
              serverId: server.id, 
              metrics: {}, 
              pm2: pm2Apps 
            });
          }
        } catch (parseErr) {
          console.warn(`[SSH] Failed to parse PM2 data for ${server.name}: ${parseErr.message}`);
          console.warn(`[SSH] Raw stdout (first 200 chars): ${pm2Result.stdout.substring(0, 200)}`);
        }
      } else {
        console.log(`[SSH] No PM2 data for ${server.name} (PM2 not installed or no processes)`);
      }
    } catch (pm2Err) {
      // PM2 not installed or command failed - gracefully continue
      console.warn(`[SSH] PM2 fetch failed for ${server.name}:`, pm2Err.message);
    }

    const script = buildStreamScript();

    // Use raw ssh2 exec for streaming (avoids node-ssh memory accumulation)
    const channel = await new Promise((resolve, reject) => {
      ssh.connection.exec(script, (err, ch) => {
        if (err) return reject(err);
        resolve(ch);
      });
    });

    let buffer = '';

    channel.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('===END===')) !== -1) {
        const tick = buffer.substring(0, idx);
        buffer = buffer.substring(idx + 9);
        if (buffer.startsWith('\n')) buffer = buffer.substring(1);
        processTick(server.id, tick);
      }
    });

    channel.stderr.on('data', () => {}); // ignore stderr

    channel.on('close', () => {
      handleStreamEnd(server);
    });

    // Mark online
    db.updateServerStatus(server.id, 'online');
    if (browserIo) {
      browserIo.emit('server:status', { serverId: server.id, status: 'online', lastSeen: Math.floor(Date.now() / 1000) });
    }
    const conn = connections.get(server.id);
    if (conn) conn.failCount = 0;

  } catch (err) {
    handleStreamEnd(server, err);
  }
}

// Generic section splitter: splits tick data by ===MARKER=== delimiters
function splitSections(data) {
  const result = {};
  const parts = data.split(/===([\w]+)===/);
  // parts[0] is before first marker (sys section)
  result.SYS = (parts[0] || '').trim();
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const content = (parts[i + 1] || '').trim();
    result[name] = content;
  }
  return result;
}

function processTick(serverId, tickData) {
  if (!activeStreams.has(serverId)) return;

  // Remove ===TICK=== marker
  const data = tickData.replace(/^[\s\S]*?===TICK===\n?/, '');

  // Split into sections generically
  const sections = splitSections(data);

  // Reconstruct sys section (parseSysOutput expects MEMINFO/TEMP markers embedded)
  const sysData = (sections.SYS || '') + '\n===MEMINFO===\n' + (sections.MEMINFO || '') + '\n===TEMP===\n' + (sections.TEMP || '');

  // Parse system metrics (CPU, RAM, Temp)
  const metrics = parseSysOutput(serverId, sysData);

  // Parse disk usage
  if (sections.DISK) {
    const disk = parseDiskOutput(sections.DISK);
    if (disk) {
      metrics.disk_total = disk.disk_total;
      metrics.disk_used = disk.disk_used;
    }
  }

  // Parse network throughput
  if (sections.NET) {
    const net = parseNetworkOutput(sections.NET);
    if (net) {
      metrics.net_rx_bytes = net.net_rx_bytes;
      metrics.net_tx_bytes = net.net_tx_bytes;
    }
  }

  // Parse power consumption (CPU RAPL + GPU)
  if (sections.POWER) {
    const power = parsePowerOutput(sections.POWER);
    if (power) {
      if (power.cpu_watts != null) metrics.cpu_watts = power.cpu_watts;
      if (power.dgpu_watts != null) metrics.dgpu_watts = power.dgpu_watts;
    }
  }

  // Parse iGPU (Intel)
  if (sections.GPU) {
    const gpuData = parseIntelGpuOutput(sections.GPU);
    if (gpuData) {
      metrics.igpu_percent = gpuData.igpu_percent;
      metrics.igpu_mem_used = gpuData.igpu_mem_used;
    }
  }

  // Parse dGPU (NVIDIA)
  if (sections.DGPU) {
    const dgpuData = parseNvidiaGpuOutput(sections.DGPU);
    if (dgpuData) {
      metrics.dgpu_percent = dgpuData.dgpu_percent;
      metrics.dgpu_mem_used = dgpuData.dgpu_mem_used;
      metrics.dgpu_mem_total = dgpuData.dgpu_mem_total;
    }
  }

  // Parse GPU names and cache them
  if (sections.GPUNAMES) {
    const names = parseGpuNames(sections.GPUNAMES);
    if (names.igpu || names.dgpu) {
      gpuNamesCache.set(serverId, names);
      // Update server record with GPU names (once, or when changed)
      db.updateGpuNames(serverId, JSON.stringify(names));
    }
  }

  // Attach cached GPU names to metrics for frontend
  const cachedNames = gpuNamesCache.get(serverId);
  if (cachedNames) {
    metrics.gpu_names = cachedNames;
  }

  if (sections.GPUCHECK) {
    const check = parseGpuCheck(sections.GPUCHECK);
    if (check) gpuCheckCache.set(serverId, check);
  }

  const cachedGpuCheck = gpuCheckCache.get(serverId);
  if (cachedGpuCheck) {
    metrics.gpu_check_available = cachedGpuCheck.available;
    metrics.gpu_check_message = cachedGpuCheck.message;
    metrics.gpu_check_ts = cachedGpuCheck.ts;
  }

  // Parse PM2 processes
  let pm2Apps = null; // null means "no data available yet"
  if (sections.PM2) {
    try {
      const raw = JSON.parse(sections.PM2);
      pm2Apps = raw.map(p => ({
        pm_id: p.pm_id,
        name: p.name,
        status: p.pm2_env ? p.pm2_env.status : 'unknown',
        cpu: p.monit ? p.monit.cpu : 0,
        memory: p.monit ? p.monit.memory : 0,
        uptime: p.pm2_env ? (Date.now() - p.pm2_env.pm_uptime) : 0,
        restarts: p.pm2_env ? p.pm2_env.restart_time : 0
      }));
      db.upsertPm2Apps(serverId, pm2Apps);
    } catch { /* ignore parse error */ }
  } else {
    // No PM2 data in this tick — read from DB cache to maintain consistency
    const cached = db.getPm2Apps(serverId);
    // Only include cached data if cache is populated (avoid sending empty array
    // when cache hasn't been populated yet, which would show "0" on frontend)
    if (cached.length > 0) {
      pm2Apps = cached;
    }
  }

  // Parse PM2 logs (with deduplication)
  if (sections.PM2LOGS) {
    const parsedLogs = parsePm2Logs(sections.PM2LOGS);
    for (const [appName, lines] of Object.entries(parsedLogs)) {
      const key = `${serverId}:${appName}`;
      const lastSeen = lastLogLines.get(key);

      // Find where new lines start (after the last seen line)
      let startIdx = 0;
      if (lastSeen) {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].message === lastSeen) {
            startIdx = i + 1;
            break;
          }
        }
      }

      const newLines = lines.slice(startIdx);
      if (newLines.length > 0) {
        // Remember last line for next dedup
        lastLogLines.set(key, lines[lines.length - 1].message);

        db.insertLogs(serverId, appName, newLines);
        if (browserIo) {
          for (const line of newLines) {
            browserIo.emit('server:log', {
              serverId, appName,
              logType: line.log_type, message: line.message
            });
          }
        }
      } else if (lines.length > 0) {
        // No new lines, but update last seen
        lastLogLines.set(key, lines[lines.length - 1].message);
      }
    }
  }

  // Save to DB
  db.updateServerStatus(serverId, 'online');
  db.insertMetrics(serverId, metrics);

  // Notify browser
  if (browserIo) {
    const server = db.getServer(serverId);
    browserIo.emit('server:update', { serverId, metrics: accessManager.enrichMetric(server, metrics), pm2: pm2Apps });
    browserIo.emit('server:status', { serverId, status: 'online', lastSeen: Math.floor(Date.now() / 1000) });
  }

  const conn = connections.get(serverId);
  if (conn) conn.failCount = 0;
}

function handleStreamEnd(server, err) {
  if (err) {
    console.error(`[SSH] Stream error for ${server.name}: ${err.message}`);
  } else {
    console.log(`[SSH] Stream ended for ${server.name}`);
  }

  if (!activeStreams.has(server.id)) return; // intentionally stopped

  // Cleanup connection
  const conn = connections.get(server.id);
  const failCount = conn ? conn.failCount + 1 : 1;
  if (conn && conn.ssh) {
    try { conn.ssh.dispose(); } catch {}
  }
  connections.delete(server.id);

  if (failCount >= 3) {
    console.log(`[SSH] ${server.name} marked offline after 3 failures. Retry in 5 min.`);
    db.updateServerStatus(server.id, 'offline');
    if (browserIo) {
      browserIo.emit('server:status', { serverId: server.id, status: 'offline', lastSeen: server.last_seen });
    }
    activeStreams.delete(server.id);
    setTimeout(() => startPolling(server), 300000);
  } else {
    console.log(`[SSH] Reconnecting ${server.name} (attempt ${failCount}/3)...`);
    // Store fail count for next attempt
    connections.set(server.id, { ssh: null, failCount });
    setTimeout(() => startStream(server), 5000);
  }
}

/* ─── Parsers ─── */

function parseSysOutput(serverId, output) {
  const metrics = { cpu_percent: 0, cpu_cores: [], cpu_temp: null, ram_total: 0, ram_used: 0, igpu_percent: null, igpu_mem_used: null, dgpu_percent: null, dgpu_mem_used: null, dgpu_mem_total: null, disk_total: null, disk_used: null, gpu_check_available: null, gpu_check_message: null, gpu_check_ts: null };

  const sections = output.split('===MEMINFO===');
  const statSection = sections[0] || '';
  const rest = (sections[1] || '').split('===TEMP===');
  const meminfoSection = rest[0] || '';
  const tempSection = rest[1] || '';

  // Parse /proc/stat for per-core CPU
  const prev = prevCpuData.get(serverId) || {};
  const curr = {};

  for (const line of statSection.split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const key = parts[0];
    const values = parts.slice(1).map(Number);
    const idle = values[3] + (values[4] || 0);
    const total = values.reduce((a, b) => a + b, 0);
    curr[key] = { idle, total };

    if (prev[key]) {
      const idleDiff = idle - prev[key].idle;
      const totalDiff = total - prev[key].total;
      const percent = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 1000) / 10 : 0;

      if (key === 'cpu') {
        metrics.cpu_percent = percent;
      } else {
        metrics.cpu_cores.push({ core: parseInt(key.replace('cpu', '')), percent });
      }
    }
  }

  prevCpuData.set(serverId, curr);

  // Parse /proc/meminfo
  for (const line of meminfoSection.split('\n')) {
    if (line.startsWith('MemTotal:')) metrics.ram_total = parseInt(line.split(/\s+/)[1]) * 1024;
    if (line.startsWith('MemAvailable:')) {
      const available = parseInt(line.split(/\s+/)[1]) * 1024;
      metrics.ram_used = metrics.ram_total - available;
    }
  }

  // Parse thermal zones — look for CPU temp
  for (const line of tempSection.split('\n')) {
    const match = line.match(/^(.+):(\d+)$/);
    if (!match) continue;
    const type = match[1];
    const temp = parseInt(match[2]);
    if (type.includes('x86_pkg') || type.includes('coretemp') || type === 'cpu' || type.includes('cpu')) {
      metrics.cpu_temp = Math.round(temp / 100) / 10;
      break;
    }
  }
  if (metrics.cpu_temp == null) {
    const firstLine = tempSection.split('\n').find(l => l.match(/^.+:\d+$/));
    if (firstLine) {
      metrics.cpu_temp = Math.round(parseInt(firstLine.split(':')[1]) / 100) / 10;
    }
  }

  return metrics;
}

function parseIntelGpuOutput(output) {
  // Try JSON format first (intel_gpu_top -J on newer versions)
  try {
    let parsed = JSON.parse(output);
    const sample = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    const engines = sample.engines || {};

    let igpu_percent = 0;
    if (engines['Render/3D'] !== undefined) {
      igpu_percent = typeof engines['Render/3D'] === 'object'
        ? (engines['Render/3D'].busy ?? 0)
        : engines['Render/3D'];
    } else {
      let totalBusy = 0, count = 0;
      for (const engine of Object.values(engines)) {
        const busy = typeof engine === 'object' ? engine.busy : engine;
        if (busy !== undefined) { totalBusy += busy; count++; }
      }
      igpu_percent = count > 0 ? totalBusy / count : 0;
    }
    return { igpu_percent, igpu_mem_used: 0 };
  } catch { /* not JSON, try text format */ }

  // Parse text table format (older intel-gpu-tools)
  try {
    const lines = output.split('\n');
    // Collect data lines (start with digit after optional whitespace)
    const dataLines = lines.filter(l => /^\s*\d/.test(l));
    // Prefer lines where freq_act > 0 (skip the idle first sample where req=0 act=0)
    // Layout: req(0) act(1) irq/s(2) rc6%(3) gpu_w(4) pkg_w(5) RCS%(6) ...
    const activeLine = dataLines.find(l => {
      const parts = l.trim().split(/\s+/);
      return parts.length >= 7 && parseFloat(parts[1]) > 0; // act > 0
    }) || dataLines[dataLines.length - 1]; // fallback to last line

    if (activeLine) {
      const parts = activeLine.trim().split(/\s+/);
      if (parts.length >= 7) {
        const rcsPercent = parseFloat(parts[6]);
        if (!isNaN(rcsPercent) && rcsPercent >= 0 && rcsPercent <= 100) {
          return { igpu_percent: rcsPercent, igpu_mem_used: 0 };
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

// Parse nvidia-smi CSV output: "utilization.gpu, memory.used, memory.total"
// Each line = one GPU; we take the first one
function parseNvidiaGpuOutput(output) {
  try {
    const line = output.split('\n').find(l => l.trim().length > 0);
    if (!line) return null;
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 3) return null;
    const percent = parseFloat(parts[0]);
    const memUsed = parseFloat(parts[1]); // MiB
    const memTotal = parseFloat(parts[2]); // MiB
    if (isNaN(percent)) return null;
    return {
      dgpu_percent: percent,
      dgpu_mem_used: Math.round(memUsed * 1048576), // MiB -> bytes
      dgpu_mem_total: Math.round(memTotal * 1048576)
    };
  } catch { return null; }
}

// Parse df -B1 -P output: "Filesystem  1B-blocks  Used  Available  Capacity  Mounted on"
function parseDiskOutput(output) {
  try {
    const line = output.split('\n').find(l => l.trim().length > 0);
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    // POSIX df may wrap long filesystem names; columns are at the end
    if (parts.length < 6) return null;
    const total = parseInt(parts[parts.length - 5]);
    const used = parseInt(parts[parts.length - 4]);
    if (isNaN(total) || isNaN(used)) return null;
    return { disk_total: total, disk_used: used };
  } catch { return null; }
}

// Parse /proc/net/dev output (two snapshots: previous tick saved to file, current tick)
// separated by ---NET_SNAP--- to get bytes/sec over the ~2s tick interval
// awk output format: "iface: rx_bytes tx_bytes" per line
function parseNetworkOutput(output) {
  try {
    const parts = output.split('---NET_SNAP---');
    if (parts.length < 2) return null;

    const parseSnapshot = (text) => {
      const map = {};
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Format: "eth0: 12345 67890"
        const m = trimmed.match(/^(\S+):\s+(\d+)\s+(\d+)/);
        if (!m) continue;
        const iface = m[1];
        // Skip loopback
        if (iface === 'lo') continue;
        map[iface] = { rx: parseInt(m[2]), tx: parseInt(m[3]) };
      }
      return map;
    };

    const snap1 = parseSnapshot(parts[0]);
    const snap2 = parseSnapshot(parts[1]);

    // Need both snapshots to calculate delta
    if (Object.keys(snap1).length === 0 || Object.keys(snap2).length === 0) return null;

    let totalRx = 0, totalTx = 0;
    for (const iface of Object.keys(snap2)) {
      if (!snap1[iface]) continue;
      const rx = snap2[iface].rx - snap1[iface].rx;
      const tx = snap2[iface].tx - snap1[iface].tx;
      // Guard against counter wrap or negative values
      if (rx >= 0) totalRx += rx;
      if (tx >= 0) totalTx += tx;
    }

    // Delta is over ~2s tick interval, convert to bytes/sec
    return { net_rx_bytes: Math.round(totalRx / 2), net_tx_bytes: Math.round(totalTx / 2) };
  } catch { return null; }
}

// Parse GPU names from ===GPUNAMES=== section
function parseGpuNames(output) {
  const names = { igpu: '', dgpu: '' };
  for (const line of output.split('\n')) {
    if (line.startsWith('igpu:')) {
      names.igpu = line.substring(5).trim();
    } else if (line.startsWith('dgpu:')) {
      names.dgpu = line.substring(5).trim();
    }
  }
  return names;
}

function parseGpuCheck(output) {
  const result = { available: false, message: '', ts: Math.floor(Date.now() / 1000) };
  for (const line of output.split('\n')) {
    if (line.startsWith('available:')) {
      result.available = line.substring(10).trim() === '1';
    } else if (line.startsWith('message:')) {
      result.message = line.substring(8).trim();
    } else if (line.startsWith('ts:')) {
      const ts = parseInt(line.substring(3).trim(), 10);
      if (!isNaN(ts)) result.ts = ts;
    }
  }
  return result;
}

// Parse POWER section: CPU RAPL delta (two snapshots separated by ---POWER_SNAP---) + GPU watts
// RAPL lines: "rapl:<name>:<energy_uj>"  GPU line: "dgpu_power:<watts>"
function parsePowerOutput(output) {
  try {
    const parts = output.split('---POWER_SNAP---');
    const result = {};

    // Parse GPU power (can appear anywhere in the section)
    for (const line of output.split('\n')) {
      if (line.startsWith('dgpu_power:')) {
        const w = parseFloat(line.substring(11).trim());
        if (!isNaN(w) && w >= 0) result.dgpu_watts = Math.round(w * 10) / 10;
      }
    }

    // Calculate CPU watts from RAPL delta (need both snapshots)
    // parts[0] = previous tick snapshot, parts[1] = current tick snapshot + gpu line
    if (parts.length >= 2 && parts[0].trim().length > 0) {
      const parseRapl = (text) => {
        const map = {};
        for (const line of text.split('\n')) {
          const m = line.match(/^rapl:([^:]+):(\d+)/);
          if (m) map[m[1].trim()] = parseInt(m[2]);
        }
        return map;
      };

      const snap1 = parseRapl(parts[0]);
      const snap2 = parseRapl(parts[1]);

      // Sum only top-level package domains to avoid double-counting core/uncore
      let totalUj = 0;
      let hasData = false;
      for (const name of Object.keys(snap2)) {
        if (!name.startsWith('package')) continue;
        if (snap1[name] == null) continue;
        let delta = snap2[name] - snap1[name];
        // Handle counter wrap (max_energy_range_uj ~262144 J)
        if (delta < 0) delta += 262144000000;
        if (delta > 0) {
          totalUj += delta;
          hasData = true;
        }
      }

      if (hasData) {
        // Delta over ~2s tick interval → watts = microjoules / 2,000,000
        result.cpu_watts = Math.round((totalUj / 2000000) * 10) / 10;
      }
    }

    return (result.cpu_watts != null || result.dgpu_watts != null) ? result : null;
  } catch { return null; }
}

function parsePm2Logs(output) {
  const logs = {};
  let currentApp = null;
  let currentType = 'out';

  for (const line of output.split('\n')) {
    const headerMatch = line.match(/^==> .+\/(.+)-(out|error)\.log <==$/);
    if (headerMatch) {
      currentApp = headerMatch[1];
      currentType = headerMatch[2] === 'error' ? 'err' : 'out';
      if (!logs[currentApp]) logs[currentApp] = [];
      continue;
    }
    if (!currentApp || !line.trim()) continue;
    logs[currentApp].push({ log_type: currentType, message: line });
  }
  return logs;
}

function startAllPolling() {
  const servers = db.getServers();
  for (const server of servers) {
    if (server.mode === 'ssh') {
      startPolling(server);
    }
  }
}

async function testConnection(server) {
  const ssh = new NodeSSH();
  const config = {
    host: server.ip,
    username: server.ssh_user || 'root',
    readyTimeout: 10000,
  };

  if (server.ssh_key_path) {
    config.privateKeyPath = server.ssh_key_path;
    if (server.ssh_password) config.passphrase = server.ssh_password;
  } else if (server.ssh_password) {
    config.password = server.ssh_password;
  }

  try {
    await ssh.connect(config);
    ssh.dispose();
    return { success: true };
  } catch (err) {
    const msg = err.message || '';
    let error = 'Connection failed';
    if (msg.includes('Authentication') || msg.includes('authentication') || msg.includes('Permission denied')) {
      error = 'Authentication failed';
    } else if (msg.includes('ECONNREFUSED') || msg.includes('Connection refused')) {
      error = 'Connection refused';
    } else if (msg.includes('ETIMEDOUT') || msg.includes('timed out') || msg.includes('Timed out')) {
      error = 'Connection timed out';
    } else if (msg.includes('EHOSTUNREACH') || msg.includes('ENETUNREACH') || msg.includes('unreachable')) {
      error = 'Host unreachable';
    } else if (msg.includes('ENOTFOUND')) {
      error = 'Host not found';
    }
    return { success: false, error };
  }
}

module.exports = { init, startPolling, stopPolling, startAllPolling, testConnection, parseSysOutput, parsePm2Logs, buildStreamScript };
