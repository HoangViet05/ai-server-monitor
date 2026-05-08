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

module.exports = { diffSection, diffPipMap, computeVersionDrift, isCriticalSystemPkg };
