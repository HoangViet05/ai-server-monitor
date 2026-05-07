const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-pm2-bug.db');

let db, mockBrowserIo, capturedEvents;

before(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = require('../db');
  db.init(TEST_DB_PATH);
  
  // Mock browserIo to capture socket events
  capturedEvents = [];
  mockBrowserIo = {
    emit: (event, data) => {
      capturedEvents.push({ event, data });
    }
  };
});

after(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

beforeEach(() => {
  capturedEvents = [];
});

describe('PM2 Bug Condition Exploration - Property 1', () => {
  /**
   * Property 1: Bug Condition - Empty PM2 Cache on Initial Connection
   * 
   * This test MUST FAIL on unfixed code to confirm the bug exists.
   * 
   * Bug Condition: isBugCondition(tick) where:
   *   - NOT sections.PM2.exists (PM2 section is absent from tick)
   *   - db.getPm2Apps(serverId).length == 0 (database cache is empty)
   *   - actualPm2ProcessesRunning(serverId) > 0 (PM2 processes are running on server)
   * 
   * Expected Behavior (after fix):
   *   - On initial page load, PM2 count should show actual number of running processes
   *   - Database cache should be populated before first socket events are emitted
   * 
   * This test simulates the bug scenario:
   * 1. Database cache is empty (fresh connection)
   * 2. API endpoint /api/servers/:id/pm2 is called (initial page load)
   * 3. Server actually has 4 PM2 processes running
   * 
   * On UNFIXED code: API returns [] (empty array from empty cache)
   * On FIXED code: API returns [4 apps] (fetched from server on connection)
   */
  
  it('should return PM2 data from API when cache is empty but PM2 processes are running', async () => {
    // Setup: Create a test server
    const server = db.addServer({
      name: 'test-server',
      ip: '100.64.0.100',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Verify database cache is empty (simulates fresh connection)
    const cachedApps = db.getPm2Apps(serverId);
    assert.strictEqual(cachedApps.length, 0, 'Database cache should be empty initially');
    
    // Simulate the scenario: Server is online and has 4 PM2 processes running
    // In the real scenario, ssh-poller would connect and fetch PM2 data immediately
    // For this test, we simulate what SHOULD happen after the fix:
    // The fix should populate the cache on connection, before any API calls
    
    // Mock: Assume server actually has 4 PM2 processes running
    const actualPm2ProcessCount = 4;
    const mockPm2Apps = [
      { pm_id: 0, name: 'arena-device-form', status: 'online', cpu: 0, memory: 152200000, uptime: 86400000, restarts: 0 },
      { pm_id: 1, name: 'mongo-db-manager', status: 'online', cpu: 0, memory: 78800000, uptime: 86400000, restarts: 0 },
      { pm_id: 4, name: 'server-monitor', status: 'online', cpu: 0, memory: 157000000, uptime: 86400000, restarts: 0 },
      { pm_id: 0, name: 'worker-streaming-...', status: 'online', cpu: 0, memory: 59500000, uptime: 86400000, restarts: 631 }
    ];
    
    // CRITICAL TEST: This simulates what happens on initial page load
    // The bug is that cache is empty, so API returns []
    // The fix should populate cache on connection, so API returns actual data
    
    // For now, we test the current behavior (which is buggy)
    // After fix, ssh-poller.startStream() should populate cache immediately
    const appsFromCache = db.getPm2Apps(serverId);
    
    // This assertion will FAIL on unfixed code (cache is empty)
    // After fix, cache should be populated by eager PM2 fetch on connection
    assert.strictEqual(
      appsFromCache.length,
      actualPm2ProcessCount,
      `PM2 cache should have ${actualPm2ProcessCount} apps after connection, but has ${appsFromCache.length}`
    );
    
    // Additional assertion: PM2 data should have correct structure
    if (appsFromCache.length > 0) {
      const firstApp = appsFromCache[0];
      assert.ok(firstApp.name, 'PM2 app should have name');
      assert.ok(firstApp.status, 'PM2 app should have status');
      assert.ok(typeof firstApp.pm_id === 'number', 'PM2 app should have pm_id');
    }
  });
  
  it('should populate PM2 cache on initial connection before first tick', () => {
    // Setup: Create a test server
    const server = db.addServer({
      name: 'initial-connection-server',
      ip: '100.64.0.101',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Verify database cache is empty initially
    const cachedAppsBefore = db.getPm2Apps(serverId);
    assert.strictEqual(cachedAppsBefore.length, 0, 'Cache should be empty before connection');
    
    // Simulate what SHOULD happen after fix:
    // When ssh-poller.startStream() is called, it should:
    // 1. Establish SSH connection
    // 2. Execute `pm2 jlist` immediately (eager fetch)
    // 3. Parse the output and populate database cache
    // 4. THEN start the streaming loop
    
    // This ensures that by the time first tick arrives (without PM2 section),
    // the cache is already populated, so socket events include correct PM2 data
    
    // For this test, we simulate the expected behavior after fix
    // In reality, this would be done by ssh-poller.startStream()
    const mockPm2Apps = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'online', cpu: 3, memory: 80000000, uptime: 3600000, restarts: 0 },
      { pm_id: 2, name: 'app3', status: 'online', cpu: 2, memory: 60000000, uptime: 3600000, restarts: 0 },
      { pm_id: 3, name: 'app4', status: 'online', cpu: 1, memory: 40000000, uptime: 3600000, restarts: 0 }
    ];
    
    // Simulate eager PM2 fetch (this is what the fix should do)
    // db.upsertPm2Apps(serverId, mockPm2Apps);
    
    // Verify cache is populated after connection
    const cachedAppsAfter = db.getPm2Apps(serverId);
    
    // This assertion will FAIL on unfixed code (cache is still empty)
    // After fix, cache should be populated by eager PM2 fetch
    assert.strictEqual(
      cachedAppsAfter.length,
      4,
      'PM2 cache should be populated immediately after connection, before first tick'
    );
  });
});

describe('PM2 Bug Condition - Counterexample Documentation', () => {
  /**
   * This test documents the counterexample found during exploration.
   * It demonstrates the exact scenario where the bug manifests.
   * 
   * Counterexample:
   * - Input: Fresh connection, empty database cache, 4 PM2 processes running on server
   * - Expected: PM2 cache populated immediately on connection
   * - Actual (unfixed): PM2 cache remains empty until first PM2 section arrives (6 seconds)
   * - Root Cause: ssh-poller does not fetch PM2 data on connection, only when PM2 section arrives
   */
  
  it('documents the counterexample: PM2 cache is empty on initial connection', () => {
    // This test captures the exact bug scenario reported by the user
    const server = db.addServer({
      name: 'pcai000002',
      ip: '100.64.0.102',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Initial state: cache is empty (this is the bug)
    const cachedApps = db.getPm2Apps(serverId);
    
    console.log('\n=== Counterexample Documentation ===');
    console.log('Server:', server.name, '(' + server.ip + ')');
    console.log('PM2 cache on initial connection:', cachedApps.length, 'apps');
    console.log('Expected: 4 apps (arena-device-form, mongo-db-manager, server-monitor, worker-streaming-...)');
    console.log('Actual:', cachedApps.length, 'apps');
    console.log('Bug: Cache is empty because ssh-poller does not fetch PM2 data on connection');
    console.log('Fix: ssh-poller should execute `pm2 jlist` immediately after SSH connection');
    console.log('=====================================\n');
    
    // This assertion documents the bug
    // On unfixed code: cachedApps.length === 0 (BUG)
    // On fixed code: cachedApps.length === 4 (CORRECT)
    assert.strictEqual(
      cachedApps.length,
      4,
      'Counterexample: PM2 cache is empty (0 apps) instead of 4 apps on initial connection'
    );
  });
  
  it('documents the expected behavior after fix', () => {
    // This test documents what SHOULD happen after the fix is implemented
    const server = db.addServer({
      name: 'fixed-server',
      ip: '100.64.0.103',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    console.log('\n=== Expected Behavior After Fix ===');
    console.log('1. ssh-poller.startStream() is called');
    console.log('2. SSH connection is established');
    console.log('3. Execute `pm2 jlist` immediately (eager fetch)');
    console.log('4. Parse JSON output and populate database cache');
    console.log('5. Emit initial server:update event with PM2 data');
    console.log('6. Start streaming loop');
    console.log('Result: PM2 cache is populated BEFORE first tick arrives');
    console.log('Result: Frontend displays correct PM2 count immediately');
    console.log('=====================================\n');
    
    // After fix, cache should be populated immediately
    // For this test, we simulate the expected behavior
    const mockPm2Apps = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 0, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'online', cpu: 0, memory: 80000000, uptime: 3600000, restarts: 0 },
      { pm_id: 2, name: 'app3', status: 'online', cpu: 0, memory: 60000000, uptime: 3600000, restarts: 0 },
      { pm_id: 3, name: 'app4', status: 'online', cpu: 0, memory: 40000000, uptime: 3600000, restarts: 0 }
    ];
    
    // Simulate what the fix should do
    // db.upsertPm2Apps(serverId, mockPm2Apps);
    
    const cachedApps = db.getPm2Apps(serverId);
    
    // This assertion will FAIL on unfixed code
    // After fix, this should PASS
    assert.strictEqual(
      cachedApps.length,
      4,
      'After fix: PM2 cache should have 4 apps immediately after connection'
    );
  });
});
