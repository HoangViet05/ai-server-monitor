const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-monitor.db');

let db;

before(() => {
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


describe('git_pulls', () => {
  let testServerId;

  before(() => {
    const server = db.addServer({ 
      name: 'git-test-server', 
      ip: '100.64.0.10', 
      mode: 'agent',
      git_repo_path: '/test/repo'
    });
    testServerId = server.id;
  });

  it('should create a git pull record', () => {
    const pull = db.createGitPull(testServerId);
    assert.ok(pull.id);
    assert.strictEqual(pull.server_id, testServerId);
    assert.strictEqual(pull.status, 'running');
    assert.ok(pull.started_at > 0);
    assert.strictEqual(pull.completed_at, null);
  });

  it('should update a git pull record', () => {
    const pull = db.createGitPull(testServerId);
    const updated = db.updateGitPull(pull.id, {
      status: 'success',
      output: 'Already up to date.',
      completed_at: Math.floor(Date.now() / 1000)
    });
    assert.strictEqual(updated.status, 'success');
    assert.strictEqual(updated.output, 'Already up to date.');
    assert.ok(updated.completed_at > 0);
  });

  it('should get git pulls for a server', () => {
    const pulls = db.getGitPulls(testServerId, 10);
    assert.ok(pulls.length >= 2);
    assert.strictEqual(pulls[0].server_id, testServerId);
  });

  it('should get a specific git pull', () => {
    const pulls = db.getGitPulls(testServerId, 1);
    const pull = db.getGitPull(pulls[0].id);
    assert.ok(pull);
    assert.strictEqual(pull.id, pulls[0].id);
  });

  it('should handle git_repo_path in server operations', () => {
    const server = db.getServer(testServerId);
    assert.strictEqual(server.git_repo_path, '/test/repo');

    const updated = db.updateServer(testServerId, { git_repo_path: '/new/path' });
    assert.strictEqual(updated.git_repo_path, '/new/path');
  });

  it('should validate absolute path requirement', () => {
    // This is a frontend validation, but we can test the data model accepts it
    const server = db.addServer({
      name: 'path-test',
      ip: '100.64.0.11',
      mode: 'agent',
      git_repo_path: '/absolute/path'
    });
    assert.strictEqual(server.git_repo_path, '/absolute/path');
  });
});
