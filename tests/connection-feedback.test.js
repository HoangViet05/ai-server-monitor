/**
 * Bug Condition Exploration Tests - server-connection-feedback
 *
 * Property 1: Bug Condition - SSH Form Submit Without Connection Test
 * These tests MUST FAIL on unfixed code to confirm the bug exists.
 *
 * Bug Condition: isBugCondition(X) = X.mode = "ssh" AND X.action IN ["add","edit"]
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-connection-feedback.db');

let app, request;

before(async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = require('../db');
  db.init(TEST_DB_PATH);

  const express = require('express');
  app = express();
  app.use(express.json());

  const mockBrowserIo = { emit: () => {}, of: () => ({ sockets: new Map() }) };
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

// ---------------------------------------------------------------------------
// Property 1: Bug Condition Tests (MUST FAIL on unfixed code)
// ---------------------------------------------------------------------------

describe('Property 1: Bug Condition - POST /api/servers/:id/test-connection', () => {
  it('should have a test-connection endpoint (returns 200 or 500, not 404)', async () => {
    // Add an SSH server first
    const addRes = await request.post('/api/servers').send({
      name: 'ssh-test-srv',
      ip: '100.64.0.10',
      mode: 'ssh',
      ssh_user: 'root',
      ssh_key_path: '/root/.ssh/id_rsa',
    });
    assert.strictEqual(addRes.status, 201);
    const serverId = addRes.body.id;

    // The endpoint must exist - on unfixed code this returns 404 (route not defined)
    // EXPECTED FAILURE on unfixed code: 404 Not Found
    const res = await request.post(`/api/servers/${serverId}/test-connection`);
    assert.notStrictEqual(res.status, 404,
      'COUNTEREXAMPLE: POST /servers/:id/test-connection does not exist (404). Bug confirmed: no test-connection endpoint.');
  });

  it('should return 404 for non-existent server', async () => {
    const res = await request.post('/api/servers/nonexistent/test-connection');
    assert.strictEqual(res.status, 404);
  });

  it('should return 400 for agent-mode server (not SSH)', async () => {
    const addRes = await request.post('/api/servers').send({
      name: 'agent-srv',
      ip: '100.64.0.11',
      mode: 'agent',
    });
    const serverId = addRes.body.id;

    // Endpoint should reject non-SSH servers
    const res = await request.post(`/api/servers/${serverId}/test-connection`);
    // On unfixed code: 404 (route doesn't exist)
    // On fixed code: 400 (server is not SSH mode)
    assert.notStrictEqual(res.status, 404,
      'COUNTEREXAMPLE: endpoint does not exist. Bug confirmed.');
    assert.strictEqual(res.status, 400,
      'Should return 400 for agent-mode server');
  });

  it('should return success/failure object (not 404) when testing SSH connection', async () => {
    const list = await request.get('/api/servers');
    const sshServer = list.body.find(s => s.mode === 'ssh');
    if (!sshServer) return;

    const res = await request.post(`/api/servers/${sshServer.id}/test-connection`);
    // On unfixed code: 404
    // On fixed code: 200 with { success: true/false, ... }
    assert.notStrictEqual(res.status, 404,
      'COUNTEREXAMPLE: test-connection endpoint missing. Bug confirmed.');
    assert.ok(
      res.body.hasOwnProperty('success'),
      'Response must have a "success" property'
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Preservation Tests (MUST PASS on unfixed code)
// ---------------------------------------------------------------------------

describe('Property 2: Preservation - Agent mode and validation behavior unchanged', () => {
  it('should still add agent-mode server without SSH test (immediate save)', async () => {
    const res = await request.post('/api/servers').send({
      name: 'agent-preserve',
      ip: '100.64.0.20',
      mode: 'agent',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.mode, 'agent');
    assert.ok(res.body.id);
  });

  it('should still reject missing name (validation unchanged)', async () => {
    const res = await request.post('/api/servers').send({
      ip: '100.64.0.21',
      mode: 'ssh',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });

  it('should still reject invalid IP (validation unchanged)', async () => {
    const res = await request.post('/api/servers').send({
      name: 'bad-ip',
      ip: 'not-an-ip',
      mode: 'ssh',
    });
    assert.strictEqual(res.status, 400);
  });

  it('should still update server name without triggering SSH test', async () => {
    const addRes = await request.post('/api/servers').send({
      name: 'preserve-edit',
      ip: '100.64.0.22',
      mode: 'agent',
    });
    const id = addRes.body.id;

    const res = await request.put(`/api/servers/${id}`).send({ name: 'preserve-edit-updated' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'preserve-edit-updated');
  });

  it('should still delete server normally', async () => {
    const addRes = await request.post('/api/servers').send({
      name: 'to-delete',
      ip: '100.64.0.23',
      mode: 'agent',
    });
    const id = addRes.body.id;

    const res = await request.delete(`/api/servers/${id}`);
    assert.strictEqual(res.status, 204);
  });
});
