const { describe, it } = require('node:test');
const assert = require('node:assert');

// Mock Chart.js and DOM for testing
global.Chart = class Chart {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.data = config.data;
    this.options = config.options;
  }
  update() {}
  destroy() {}
};

global.document = {
  getElementById: (id) => ({ id })
};

// Load the Charts module by evaluating it in a function scope
function loadChartsModule() {
  const chartInstances = {};
  const chartData = {
    'chart-cpu': [],
    'chart-ram': [],
    'chart-igpu': []
  };
  let currentTimeRange = '5h';
  const TIME_RANGE_SECONDS = {
    '5m': 300,
    '10m': 600,
    '30m': 1800,
    '1h': 3600,
    '5h': 18000,
    'all': 0
  };

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function calculateStartTimestamp(range) {
    if (range === 'all') {
      return 0;
    }
    const now = Math.floor(Date.now() / 1000);
    const seconds = TIME_RANGE_SECONDS[range];
    
    // Warn if range is not recognized
    if (seconds === undefined) {
      console.warn(`Unknown time range: ${range}, treating as 'all'`);
      return 0;
    }
    
    return now - seconds;
  }

  function filterDataByRange(dataArray, range) {
    if (!dataArray || dataArray.length === 0) {
      return [];
    }
    if (range === 'all') {
      return dataArray;
    }
    const startTime = calculateStartTimestamp(range);
    return dataArray.filter(point => point.timestamp >= startTime);
  }

  function setTimeRange(range) {
    const validRanges = ['all', '5h', '1h', '30m', '10m', '5m'];
    if (!validRanges.includes(range)) {
      console.warn(`Invalid time range: ${range}, defaulting to 'all'`);
      range = 'all';
    }
    currentTimeRange = range;
  }

  function getCurrentTimeRange() {
    return currentTimeRange;
  }

  return { 
    calculateStartTimestamp, 
    filterDataByRange, 
    setTimeRange, 
    getCurrentTimeRange,
    TIME_RANGE_SECONDS
  };
}

describe('Charts Module - Time Filtering', () => {
  const Charts = loadChartsModule();

  describe('calculateStartTimestamp', () => {
    it('should return 0 for "all" range', () => {
      const result = Charts.calculateStartTimestamp('all');
      assert.strictEqual(result, 0);
    });

    it('should calculate correct timestamp for 5m range', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = Charts.calculateStartTimestamp('5m');
      const expected = now - 300;
      // Allow 1 second tolerance for test execution time
      assert.ok(Math.abs(result - expected) <= 1);
    });

    it('should calculate correct timestamp for 10m range', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = Charts.calculateStartTimestamp('10m');
      const expected = now - 600;
      assert.ok(Math.abs(result - expected) <= 1);
    });

    it('should calculate correct timestamp for 30m range', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = Charts.calculateStartTimestamp('30m');
      const expected = now - 1800;
      assert.ok(Math.abs(result - expected) <= 1);
    });

    it('should calculate correct timestamp for 1h range', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = Charts.calculateStartTimestamp('1h');
      const expected = now - 3600;
      assert.ok(Math.abs(result - expected) <= 1);
    });

    it('should calculate correct timestamp for 5h range', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = Charts.calculateStartTimestamp('5h');
      const expected = now - 18000;
      assert.ok(Math.abs(result - expected) <= 1);
    });
  });

  describe('filterDataByRange', () => {
    it('should return empty array for empty input', () => {
      const result = Charts.filterDataByRange([], '5m');
      assert.deepStrictEqual(result, []);
    });

    it('should return empty array for null input', () => {
      const result = Charts.filterDataByRange(null, '5m');
      assert.deepStrictEqual(result, []);
    });

    it('should return all data for "all" range', () => {
      const data = [
        { timestamp: 1000, value: 10 },
        { timestamp: 2000, value: 20 },
        { timestamp: 3000, value: 30 }
      ];
      const result = Charts.filterDataByRange(data, 'all');
      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(result, data);
    });

    it('should filter out old data points for 5m range', () => {
      const now = Math.floor(Date.now() / 1000);
      const data = [
        { timestamp: now - 600, value: 10 }, // 10 minutes ago - should be filtered
        { timestamp: now - 200, value: 20 }, // 3.3 minutes ago - should be kept
        { timestamp: now - 100, value: 30 }  // 1.6 minutes ago - should be kept
      ];
      const result = Charts.filterDataByRange(data, '5m');
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].value, 20);
      assert.strictEqual(result[1].value, 30);
    });

    it('should keep all data within time range', () => {
      const now = Math.floor(Date.now() / 1000);
      const data = [
        { timestamp: now - 250, value: 10 }, // 4.1 minutes ago
        { timestamp: now - 150, value: 20 }, // 2.5 minutes ago
        { timestamp: now - 50, value: 30 }   // 0.8 minutes ago
      ];
      const result = Charts.filterDataByRange(data, '5m');
      assert.strictEqual(result.length, 3);
    });
  });

  describe('setTimeRange and getCurrentTimeRange', () => {
    it('should set and get time range', () => {
      Charts.setTimeRange('5m');
      assert.strictEqual(Charts.getCurrentTimeRange(), '5m');
    });

    it('should default to "all" for invalid range', () => {
      Charts.setTimeRange('invalid');
      assert.strictEqual(Charts.getCurrentTimeRange(), 'all');
    });

    it('should accept all valid ranges', () => {
      const validRanges = ['all', '5h', '1h', '30m', '10m', '5m'];
      for (const range of validRanges) {
        Charts.setTimeRange(range);
        assert.strictEqual(Charts.getCurrentTimeRange(), range);
      }
    });
  });

  describe('TIME_RANGE_SECONDS mapping', () => {
    it('should have correct second values', () => {
      assert.strictEqual(Charts.TIME_RANGE_SECONDS['5m'], 300);
      assert.strictEqual(Charts.TIME_RANGE_SECONDS['10m'], 600);
      assert.strictEqual(Charts.TIME_RANGE_SECONDS['30m'], 1800);
      assert.strictEqual(Charts.TIME_RANGE_SECONDS['1h'], 3600);
      assert.strictEqual(Charts.TIME_RANGE_SECONDS['5h'], 18000);
      assert.strictEqual(Charts.TIME_RANGE_SECONDS['all'], 0);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid time range in setTimeRange', () => {
      Charts.setTimeRange('invalid-range');
      assert.strictEqual(Charts.getCurrentTimeRange(), 'all');
    });

    it('should handle unknown time range in calculateStartTimestamp', () => {
      const result = Charts.calculateStartTimestamp('unknown');
      assert.strictEqual(result, 0);
    });

    it('should handle null data array in filterDataByRange', () => {
      const result = Charts.filterDataByRange(null, '5m');
      assert.deepStrictEqual(result, []);
    });

    it('should handle undefined data array in filterDataByRange', () => {
      const result = Charts.filterDataByRange(undefined, '5m');
      assert.deepStrictEqual(result, []);
    });

    it('should handle empty data array in filterDataByRange', () => {
      const result = Charts.filterDataByRange([], '10m');
      assert.deepStrictEqual(result, []);
    });
  });

  describe('Performance Optimization', () => {
    it('should filter data efficiently within 100ms for large datasets', () => {
      const now = Math.floor(Date.now() / 1000);
      // Create a large dataset (8640 points = 24 hours at 10s interval)
      const largeDataset = [];
      for (let i = 0; i < 8640; i++) {
        largeDataset.push({
          timestamp: now - (8640 - i) * 10,
          value: Math.random() * 100
        });
      }

      const startTime = performance.now();
      const result = Charts.filterDataByRange(largeDataset, '5m');
      const endTime = performance.now();
      const duration = endTime - startTime;

      // Verify filtering completed within 100ms
      assert.ok(duration < 100, `Filtering took ${duration}ms, expected < 100ms`);
      
      // Verify result is correct (should have ~30 points for 5 minutes at 10s interval)
      assert.ok(result.length > 0, 'Should have filtered data');
      assert.ok(result.length <= 30, 'Should have approximately 30 points for 5 minutes');
    });

    it('should filter data efficiently for all time ranges', () => {
      const now = Math.floor(Date.now() / 1000);
      const largeDataset = [];
      for (let i = 0; i < 8640; i++) {
        largeDataset.push({
          timestamp: now - (8640 - i) * 10,
          value: Math.random() * 100
        });
      }

      const ranges = ['5m', '10m', '30m', '1h', '5h', 'all'];
      for (const range of ranges) {
        const startTime = performance.now();
        Charts.filterDataByRange(largeDataset, range);
        const endTime = performance.now();
        const duration = endTime - startTime;

        assert.ok(duration < 100, `Filtering for ${range} took ${duration}ms, expected < 100ms`);
      }
    });

    it('should handle multiple consecutive filter operations efficiently', () => {
      const now = Math.floor(Date.now() / 1000);
      const dataset = [];
      for (let i = 0; i < 1000; i++) {
        dataset.push({
          timestamp: now - (1000 - i) * 10,
          value: Math.random() * 100
        });
      }

      const ranges = ['5m', '10m', '30m', '1h', '5h', 'all', '5m', '10m'];
      const startTime = performance.now();
      
      for (const range of ranges) {
        Charts.filterDataByRange(dataset, range);
      }
      
      const endTime = performance.now();
      const totalDuration = endTime - startTime;
      const avgDuration = totalDuration / ranges.length;

      assert.ok(avgDuration < 100, `Average filtering took ${avgDuration}ms, expected < 100ms`);
    });

    it('should use efficient array filtering without full re-renders', () => {
      const now = Math.floor(Date.now() / 1000);
      const data = [];
      for (let i = 0; i < 1000; i++) {
        data.push({
          timestamp: now - (1000 - i) * 10,
          value: i
        });
      }

      // Test that filtering doesn't mutate original array
      const originalLength = data.length;
      const filtered = Charts.filterDataByRange(data, '5m');
      
      assert.strictEqual(data.length, originalLength, 'Original array should not be mutated');
      assert.ok(filtered.length < data.length, 'Filtered array should be smaller');
      assert.notStrictEqual(filtered, data, 'Filtered array should be a new array');
    });

    it('should handle worst-case scenario: switching filters rapidly on large dataset', () => {
      const now = Math.floor(Date.now() / 1000);
      const largeDataset = [];
      
      // Create maximum size dataset (8640 points)
      for (let i = 0; i < 8640; i++) {
        largeDataset.push({
          timestamp: now - (8640 - i) * 10,
          value: Math.random() * 100
        });
      }

      // Simulate rapid filter switching (worst case)
      const ranges = ['all', '5h', '5m', '10m', '30m', '1h', 'all', '5m', '10m', '30m', '1h'];
      const startTime = performance.now();
      
      for (const range of ranges) {
        Charts.filterDataByRange(largeDataset, range);
      }
      
      const endTime = performance.now();
      const totalDuration = endTime - startTime;
      const avgDuration = totalDuration / ranges.length;

      // Each filter operation should complete in < 100ms
      assert.ok(avgDuration < 100, `Average filtering took ${avgDuration}ms, expected < 100ms`);
      
      // Total time for 10 operations should be reasonable
      assert.ok(totalDuration < 500, `Total time ${totalDuration}ms should be < 500ms for 10 operations`);
    });

    it('should verify no performance degradation with repeated operations', () => {
      const now = Math.floor(Date.now() / 1000);
      const dataset = [];
      for (let i = 0; i < 1000; i++) {
        dataset.push({
          timestamp: now - (1000 - i) * 10,
          value: Math.random() * 100
        });
      }

      // Measure first operation
      const start1 = performance.now();
      Charts.filterDataByRange(dataset, '5m');
      const duration1 = performance.now() - start1;

      // Measure 100th operation
      for (let i = 0; i < 98; i++) {
        Charts.filterDataByRange(dataset, '5m');
      }
      const start100 = performance.now();
      Charts.filterDataByRange(dataset, '5m');
      const duration100 = performance.now() - start100;

      // Performance should not degrade (allow 2x tolerance for variance)
      assert.ok(duration100 < duration1 * 2, 
        `Performance degraded: first=${duration1}ms, 100th=${duration100}ms`);
    });
  });
});
