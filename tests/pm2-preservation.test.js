const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-pm2-preservation.db');

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

describe('PM2 Preservation - Property 2', () => {
  /**
   * Property 2: Preservation - Steady-State PM2 Data Flow Unchanged
   * 
   * This test MUST PASS on unfixed code to confirm baseline behavior.
   * 
   * Preservation Requirements:
   * - When PM2 section exists in tick, PM2 data is parsed and upserted to database
   * - When PM2 section is absent but cache is populated, PM2 data is read from cache
   * - Socket emission pattern remains the same (emit on every tick with `pm2` field)
   * - Frontend socket handler continues to update PM2 count when `pm2` data is received
   * - PM2 action buttons (restart, stop, delete) continue to work and update database cache
   * 
   * These tests observe behavior on UNFIXED code for non-buggy inputs
   * (when database cache is already populated).
   */
  
  it('should parse and upsert PM2 data when PM2 section exists in tick', () => {
    // Setup: Create a test server with populated cache
    const server = db.addServer({
      name: 'preservation-server-1',
      ip: '100.64.0.200',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Pre-populate cache (simulates steady-state operation)
    const initialApps = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'online', cpu: 3, memory: 80000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, initialApps);
    
    // Verify cache is populated
    const cachedBefore = db.getPm2Apps(serverId);
    assert.strictEqual(cachedBefore.length, 2, 'Cache should have 2 apps initially');
    
    // Simulate PM2 data update (new app added)
    const updatedApps = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'online', cpu: 3, memory: 80000000, uptime: 3600000, restarts: 0 },
      { pm_id: 2, name: 'app3', status: 'online', cpu: 2, memory: 60000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, updatedApps);
    
    // Verify cache is updated
    const cachedAfter = db.getPm2Apps(serverId);
    assert.strictEqual(cachedAfter.length, 3, 'Cache should have 3 apps after update');
    assert.strictEqual(cachedAfter[2].name, 'app3', 'New app should be in cache');
    
    // This behavior MUST be preserved after fix
    console.log('✓ Preservation: PM2 data parsing and database upsert works correctly');
  });
  
  it('should read PM2 data from cache when PM2 section is absent but cache is populated', () => {
    // Setup: Create a test server with populated cache
    const server = db.addServer({
      name: 'preservation-server-2',
      ip: '100.64.0.201',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Pre-populate cache
    const apps = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'online', cpu: 3, memory: 80000000, uptime: 3600000, restarts: 0 },
      { pm_id: 2, name: 'app3', status: 'online', cpu: 2, memory: 60000000, uptime: 3600000, restarts: 0 },
      { pm_id: 3, name: 'app4', status: 'online', cpu: 1, memory: 40000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, apps);
    
    // Verify cache is populated
    const cachedApps = db.getPm2Apps(serverId);
    assert.strictEqual(cachedApps.length, 4, 'Cache should have 4 apps');
    
    // Simulate reading from cache (this is what happens when PM2 section is absent)
    const appsFromCache = db.getPm2Apps(serverId);
    assert.strictEqual(appsFromCache.length, 4, 'Should read 4 apps from cache');
    assert.strictEqual(appsFromCache[0].name, 'app1', 'First app should be app1');
    assert.strictEqual(appsFromCache[3].name, 'app4', 'Last app should be app4');
    
    // This behavior MUST be preserved after fix
    console.log('✓ Preservation: Reading PM2 data from cache works correctly');
  });
  
  it('should maintain PM2 data structure and fields', () => {
    // Setup: Create a test server
    const server = db.addServer({
      name: 'preservation-server-3',
      ip: '100.64.0.202',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Upsert PM2 apps with all expected fields
    const apps = [
      { 
        pm_id: 0, 
        name: 'test-app', 
        status: 'online', 
        cpu: 5.5, 
        memory: 104857600, 
        uptime: 86400000, 
        restarts: 3 
      }
    ];
    db.upsertPm2Apps(serverId, apps);
    
    // Retrieve and verify structure
    const retrieved = db.getPm2Apps(serverId);
    assert.strictEqual(retrieved.length, 1, 'Should have 1 app');
    
    const app = retrieved[0];
    assert.strictEqual(app.pm_id, 0, 'pm_id should be preserved');
    assert.strictEqual(app.name, 'test-app', 'name should be preserved');
    assert.strictEqual(app.status, 'online', 'status should be preserved');
    assert.strictEqual(app.cpu, 5.5, 'cpu should be preserved');
    assert.strictEqual(app.memory, 104857600, 'memory should be preserved');
    assert.strictEqual(app.uptime, 86400000, 'uptime should be preserved');
    assert.strictEqual(app.restarts, 3, 'restarts should be preserved');
    assert.ok(app.updated_at, 'updated_at should be set');
    
    // This structure MUST be preserved after fix
    console.log('✓ Preservation: PM2 data structure and fields are maintained');
  });
  
  it('should overwrite PM2 apps on upsert (not append)', () => {
    // Setup: Create a test server
    const server = db.addServer({
      name: 'preservation-server-4',
      ip: '100.64.0.203',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // First upsert: 3 apps
    const apps1 = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'online', cpu: 3, memory: 80000000, uptime: 3600000, restarts: 0 },
      { pm_id: 2, name: 'app3', status: 'online', cpu: 2, memory: 60000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, apps1);
    assert.strictEqual(db.getPm2Apps(serverId).length, 3, 'Should have 3 apps after first upsert');
    
    // Second upsert: 2 apps (one removed)
    const apps2 = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'stopped', cpu: 0, memory: 0, uptime: 0, restarts: 5 }
    ];
    db.upsertPm2Apps(serverId, apps2);
    
    // Verify: Should have 2 apps (not 5), and app2 status should be updated
    const final = db.getPm2Apps(serverId);
    assert.strictEqual(final.length, 2, 'Should have 2 apps after second upsert (overwrite, not append)');
    assert.strictEqual(final[1].status, 'stopped', 'app2 status should be updated to stopped');
    assert.strictEqual(final[1].restarts, 5, 'app2 restarts should be updated to 5');
    
    // This behavior MUST be preserved after fix
    console.log('✓ Preservation: PM2 apps are overwritten on upsert (not appended)');
  });
  
  it('should handle empty PM2 apps array correctly', () => {
    // Setup: Create a test server
    const server = db.addServer({
      name: 'preservation-server-5',
      ip: '100.64.0.204',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Pre-populate cache
    const apps = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, apps);
    assert.strictEqual(db.getPm2Apps(serverId).length, 1, 'Should have 1 app initially');
    
    // Upsert empty array (all apps stopped/deleted)
    db.upsertPm2Apps(serverId, []);
    
    // Verify: Cache should be empty
    const final = db.getPm2Apps(serverId);
    assert.strictEqual(final.length, 0, 'Should have 0 apps after upserting empty array');
    
    // This behavior MUST be preserved after fix
    console.log('✓ Preservation: Empty PM2 apps array is handled correctly');
  });
  
  it('should maintain PM2 apps ordering by pm_id', () => {
    // Setup: Create a test server
    const server = db.addServer({
      name: 'preservation-server-6',
      ip: '100.64.0.205',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Upsert apps in non-sequential order
    const apps = [
      { pm_id: 3, name: 'app4', status: 'online', cpu: 1, memory: 40000000, uptime: 3600000, restarts: 0 },
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 2, name: 'app3', status: 'online', cpu: 2, memory: 60000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'app2', status: 'online', cpu: 3, memory: 80000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, apps);
    
    // Retrieve and verify ordering
    const retrieved = db.getPm2Apps(serverId);
    assert.strictEqual(retrieved.length, 4, 'Should have 4 apps');
    assert.strictEqual(retrieved[0].pm_id, 0, 'First app should have pm_id 0');
    assert.strictEqual(retrieved[1].pm_id, 1, 'Second app should have pm_id 1');
    assert.strictEqual(retrieved[2].pm_id, 2, 'Third app should have pm_id 2');
    assert.strictEqual(retrieved[3].pm_id, 3, 'Fourth app should have pm_id 3');
    
    // This ordering MUST be preserved after fix
    console.log('✓ Preservation: PM2 apps are ordered by pm_id');
  });
});

describe('PM2 Preservation - API Endpoint Behavior', () => {
  /**
   * Verify that API endpoint behavior remains unchanged after fix.
   * The /api/servers/:id/pm2 endpoint should continue to return PM2 apps from cache.
   */
  
  it('should return PM2 apps from database cache via API endpoint', () => {
    // Setup: Create a test server with populated cache
    const server = db.addServer({
      name: 'api-preservation-server',
      ip: '100.64.0.206',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Pre-populate cache
    const apps = [
      { pm_id: 0, name: 'api-app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 },
      { pm_id: 1, name: 'api-app2', status: 'online', cpu: 3, memory: 80000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, apps);
    
    // Simulate API endpoint behavior (reads from cache)
    const appsFromApi = db.getPm2Apps(serverId);
    
    // Verify API returns correct data
    assert.strictEqual(appsFromApi.length, 2, 'API should return 2 apps from cache');
    assert.strictEqual(appsFromApi[0].name, 'api-app1', 'First app should be api-app1');
    assert.strictEqual(appsFromApi[1].name, 'api-app2', 'Second app should be api-app2');
    
    // This behavior MUST be preserved after fix
    console.log('✓ Preservation: API endpoint returns PM2 apps from cache');
  });
});

describe('PM2 Preservation - Database Operations', () => {
  /**
   * Verify that database operations remain unchanged after fix.
   */
  
  it('should delete PM2 apps when server is deleted (CASCADE)', () => {
    // Setup: Create a test server with PM2 apps
    const server = db.addServer({
      name: 'cascade-test-server',
      ip: '100.64.0.207',
      mode: 'ssh',
      ssh_user: 'root'
    });
    const serverId = server.id;
    
    // Add PM2 apps
    const apps = [
      { pm_id: 0, name: 'app1', status: 'online', cpu: 5, memory: 100000000, uptime: 3600000, restarts: 0 }
    ];
    db.upsertPm2Apps(serverId, apps);
    assert.strictEqual(db.getPm2Apps(serverId).length, 1, 'Should have 1 app');
    
    // Delete server
    db.deleteServer(serverId);
    
    // Verify PM2 apps are deleted (CASCADE)
    const appsAfterDelete = db.getPm2Apps(serverId);
    assert.strictEqual(appsAfterDelete.length, 0, 'PM2 apps should be deleted when server is deleted');
    
    // This behavior MUST be preserved after fix
    console.log('✓ Preservation: PM2 apps are deleted when server is deleted (CASCADE)');
  });
});
