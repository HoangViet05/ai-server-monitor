const { describe, it } = require('node:test');
const assert = require('node:assert');

const accessManager = require('../access-manager');

describe('access manager', () => {
  it('counts GT 1030 as one active device when CPU is active', () => {
    const access = accessManager.calculateAccess(
      { access_model: 'gt1030' },
      { cpu_percent: 18, cpu_cores: [] }
    );

    assert.strictEqual(access.access_active_devices, 1);
    assert.strictEqual(access.access_capacity, 1);
  });

  it('counts GTX 1660S devices from active core pairs', () => {
    const access = accessManager.calculateAccess(
      { access_model: 'gtx1660s' },
      {
        cpu_percent: 50,
        cpu_cores: [
          { core: 0, percent: 25 },
          { core: 1, percent: 30 },
          { core: 2, percent: 22 },
          { core: 3, percent: 19 },
          { core: 4, percent: 90 },
        ],
      }
    );

    assert.strictEqual(access.access_active_cores, 4);
    assert.strictEqual(access.access_active_devices, 2);
    assert.strictEqual(access.access_capacity, 5);
  });

  it('caps GTX 1660S at five active devices', () => {
    const cores = Array.from({ length: 14 }, (_, core) => ({ core, percent: 50 }));
    const access = accessManager.calculateAccess({ access_model: 'gtx1660s' }, { cpu_cores: cores });

    assert.strictEqual(access.access_active_devices, 5);
  });
});
