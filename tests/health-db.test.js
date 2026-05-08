const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-health.db');
let db;
let serverId;

before(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = require('../db');
  db.init(TEST_DB_PATH);
  const server = db.addServer({ name: 'health-srv', ip: '100.64.0.10', mode: 'agent' });
  serverId = server.id;
});

after(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('health_events', () => {
  it('inserts and retrieves events', () => {
    db.insertHealthEvent(serverId, {
      kind: 'host_health',
      ok: true,
      payload: { ram_used: 100, ram_total: 200 },
      errors: [],
      ts: 1700000000
    });
    const rows = db.getRecentHealthEvents(serverId, 1699000000);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, 'host_health');
    assert.strictEqual(rows[0].ok, 1);
    assert.deepStrictEqual(JSON.parse(rows[0].payload), { ram_used: 100, ram_total: 200 });
  });

  it('filters by kind', () => {
    db.insertHealthEvent(serverId, {
      kind: 'ext_deps', ok: false, payload: {}, errors: ['mongo timeout'], ts: 1700000100
    });
    const hostOnly = db.getRecentHealthEvents(serverId, 1699000000, 'host_health');
    assert.ok(hostOnly.every(r => r.kind === 'host_health'));
  });
});
