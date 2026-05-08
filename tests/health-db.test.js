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

describe('version_snapshots', () => {
  it('inserts and retrieves latest snapshot', () => {
    db.insertVersionSnapshot(serverId, {
      pip_freeze: { '/opt/venv': { torch: '2.0.1' } },
      system_pkgs: { tensorrt: '8.6.1' },
      node_pkgs: { node: '20.10.0' },
      ts: 1700000200
    });
    db.insertVersionSnapshot(serverId, {
      pip_freeze: { '/opt/venv': { torch: '2.0.2' } },
      system_pkgs: { tensorrt: '8.6.1' },
      node_pkgs: { node: '20.10.0' },
      ts: 1700000300
    });
    const latest = db.getLatestVersionSnapshot(serverId);
    assert.strictEqual(latest.ts, 1700000300);
    assert.deepStrictEqual(JSON.parse(latest.pip_freeze), { '/opt/venv': { torch: '2.0.2' } });
  });
});

describe('baselines', () => {
  it('saves baseline as active and deactivates previous', () => {
    const b1 = db.saveBaseline(serverId, {
      pip_freeze: { '/opt/venv': { torch: '2.0.1' } },
      system_pkgs: {}, node_pkgs: {}
    }, 'first');
    assert.strictEqual(b1.active, 1);
    const active1 = db.getActiveBaseline(serverId);
    assert.strictEqual(active1.id, b1.id);

    const b2 = db.saveBaseline(serverId, {
      pip_freeze: { '/opt/venv': { torch: '2.0.2' } },
      system_pkgs: {}, node_pkgs: {}
    }, 'second');
    const active2 = db.getActiveBaseline(serverId);
    assert.strictEqual(active2.id, b2.id);

    const all = db.listBaselines(serverId);
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all.filter(b => b.active === 1).length, 1);
  });

  it('acceptBaseline switches active flag', () => {
    const all = db.listBaselines(serverId);
    const oldOne = all.find(b => b.label === 'first');
    db.acceptBaseline(oldOne.id);
    const active = db.getActiveBaseline(serverId);
    assert.strictEqual(active.id, oldOne.id);
  });
});

describe('incidents', () => {
  let openId;

  it('opens a new incident via upsert', () => {
    const inc = db.upsertIncident(serverId, {
      kind: 'disk_full', severity: 'warn', title: 'Disk / 87%',
      details: { mount: '/', percent: 87 },
      suggested_actions: [{ label: 'Show largest folders', command: 'du -sh /var/log' }]
    });
    assert.ok(inc.id);
    assert.strictEqual(inc.severity, 'warn');
    assert.strictEqual(inc.closed_at, null);
    openId = inc.id;
  });

  it('upsert updates details of existing open incident (same kind)', () => {
    const inc = db.upsertIncident(serverId, {
      kind: 'disk_full', severity: 'critical', title: 'Disk / 96%',
      details: { mount: '/', percent: 96 }, suggested_actions: []
    });
    assert.strictEqual(inc.id, openId);
    assert.strictEqual(inc.severity, 'critical');
    const open = db.getOpenIncidents(serverId);
    assert.strictEqual(open.filter(i => i.kind === 'disk_full').length, 1);
  });

  it('ackIncident sets acked_at', () => {
    db.ackIncident(openId);
    const inc = db.getIncident(openId);
    assert.ok(inc.acked_at > 0);
    assert.strictEqual(inc.closed_at, null);
  });

  it('closeIncident sets closed_at and removes from open list', () => {
    db.closeIncident(openId);
    const inc = db.getIncident(openId);
    assert.ok(inc.closed_at > 0);
    const open = db.getOpenIncidents(serverId);
    assert.strictEqual(open.filter(i => i.id === openId).length, 0);
  });

  it('getIncidentHistory returns closed and open with filters', () => {
    db.upsertIncident(serverId, {
      kind: 'mongo_down', severity: 'critical', title: 'Mongo unreachable',
      details: {}, suggested_actions: []
    });
    const all = db.getIncidentHistory(serverId, 0);
    assert.ok(all.length >= 2);
    const onlyDisk = db.getIncidentHistory(serverId, 0, { kind: 'disk_full' });
    assert.ok(onlyDisk.every(i => i.kind === 'disk_full'));
  });
});
