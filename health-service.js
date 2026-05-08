const CRITICAL_SYSTEM_PATTERNS = [
  /^tensorrt/i, /^libcudnn/i, /^cuda/i, /^nvidia-driver/i, /^nvidia-/i
];

function diffSection(baseline, current) {
  const added = [], removed = [], changed = [];
  for (const pkg of Object.keys(current)) {
    if (!(pkg in baseline)) added.push({ pkg, version: current[pkg] });
    else if (baseline[pkg] !== current[pkg]) changed.push({ pkg, from: baseline[pkg], to: current[pkg] });
  }
  for (const pkg of Object.keys(baseline)) {
    if (!(pkg in current)) removed.push({ pkg, version: baseline[pkg] });
  }
  return { added, removed, changed };
}

function diffPipMap(baseline, current) {
  const result = {};
  const venvs = new Set([...Object.keys(baseline || {}), ...Object.keys(current || {})]);
  for (const venv of venvs) {
    const d = diffSection(baseline[venv] || {}, current[venv] || {});
    if (d.added.length || d.removed.length || d.changed.length) result[venv] = d;
  }
  return result;
}

function isCriticalSystemPkg(pkg) {
  return CRITICAL_SYSTEM_PATTERNS.some(re => re.test(pkg));
}

function computeVersionDrift(baseline, current, opts = {}) {
  const watchPip = new Set(opts.watchPip || []);
  const pipDiff = diffPipMap(baseline.pip_freeze || {}, current.pip_freeze || {});
  const sysDiff = diffSection(baseline.system_pkgs || {}, current.system_pkgs || {});
  const nodeDiff = diffSection(baseline.node_pkgs || {}, current.node_pkgs || {});

  const hasPip = Object.keys(pipDiff).length > 0;
  const hasSys = sysDiff.added.length || sysDiff.removed.length || sysDiff.changed.length;
  const hasNode = nodeDiff.added.length || nodeDiff.removed.length || nodeDiff.changed.length;

  if (!hasPip && !hasSys && !hasNode) return null;

  let severity = 'warn';
  for (const venv of Object.keys(pipDiff)) {
    const venvDiff = pipDiff[venv];
    const allChanged = [...venvDiff.changed, ...venvDiff.added, ...venvDiff.removed];
    if (allChanged.some(c => watchPip.has(c.pkg))) severity = 'critical';
  }
  const sysAll = [...sysDiff.changed, ...sysDiff.added, ...sysDiff.removed];
  if (sysAll.some(c => isCriticalSystemPkg(c.pkg))) severity = 'critical';

  return {
    severity,
    diff: { pip: pipDiff, system: sysDiff, node: nodeDiff }
  };
}

const THRESHOLDS = {
  disk:        { warnPct: 85, critPct: 95, sustained: 1 },
  ram:         { warnPct: 85, critPct: 95, sustained: 3 },
  swap:        { warnPct: 50, critPct: 80, sustained: 3 },
  oomEvents:   { warn: 1, crit: 3, sustained: 1 },
  gpuTemp:     { warn: 85, crit: 90, sustained: 1 },
  gpuMemPct:   { warn: 90, crit: 98, sustained: 2 },
  gpuLost:     { sustained: 2 },
  mongo:       { sustained: 3 },
  s3:          { sustained: 3 },
  tailscale:   { sustained: 1 },
};

const sustainedCounters = new Map();

function _key(serverId, kind, sub) {
  return sub ? `${serverId}:${kind}:${sub}` : `${serverId}:${kind}`;
}

function _bump(key) {
  const n = (sustainedCounters.get(key) || 0) + 1;
  sustainedCounters.set(key, n);
  return n;
}

function _reset(key) {
  sustainedCounters.delete(key);
}

function _resetSustainedState() {
  sustainedCounters.clear();
}

function _checkRam(serverId, ram, oomEvents) {
  const out = [];
  if (!ram || !ram.total) return out;
  const pct = (ram.used / ram.total) * 100;
  const swapPct = ram.swap_total ? (ram.swap_used / ram.swap_total) * 100 : 0;

  const ramKey = _key(serverId, 'ram_high');
  if (pct >= THRESHOLDS.ram.warnPct) {
    const n = _bump(ramKey);
    if (n >= THRESHOLDS.ram.sustained) {
      out.push({
        action: 'open', kind: 'ram_high',
        severity: pct >= THRESHOLDS.ram.critPct ? 'critical' : 'warn',
        title: `RAM ${pct.toFixed(1)}%`,
        details: { percent: pct, used: ram.used, total: ram.total },
        suggested_actions: []
      });
    }
  } else {
    if (sustainedCounters.has(ramKey)) {
      _reset(ramKey);
      out.push({ action: 'close', kind: 'ram_high' });
    }
  }

  const swapKey = _key(serverId, 'swap_high');
  if (swapPct >= THRESHOLDS.swap.warnPct) {
    const n = _bump(swapKey);
    if (n >= THRESHOLDS.swap.sustained) {
      out.push({
        action: 'open', kind: 'swap_high',
        severity: swapPct >= THRESHOLDS.swap.critPct ? 'critical' : 'warn',
        title: `Swap ${swapPct.toFixed(1)}%`,
        details: { percent: swapPct, used: ram.swap_used, total: ram.swap_total },
        suggested_actions: []
      });
    }
  } else if (sustainedCounters.has(swapKey)) {
    _reset(swapKey);
    out.push({ action: 'close', kind: 'swap_high' });
  }

  if (typeof oomEvents === 'number' && oomEvents >= THRESHOLDS.oomEvents.warn) {
    out.push({
      action: 'open', kind: 'oom_kill',
      severity: oomEvents >= THRESHOLDS.oomEvents.crit ? 'critical' : 'warn',
      title: `${oomEvents} OOM kill(s) recently`,
      details: { count: oomEvents },
      suggested_actions: [{ label: 'Show last OOM victim', command: "dmesg -T | grep -i 'killed process' | tail -3" }]
    });
  }

  return out;
}

function _checkDisk(serverId, disks) {
  const out = [];
  if (!Array.isArray(disks)) return out;
  for (const d of disks) {
    const key = _key(serverId, 'disk_full', d.mount);
    if (d.percent >= THRESHOLDS.disk.warnPct) {
      _bump(key);
      out.push({
        action: 'open', kind: 'disk_full',
        severity: d.percent >= THRESHOLDS.disk.critPct ? 'critical' : 'warn',
        title: `Disk ${d.mount} ${d.percent.toFixed(1)}%`,
        details: { mount: d.mount, percent: d.percent, used: d.used, total: d.total },
        suggested_actions: [{ label: `du -sh largest in ${d.mount}`, command: `du -sh ${d.mount}/* 2>/dev/null | sort -h | tail -10` }]
      });
    } else if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: 'disk_full' });
    }
  }
  return out;
}

function _checkGpu(serverId, gpu) {
  const out = [];
  if (!gpu) return out;

  if (gpu.lost) {
    const key = _key(serverId, 'gpu_lost');
    const n = _bump(key);
    if (n >= THRESHOLDS.gpuLost.sustained) {
      out.push({
        action: 'open', kind: 'gpu_lost', severity: 'critical',
        title: 'GPU lost or driver unresponsive',
        details: { errors: gpu.errors || [] },
        suggested_actions: [
          { label: 'Show nvidia-smi', command: 'nvidia-smi' },
          { label: 'Show dmesg GPU lines', command: 'dmesg -T | grep -i nvidia | tail -20' }
        ]
      });
    }
    return out;
  } else {
    const key = _key(serverId, 'gpu_lost');
    if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: 'gpu_lost' });
    }
  }

  if (typeof gpu.temp === 'number' && gpu.temp >= THRESHOLDS.gpuTemp.warn) {
    out.push({
      action: 'open', kind: 'gpu_temp',
      severity: gpu.temp >= THRESHOLDS.gpuTemp.crit ? 'critical' : 'warn',
      title: `GPU temp ${gpu.temp}°C`,
      details: { temp: gpu.temp },
      suggested_actions: []
    });
  } else if (sustainedCounters.has(_key(serverId, 'gpu_temp'))) {
    _reset(_key(serverId, 'gpu_temp'));
    out.push({ action: 'close', kind: 'gpu_temp' });
  }

  if (gpu.mem_total && gpu.mem_used != null) {
    const memPct = (gpu.mem_used / gpu.mem_total) * 100;
    const key = _key(serverId, 'gpu_mem_high');
    if (memPct >= THRESHOLDS.gpuMemPct.warn) {
      const n = _bump(key);
      if (n >= THRESHOLDS.gpuMemPct.sustained) {
        out.push({
          action: 'open', kind: 'gpu_mem_high',
          severity: memPct >= THRESHOLDS.gpuMemPct.crit ? 'critical' : 'warn',
          title: `GPU mem ${memPct.toFixed(1)}%`,
          details: { percent: memPct, used: gpu.mem_used, total: gpu.mem_total },
          suggested_actions: []
        });
      }
    } else if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: 'gpu_mem_high' });
    }
  }

  return out;
}

function _checkExtDeps(serverId, payload) {
  const out = [];
  const map = [
    { name: 'mongo', kind: 'mongo_down', severity: 'critical', sustained: THRESHOLDS.mongo.sustained },
    { name: 's3', kind: 's3_down', severity: 'warn', sustained: THRESHOLDS.s3.sustained },
    { name: 'tailscale', kind: 'tailscale_down', severity: 'critical', sustained: THRESHOLDS.tailscale.sustained },
  ];
  for (const dep of map) {
    const status = payload[dep.name];
    if (!status) continue;
    const key = _key(serverId, dep.kind);
    if (!status.ok) {
      const n = _bump(key);
      if (n >= dep.sustained) {
        out.push({
          action: 'open', kind: dep.kind, severity: dep.severity,
          title: `${dep.name} unreachable`,
          details: { error: status.error || null },
          suggested_actions: [{ label: `Re-test ${dep.name} now`, command: `# triggered via dashboard` }]
        });
      }
    } else if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: dep.kind });
    }
  }
  return out;
}

function evaluate(serverId, ev) {
  if (ev.kind === 'host_health') {
    const p = ev.payload || {};
    return [
      ..._checkRam(serverId, p.ram, p.oom_events),
      ..._checkDisk(serverId, p.disk),
      ..._checkGpu(serverId, p.gpu),
    ];
  }
  if (ev.kind === 'ext_deps') {
    return _checkExtDeps(serverId, ev.payload || {});
  }
  return [];
}

module.exports = {
  diffSection, diffPipMap, computeVersionDrift, isCriticalSystemPkg,
  THRESHOLDS, evaluate, _resetSustainedState
};
