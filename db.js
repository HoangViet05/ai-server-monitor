const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

let db;

function init(dbPath) {
  const resolvedPath = dbPath || path.join(__dirname, 'data', 'monitor.db');
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
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
  `);
}

function close() {
  if (db) db.close();
}

// --- Servers ---

function addServer({ name, ip, mode, ssh_user, ssh_key_path, ssh_password }) {
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO servers (id, name, ip, mode, ssh_user, ssh_key_path, ssh_password, status, last_seen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', 0, ?)
  `).run(id, name, ip, mode || 'agent', ssh_user || null, ssh_key_path || null, ssh_password || null, now);
  return getServer(id);
}

function getServer(id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id) || null;
}

function getServers() {
  return db.prepare('SELECT * FROM servers ORDER BY created_at ASC').all();
}

function updateServer(id, fields) {
  const allowed = ['name', 'ip', 'mode', 'ssh_user', 'ssh_key_path', 'ssh_password'];
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
  db.prepare('UPDATE servers SET status = ?, last_seen = ? WHERE id = ?').run(status, now, id);
}

function deleteServer(id) {
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
}

function findServerByIp(ip) {
  return db.prepare('SELECT * FROM servers WHERE ip = ?').get(ip) || null;
}

// --- Metrics ---

function insertMetrics(serverId, m) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO metrics (server_id, cpu_percent, ram_total, ram_used, igpu_percent, igpu_mem_used, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(serverId, m.cpu_percent, m.ram_total, m.ram_used, m.igpu_percent ?? null, m.igpu_mem_used ?? null, now);
}

function _rawInsertMetric(serverId, cpu, ramTotal, ramUsed, igpu, igpuMem, timestamp) {
  db.prepare(`
    INSERT INTO metrics (server_id, cpu_percent, ram_total, ram_used, igpu_percent, igpu_mem_used, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(serverId, cpu, ramTotal, ramUsed, igpu, igpuMem, timestamp);
}

function getMetrics(serverId, hours) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return db.prepare(
    'SELECT * FROM metrics WHERE server_id = ? AND timestamp >= ? ORDER BY timestamp ASC'
  ).all(serverId, since);
}

function cleanupOldMetrics() {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  db.prepare('DELETE FROM metrics WHERE timestamp < ?').run(cutoff);
}

// --- PM2 Apps ---

function upsertPm2Apps(serverId, apps) {
  const now = Math.floor(Date.now() / 1000);
  const deleteStmt = db.prepare('DELETE FROM pm2_apps WHERE server_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO pm2_apps (server_id, pm_id, name, status, cpu, memory, uptime, restarts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsert = db.transaction((serverId, apps) => {
    deleteStmt.run(serverId);
    for (const app of apps) {
      insertStmt.run(serverId, app.pm_id, app.name, app.status, app.cpu, app.memory, app.uptime, app.restarts, now);
    }
  });

  upsert(serverId, apps);
}

function getPm2Apps(serverId) {
  return db.prepare('SELECT * FROM pm2_apps WHERE server_id = ? ORDER BY pm_id ASC').all(serverId);
}

// --- PM2 Logs ---

function insertLogs(serverId, appName, lines) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO pm2_logs (server_id, app_name, log_type, message, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insert = db.transaction((lines) => {
    for (const line of lines) {
      stmt.run(serverId, appName, line.log_type, line.message, now);
    }
  });

  insert(lines);
}

function getLogs(serverId, appName, limit) {
  return db.prepare(
    'SELECT * FROM pm2_logs WHERE server_id = ? AND app_name = ? ORDER BY id DESC LIMIT ?'
  ).all(serverId, appName, limit || 200).reverse();
}

function cleanupExcessLogs() {
  const apps = db.prepare(
    'SELECT DISTINCT server_id, app_name FROM pm2_logs'
  ).all();

  const deleteStmt = db.prepare(`
    DELETE FROM pm2_logs WHERE id IN (
      SELECT id FROM pm2_logs WHERE server_id = ? AND app_name = ?
      ORDER BY id DESC LIMIT -1 OFFSET 500
    )
  `);

  for (const app of apps) {
    deleteStmt.run(app.server_id, app.app_name);
  }
}

module.exports = {
  init, close,
  addServer, getServer, getServers, updateServer, updateServerStatus, deleteServer, findServerByIp,
  insertMetrics, getMetrics, cleanupOldMetrics, _rawInsertMetric,
  upsertPm2Apps, getPm2Apps,
  insertLogs, getLogs, cleanupExcessLogs
};
