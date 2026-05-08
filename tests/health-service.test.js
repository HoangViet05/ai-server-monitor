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
