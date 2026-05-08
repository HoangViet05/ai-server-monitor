const { execSync } = require('child_process');
const fs = require('fs');

let timers = [];
let socket = null;
let config = null;
let lastDmesgCount = 0;

function _safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: opts.timeout || 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function _readMeminfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => {
      const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1]) * 1024 : 0;
    };
    return {
      total: get('MemTotal'),
      used: get('MemTotal') - get('MemAvailable'),
      swap_total: get('SwapTotal'),
      swap_used: get('SwapTotal') - get('SwapFree'),
    };
  } catch { return null; }
}

function _readDisks(mounts) {
  const out = [];
  for (const mount of mounts) {
    const text = _safeExec(`df -B1 -P "${mount}" 2>/dev/null | tail -n 1`);
    if (!text) continue;
    const parts = text.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const total = parseInt(parts[parts.length - 5]);
    const used = parseInt(parts[parts.length - 4]);
    if (isNaN(total) || isNaN(used) || total === 0) continue;
    out.push({ mount, total, used, percent: (used / total) * 100 });
  }
  return out;
}

function _readGpu() {
  const list = _safeExec('nvidia-smi -L');
  if (!list) return null;
  const csv = _safeExec('nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu,utilization.gpu --format=csv,noheader,nounits');
  if (!csv) return { lost: true, errors: ['nvidia-smi query failed'] };
  const line = csv.split('\n').find(l => l.trim().length > 0);
  if (!line) return { lost: true, errors: ['empty GPU response'] };
  const parts = line.split(',').map(s => parseFloat(s.trim()));
  if (parts.some(isNaN)) return { lost: true, errors: ['unparseable GPU response'] };
  return {
    lost: false,
    mem_used: parts[0] * 1048576,
    mem_total: parts[1] * 1048576,
    temp: parts[2],
    util: parts[3],
  };
}

function _readOomEvents() {
  const out = _safeExec('dmesg -T 2>/dev/null | grep -ci "out of memory"');
  if (out == null) return 0;
  const total = parseInt(out.trim()) || 0;
  if (lastDmesgCount === 0) {
    lastDmesgCount = total;
    return 0;
  }
  const delta = Math.max(0, total - lastDmesgCount);
  lastDmesgCount = total;
  return delta;
}

async function _pingMongo(cfg) {
  if (!cfg || !cfg.uri) return null;
  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); }
  catch { return { ok: false, error: 'mongodb module not installed' }; }
  const client = new MongoClient(cfg.uri, { serverSelectionTimeoutMS: cfg.timeout_ms || 5000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await client.close().catch(() => {});
  }
}

async function _probeS3(cfg) {
  if (!cfg || !cfg.bucket || !cfg.endpoint) return null;
  let S3Client, ListObjectsV2Command;
  try { ({ S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3')); }
  catch { return { ok: false, error: '@aws-sdk/client-s3 not installed' }; }
  const client = new S3Client({
    endpoint: cfg.endpoint, region: cfg.region || 'auto',
    credentials: { accessKeyId: cfg.access_key, secretAccessKey: cfg.secret_key },
    requestHandler: { requestTimeout: cfg.timeout_ms || 5000 }
  });
  try {
    await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function _probeTailscale() {
  const out = _safeExec('tailscale status --json 2>/dev/null');
  if (!out) return { ok: false, error: 'tailscale CLI not available' };
  try {
    const parsed = JSON.parse(out);
    const online = parsed.Self && parsed.Self.Online === true;
    return online ? { ok: true } : { ok: false, error: 'Self.Online=false' };
  } catch (err) {
    return { ok: false, error: 'cannot parse tailscale status' };
  }
}

async function probeExternalDeps() {
  const cfg = (config && config.external_deps) || {};
  const errors = [];
  const mongo = await _pingMongo(cfg.mongo);
  const s3 = await _probeS3(cfg.s3);
  const tailscale = (cfg.tailscale && cfg.tailscale.enabled === false) ? null : _probeTailscale();

  const payload = { mongo, s3, tailscale };
  for (const [name, status] of Object.entries(payload)) {
    if (status && status.ok === false) errors.push(`${name}: ${status.error}`);
  }
  const ok = !Object.values(payload).some(s => s && s.ok === false);
  return { kind: 'ext_deps', ok, payload, errors, ts: Math.floor(Date.now() / 1000) };
}

async function probeHostHealth() {
  const errors = [];
  const ram = _readMeminfo();
  if (!ram) errors.push('meminfo unreadable');
  const mounts = (config && config.monitored_mounts) || ['/'];
  const disk = _readDisks(mounts);
  const gpu = _readGpu();
  const oom = _readOomEvents();

  const payload = { ram, disk, gpu, oom_events: oom };
  return {
    kind: 'host_health',
    ok: errors.length === 0 && (!gpu || !gpu.lost),
    payload, errors,
    ts: Math.floor(Date.now() / 1000),
  };
}

function start(_socket, _config) {
  socket = _socket;
  config = _config || {};
  if (!config.enabled) return;

  const hostInterval = config.host_interval || 60000;
  timers.push(setInterval(async () => {
    if (!socket || !socket.connected) return;
    try {
      const ev = await probeHostHealth();
      socket.emit('health:check', ev);
    } catch (err) {
      console.error('[health] probeHostHealth error:', err.message);
    }
  }, hostInterval));

  const extInterval = config.ext_deps_interval || 60000;
  timers.push(setInterval(async () => {
    if (!socket || !socket.connected) return;
    try {
      const ev = await probeExternalDeps();
      socket.emit('health:check', ev);
    } catch (err) {
      console.error('[health] probeExternalDeps error:', err.message);
    }
  }, extInterval));

  console.log(`[health] Started — host every ${hostInterval/1000}s, ext-deps every ${extInterval/1000}s`);
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

module.exports = { start, stop, probeHostHealth, probeExternalDeps };
