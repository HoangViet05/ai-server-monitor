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

  // Mock browserIo for git operations
  const mockBrowserIo = {
    emit: () => {},
    of: () => ({ sockets: new Map() })
  };
  app.set('browserIo', mockBrowserIo);

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

describe('POST /api/servers/:id/pull', () => {
  it('should reject pull without git_repo_path', async () => {
    const addRes = await request.post('/api/servers').send({
      name: 'no-git-srv', ip: '100.64.0.5', mode: 'agent'
    });
    const id = addRes.body.id;

    const res = await request.post(`/api/servers/${id}/pull`);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Git repository path not configured'));
  });

  it('should reject pull with non-absolute path', async () => {
    const addRes = await request.post('/api/servers').send({
      name: 'relative-path-srv', ip: '100.64.0.6', mode: 'agent',
      git_repo_path: 'relative/path'
    });
    const id = addRes.body.id;

    const res = await request.post(`/api/servers/${id}/pull`);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('absolute'));
  });

  it('should accept pull with valid git_repo_path', async () => {
    const addRes = await request.post('/api/servers').send({
      name: 'git-srv', ip: '100.64.0.7', mode: 'agent',
      git_repo_path: '/test/repo'
    });
    const id = addRes.body.id;

    // This will fail because server is offline, but validates the path
    const res = await request.post(`/api/servers/${id}/pull`);
    // Should be 503 (offline) or 500 (other error), not 400 (validation error)
    assert.ok(res.status === 503 || res.status === 500);
  });
});

describe('GET /api/servers/:id/pulls', () => {
  it('should return pull history', async () => {
    const list = await request.get('/api/servers');
    const server = list.body.find(s => s.git_repo_path);
    if (!server) return; // Skip if no server with git_repo_path

    const db = require('../db');
    const pull = db.createGitPull(server.id);
    db.updateGitPull(pull.id, { status: 'success', completed_at: Math.floor(Date.now() / 1000) });

    const res = await request.get(`/api/servers/${server.id}/pulls?limit=10`);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length > 0);
  });
});

describe('GET /api/pulls/:pullId', () => {
  it('should return pull details', async () => {
    const list = await request.get('/api/servers');
    const server = list.body.find(s => s.git_repo_path);
    if (!server) return; // Skip if no server with git_repo_path

    const db = require('../db');
    const pull = db.createGitPull(server.id);

    const res = await request.get(`/api/pulls/${pull.id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, pull.id);
    assert.strictEqual(res.body.server_id, server.id);
  });

  it('should 404 for unknown pull id', async () => {
    const res = await request.get('/api/pulls/nonexistent');
    assert.strictEqual(res.status, 404);
  });
});

describe('POST /api/pull-all', () => {
  it('should return empty array when no servers have git_repo_path', async () => {
    // Delete all servers with git_repo_path first
    const list = await request.get('/api/servers');
    for (const server of list.body) {
      if (server.git_repo_path) {
        await request.delete(`/api/servers/${server.id}`);
      }
    }

    const res = await request.post('/api/pull-all');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.operations.length, 0);
  });

  it('should initiate pulls on servers with git_repo_path', async () => {
    // Add servers with git_repo_path
    await request.post('/api/servers').send({
      name: 'git-srv-1', ip: '100.64.0.8', mode: 'agent',
      git_repo_path: '/test/repo1'
    });
    await request.post('/api/servers').send({
      name: 'git-srv-2', ip: '100.64.0.9', mode: 'agent',
      git_repo_path: '/test/repo2'
    });

    const res = await request.post('/api/pull-all');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.operations.length >= 2);
  });
});
