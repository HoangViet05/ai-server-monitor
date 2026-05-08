const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { diffSection, computeVersionDrift } = require('../health-service');

describe('diffSection', () => {
  it('detects added/removed/changed', () => {
    const baseline = { torch: '2.0.1', numpy: '1.24.0', removed_pkg: '1.0' };
    const current = { torch: '2.0.2', numpy: '1.24.0', new_pkg: '0.1' };
    const diff = diffSection(baseline, current);
    assert.deepStrictEqual(diff.added, [{ pkg: 'new_pkg', version: '0.1' }]);
    assert.deepStrictEqual(diff.removed, [{ pkg: 'removed_pkg', version: '1.0' }]);
    assert.deepStrictEqual(diff.changed, [{ pkg: 'torch', from: '2.0.1', to: '2.0.2' }]);
  });

  it('returns empty arrays when identical', () => {
    const a = { torch: '2.0.1' };
    const diff = diffSection(a, { ...a });
    assert.strictEqual(diff.added.length, 0);
    assert.strictEqual(diff.removed.length, 0);
    assert.strictEqual(diff.changed.length, 0);
  });
});

describe('computeVersionDrift', () => {
  const baseline = {
    pip_freeze: { '/opt/venv': { torch: '2.0.1', requests: '2.31.0' } },
    system_pkgs: { tensorrt: '8.6.1' },
    node_pkgs: { node: '20.10.0', pm2: '5.3.0' }
  };

  it('returns null when no drift', () => {
    const drift = computeVersionDrift(baseline, baseline, { watchPip: ['torch'] });
    assert.strictEqual(drift, null);
  });

  it('flags critical when watched pip pkg changes', () => {
    const current = {
      ...baseline,
      pip_freeze: { '/opt/venv': { torch: '2.1.0', requests: '2.31.0' } }
    };
    const drift = computeVersionDrift(baseline, current, { watchPip: ['torch'] });
    assert.ok(drift);
    assert.strictEqual(drift.severity, 'critical');
    assert.strictEqual(drift.diff.pip['/opt/venv'].changed[0].pkg, 'torch');
  });

  it('flags critical when system tensorrt changes', () => {
    const current = { ...baseline, system_pkgs: { tensorrt: '8.6.2' } };
    const drift = computeVersionDrift(baseline, current, { watchPip: [] });
    assert.strictEqual(drift.severity, 'critical');
  });

  it('flags warn when only non-watched pip pkg changes', () => {
    const current = {
      ...baseline,
      pip_freeze: { '/opt/venv': { torch: '2.0.1', requests: '2.32.0' } }
    };
    const drift = computeVersionDrift(baseline, current, { watchPip: ['torch'] });
    assert.strictEqual(drift.severity, 'warn');
  });
});

const { evaluate, _resetSustainedState } = require('../health-service');

describe('evaluate (host_health)', () => {
  beforeEach(() => _resetSustainedState());

  it('opens disk_full incident on first event > 95%', () => {
    const ev = {
      kind: 'host_health', ok: true,
      payload: { disk: [{ mount: '/', percent: 96, used: 96, total: 100 }] },
      ts: 1700000000
    };
    const result = evaluate('srv1', ev);
    const open = result.filter(r => r.action === 'open');
    assert.ok(open.find(i => i.kind === 'disk_full' && i.severity === 'critical'));
  });

  it('opens warn for disk 86% on first event', () => {
    const ev = {
      kind: 'host_health', ok: true,
      payload: { disk: [{ mount: '/', percent: 86, used: 86, total: 100 }] },
      ts: 1700000000
    };
    const result = evaluate('srv1', ev);
    assert.ok(result.find(r => r.action === 'open' && r.severity === 'warn' && r.kind === 'disk_full'));
  });

  it('does NOT open ram_high on a single high tick (sustained=3)', () => {
    const ev = {
      kind: 'host_health', ok: true,
      payload: { ram: { used: 90, total: 100, swap_used: 0, swap_total: 100 }, oom_events: 0 },
      ts: 1700000000
    };
    const result = evaluate('srv1', ev);
    assert.strictEqual(result.find(r => r.kind === 'ram_high'), undefined);
  });

  it('opens ram_high on 3rd consecutive high tick', () => {
    const mk = (ts) => ({
      kind: 'host_health', ok: true,
      payload: { ram: { used: 90, total: 100, swap_used: 0, swap_total: 100 }, oom_events: 0 },
      ts
    });
    evaluate('srv1', mk(1700000000));
    evaluate('srv1', mk(1700000060));
    const result = evaluate('srv1', mk(1700000120));
    assert.ok(result.find(r => r.action === 'open' && r.kind === 'ram_high'));
  });

  it('emits close when condition clears', () => {
    const high = (ts) => ({
      kind: 'host_health', ok: true,
      payload: { disk: [{ mount: '/', percent: 96, used: 96, total: 100 }] },
      ts
    });
    const low = (ts) => ({
      kind: 'host_health', ok: true,
      payload: { disk: [{ mount: '/', percent: 50, used: 50, total: 100 }] },
      ts
    });
    evaluate('srv2', high(1700000000));
    const result = evaluate('srv2', low(1700000060));
    assert.ok(result.find(r => r.action === 'close' && r.kind === 'disk_full'));
  });
});

describe('evaluate (ext_deps)', () => {
  beforeEach(() => _resetSustainedState());

  it('opens mongo_down after 3 consecutive failures', () => {
    const ev = (ts) => ({
      kind: 'ext_deps', ok: false,
      payload: { mongo: { ok: false }, s3: { ok: true }, tailscale: { ok: true } },
      errors: ['mongo timeout'], ts
    });
    evaluate('srv3', ev(1700000000));
    evaluate('srv3', ev(1700000060));
    const result = evaluate('srv3', ev(1700000120));
    assert.ok(result.find(r => r.action === 'open' && r.kind === 'mongo_down' && r.severity === 'critical'));
  });

  it('opens tailscale_down on first failure', () => {
    const result = evaluate('srv4', {
      kind: 'ext_deps', ok: false,
      payload: { mongo: { ok: true }, s3: { ok: true }, tailscale: { ok: false } },
      errors: [], ts: 1700000000
    });
    assert.ok(result.find(r => r.action === 'open' && r.kind === 'tailscale_down'));
  });
});
