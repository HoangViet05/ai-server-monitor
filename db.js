const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

let db;
const stmts = {}; // cached prepared statements

function init(dbPath) {
  const resolvedPath = dbPath || path.join(__dirname, 'data', 'monitor.db');
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -16000');   // 16MB cache
  db.pragma('temp_store = MEMORY');
  createTables();
  prepareStatements();
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'agent',
      ssh_user TEXT,
      ssh_key_path TEXT,
      ssh_password TEXT,
      git_repo_path TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      cpu_percent REAL,
      ram_total INTEGER,
      ram_used INTEGER,
      igpu_percent REAL,
      igpu_mem_used INTEGER,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pm2_apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      pm_id INTEGER,
      name TEXT NOT NULL,
      status TEXT,
      cpu REAL,
      memory INTEGER,
      uptime INTEGER,
      restarts INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pm2_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      log_type TEXT NOT NULL,
      message TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_server_ts ON metrics(server_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_pm2_apps_server ON pm2_apps(server_id);
    CREATE INDEX IF NOT EXISTS idx_pm2_logs_server_app ON pm2_logs(server_id, app_name);

    CREATE TABLE IF NOT EXISTS git_pulls (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT,
      conflict_detected INTEGER DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_git_pulls_server ON git_pulls(server_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS scoreboards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scoreboard_id TEXT NOT NULL,
      script_type TEXT NOT NULL DEFAULT 'mission',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scoreboard_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scoreboard_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      message TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (scoreboard_id) REFERENCES scoreboards(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scoreboard_logs_id ON scoreboard_logs(scoreboard_id, id);

    CREATE TABLE IF NOT EXISTS health_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ok INTEGER NOT NULL,
      payload TEXT,
      errors TEXT,
      ts INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_health_server_ts ON health_events(server_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_health_server_kind_ts ON health_events(server_id, kind, ts DESC);

    CREATE TABLE IF NOT EXISTS version_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      pip_freeze TEXT,
      system_pkgs TEXT,
      node_pkgs TEXT,
      ts INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_version_server_ts ON version_snapshots(server_id, ts DESC);

    CREATE TABLE IF NOT EXISTS baselines (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      label TEXT,
      pip_freeze TEXT,
      system_pkgs TEXT,
      node_pkgs TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_baselines_active ON baselines(server_id, active);

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT,
      suggested_actions TEXT,
      opened_at INTEGER NOT NULL,
      acked_at INTEGER,
      closed_at INTEGER,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(server_id, closed_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_server_opened ON incidents(server_id, opened_at DESC);
  `);

  // Migrations — add per-core CPU and temperature columns
  try { db.exec('ALTER TABLE metrics ADD COLUMN cpu_cores TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE metrics ADD COLUMN cpu_temp REAL'); } catch { /* already exists */ }

  // Migration — add git_repo_path column
  try { db.exec('ALTER TABLE servers ADD COLUMN git_repo_path TEXT'); } catch { /* already exists */ }

  // Migration — add discrete GPU columns to metrics
  try { db.exec('ALTER TABLE metrics ADD COLUMN dgpu_percent REAL'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE metrics ADD COLUMN dgpu_mem_used INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE metrics ADD COLUMN dgpu_mem_total INTEGER'); } catch { /* already exists */ }

  // Migration — add gpu_names column to servers (JSON: {"igpu":"...","dgpu":"..."})
  try { db.exec('ALTER TABLE servers ADD COLUMN gpu_names TEXT'); } catch { /* already exists */ }

  // Migration — add disk usage columns to metrics (root filesystem in bytes)
  try { db.exec('ALTER TABLE metrics ADD COLUMN disk_total INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE metrics ADD COLUMN disk_used INTEGER'); } catch { /* already exists */ }

  // Migration — add network throughput columns to metrics (bytes/sec)
  try { db.exec('ALTER TABLE metrics ADD COLUMN net_rx_bytes INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE metrics ADD COLUMN net_tx_bytes INTEGER'); } catch { /* already exists */ }

  // Migration — add power consumption columns to metrics (watts)
  try { db.exec('ALTER TABLE metrics ADD COLUMN cpu_watts REAL'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE metrics ADD COLUMN dgpu_watts REAL'); } catch { /* already exists */ }
}

function prepareStatements() {
  // Servers
  stmts.addServer = db.prepare(`
    INSERT INTO servers (id, name, ip, mode, ssh_user, ssh_key_path, ssh_password, git_repo_path, status, last_seen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offline', 0, ?)
  `);
  stmts.getServer = db.prepare('SELECT * FROM servers WHERE id = ?');
  stmts.getServers = db.prepare('SELECT * FROM servers ORDER BY created_at ASC');
  stmts.updateServerStatus = db.prepare('UPDATE servers SET status = ?, last_seen = ? WHERE id = ?');
  stmts.deleteServer = db.prepare('DELETE FROM servers WHERE id = ?');
  stmts.findServerByIp = db.prepare('SELECT * FROM servers WHERE ip = ?');
  stmts.updateGpuNames = db.prepare('UPDATE servers SET gpu_names = ? WHERE id = ?');

  // Metrics
  stmts.insertMetrics = db.prepare(`
    INSERT INTO metrics (server_id, cpu_percent, cpu_cores, cpu_temp, ram_total, ram_used, igpu_percent, igpu_mem_used, dgpu_percent, dgpu_mem_used, dgpu_mem_total, disk_total, disk_used, net_rx_bytes, net_tx_bytes, cpu_watts, dgpu_watts, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmts.rawInsertMetric = db.prepare(`
    INSERT INTO metrics (server_id, cpu_percent, ram_total, ram_used, igpu_percent, igpu_mem_used, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmts.getMetrics = db.prepare('SELECT * FROM metrics WHERE server_id = ? AND timestamp >= ? ORDER BY timestamp ASC');
  stmts.cleanupOldMetrics = db.prepare('DELETE FROM metrics WHERE timestamp < ?');

  // PM2 Apps
  stmts.deletePm2Apps = db.prepare('DELETE FROM pm2_apps WHERE server_id = ?');
  stmts.insertPm2App = db.prepare(`
    INSERT INTO pm2_apps (server_id, pm_id, name, status, cpu, memory, uptime, restarts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmts.getPm2Apps = db.prepare('SELECT * FROM pm2_apps WHERE server_id = ? ORDER BY pm_id ASC');

  // PM2 Logs
  stmts.insertLog = db.prepare(`
    INSERT INTO pm2_logs (server_id, app_name, log_type, message, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmts.getLogs = db.prepare('SELECT * FROM pm2_logs WHERE server_id = ? AND app_name = ? ORDER BY id DESC LIMIT ?');
  stmts.getDistinctLogApps = db.prepare('SELECT DISTINCT server_id, app_name FROM pm2_logs');
  stmts.cleanupExcessLogs = db.prepare(`
    DELETE FROM pm2_logs WHERE id IN (
      SELECT id FROM pm2_logs WHERE server_id = ? AND app_name = ?
      ORDER BY id DESC LIMIT -1 OFFSET 2000
    )
  `);

  // Scoreboards
  stmts.addScoreboard = db.prepare(`
    INSERT INTO scoreboards (id, name, scoreboard_id, script_type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmts.getScoreboard = db.prepare('SELECT * FROM scoreboards WHERE id = ?');
  stmts.getScoreboards = db.prepare('SELECT * FROM scoreboards ORDER BY created_at ASC');
  stmts.deleteScoreboard = db.prepare('DELETE FROM scoreboards WHERE id = ?');

  stmts.insertScoreboardLog = db.prepare(`
    INSERT INTO scoreboard_logs (scoreboard_id, stream, message, timestamp)
    VALUES (?, ?, ?, ?)
  `);
  stmts.getScoreboardLogs = db.prepare(
    'SELECT * FROM scoreboard_logs WHERE scoreboard_id = ? ORDER BY id DESC LIMIT ?'
  );
  stmts.cleanupExcessScoreboardLogs = db.prepare(`
    DELETE FROM scoreboard_logs WHERE id IN (
      SELECT id FROM scoreboard_logs WHERE scoreboard_id = ?
      ORDER BY id DESC LIMIT -1 OFFSET 2000
    )
  `);

  // Git Pulls
  stmts.createGitPull = db.prepare(`
    INSERT INTO git_pulls (id, server_id, status, started_at)
    VALUES (?, ?, 'running', ?)
  `);
  stmts.getGitPull = db.prepare('SELECT * FROM git_pulls WHERE id = ?');
  stmts.getGitPulls = db.prepare('SELECT * FROM git_pulls WHERE server_id = ? ORDER BY started_at DESC LIMIT ?');
  stmts.cleanupOldGitPulls = db.prepare('DELETE FROM git_pulls WHERE started_at < ?');
}

function close() {
  if (db) db.close();
}

// --- Servers ---

function addServer({ name, ip, mode, ssh_user, ssh_key_path, ssh_password, git_repo_path }) {
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  stmts.addServer.run(id, name, ip, mode || 'agent', ssh_user || null, ssh_key_path || null, ssh_password || null, git_repo_path || null, now);
  return getServer(id);
}

function getServer(id) {
  return stmts.getServer.get(id) || null;
}

function getServers() {
  return stmts.getServers.all();
}

function updateServer(id, fields) {
  const allowed = ['name', 'ip', 'mode', 'ssh_user', 'ssh_key_path', 'ssh_password', 'git_repo_path'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (updates.length === 0) return getServer(id);
  values.push(id);
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getServer(id);
}

function updateServerStatus(id, status) {
  const now = Math.floor(Date.now() / 1000);
  stmts.updateServerStatus.run(status, now, id);
}

function deleteServer(id) {
  stmts.deleteServer.run(id);
}

function findServerByIp(ip) {
  return stmts.findServerByIp.get(ip) || null;
}

function updateGpuNames(serverId, gpuNamesJson) {
  stmts.updateGpuNames.run(gpuNamesJson, serverId);
}

// --- Metrics ---

function insertMetrics(serverId, m) {
  const now = Math.floor(Date.now() / 1000);
  const cpuCoresJson = m.cpu_cores ? JSON.stringify(m.cpu_cores) : null;
  stmts.insertMetrics.run(serverId, m.cpu_percent, cpuCoresJson, m.cpu_temp ?? null, m.ram_total, m.ram_used, m.igpu_percent ?? null, m.igpu_mem_used ?? null, m.dgpu_percent ?? null, m.dgpu_mem_used ?? null, m.dgpu_mem_total ?? null, m.disk_total ?? null, m.disk_used ?? null, m.net_rx_bytes ?? null, m.net_tx_bytes ?? null, m.cpu_watts ?? null, m.dgpu_watts ?? null, now);
}

function _rawInsertMetric(serverId, cpu, ramTotal, ramUsed, igpu, igpuMem, timestamp) {
  stmts.rawInsertMetric.run(serverId, cpu, ramTotal, ramUsed, igpu, igpuMem, timestamp);
}

function getMetrics(serverId, hours) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return stmts.getMetrics.all(serverId, since);
}

function cleanupOldMetrics() {
  const cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
  stmts.cleanupOldMetrics.run(cutoff);
}

// --- PM2 Apps ---

function upsertPm2Apps(serverId, apps) {
  const now = Math.floor(Date.now() / 1000);

  const upsert = db.transaction((serverId, apps) => {
    stmts.deletePm2Apps.run(serverId);
    for (const app of apps) {
      stmts.insertPm2App.run(serverId, app.pm_id, app.name, app.status, app.cpu, app.memory, app.uptime, app.restarts, now);
    }
  });

  upsert(serverId, apps);
}

function getPm2Apps(serverId) {
  return stmts.getPm2Apps.all(serverId);
}

// --- PM2 Logs ---

function insertLogs(serverId, appName, lines) {
  const now = Math.floor(Date.now() / 1000);

  const insert = db.transaction((lines) => {
    for (const line of lines) {
      stmts.insertLog.run(serverId, appName, line.log_type, line.message, now);
    }
  });

  insert(lines);
}

function getLogs(serverId, appName, limit) {
  return stmts.getLogs.all(serverId, appName, limit || 200).reverse();
}

function cleanupExcessLogs() {
  const apps = stmts.getDistinctLogApps.all();

  const cleanup = db.transaction(() => {
    for (const app of apps) {
      stmts.cleanupExcessLogs.run(app.server_id, app.app_name);
    }
  });

  cleanup();
}

// --- Scoreboards ---

function addScoreboard({ name, scoreboard_id, script_type }) {
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  stmts.addScoreboard.run(id, name, scoreboard_id, script_type || 'mission', now);
  return getScoreboard(id);
}

function getScoreboard(id) {
  return stmts.getScoreboard.get(id) || null;
}

function getScoreboards() {
  return stmts.getScoreboards.all();
}

function deleteScoreboard(id) {
  stmts.deleteScoreboard.run(id);
}

function insertScoreboardLog(scoreboardId, stream, message) {
  const now = Math.floor(Date.now() / 1000);
  stmts.insertScoreboardLog.run(scoreboardId, stream, message, now);
}

function getScoreboardLogs(scoreboardId, limit) {
  return stmts.getScoreboardLogs.all(scoreboardId, limit || 500).reverse();
}

function cleanupExcessScoreboardLogs(scoreboardId) {
  stmts.cleanupExcessScoreboardLogs.run(scoreboardId);
}

// --- Git Pulls ---

function createGitPull(serverId) {
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  stmts.createGitPull.run(id, serverId, now);
  return getGitPull(id);
}

function updateGitPull(pullId, fields) {
  const allowed = ['status', 'output', 'conflict_detected', 'completed_at'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (updates.length === 0) return getGitPull(pullId);
  values.push(pullId);
  db.prepare(`UPDATE git_pulls SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getGitPull(pullId);
}

function getGitPull(pullId) {
  return stmts.getGitPull.get(pullId) || null;
}

function getGitPulls(serverId, limit = 10) {
  return stmts.getGitPulls.all(serverId, limit);
}

function cleanupOldGitPulls() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  stmts.cleanupOldGitPulls.run(cutoff);
}

module.exports = {
  init, close,
  addServer, getServer, getServers, updateServer, updateServerStatus, deleteServer, findServerByIp, updateGpuNames,
  insertMetrics, getMetrics, cleanupOldMetrics, _rawInsertMetric,
  upsertPm2Apps, getPm2Apps,
  insertLogs, getLogs, cleanupExcessLogs,
  createGitPull, updateGitPull, getGitPull, getGitPulls, cleanupOldGitPulls,
  addScoreboard, getScoreboard, getScoreboards, deleteScoreboard,
  insertScoreboardLog, getScoreboardLogs, cleanupExcessScoreboardLogs
};
