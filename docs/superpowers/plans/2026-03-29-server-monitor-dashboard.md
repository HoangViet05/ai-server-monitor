# Server Monitor Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-time server monitoring dashboard that tracks PM2 processes, logs, and system metrics (CPU/iGPU/RAM) across Tailscale-connected servers.

**Architecture:** Express + Socket.IO dashboard on Windows (port 3000), agent WebSocket receiver (port 3001), SSH fallback polling. SQLite for persistence. EJS + vanilla JS + Chart.js for dark-themed UI.

**Tech Stack:** Node.js, Express, Socket.IO, better-sqlite3, node-ssh, EJS, Chart.js (CDN), uuid

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | Dashboard dependencies and scripts |
| `db.js` | SQLite schema, CRUD operations, cleanup queries |
| `routes/api.js` | REST API endpoints for servers, metrics, pm2, logs |
| `agent-server.js` | WebSocket server (port 3001) receiving agent heartbeats |
| `ssh-poller.js` | SSH polling loop for ssh-mode servers |
| `cleanup.js` | Hourly job to prune old metrics and excess logs |
| `server.js` | Entry point — wires Express, Socket.IO, agent-server, ssh-poller, cleanup |
| `views/layout.ejs` | HTML shell with dark theme, CDN links |
| `views/index.ejs` | Dashboard page: server grid, detail panel, log viewer, add modal |
| `public/css/style.css` | Dark theme styles |
| `public/js/app.js` | Socket.IO client, server grid rendering, modal logic |
| `public/js/charts.js` | Chart.js line chart creation and real-time updates |
| `public/js/logs.js` | Log viewer panel logic |
| `agent/package.json` | Agent dependencies |
| `agent/agent.js` | Agent script that collects metrics and sends to dashboard |
| `agent/agent-config.json` | Agent configuration template |
| `docs/agent-setup.txt` | Step-by-step agent installation guide |
| `tests/db.test.js` | Database layer unit tests |
| `tests/api.test.js` | API integration tests |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `server-monitor/` directory structure

- [ ] **Step 1: Create package.json**

```json
{
  "name": "server-monitor",
  "version": "1.0.0",
  "description": "Server monitoring dashboard via Tailscale",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "ejs": "^3.1.10",
    "express": "^4.21.0",
    "node-ssh": "^13.2.0",
    "socket.io": "^4.7.5",
    "uuid": "^10.0.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Create directory structure**

Run:
```bash
cd server-monitor
mkdir -p routes public/css public/js views agent data tests docs
```

- [ ] **Step 3: Install dependencies**

Run:
```bash
cd server-monitor
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 4: Create .gitignore**

```
node_modules/
data/*.db
```

- [ ] **Step 5: Commit**

```bash
git init
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold server-monitor project"
```

---

### Task 2: Database Layer

**Files:**
- Create: `db.js`
- Create: `tests/db.test.js`

- [ ] **Step 1: Write failing tests for db layer**

Create `tests/db.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-monitor.db');

let db;

before(() => {
  // Clean up any leftover test db
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = require('../db');
  db.init(TEST_DB_PATH);
});

after(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('servers', () => {
  it('should add and list servers', () => {
    const server = db.addServer({ name: 'test-server', ip: '100.64.0.1', mode: 'agent' });
    assert.ok(server.id);
    assert.strictEqual(server.name, 'test-server');
    assert.strictEqual(server.status, 'offline');

    const list = db.getServers();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].ip, '100.64.0.1');
  });

  it('should update a server', () => {
    const servers = db.getServers();
    const id = servers[0].id;
    const updated = db.updateServer(id, { name: 'renamed-server' });
    assert.strictEqual(updated.name, 'renamed-server');
  });

  it('should update server status', () => {
    const servers = db.getServers();
    const id = servers[0].id;
    db.updateServerStatus(id, 'online');
    const server = db.getServer(id);
    assert.strictEqual(server.status, 'online');
    assert.ok(server.last_seen > 0);
  });

  it('should delete a server', () => {
    const servers = db.getServers();
    const id = servers[0].id;
    db.deleteServer(id);
    const list = db.getServers();
    assert.strictEqual(list.length, 0);
  });
});

describe('metrics', () => {
  let serverId;

  before(() => {
    const server = db.addServer({ name: 'metrics-server', ip: '100.64.0.2', mode: 'agent' });
    serverId = server.id;
  });

  it('should insert and retrieve metrics', () => {
    db.insertMetrics(serverId, {
      cpu_percent: 45.2,
      ram_total: 8589934592,
      ram_used: 4294967296,
      igpu_percent: 10.0,
      igpu_mem_used: 134217728
    });

    const metrics = db.getMetrics(serverId, 24);
    assert.strictEqual(metrics.length, 1);
    assert.strictEqual(metrics[0].cpu_percent, 45.2);
  });
});

describe('pm2_apps', () => {
  let serverId;

  before(() => {
    const servers = db.getServers();
    serverId = servers[0].id;
  });

  it('should upsert pm2 apps', () => {
    db.upsertPm2Apps(serverId, [
      { pm_id: 0, name: 'api', status: 'online', cpu: 5.0, memory: 104857600, uptime: 86400000, restarts: 0 },
      { pm_id: 1, name: 'web', status: 'stopped', cpu: 0, memory: 0, uptime: 0, restarts: 3 }
    ]);

    const apps = db.getPm2Apps(serverId);
    assert.strictEqual(apps.length, 2);
    assert.strictEqual(apps[0].name, 'api');
    assert.strictEqual(apps[1].status, 'stopped');
  });

  it('should overwrite on second upsert', () => {
    db.upsertPm2Apps(serverId, [
      { pm_id: 0, name: 'api', status: 'errored', cpu: 0, memory: 0, uptime: 0, restarts: 5 }
    ]);

    const apps = db.getPm2Apps(serverId);
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].status, 'errored');
  });
});

describe('pm2_logs', () => {
  let serverId;

  before(() => {
    const servers = db.getServers();
    serverId = servers[0].id;
  });

  it('should insert and retrieve logs', () => {
    db.insertLogs(serverId, 'api', [
      { log_type: 'out', message: 'Server started on port 3000' },
      { log_type: 'error', message: 'Warning: deprecated API' }
    ]);

    const logs = db.getLogs(serverId, 'api', 200);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].log_type, 'out');
  });
});

describe('cleanup', () => {
  it('should delete old metrics', () => {
    const servers = db.getServers();
    const serverId = servers[0].id;

    // Insert a metric with old timestamp (25 hours ago)
    const oldTs = Math.floor(Date.now() / 1000) - 25 * 3600;
    db._rawInsertMetric(serverId, 10.0, 8589934592, 1000000, null, null, oldTs);

    const before = db.getMetrics(serverId, 48);
    db.cleanupOldMetrics();
    const after = db.getMetrics(serverId, 48);

    assert.ok(after.length < before.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd server-monitor
npm test
```
Expected: FAIL — `Cannot find module '../db'`

- [ ] **Step 3: Implement db.js**

Create `db.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd server-monitor
npm test
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add db.js tests/db.test.js
git commit -m "feat: add database layer with CRUD for servers, metrics, pm2 apps, logs"
```

---

### Task 3: REST API Routes

**Files:**
- Create: `routes/api.js`
- Create: `tests/api.test.js`

- [ ] **Step 1: Write failing tests for API**

Create `tests/api.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-api.db');

let app, request;

before(async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = require('../db');
  db.init(TEST_DB_PATH);

  const express = require('express');
  app = express();
  app.use(express.json());

  const apiRouter = require('../routes/api');
  app.use('/api', apiRouter);

  const supertest = (await import('supertest')).default;
  request = supertest(app);
});

after(() => {
  const db = require('../db');
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('POST /api/servers', () => {
  it('should add a server', async () => {
    const res = await request.post('/api/servers').send({
      name: 'test-srv', ip: '100.64.0.1', mode: 'agent'
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.name, 'test-srv');
    assert.ok(res.body.id);
  });

  it('should reject invalid IP', async () => {
    const res = await request.post('/api/servers').send({
      name: 'bad', ip: 'not-an-ip', mode: 'agent'
    });
    assert.strictEqual(res.status, 400);
  });
});

describe('GET /api/servers', () => {
  it('should list servers', async () => {
    const res = await request.get('/api/servers');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 1);
  });
});

describe('PUT /api/servers/:id', () => {
  it('should update a server', async () => {
    const list = await request.get('/api/servers');
    const id = list.body[0].id;
    const res = await request.put(`/api/servers/${id}`).send({ name: 'updated' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'updated');
  });

  it('should 404 for unknown id', async () => {
    const res = await request.put('/api/servers/nonexistent').send({ name: 'x' });
    assert.strictEqual(res.status, 404);
  });
});

describe('DELETE /api/servers/:id', () => {
  it('should delete a server', async () => {
    const list = await request.get('/api/servers');
    const id = list.body[0].id;
    const res = await request.delete(`/api/servers/${id}`);
    assert.strictEqual(res.status, 204);

    const after = await request.get('/api/servers');
    assert.strictEqual(after.body.length, 0);
  });
});

describe('GET /api/servers/:id/metrics', () => {
  it('should return metrics', async () => {
    const addRes = await request.post('/api/servers').send({
      name: 'metrics-srv', ip: '100.64.0.2', mode: 'agent'
    });
    const id = addRes.body.id;
    const db = require('../db');
    db.insertMetrics(id, { cpu_percent: 50, ram_total: 8e9, ram_used: 4e9, igpu_percent: null, igpu_mem_used: null });

    const res = await request.get(`/api/servers/${id}/metrics?range=24`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
  });
});

describe('GET /api/servers/:id/pm2', () => {
  it('should return pm2 apps', async () => {
    const list = await request.get('/api/servers');
    const id = list.body[0].id;
    const db = require('../db');
    db.upsertPm2Apps(id, [{ pm_id: 0, name: 'app1', status: 'online', cpu: 1, memory: 1000, uptime: 5000, restarts: 0 }]);

    const res = await request.get(`/api/servers/${id}/pm2`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
  });
});

describe('GET /api/servers/:id/logs/:appName', () => {
  it('should return logs', async () => {
    const list = await request.get('/api/servers');
    const id = list.body[0].id;
    const db = require('../db');
    db.insertLogs(id, 'app1', [{ log_type: 'out', message: 'hello' }]);

    const res = await request.get(`/api/servers/${id}/logs/app1?lines=100`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server-monitor && npm test`
Expected: FAIL — `Cannot find module '../routes/api'`

- [ ] **Step 3: Implement routes/api.js**

Create `routes/api.js`:

```js
const express = require('express');
const router = express.Router();
const db = require('../db');

function isValidIp(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

// List all servers
router.get('/servers', (req, res) => {
  const servers = db.getServers();
  res.json(servers);
});

// Add server
router.post('/servers', (req, res) => {
  const { name, ip, mode, ssh_user, ssh_key_path, ssh_password } = req.body;

  if (!name || !ip) {
    return res.status(400).json({ error: 'name and ip are required' });
  }
  if (!isValidIp(ip)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  const server = db.addServer({ name, ip, mode, ssh_user, ssh_key_path, ssh_password });
  res.status(201).json(server);
});

// Update server
router.put('/servers/:id', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (req.body.ip && !isValidIp(req.body.ip)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  const updated = db.updateServer(req.params.id, req.body);
  res.json(updated);
});

// Delete server
router.delete('/servers/:id', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  db.deleteServer(req.params.id);
  res.status(204).end();
});

// Get metrics
router.get('/servers/:id/metrics', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const range = parseInt(req.query.range) || 24;
  const metrics = db.getMetrics(req.params.id, range);
  res.json(metrics);
});

// Get PM2 apps
router.get('/servers/:id/pm2', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const apps = db.getPm2Apps(req.params.id);
  res.json(apps);
});

// Get logs
router.get('/servers/:id/logs/:appName', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const lines = parseInt(req.query.lines) || 200;
  const logs = db.getLogs(req.params.id, req.params.appName, lines);
  res.json(logs);
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server-monitor && npm test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add routes/api.js tests/api.test.js
git commit -m "feat: add REST API routes for servers, metrics, pm2, logs"
```

---

### Task 4: Agent WebSocket Server

**Files:**
- Create: `agent-server.js`

- [ ] **Step 1: Implement agent-server.js**

```js
const { Server } = require('socket.io');
const db = require('./db');

let browserIo = null;

function createAgentServer(httpServer, _browserIo) {
  browserIo = _browserIo;

  const agentIo = new Server(httpServer, {
    path: '/agent',
    cors: { origin: '*' }
  });

  agentIo.on('connection', (socket) => {
    let serverId = null;

    console.log(`[Agent] New connection from ${socket.handshake.address}`);

    socket.on('register', (data) => {
      const { hostname, ip } = data;
      console.log(`[Agent] Register: ${hostname} (${ip})`);

      let server = db.findServerByIp(ip);
      if (server) {
        serverId = server.id;
        db.updateServerStatus(serverId, 'online');
      } else {
        // Auto-register unknown agents
        const newServer = db.addServer({ name: hostname, ip, mode: 'agent' });
        serverId = newServer.id;
        db.updateServerStatus(serverId, 'online');
      }

      if (browserIo) {
        browserIo.emit('server:status', { serverId, status: 'online', lastSeen: Math.floor(Date.now() / 1000) });
      }
    });

    socket.on('heartbeat', (data) => {
      if (!serverId) return;

      const { metrics, pm2 } = data;

      db.updateServerStatus(serverId, 'online');
      db.insertMetrics(serverId, metrics);

      if (pm2 && pm2.length >= 0) {
        db.upsertPm2Apps(serverId, pm2);
      }

      if (browserIo) {
        browserIo.emit('server:update', { serverId, metrics, pm2 });
      }
    });

    socket.on('logs', (data) => {
      if (!serverId) return;

      const { appName, logType, lines } = data;
      const logEntries = lines.map(msg => ({ log_type: logType, message: msg }));
      db.insertLogs(serverId, appName, logEntries);

      if (browserIo) {
        for (const msg of lines) {
          browserIo.emit('server:log', { serverId, appName, logType, message: msg });
        }
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Agent] Disconnected: ${serverId || 'unknown'}`);
      // Don't immediately mark offline — let the heartbeat timeout handle it
    });
  });

  return agentIo;
}

module.exports = { createAgentServer };
```

- [ ] **Step 2: Commit**

```bash
git add agent-server.js
git commit -m "feat: add agent WebSocket server for receiving heartbeats"
```

---

### Task 5: SSH Poller

**Files:**
- Create: `ssh-poller.js`

- [ ] **Step 1: Implement ssh-poller.js**

```js
const { NodeSSH } = require('node-ssh');
const db = require('./db');

const connections = new Map(); // serverId -> { ssh, failCount }
let browserIo = null;
let pollingIntervals = new Map();

function init(_browserIo) {
  browserIo = _browserIo;
}

function startPolling(server) {
  if (pollingIntervals.has(server.id)) return;

  console.log(`[SSH] Start polling ${server.name} (${server.ip})`);

  // Poll immediately, then every 30s
  pollServer(server);
  const interval = setInterval(() => pollServer(server), 30000);
  pollingIntervals.set(server.id, interval);
}

function stopPolling(serverId) {
  const interval = pollingIntervals.get(serverId);
  if (interval) {
    clearInterval(interval);
    pollingIntervals.delete(serverId);
  }
  const conn = connections.get(serverId);
  if (conn && conn.ssh) {
    conn.ssh.dispose();
    connections.delete(serverId);
  }
}

async function getConnection(server) {
  let conn = connections.get(server.id);
  if (conn && conn.ssh.isConnected()) return conn.ssh;

  const ssh = new NodeSSH();
  const config = {
    host: server.ip,
    username: server.ssh_user || 'root',
    readyTimeout: 10000,
    keepaliveInterval: 60000,
  };

  if (server.ssh_key_path) {
    config.privateKeyPath = server.ssh_key_path;
  } else if (server.ssh_password) {
    config.password = server.ssh_password;
  }

  await ssh.connect(config);
  connections.set(server.id, { ssh, failCount: 0 });
  return ssh;
}

async function pollServer(server) {
  // Refresh server data
  server = db.getServer(server.id);
  if (!server) {
    stopPolling(server.id);
    return;
  }

  try {
    const ssh = await getConnection(server);

    // Collect CPU + RAM
    const topResult = await ssh.execCommand('top -bn1 | head -5');
    const metrics = parseTopOutput(topResult.stdout);

    // Collect iGPU (optional)
    try {
      const gpuResult = await ssh.execCommand('timeout 2 intel_gpu_top -J -s 1000 -l 1 2>/dev/null');
      if (gpuResult.stdout) {
        const gpuData = parseIntelGpuOutput(gpuResult.stdout);
        if (gpuData) {
          metrics.igpu_percent = gpuData.igpu_percent;
          metrics.igpu_mem_used = gpuData.igpu_mem_used;
        }
      }
    } catch {
      // No iGPU or tool not installed — skip
    }

    // Collect PM2
    const pm2Result = await ssh.execCommand('pm2 jlist 2>/dev/null');
    let pm2Apps = [];
    if (pm2Result.stdout) {
      try {
        const raw = JSON.parse(pm2Result.stdout);
        pm2Apps = raw.map(p => ({
          pm_id: p.pm_id,
          name: p.name,
          status: p.pm2_env ? p.pm2_env.status : 'unknown',
          cpu: p.monit ? p.monit.cpu : 0,
          memory: p.monit ? p.monit.memory : 0,
          uptime: p.pm2_env ? (Date.now() - p.pm2_env.pm_uptime) : 0,
          restarts: p.pm2_env ? p.pm2_env.restart_time : 0
        }));
      } catch { /* ignore parse error */ }
    }

    // Collect PM2 logs
    const logsResult = await ssh.execCommand('pm2 logs --nostream --lines 50 2>/dev/null');
    if (logsResult.stdout) {
      const parsedLogs = parsePm2Logs(logsResult.stdout);
      for (const [appName, lines] of Object.entries(parsedLogs)) {
        db.insertLogs(server.id, appName, lines);
      }
    }

    // Save to DB
    db.updateServerStatus(server.id, 'online');
    db.insertMetrics(server.id, metrics);
    if (pm2Apps.length >= 0) {
      db.upsertPm2Apps(server.id, pm2Apps);
    }

    // Notify browser
    if (browserIo) {
      browserIo.emit('server:update', { serverId: server.id, metrics, pm2: pm2Apps });
      browserIo.emit('server:status', { serverId: server.id, status: 'online', lastSeen: Math.floor(Date.now() / 1000) });
    }

    // Reset fail count
    const conn = connections.get(server.id);
    if (conn) conn.failCount = 0;

  } catch (err) {
    console.error(`[SSH] Poll failed for ${server.name}: ${err.message}`);

    let conn = connections.get(server.id);
    if (!conn) conn = { failCount: 0 };
    conn.failCount++;
    connections.set(server.id, conn);

    if (conn.failCount >= 3) {
      console.log(`[SSH] ${server.name} marked offline after 3 failures. Retry in 5 min.`);
      db.updateServerStatus(server.id, 'offline');

      if (browserIo) {
        browserIo.emit('server:status', { serverId: server.id, status: 'offline', lastSeen: server.last_seen });
      }

      // Switch to slow retry (5 min)
      stopPolling(server.id);
      setTimeout(() => startPolling(server), 300000);
    }
  }
}

function parseTopOutput(output) {
  const metrics = { cpu_percent: 0, ram_total: 0, ram_used: 0, igpu_percent: null, igpu_mem_used: null };

  const lines = output.split('\n');
  for (const line of lines) {
    // Parse CPU line: %Cpu(s):  5.3 us,  2.1 sy, ...
    if (line.includes('Cpu')) {
      const match = line.match(/([\d.]+)\s*us.*?([\d.]+)\s*sy/);
      if (match) {
        metrics.cpu_percent = parseFloat(match[1]) + parseFloat(match[2]);
      }
    }
    // Parse memory line: MiB Mem :  7963.3 total,   234.5 free,  3456.7 used, ...
    if (line.includes('Mem')) {
      const totalMatch = line.match(/([\d.]+)\s*total/);
      const usedMatch = line.match(/([\d.]+)\s*used/);
      if (totalMatch) metrics.ram_total = Math.round(parseFloat(totalMatch[1]) * 1024 * 1024);
      if (usedMatch) metrics.ram_used = Math.round(parseFloat(usedMatch[1]) * 1024 * 1024);
    }
  }

  return metrics;
}

function parseIntelGpuOutput(output) {
  try {
    const data = JSON.parse(output);
    const engines = data.engines || {};
    let totalBusy = 0;
    let count = 0;
    for (const engine of Object.values(engines)) {
      if (engine.busy !== undefined) {
        totalBusy += engine.busy;
        count++;
      }
    }
    return {
      igpu_percent: count > 0 ? totalBusy / count : 0,
      igpu_mem_used: 0
    };
  } catch {
    return null;
  }
}

function parsePm2Logs(output) {
  const logs = {};
  const lines = output.split('\n');
  for (const line of lines) {
    // Format: "PM2  | App [name] ..." or "[TAILING] ..." or actual log lines
    // Typical: "0|app-name  | log message here"
    const match = line.match(/^(\d+)\|(\S+)\s*\|\s*(.*)$/);
    if (match) {
      const appName = match[2];
      const message = match[3];
      if (!logs[appName]) logs[appName] = [];
      logs[appName].push({ log_type: 'out', message });
    }
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

module.exports = { init, startPolling, stopPolling, startAllPolling, parseTopOutput, parsePm2Logs };
```

- [ ] **Step 2: Commit**

```bash
git add ssh-poller.js
git commit -m "feat: add SSH poller with auto-retry and fallback logic"
```

---

### Task 6: Cleanup Job

**Files:**
- Create: `cleanup.js`

- [ ] **Step 1: Implement cleanup.js**

```js
const db = require('./db');

let intervalHandle = null;

function start() {
  console.log('[Cleanup] Started — runs every hour');

  // Run immediately on start
  run();

  // Then every hour
  intervalHandle = setInterval(run, 3600000);
}

function run() {
  try {
    db.cleanupOldMetrics();
    db.cleanupExcessLogs();
    console.log(`[Cleanup] Done at ${new Date().toISOString()}`);
  } catch (err) {
    console.error(`[Cleanup] Error: ${err.message}`);
  }
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop, run };
```

- [ ] **Step 2: Commit**

```bash
git add cleanup.js
git commit -m "feat: add hourly cleanup job for old metrics and excess logs"
```

---

### Task 7: Heartbeat Monitor

**Files:**
- Create: `heartbeat.js`

This checks all servers and marks them offline if no data received for >60s.

- [ ] **Step 1: Implement heartbeat.js**

```js
const db = require('./db');
const sshPoller = require('./ssh-poller');

let intervalHandle = null;
let browserIo = null;

function start(_browserIo) {
  browserIo = _browserIo;
  intervalHandle = setInterval(check, 15000); // Check every 15s
  console.log('[Heartbeat] Monitor started — checking every 15s');
}

function check() {
  const now = Math.floor(Date.now() / 1000);
  const servers = db.getServers();

  for (const server of servers) {
    if (server.status === 'online' && server.last_seen > 0 && (now - server.last_seen) > 60) {
      console.log(`[Heartbeat] ${server.name} timed out — marking offline`);
      db.updateServerStatus(server.id, 'offline');

      if (browserIo) {
        browserIo.emit('server:status', { serverId: server.id, status: 'offline', lastSeen: server.last_seen });
      }

      // If agent-mode server has SSH config, try SSH fallback
      if (server.mode === 'agent' && (server.ssh_user || server.ssh_key_path || server.ssh_password)) {
        console.log(`[Heartbeat] Attempting SSH fallback for ${server.name}`);
        sshPoller.startPolling(server);
      }
    }
  }
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop };
```

- [ ] **Step 2: Commit**

```bash
git add heartbeat.js
git commit -m "feat: add heartbeat monitor with SSH auto-fallback"
```

---

### Task 8: Main Server Entry Point

**Files:**
- Create: `server.js`

- [ ] **Step 1: Implement server.js**

```js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const db = require('./db');
const apiRouter = require('./routes/api');
const { createAgentServer } = require('./agent-server');
const sshPoller = require('./ssh-poller');
const cleanup = require('./cleanup');
const heartbeat = require('./heartbeat');

// Initialize database
db.init();

// Express app
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', apiRouter);
app.get('/', (req, res) => {
  res.render('index');
});

// HTTP server
const server = http.createServer(app);

// Browser Socket.IO (port 3000, same as Express)
const browserIo = new Server(server);
browserIo.on('connection', (socket) => {
  console.log(`[Browser] Client connected`);
  socket.on('disconnect', () => {
    console.log(`[Browser] Client disconnected`);
  });
});

// Agent Socket.IO (same HTTP server, different path)
createAgentServer(server, browserIo);

// SSH Poller
sshPoller.init(browserIo);
sshPoller.startAllPolling();

// Heartbeat monitor
heartbeat.start(browserIo);

// Cleanup job
cleanup.start();

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Dashboard running at http://localhost:${PORT}`);
  console.log(`[Server] Agent WebSocket path: /agent`);
});
```

- [ ] **Step 2: Test that server starts**

Run:
```bash
cd server-monitor
node server.js
```
Expected: Console shows `[Server] Dashboard running at http://localhost:3000`. Kill with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add main server entry point wiring all components"
```

---

### Task 9: Frontend — EJS Templates + CSS

**Files:**
- Create: `views/layout.ejs`
- Create: `views/index.ejs`
- Create: `public/css/style.css`

- [ ] **Step 1: Create layout.ejs**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server Monitor</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <%- body %>
  <script src="/socket.io/socket.io.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <script src="/js/charts.js"></script>
  <script src="/js/logs.js"></script>
  <script src="/js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create index.ejs**

```html
<% var body = `
<div class="dashboard">
  <header>
    <h1>Server Monitor</h1>
    <button id="btn-add-server" class="btn btn-primary">+ Add Server</button>
  </header>

  <div id="server-grid" class="server-grid">
    <!-- Server cards rendered by JS -->
  </div>

  <div id="server-detail" class="server-detail hidden">
    <div class="detail-header">
      <h2 id="detail-server-name"></h2>
      <span id="detail-server-status" class="status-badge"></span>
      <button id="btn-close-detail" class="btn btn-sm">Close</button>
      <button id="btn-edit-server" class="btn btn-sm">Edit</button>
      <button id="btn-delete-server" class="btn btn-sm btn-danger">Delete</button>
    </div>

    <div class="charts-container">
      <div class="chart-box">
        <h3>CPU %</h3>
        <canvas id="chart-cpu"></canvas>
      </div>
      <div class="chart-box">
        <h3>RAM Usage</h3>
        <canvas id="chart-ram"></canvas>
      </div>
      <div class="chart-box">
        <h3>iGPU %</h3>
        <canvas id="chart-igpu"></canvas>
      </div>
    </div>

    <div class="pm2-section">
      <h3>PM2 Processes</h3>
      <table class="pm2-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Status</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Uptime</th>
            <th>Restarts</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="pm2-tbody"></tbody>
      </table>
    </div>

    <div id="log-viewer" class="log-viewer hidden">
      <div class="log-header">
        <h3>Logs: <span id="log-app-name"></span></h3>
        <button id="btn-close-logs" class="btn btn-sm">Close</button>
      </div>
      <div id="log-content" class="log-content"></div>
    </div>
  </div>

  <!-- Add Server Modal -->
  <div id="modal-add-server" class="modal hidden">
    <div class="modal-content">
      <h2 id="modal-title">Add Server</h2>
      <form id="form-server">
        <input type="hidden" id="form-server-id">
        <label>Name</label>
        <input type="text" id="form-name" required placeholder="e.g. server-a">
        <label>Tailscale IP</label>
        <input type="text" id="form-ip" required placeholder="100.x.x.x">
        <label>Mode</label>
        <select id="form-mode">
          <option value="agent">Agent</option>
          <option value="ssh">SSH</option>
        </select>
        <div id="ssh-fields" class="hidden">
          <label>SSH User</label>
          <input type="text" id="form-ssh-user" placeholder="root">
          <label>SSH Key Path</label>
          <input type="text" id="form-ssh-key" placeholder="/path/to/key">
          <label>SSH Password</label>
          <input type="password" id="form-ssh-password" placeholder="(optional)">
        </div>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" id="btn-cancel-modal" class="btn">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</div>
` %>
<%- include('layout', { body }) %>
```

Note: Actually, EJS `include` with layout pattern is simpler inline. Revise — use `layout.ejs` as the wrapper and render `index.ejs` content directly. Update approach:

`views/index.ejs` should be a full standalone file that includes the layout inline:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server Monitor</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
<div class="dashboard">
  <header>
    <h1>Server Monitor</h1>
    <button id="btn-add-server" class="btn btn-primary">+ Add Server</button>
  </header>

  <div id="server-grid" class="server-grid"></div>

  <div id="server-detail" class="server-detail hidden">
    <div class="detail-header">
      <h2 id="detail-server-name"></h2>
      <span id="detail-server-status" class="status-badge"></span>
      <button id="btn-close-detail" class="btn btn-sm">Close</button>
      <button id="btn-edit-server" class="btn btn-sm">Edit</button>
      <button id="btn-delete-server" class="btn btn-sm btn-danger">Delete</button>
    </div>

    <div class="charts-container">
      <div class="chart-box">
        <h3>CPU %</h3>
        <canvas id="chart-cpu"></canvas>
      </div>
      <div class="chart-box">
        <h3>RAM</h3>
        <canvas id="chart-ram"></canvas>
      </div>
      <div class="chart-box">
        <h3>iGPU %</h3>
        <canvas id="chart-igpu"></canvas>
      </div>
    </div>

    <div class="pm2-section">
      <h3>PM2 Processes</h3>
      <table class="pm2-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Status</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Uptime</th>
            <th>Restarts</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="pm2-tbody"></tbody>
      </table>
    </div>

    <div id="log-viewer" class="log-viewer hidden">
      <div class="log-header">
        <h3>Logs: <span id="log-app-name"></span></h3>
        <button id="btn-close-logs" class="btn btn-sm">Close</button>
      </div>
      <div id="log-content" class="log-content"></div>
    </div>
  </div>

  <!-- Add/Edit Server Modal -->
  <div id="modal-add-server" class="modal hidden">
    <div class="modal-content">
      <h2 id="modal-title">Add Server</h2>
      <form id="form-server">
        <input type="hidden" id="form-server-id">
        <label>Name</label>
        <input type="text" id="form-name" required placeholder="e.g. server-a">
        <label>Tailscale IP</label>
        <input type="text" id="form-ip" required placeholder="100.x.x.x">
        <label>Mode</label>
        <select id="form-mode">
          <option value="agent">Agent</option>
          <option value="ssh">SSH</option>
        </select>
        <div id="ssh-fields" class="hidden">
          <label>SSH User</label>
          <input type="text" id="form-ssh-user" placeholder="root">
          <label>SSH Key Path</label>
          <input type="text" id="form-ssh-key" placeholder="/path/to/key">
          <label>SSH Password</label>
          <input type="password" id="form-ssh-password" placeholder="(optional)">
        </div>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" id="btn-cancel-modal" class="btn">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="/js/charts.js"></script>
<script src="/js/logs.js"></script>
<script src="/js/app.js"></script>
</body>
</html>
```

Delete `views/layout.ejs` — not needed with this approach.

- [ ] **Step 3: Create public/css/style.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  background: #1a1a2e;
  color: #e0e0e0;
  min-height: 100vh;
}

.dashboard { max-width: 1400px; margin: 0 auto; padding: 20px; }

header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #0f3460;
}

header h1 { font-size: 24px; font-weight: 600; }

/* Buttons */
.btn {
  padding: 8px 16px; border: 1px solid #0f3460; border-radius: 6px;
  background: #16213e; color: #e0e0e0; cursor: pointer; font-size: 14px;
  transition: background 0.2s;
}
.btn:hover { background: #0f3460; }
.btn-primary { background: #0f3460; border-color: #1a4080; }
.btn-primary:hover { background: #1a4080; }
.btn-danger { border-color: #cc3333; color: #ff6666; }
.btn-danger:hover { background: #441111; }
.btn-sm { padding: 4px 10px; font-size: 12px; }

/* Server Grid */
.server-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px; margin-bottom: 24px;
}

.server-card {
  background: #16213e; border: 2px solid #0f3460; border-radius: 10px;
  padding: 16px; cursor: pointer; transition: all 0.2s;
}
.server-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.server-card.online { border-color: #00c853; }
.server-card.offline { border-color: #555; opacity: 0.7; }

.server-card .card-header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
}
.server-card .card-header h3 { font-size: 16px; }

.status-dot {
  width: 10px; height: 10px; border-radius: 50%; display: inline-block;
}
.status-dot.online { background: #00c853; box-shadow: 0 0 6px #00c853; }
.status-dot.offline { background: #555; }

.card-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.card-metrics .metric { font-size: 13px; }
.card-metrics .metric-label { color: #888; font-size: 11px; }
.card-metrics .metric-value { font-weight: 600; font-size: 15px; }

.card-footer { margin-top: 12px; font-size: 12px; color: #666; }

/* Server Detail */
.server-detail {
  background: #16213e; border-radius: 10px; padding: 24px;
  border: 1px solid #0f3460;
}

.detail-header {
  display: flex; align-items: center; gap: 12px; margin-bottom: 20px;
  flex-wrap: wrap;
}
.detail-header h2 { font-size: 20px; }

.status-badge {
  padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;
}
.status-badge.online { background: #00c85322; color: #00c853; border: 1px solid #00c853; }
.status-badge.offline { background: #55555522; color: #888; border: 1px solid #555; }

/* Charts */
.charts-container {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  gap: 16px; margin-bottom: 24px;
}
.chart-box {
  background: #1a1a2e; border-radius: 8px; padding: 16px;
  border: 1px solid #0f3460;
}
.chart-box h3 { font-size: 14px; margin-bottom: 8px; color: #888; }

/* PM2 Table */
.pm2-section { margin-bottom: 24px; }
.pm2-section h3 { margin-bottom: 12px; }

.pm2-table { width: 100%; border-collapse: collapse; }
.pm2-table th, .pm2-table td {
  padding: 10px 12px; text-align: left; border-bottom: 1px solid #0f3460;
}
.pm2-table th { color: #888; font-size: 12px; text-transform: uppercase; }
.pm2-table td { font-size: 14px; }

.pm2-status { padding: 2px 8px; border-radius: 8px; font-size: 12px; font-weight: 600; }
.pm2-status.online { background: #00c85322; color: #00c853; }
.pm2-status.stopped { background: #ff980022; color: #ff9800; }
.pm2-status.errored { background: #ff333322; color: #ff3333; }

/* Log Viewer */
.log-viewer { margin-top: 16px; }
.log-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 8px;
}
.log-content {
  background: #111; border-radius: 8px; padding: 12px;
  font-family: 'Consolas', 'Monaco', monospace; font-size: 13px;
  max-height: 400px; overflow-y: auto; line-height: 1.6;
}
.log-line-out { color: #e0e0e0; }
.log-line-error { color: #ff6666; }

/* Modal */
.modal {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal-content {
  background: #16213e; border-radius: 12px; padding: 24px;
  width: 100%; max-width: 480px; border: 1px solid #0f3460;
}
.modal-content h2 { margin-bottom: 16px; }
.modal-content label {
  display: block; font-size: 13px; color: #888; margin: 12px 0 4px;
}
.modal-content input, .modal-content select {
  width: 100%; padding: 10px 12px; background: #1a1a2e; border: 1px solid #0f3460;
  border-radius: 6px; color: #e0e0e0; font-size: 14px;
}
.modal-content input:focus, .modal-content select:focus {
  outline: none; border-color: #1a4080;
}
.modal-actions { display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end; }

/* Utility */
.hidden { display: none !important; }
```

- [ ] **Step 4: Commit**

```bash
git add views/index.ejs public/css/style.css
git commit -m "feat: add dark theme UI with EJS template and CSS"
```

---

### Task 10: Frontend — JavaScript (app.js, charts.js, logs.js)

**Files:**
- Create: `public/js/charts.js`
- Create: `public/js/logs.js`
- Create: `public/js/app.js`

- [ ] **Step 1: Create public/js/charts.js**

```js
const Charts = (() => {
  const chartInstances = {};

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: {
        type: 'time' in (Chart.defaults.scales || {}) ? 'time' : 'linear',
        ticks: { color: '#888', maxTicksLimit: 8 },
        grid: { color: '#0f3460' }
      },
      y: {
        ticks: { color: '#888' },
        grid: { color: '#0f3460' },
        beginAtZero: true
      }
    },
    plugins: {
      legend: { display: false }
    }
  };

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function createChart(canvasId, label, color, unit) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    if (chartInstances[canvasId]) {
      chartInstances[canvasId].destroy();
    }

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label,
          data: [],
          borderColor: color,
          backgroundColor: color + '22',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        ...commonOptions,
        scales: {
          ...commonOptions.scales,
          x: { ...commonOptions.scales.x },
          y: {
            ...commonOptions.scales.y,
            max: unit === '%' ? 100 : undefined,
            ticks: {
              ...commonOptions.scales.y.ticks,
              callback: (v) => unit === 'GB' ? (v / 1073741824).toFixed(1) + ' GB' : v + (unit || '')
            }
          }
        }
      }
    });

    chartInstances[canvasId] = chart;
    return chart;
  }

  function updateChart(canvasId, metrics, valueKey) {
    const chart = chartInstances[canvasId];
    if (!chart) return;

    chart.data.labels = metrics.map(m => formatTime(m.timestamp));
    chart.data.datasets[0].data = metrics.map(m => m[valueKey]);
    chart.update('none');
  }

  function appendPoint(canvasId, timestamp, value) {
    const chart = chartInstances[canvasId];
    if (!chart) return;

    chart.data.labels.push(formatTime(timestamp));
    chart.data.datasets[0].data.push(value);

    // Keep max 8640 points (24h at 10s interval)
    if (chart.data.labels.length > 8640) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }

    chart.update('none');
  }

  function destroyAll() {
    for (const key of Object.keys(chartInstances)) {
      chartInstances[key].destroy();
      delete chartInstances[key];
    }
  }

  return { createChart, updateChart, appendPoint, destroyAll };
})();
```

- [ ] **Step 2: Create public/js/logs.js**

```js
const Logs = (() => {
  let currentServerId = null;
  let currentAppName = null;

  function open(serverId, appName) {
    currentServerId = serverId;
    currentAppName = appName;

    document.getElementById('log-viewer').classList.remove('hidden');
    document.getElementById('log-app-name').textContent = appName;
    document.getElementById('log-content').innerHTML = '<div class="log-line-out">Loading...</div>';

    fetch(`/api/servers/${serverId}/logs/${appName}?lines=200`)
      .then(r => r.json())
      .then(logs => {
        const container = document.getElementById('log-content');
        container.innerHTML = '';
        for (const log of logs) {
          appendLine(log.log_type, log.message);
        }
        container.scrollTop = container.scrollHeight;
      });
  }

  function close() {
    currentServerId = null;
    currentAppName = null;
    document.getElementById('log-viewer').classList.add('hidden');
  }

  function appendLine(logType, message) {
    const container = document.getElementById('log-content');
    if (!container) return;

    const div = document.createElement('div');
    div.className = logType === 'error' ? 'log-line-error' : 'log-line-out';
    div.textContent = message;
    container.appendChild(div);

    // Auto-scroll
    container.scrollTop = container.scrollHeight;
  }

  function handleNewLog(serverId, appName, logType, message) {
    if (serverId === currentServerId && appName === currentAppName) {
      appendLine(logType, message);
    }
  }

  return { open, close, handleNewLog };
})();
```

- [ ] **Step 3: Create public/js/app.js**

```js
const App = (() => {
  const socket = io();
  let servers = [];
  let selectedServerId = null;

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
            <div class="metric-label">RAM</div>
            <div class="metric-value" id="card-ram-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">iGPU</div>
            <div class="metric-value" id="card-igpu-${s.id}">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">PM2 Apps</div>
            <div class="metric-value" id="card-pm2-${s.id}">--</div>
          </div>
        </div>
        <div class="card-footer">
          ${s.status === 'offline' ? 'Last seen: ' + lastSeen : 'Mode: ' + s.mode}
        </div>
      `;

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

  function updateCardMetrics(serverId, m) {
    const cpuEl = document.getElementById(`card-cpu-${serverId}`);
    const ramEl = document.getElementById(`card-ram-${serverId}`);
    const igpuEl = document.getElementById(`card-igpu-${serverId}`);
    if (cpuEl) cpuEl.textContent = m.cpu_percent != null ? m.cpu_percent.toFixed(1) + '%' : '--';
    if (ramEl) ramEl.textContent = m.ram_used != null ? (m.ram_used / 1073741824).toFixed(1) + '/' + (m.ram_total / 1073741824).toFixed(1) + ' GB' : '--';
    if (igpuEl) igpuEl.textContent = m.igpu_percent != null ? m.igpu_percent.toFixed(1) + '%' : 'N/A';
  }

  // --- Server Detail ---
  function openDetail(serverId) {
    selectedServerId = serverId;
    const server = servers.find(s => s.id === serverId);
    if (!server) return;

    document.getElementById('server-detail').classList.remove('hidden');
    document.getElementById('detail-server-name').textContent = server.name;

    const badge = document.getElementById('detail-server-status');
    badge.textContent = server.status;
    badge.className = `status-badge ${server.status}`;

    // Load charts
    Charts.createChart('chart-cpu', 'CPU %', '#00c853', '%');
    Charts.createChart('chart-ram', 'RAM', '#2196f3', 'GB');
    Charts.createChart('chart-igpu', 'iGPU %', '#ff9800', '%');

    fetch(`/api/servers/${serverId}/metrics?range=24`)
      .then(r => r.json())
      .then(metrics => {
        Charts.updateChart('chart-cpu', metrics, 'cpu_percent');
        Charts.updateChart('chart-ram', metrics, 'ram_used');
        Charts.updateChart('chart-igpu', metrics, 'igpu_percent');
      });

    // Load PM2 apps
    loadPm2Apps(serverId);

    // Close logs if open
    Logs.close();
  }

  function closeDetail() {
    selectedServerId = null;
    document.getElementById('server-detail').classList.add('hidden');
    Charts.destroyAll();
    Logs.close();
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
        <td><button class="btn btn-sm btn-logs" data-app="${esc(app.name)}">Logs</button></td>
      `;
      tbody.appendChild(tr);
    }

    // Bind log buttons
    tbody.querySelectorAll('.btn-logs').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Logs.open(serverId, btn.dataset.app);
      });
    });
  }

  // --- Modal ---
  function openAddModal() {
    document.getElementById('modal-title').textContent = 'Add Server';
    document.getElementById('form-server-id').value = '';
    document.getElementById('form-name').value = '';
    document.getElementById('form-ip').value = '';
    document.getElementById('form-mode').value = 'agent';
    document.getElementById('form-ssh-user').value = '';
    document.getElementById('form-ssh-key').value = '';
    document.getElementById('form-ssh-password').value = '';
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
    document.getElementById('form-ssh-user').value = server.ssh_user || '';
    document.getElementById('form-ssh-key').value = server.ssh_key_path || '';
    document.getElementById('form-ssh-password').value = '';
    document.getElementById('ssh-fields').classList.toggle('hidden', server.mode !== 'ssh');
    document.getElementById('modal-add-server').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modal-add-server').classList.add('hidden');
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('form-server-id').value;
    const body = {
      name: document.getElementById('form-name').value,
      ip: document.getElementById('form-ip').value,
      mode: document.getElementById('form-mode').value,
      ssh_user: document.getElementById('form-ssh-user').value || null,
      ssh_key_path: document.getElementById('form-ssh-key').value || null,
      ssh_password: document.getElementById('form-ssh-password').value || null,
    };

    const url = id ? `/api/servers/${id}` : '/api/servers';
    const method = id ? 'PUT' : 'POST';

    fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error); });
        return r.json();
      })
      .then(() => {
        closeModal();
        loadServers();
      })
      .catch(err => alert('Error: ' + err.message));
  }

  function handleDelete() {
    if (!selectedServerId) return;
    if (!confirm('Delete this server?')) return;

    fetch(`/api/servers/${selectedServerId}`, { method: 'DELETE' })
      .then(() => {
        closeDetail();
        loadServers();
      });
  }

  // --- Socket.IO ---
  function bindSocket() {
    socket.on('server:update', (data) => {
      const { serverId, metrics, pm2 } = data;

      // Update card
      updateCardMetrics(serverId, metrics);
      const pm2El = document.getElementById(`card-pm2-${serverId}`);
      if (pm2El && pm2) pm2El.textContent = pm2.length;

      // Update detail if open
      if (serverId === selectedServerId) {
        const ts = Math.floor(Date.now() / 1000);
        Charts.appendPoint('chart-cpu', ts, metrics.cpu_percent);
        Charts.appendPoint('chart-ram', ts, metrics.ram_used);
        if (metrics.igpu_percent != null) {
          Charts.appendPoint('chart-igpu', ts, metrics.igpu_percent);
        }
        if (pm2) renderPm2Table(serverId, pm2);
      }
    });

    socket.on('server:status', (data) => {
      const { serverId, status } = data;
      const server = servers.find(s => s.id === serverId);
      if (server) {
        server.status = status;
        renderGrid();
      }

      if (serverId === selectedServerId) {
        const badge = document.getElementById('detail-server-status');
        badge.textContent = status;
        badge.className = `status-badge ${status}`;
      }
    });

    socket.on('server:log', (data) => {
      Logs.handleNewLog(data.serverId, data.appName, data.logType, data.message);
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
    document.getElementById('btn-close-logs').addEventListener('click', () => Logs.close());

    document.getElementById('form-mode').addEventListener('change', (e) => {
      document.getElementById('ssh-fields').classList.toggle('hidden', e.target.value !== 'ssh');
    });

    // Close modal on backdrop click
    document.getElementById('modal-add-server').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) closeModal();
    });
  }

  // --- Helpers ---
  function esc(str) {
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

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
```

- [ ] **Step 4: Verify dashboard loads**

Run:
```bash
cd server-monitor
node server.js
```
Open browser at `http://localhost:3000`. Expected: Dark themed dashboard with empty grid and working "Add Server" button.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js public/js/charts.js public/js/logs.js
git commit -m "feat: add frontend JS — real-time grid, charts, logs, modal"
```

---

### Task 11: Agent Code

**Files:**
- Create: `agent/package.json`
- Create: `agent/agent-config.json`
- Create: `agent/agent.js`

- [ ] **Step 1: Create agent/package.json**

```json
{
  "name": "server-monitor-agent",
  "version": "1.0.0",
  "description": "Lightweight monitoring agent",
  "main": "agent.js",
  "dependencies": {
    "socket.io-client": "^4.7.5"
  }
}
```

- [ ] **Step 2: Create agent/agent-config.json**

```json
{
  "dashboard_url": "ws://DASHBOARD_TAILSCALE_IP:3000",
  "interval": 10000,
  "server_name": "my-server"
}
```

- [ ] **Step 3: Create agent/agent.js**

```js
const { io } = require('socket.io-client');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load config
const configPath = path.join(__dirname, 'agent-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const DASHBOARD_URL = config.dashboard_url;
const INTERVAL = config.interval || 10000;
const SERVER_NAME = config.server_name || os.hostname();

console.log(`[Agent] Connecting to ${DASHBOARD_URL}...`);

const socket = io(DASHBOARD_URL, {
  path: '/agent',
  reconnection: true,
  reconnectionDelay: 5000,
  reconnectionDelayMax: 30000,
});

// Detect own Tailscale IP
function getTailscaleIp() {
  try {
    const output = execSync('tailscale ip -4 2>/dev/null || ip addr show tailscale0 2>/dev/null | grep inet | awk \'{print $2}\' | cut -d/ -f1', { encoding: 'utf8' });
    return output.trim().split('\n')[0];
  } catch {
    return '0.0.0.0';
  }
}

// CPU usage from /proc/stat
let prevCpu = null;

function getCpuPercent() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const line = stat.split('\n')[0]; // "cpu  user nice system idle ..."
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + parts[4];
    const total = parts.reduce((a, b) => a + b, 0);

    if (prevCpu) {
      const idleDiff = idle - prevCpu.idle;
      const totalDiff = total - prevCpu.total;
      prevCpu = { idle, total };
      return totalDiff > 0 ? ((1 - idleDiff / totalDiff) * 100) : 0;
    }

    prevCpu = { idle, total };
    return 0;
  } catch {
    return 0;
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
    const data = JSON.parse(output);
    const engines = data.engines || {};
    let totalBusy = 0, count = 0;
    for (const engine of Object.values(engines)) {
      if (engine.busy !== undefined) {
        totalBusy += engine.busy;
        count++;
      }
    }
    return { igpu_percent: count > 0 ? totalBusy / count : 0, igpu_mem_used: 0 };
  } catch {
    return { igpu_percent: null, igpu_mem_used: null };
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
const tailscaleIp = getTailscaleIp();

socket.on('connect', () => {
  console.log(`[Agent] Connected! Registering as ${SERVER_NAME} (${tailscaleIp})`);
  socket.emit('register', { hostname: SERVER_NAME, ip: tailscaleIp });
});

socket.on('disconnect', (reason) => {
  console.log(`[Agent] Disconnected: ${reason}`);
});

socket.on('connect_error', (err) => {
  console.log(`[Agent] Connection error: ${err.message}`);
});

// Heartbeat loop
setInterval(() => {
  if (!socket.connected) return;

  const cpu_percent = getCpuPercent();
  const { ram_total, ram_used } = getRamInfo();
  const { igpu_percent, igpu_mem_used } = getIgpuInfo();
  const pm2 = getPm2Apps();

  socket.emit('heartbeat', {
    metrics: { cpu_percent, ram_total, ram_used, igpu_percent, igpu_mem_used },
    pm2
  });

  console.log(`[Agent] Heartbeat sent — CPU: ${cpu_percent.toFixed(1)}%, RAM: ${(ram_used/1073741824).toFixed(1)}GB, PM2: ${pm2.length} apps`);
}, INTERVAL);

console.log(`[Agent] Started. Heartbeat every ${INTERVAL/1000}s`);
```

- [ ] **Step 4: Commit**

```bash
git add agent/
git commit -m "feat: add monitoring agent for Linux servers"
```

---

### Task 12: Agent Setup Documentation

**Files:**
- Create: `docs/agent-setup.txt`

- [ ] **Step 1: Write agent-setup.txt**

```
=== Server Monitor Agent — Installation Guide ===

Prerequisites:
- Node.js 18+ installed
- PM2 installed globally (npm install -g pm2)
- Tailscale connected

Steps:

1. Copy the agent folder to the server:
   scp -r agent/ user@100.x.x.x:~/monitor-agent/

2. SSH into the server:
   ssh user@100.x.x.x

3. Install dependencies:
   cd ~/monitor-agent
   npm install

4. Edit the config file:
   nano agent-config.json

   Change these values:
   - "dashboard_url": "ws://YOUR_DASHBOARD_TAILSCALE_IP:3000"
     (Replace with the Tailscale IP of the Windows machine running the dashboard)
   - "server_name": "my-server-name"
     (Give this server a recognizable name)
   - "interval": 10000
     (Heartbeat interval in ms. Default 10s is fine.)

5. Start the agent with PM2:
   pm2 start agent.js --name monitor-agent

6. Save PM2 process list (auto-start on boot):
   pm2 save
   pm2 startup
   (Follow the instructions pm2 prints to enable startup script)

7. Verify it's running:
   pm2 status
   pm2 logs monitor-agent

The agent will:
- Auto-connect to the dashboard
- Send CPU, RAM, iGPU metrics every 10s
- Send PM2 process list
- Auto-reconnect if dashboard restarts

Troubleshooting:
- "Connection error": Check Tailscale is running, dashboard IP is correct
- "pm2 jlist" fails: Make sure PM2 is installed globally
- No iGPU data: Install intel-gpu-tools (sudo apt install intel-gpu-tools)
  Note: intel_gpu_top requires root. Run agent with sudo or add user to video group.

To update the agent:
   pm2 stop monitor-agent
   (copy new agent.js)
   pm2 restart monitor-agent

To uninstall:
   pm2 delete monitor-agent
   pm2 save
   rm -rf ~/monitor-agent
```

- [ ] **Step 2: Commit**

```bash
git add docs/agent-setup.txt
git commit -m "docs: add agent installation guide"
```

---

### Task 13: Final Integration Test

- [ ] **Step 1: Start the dashboard**

Run:
```bash
cd server-monitor
node server.js
```

Expected output:
```
[Server] Dashboard running at http://localhost:3000
[Server] Agent WebSocket path: /agent
[Cleanup] Started — runs every hour
[Heartbeat] Monitor started — checking every 15s
```

- [ ] **Step 2: Open browser and verify UI**

Open `http://localhost:3000`. Verify:
- Dark theme loads correctly
- "Server Monitor" header visible
- "+ Add Server" button works
- Modal opens with form fields
- Mode dropdown toggles SSH fields

- [ ] **Step 3: Add a test server via UI**

In the modal:
- Name: `test-server`
- IP: `100.64.0.1`
- Mode: Agent
- Click Save

Verify: Server card appears in grid with "offline" status.

- [ ] **Step 4: Verify API directly**

Run in another terminal:
```bash
curl http://localhost:3000/api/servers
```
Expected: JSON array with the test server.

- [ ] **Step 5: Test delete**

Click the test server card → click Delete → confirm. Verify card disappears.

- [ ] **Step 6: Run unit tests**

```bash
cd server-monitor
npm test
```
Expected: All tests pass.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: final integration verification"
```
