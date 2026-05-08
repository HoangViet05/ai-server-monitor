# Server Health Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add active health-probe + version-drift module to `server-monitor` so a 5-camera server's failure modes (RAM/Swap/Disk/GPU, MongoDB/S3/Tailscale, library version drift) become visible as incidents in the dashboard with suggested-action buttons.

**Architecture:** New `agent/health-collector.js` module runs three independent probe loops (host: 60s, ext-deps: 60s, versions: 5min) and emits `health:check` / `version:snapshot` events on the existing socket connection. Dashboard adds a stateless `health-service.js` that evaluates events against thresholds and a manual baseline → opens/closes rows in 4 new SQLite tables (`health_events`, `version_snapshots`, `baselines`, `incidents`). New `Health` tab in the dashboard renders status grid, active incidents (with one-click suggested actions via existing `socket.emit('execute', ...)`), versions diff, and history.

**Tech Stack:** Node.js, better-sqlite3, socket.io / socket.io-client, EJS + vanilla JS, `node:test`. Lazy-required: `mongodb` (Mongo ping), `@aws-sdk/client-s3` (S3 list).

**Spec reference:** [docs/superpowers/specs/2026-05-08-server-health-management-design.md](../specs/2026-05-08-server-health-management-design.md)

**Convention notes (read before starting):**
- `servers.id` is **TEXT (UUID)** — every new FK column must be `TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE`. The spec shows `INTEGER`; **the plan overrides — use TEXT**.
- DB pattern: `CREATE TABLE IF NOT EXISTS` inside `createTables()`, prepared statements cached on the `stmts` object inside `prepareStatements()`. Don't introduce a new pattern.
- Test framework: built-in `node:test`. Run all: `npm test`. Run one file: `node --test tests/foo.test.js`.
- Project default: no comments unless WHY is non-obvious. Don't write docstrings.
- Commit per task with conventional-style messages (`feat:`, `test:`, `chore:`).

---

## File Structure

**New files:**
- `health-service.js` — drift + threshold logic (stateless except in-memory sustained-tick counter).
- `agent/health-collector.js` — agent-side probes.
- `tests/health-service.test.js` — unit tests for diff + evaluate.
- `tests/health-db.test.js` — unit tests for new DB helpers.
- `public/js/health.js` — UI logic for Health tab.
- `public/css/health.css` — Health tab styles (or extend existing `style.css` if simpler).

**Modified files:**
- `db.js` — 4 new tables, prepared statements, helpers (~15 new functions).
- `agent-server.js` — 2 new socket event handlers (`health:check`, `version:snapshot`).
- `cleanup.js` — extend `run()` with new retention rules.
- `routes/api.js` — 8 new endpoints under `/api/servers/:id/health`, `/api/incidents`, `/api/baselines`.
- `agent/agent.js` — load `health` config section, start collector if enabled.
- `agent/agent-config.json` — add `health` section template.
- `agent/package.json` — add `mongodb` + `@aws-sdk/client-s3` deps.
- `views/index.ejs` — tab nav and Health panel container.
- `public/js/app.js` — wire Health tab activation, listen for `health:update` / `health:incident`.
- `tests/db.test.js` — extend with health DB tests (or use new file).

---

## Task 1: Database — schema migration

**Files:**
- Modify: `db.js:21-136` (extend `createTables()`)

- [ ] **Step 1: Add 4 new `CREATE TABLE` statements**

Append to the `db.exec(\`...\`)` block in `createTables()`, after the existing index lines (around line 108 before the closing backtick), insert:

```sql
CREATE TABLE IF NOT EXISTS health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  payload TEXT,
  errors TEXT,
  ts INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_health_server_ts ON health_events(server_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_health_server_kind_ts ON health_events(server_id, kind, ts DESC);

CREATE TABLE IF NOT EXISTS version_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  pip_freeze TEXT,
  system_pkgs TEXT,
  node_pkgs TEXT,
  ts INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_version_server_ts ON version_snapshots(server_id, ts DESC);

CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  label TEXT,
  pip_freeze TEXT,
  system_pkgs TEXT,
  node_pkgs TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_baselines_active ON baselines(server_id, active);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  suggested_actions TEXT,
  opened_at INTEGER NOT NULL,
  acked_at INTEGER,
  closed_at INTEGER,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(server_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_incidents_server_opened ON incidents(server_id, opened_at DESC);
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npm test`
Expected: all existing tests pass; new tables created silently. If any test fails due to startup issue, inspect.

- [ ] **Step 3: Commit**

```bash
git add db.js
git commit -m "feat(db): add health_events, version_snapshots, baselines, incidents tables"
```

---

## Task 2: Database — health_events helpers (TDD)

**Files:**
- Create: `tests/health-db.test.js`
- Modify: `db.js` (add prepared statements + functions, export them)

- [ ] **Step 1: Write failing tests**

Create `tests/health-db.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/health-db.test.js`
Expected: FAIL with "db.insertHealthEvent is not a function".

- [ ] **Step 3: Add prepared statements to `prepareStatements()` in db.js**

Inside `prepareStatements()` (around line 215, after `cleanupOldGitPulls`), add:

```javascript
  // Health events
  stmts.insertHealthEvent = db.prepare(`
    INSERT INTO health_events (server_id, kind, ok, payload, errors, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmts.getRecentHealthEventsAll = db.prepare(`
    SELECT * FROM health_events WHERE server_id = ? AND ts >= ? ORDER BY ts DESC
  `);
  stmts.getRecentHealthEventsKind = db.prepare(`
    SELECT * FROM health_events WHERE server_id = ? AND ts >= ? AND kind = ? ORDER BY ts DESC
  `);
  stmts.cleanupOldHealthEvents = db.prepare(`DELETE FROM health_events WHERE ts < ?`);
```

- [ ] **Step 4: Add helper functions in db.js**

After the `// --- Git Pulls ---` section (around line 413), add a new section:

```javascript
// --- Health Events ---

function insertHealthEvent(serverId, ev) {
  const payload = ev.payload != null ? JSON.stringify(ev.payload) : null;
  const errors = ev.errors != null ? JSON.stringify(ev.errors) : null;
  stmts.insertHealthEvent.run(serverId, ev.kind, ev.ok ? 1 : 0, payload, errors, ev.ts);
}

function getRecentHealthEvents(serverId, sinceTs, kind) {
  if (kind) return stmts.getRecentHealthEventsKind.all(serverId, sinceTs, kind);
  return stmts.getRecentHealthEventsAll.all(serverId, sinceTs);
}

function cleanupOldHealthEvents() {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  stmts.cleanupOldHealthEvents.run(cutoff);
}
```

Add to `module.exports` block at bottom of file:
```javascript
  insertHealthEvent, getRecentHealthEvents, cleanupOldHealthEvents,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/health-db.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add db.js tests/health-db.test.js
git commit -m "feat(db): add health_events helpers"
```

---

## Task 3: Database — version_snapshots + baselines helpers (TDD)

**Files:**
- Modify: `db.js`
- Modify: `tests/health-db.test.js`

- [ ] **Step 1: Append failing tests to `tests/health-db.test.js`**

Append after the `describe('health_events', ...)` block:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/health-db.test.js`
Expected: FAIL ("db.insertVersionSnapshot is not a function" etc).

- [ ] **Step 3: Add prepared statements to `prepareStatements()` in db.js**

After the health_events stmts block:

```javascript
  // Version snapshots
  stmts.insertVersionSnapshot = db.prepare(`
    INSERT INTO version_snapshots (server_id, pip_freeze, system_pkgs, node_pkgs, ts)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmts.getLatestVersionSnapshot = db.prepare(`
    SELECT * FROM version_snapshots WHERE server_id = ? ORDER BY ts DESC LIMIT 1
  `);
  stmts.cleanupOldVersionSnapshots = db.prepare(`DELETE FROM version_snapshots WHERE ts < ?`);

  // Baselines
  stmts.insertBaseline = db.prepare(`
    INSERT INTO baselines (id, server_id, label, pip_freeze, system_pkgs, node_pkgs, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `);
  stmts.deactivateBaselines = db.prepare(`UPDATE baselines SET active = 0 WHERE server_id = ?`);
  stmts.activateBaseline = db.prepare(`UPDATE baselines SET active = 1 WHERE id = ?`);
  stmts.getBaseline = db.prepare(`SELECT * FROM baselines WHERE id = ?`);
  stmts.getActiveBaseline = db.prepare(`SELECT * FROM baselines WHERE server_id = ? AND active = 1`);
  stmts.listBaselines = db.prepare(`SELECT * FROM baselines WHERE server_id = ? ORDER BY created_at DESC`);
```

- [ ] **Step 4: Add helper functions in db.js**

```javascript
// --- Version Snapshots ---

function insertVersionSnapshot(serverId, snap) {
  stmts.insertVersionSnapshot.run(
    serverId,
    JSON.stringify(snap.pip_freeze || {}),
    JSON.stringify(snap.system_pkgs || {}),
    JSON.stringify(snap.node_pkgs || {}),
    snap.ts
  );
}

function getLatestVersionSnapshot(serverId) {
  return stmts.getLatestVersionSnapshot.get(serverId) || null;
}

function cleanupOldVersionSnapshots() {
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 24 * 3600;
  stmts.cleanupOldVersionSnapshots.run(cutoff);
}

// --- Baselines ---

function saveBaseline(serverId, snap, label) {
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    stmts.deactivateBaselines.run(serverId);
    stmts.insertBaseline.run(
      id, serverId, label || null,
      JSON.stringify(snap.pip_freeze || {}),
      JSON.stringify(snap.system_pkgs || {}),
      JSON.stringify(snap.node_pkgs || {}),
      now
    );
    stmts.activateBaseline.run(id);
  });
  tx();
  return stmts.getBaseline.get(id);
}

function getActiveBaseline(serverId) {
  return stmts.getActiveBaseline.get(serverId) || null;
}

function listBaselines(serverId) {
  return stmts.listBaselines.all(serverId);
}

function acceptBaseline(baselineId) {
  const baseline = stmts.getBaseline.get(baselineId);
  if (!baseline) return null;
  const tx = db.transaction(() => {
    stmts.deactivateBaselines.run(baseline.server_id);
    stmts.activateBaseline.run(baselineId);
  });
  tx();
  return stmts.getBaseline.get(baselineId);
}
```

Add to `module.exports`:
```javascript
  insertVersionSnapshot, getLatestVersionSnapshot, cleanupOldVersionSnapshots,
  saveBaseline, getActiveBaseline, listBaselines, acceptBaseline,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/health-db.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db.js tests/health-db.test.js
git commit -m "feat(db): add version_snapshots and baselines helpers"
```

---

## Task 4: Database — incidents helpers (TDD)

**Files:**
- Modify: `db.js`
- Modify: `tests/health-db.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/health-db.test.js`
Expected: FAIL.

- [ ] **Step 3: Add prepared statements**

```javascript
  // Incidents
  stmts.insertIncident = db.prepare(`
    INSERT INTO incidents (id, server_id, kind, severity, title, details, suggested_actions, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmts.updateOpenIncident = db.prepare(`
    UPDATE incidents SET severity = ?, title = ?, details = ?, suggested_actions = ?
    WHERE id = ? AND closed_at IS NULL
  `);
  stmts.findOpenIncident = db.prepare(`
    SELECT * FROM incidents WHERE server_id = ? AND kind = ? AND closed_at IS NULL LIMIT 1
  `);
  stmts.getIncident = db.prepare(`SELECT * FROM incidents WHERE id = ?`);
  stmts.getOpenIncidents = db.prepare(`
    SELECT * FROM incidents WHERE server_id = ? AND closed_at IS NULL ORDER BY opened_at DESC
  `);
  stmts.getAllOpenIncidents = db.prepare(`
    SELECT * FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC
  `);
  stmts.ackIncident = db.prepare(`UPDATE incidents SET acked_at = ? WHERE id = ?`);
  stmts.closeIncident = db.prepare(`UPDATE incidents SET closed_at = ? WHERE id = ?`);
  stmts.cleanupOldIncidents = db.prepare(`
    DELETE FROM incidents WHERE closed_at IS NOT NULL AND closed_at < ?
  `);
  stmts.getIncidentHistory = db.prepare(`
    SELECT * FROM incidents WHERE server_id = ? AND opened_at >= ? ORDER BY opened_at DESC
  `);
```

- [ ] **Step 4: Add helper functions**

```javascript
// --- Incidents ---

function upsertIncident(serverId, inc) {
  const existing = stmts.findOpenIncident.get(serverId, inc.kind);
  const detailsStr = JSON.stringify(inc.details || {});
  const actionsStr = JSON.stringify(inc.suggested_actions || []);
  if (existing) {
    stmts.updateOpenIncident.run(inc.severity, inc.title, detailsStr, actionsStr, existing.id);
    return stmts.getIncident.get(existing.id);
  }
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  stmts.insertIncident.run(id, serverId, inc.kind, inc.severity, inc.title, detailsStr, actionsStr, now);
  return stmts.getIncident.get(id);
}

function getIncident(id) {
  return stmts.getIncident.get(id) || null;
}

function getOpenIncidents(serverId) {
  if (serverId) return stmts.getOpenIncidents.all(serverId);
  return stmts.getAllOpenIncidents.all();
}

function ackIncident(id) {
  stmts.ackIncident.run(Math.floor(Date.now() / 1000), id);
  return getIncident(id);
}

function closeIncident(id) {
  stmts.closeIncident.run(Math.floor(Date.now() / 1000), id);
  return getIncident(id);
}

function getIncidentHistory(serverId, sinceTs, filters) {
  let rows = stmts.getIncidentHistory.all(serverId, sinceTs);
  if (filters && filters.kind) rows = rows.filter(r => r.kind === filters.kind);
  if (filters && filters.severity) rows = rows.filter(r => r.severity === filters.severity);
  return rows;
}

function cleanupOldIncidents() {
  const cutoff = Math.floor(Date.now() / 1000) - 180 * 24 * 3600;
  stmts.cleanupOldIncidents.run(cutoff);
}
```

Add to `module.exports`:
```javascript
  upsertIncident, getIncident, getOpenIncidents, ackIncident, closeIncident,
  getIncidentHistory, cleanupOldIncidents,
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/health-db.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db.js tests/health-db.test.js
git commit -m "feat(db): add incidents helpers with upsert state machine"
```

---

## Task 5: health-service.js — version diff (TDD)

**Files:**
- Create: `health-service.js`
- Create: `tests/health-service.test.js`

- [ ] **Step 1: Write failing tests**

`tests/health-service.test.js`:

```javascript
const { describe, it } = require('node:test');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/health-service.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Create `health-service.js` with diff logic**

```javascript
const CRITICAL_SYSTEM_PATTERNS = [
  /^tensorrt/i, /^libcudnn/i, /^cuda/i, /^nvidia-driver/i, /^nvidia-/i
];

function diffSection(baseline, current) {
  const added = [], removed = [], changed = [];
  for (const pkg of Object.keys(current)) {
    if (!(pkg in baseline)) added.push({ pkg, version: current[pkg] });
    else if (baseline[pkg] !== current[pkg]) changed.push({ pkg, from: baseline[pkg], to: current[pkg] });
  }
  for (const pkg of Object.keys(baseline)) {
    if (!(pkg in current)) removed.push({ pkg, version: baseline[pkg] });
  }
  return { added, removed, changed };
}

function diffPipMap(baseline, current) {
  const result = {};
  const venvs = new Set([...Object.keys(baseline || {}), ...Object.keys(current || {})]);
  for (const venv of venvs) {
    const d = diffSection(baseline[venv] || {}, current[venv] || {});
    if (d.added.length || d.removed.length || d.changed.length) result[venv] = d;
  }
  return result;
}

function isCriticalSystemPkg(pkg) {
  return CRITICAL_SYSTEM_PATTERNS.some(re => re.test(pkg));
}

function computeVersionDrift(baseline, current, opts = {}) {
  const watchPip = new Set(opts.watchPip || []);
  const pipDiff = diffPipMap(baseline.pip_freeze || {}, current.pip_freeze || {});
  const sysDiff = diffSection(baseline.system_pkgs || {}, current.system_pkgs || {});
  const nodeDiff = diffSection(baseline.node_pkgs || {}, current.node_pkgs || {});

  const hasPip = Object.keys(pipDiff).length > 0;
  const hasSys = sysDiff.added.length || sysDiff.removed.length || sysDiff.changed.length;
  const hasNode = nodeDiff.added.length || nodeDiff.removed.length || nodeDiff.changed.length;

  if (!hasPip && !hasSys && !hasNode) return null;

  let severity = 'warn';
  for (const venv of Object.keys(pipDiff)) {
    const venvDiff = pipDiff[venv];
    const allChanged = [...venvDiff.changed, ...venvDiff.added, ...venvDiff.removed];
    if (allChanged.some(c => watchPip.has(c.pkg))) severity = 'critical';
  }
  const sysAll = [...sysDiff.changed, ...sysDiff.added, ...sysDiff.removed];
  if (sysAll.some(c => isCriticalSystemPkg(c.pkg))) severity = 'critical';

  return {
    severity,
    diff: { pip: pipDiff, system: sysDiff, node: nodeDiff }
  };
}

module.exports = { diffSection, diffPipMap, computeVersionDrift, isCriticalSystemPkg };
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/health-service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add health-service.js tests/health-service.test.js
git commit -m "feat(health): version diff and drift severity logic"
```

---

## Task 6: health-service.js — threshold evaluation (TDD)

**Files:**
- Modify: `health-service.js`
- Modify: `tests/health-service.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
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
```

Note: `beforeEach` is from `node:test`. Add to imports at top of test file:
```javascript
const { describe, it, beforeEach } = require('node:test');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/health-service.test.js`
Expected: FAIL.

- [ ] **Step 3: Add threshold logic to `health-service.js`**

Append to `health-service.js`:

```javascript
const THRESHOLDS = {
  disk:        { warnPct: 85, critPct: 95, sustained: 1 },
  ram:         { warnPct: 85, critPct: 95, sustained: 3 },
  swap:        { warnPct: 50, critPct: 80, sustained: 3 },
  oomEvents:   { warn: 1, crit: 3, sustained: 1 },
  gpuTemp:     { warn: 85, crit: 90, sustained: 1 },
  gpuMemPct:   { warn: 90, crit: 98, sustained: 2 },
  gpuLost:     { sustained: 2 },
  mongo:       { sustained: 3 },
  s3:          { sustained: 3 },
  tailscale:   { sustained: 1 },
};

const sustainedCounters = new Map();

function _key(serverId, kind, sub) {
  return sub ? `${serverId}:${kind}:${sub}` : `${serverId}:${kind}`;
}

function _bump(key) {
  const n = (sustainedCounters.get(key) || 0) + 1;
  sustainedCounters.set(key, n);
  return n;
}

function _reset(key) {
  sustainedCounters.delete(key);
}

function _resetSustainedState() {
  sustainedCounters.clear();
}

function _checkRam(serverId, ram, oomEvents) {
  const out = [];
  if (!ram || !ram.total) return out;
  const pct = (ram.used / ram.total) * 100;
  const swapPct = ram.swap_total ? (ram.swap_used / ram.swap_total) * 100 : 0;

  const ramKey = _key(serverId, 'ram_high');
  if (pct >= THRESHOLDS.ram.warnPct) {
    const n = _bump(ramKey);
    if (n >= THRESHOLDS.ram.sustained) {
      out.push({
        action: 'open', kind: 'ram_high',
        severity: pct >= THRESHOLDS.ram.critPct ? 'critical' : 'warn',
        title: `RAM ${pct.toFixed(1)}%`,
        details: { percent: pct, used: ram.used, total: ram.total },
        suggested_actions: []
      });
    }
  } else {
    if (sustainedCounters.has(ramKey)) {
      _reset(ramKey);
      out.push({ action: 'close', kind: 'ram_high' });
    }
  }

  const swapKey = _key(serverId, 'swap_high');
  if (swapPct >= THRESHOLDS.swap.warnPct) {
    const n = _bump(swapKey);
    if (n >= THRESHOLDS.swap.sustained) {
      out.push({
        action: 'open', kind: 'swap_high',
        severity: swapPct >= THRESHOLDS.swap.critPct ? 'critical' : 'warn',
        title: `Swap ${swapPct.toFixed(1)}%`,
        details: { percent: swapPct, used: ram.swap_used, total: ram.swap_total },
        suggested_actions: []
      });
    }
  } else if (sustainedCounters.has(swapKey)) {
    _reset(swapKey);
    out.push({ action: 'close', kind: 'swap_high' });
  }

  if (typeof oomEvents === 'number' && oomEvents >= THRESHOLDS.oomEvents.warn) {
    out.push({
      action: 'open', kind: 'oom_kill',
      severity: oomEvents >= THRESHOLDS.oomEvents.crit ? 'critical' : 'warn',
      title: `${oomEvents} OOM kill(s) recently`,
      details: { count: oomEvents },
      suggested_actions: [{ label: 'Show last OOM victim', command: "dmesg -T | grep -i 'killed process' | tail -3" }]
    });
  }

  return out;
}

function _checkDisk(serverId, disks) {
  const out = [];
  if (!Array.isArray(disks)) return out;
  for (const d of disks) {
    const key = _key(serverId, 'disk_full', d.mount);
    if (d.percent >= THRESHOLDS.disk.warnPct) {
      _bump(key);
      out.push({
        action: 'open', kind: 'disk_full',
        severity: d.percent >= THRESHOLDS.disk.critPct ? 'critical' : 'warn',
        title: `Disk ${d.mount} ${d.percent.toFixed(1)}%`,
        details: { mount: d.mount, percent: d.percent, used: d.used, total: d.total },
        suggested_actions: [{ label: `du -sh largest in ${d.mount}`, command: `du -sh ${d.mount}/* 2>/dev/null | sort -h | tail -10` }]
      });
    } else if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: 'disk_full' });
    }
  }
  return out;
}

function _checkGpu(serverId, gpu) {
  const out = [];
  if (!gpu) return out;

  if (gpu.lost) {
    const key = _key(serverId, 'gpu_lost');
    const n = _bump(key);
    if (n >= THRESHOLDS.gpuLost.sustained) {
      out.push({
        action: 'open', kind: 'gpu_lost', severity: 'critical',
        title: 'GPU lost or driver unresponsive',
        details: { errors: gpu.errors || [] },
        suggested_actions: [
          { label: 'Show nvidia-smi', command: 'nvidia-smi' },
          { label: 'Show dmesg GPU lines', command: 'dmesg -T | grep -i nvidia | tail -20' }
        ]
      });
    }
    return out;
  } else {
    const key = _key(serverId, 'gpu_lost');
    if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: 'gpu_lost' });
    }
  }

  if (typeof gpu.temp === 'number' && gpu.temp >= THRESHOLDS.gpuTemp.warn) {
    out.push({
      action: 'open', kind: 'gpu_temp',
      severity: gpu.temp >= THRESHOLDS.gpuTemp.crit ? 'critical' : 'warn',
      title: `GPU temp ${gpu.temp}°C`,
      details: { temp: gpu.temp },
      suggested_actions: []
    });
  } else if (sustainedCounters.has(_key(serverId, 'gpu_temp'))) {
    _reset(_key(serverId, 'gpu_temp'));
    out.push({ action: 'close', kind: 'gpu_temp' });
  }

  if (gpu.mem_total && gpu.mem_used != null) {
    const memPct = (gpu.mem_used / gpu.mem_total) * 100;
    const key = _key(serverId, 'gpu_mem_high');
    if (memPct >= THRESHOLDS.gpuMemPct.warn) {
      const n = _bump(key);
      if (n >= THRESHOLDS.gpuMemPct.sustained) {
        out.push({
          action: 'open', kind: 'gpu_mem_high',
          severity: memPct >= THRESHOLDS.gpuMemPct.crit ? 'critical' : 'warn',
          title: `GPU mem ${memPct.toFixed(1)}%`,
          details: { percent: memPct, used: gpu.mem_used, total: gpu.mem_total },
          suggested_actions: []
        });
      }
    } else if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: 'gpu_mem_high' });
    }
  }

  return out;
}

function _checkExtDeps(serverId, payload) {
  const out = [];
  const map = [
    { name: 'mongo', kind: 'mongo_down', severity: 'critical', sustained: THRESHOLDS.mongo.sustained },
    { name: 's3', kind: 's3_down', severity: 'warn', sustained: THRESHOLDS.s3.sustained },
    { name: 'tailscale', kind: 'tailscale_down', severity: 'critical', sustained: THRESHOLDS.tailscale.sustained },
  ];
  for (const dep of map) {
    const status = payload[dep.name];
    if (!status) continue;
    const key = _key(serverId, dep.kind);
    if (!status.ok) {
      const n = _bump(key);
      if (n >= dep.sustained) {
        out.push({
          action: 'open', kind: dep.kind, severity: dep.severity,
          title: `${dep.name} unreachable`,
          details: { error: status.error || null },
          suggested_actions: [{ label: `Re-test ${dep.name} now`, command: `# triggered via dashboard` }]
        });
      }
    } else if (sustainedCounters.has(key)) {
      _reset(key);
      out.push({ action: 'close', kind: dep.kind });
    }
  }
  return out;
}

function evaluate(serverId, ev) {
  if (ev.kind === 'host_health') {
    const p = ev.payload || {};
    return [
      ..._checkRam(serverId, p.ram, p.oom_events),
      ..._checkDisk(serverId, p.disk),
      ..._checkGpu(serverId, p.gpu),
    ];
  }
  if (ev.kind === 'ext_deps') {
    return _checkExtDeps(serverId, ev.payload || {});
  }
  return [];
}

module.exports = {
  ...module.exports,
  THRESHOLDS, evaluate, _resetSustainedState
};
```

Note: the bottom `module.exports = { ...module.exports, ... }` re-exports — replace the existing `module.exports = { diffSection, diffPipMap, computeVersionDrift, isCriticalSystemPkg };` line with one combined exports at the end of file:

```javascript
module.exports = {
  diffSection, diffPipMap, computeVersionDrift, isCriticalSystemPkg,
  THRESHOLDS, evaluate, _resetSustainedState
};
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/health-service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add health-service.js tests/health-service.test.js
git commit -m "feat(health): threshold evaluation with sustained-tick logic"
```

---

## Task 7: Wire socket handlers in agent-server.js

**Files:**
- Modify: `agent-server.js`

- [ ] **Step 1: Add `health:check` handler**

In `agent-server.js`, after the `socket.on('logs', ...)` handler block (around line 71), add:

```javascript
    socket.on('health:check', (data) => {
      if (!serverId) return;
      const healthService = require('./health-service');
      const ev = {
        kind: data.kind, ok: !!data.ok,
        payload: data.payload, errors: data.errors,
        ts: data.ts || Math.floor(Date.now() / 1000)
      };
      db.insertHealthEvent(serverId, ev);

      const decisions = healthService.evaluate(serverId, ev);
      for (const d of decisions) {
        if (d.action === 'open') {
          const inc = db.upsertIncident(serverId, {
            kind: d.kind, severity: d.severity, title: d.title,
            details: d.details, suggested_actions: d.suggested_actions
          });
          if (browserIo) browserIo.emit('health:incident', { serverId, incident: inc, change: 'open' });
        } else if (d.action === 'close') {
          const open = db.getOpenIncidents(serverId).find(i => i.kind === d.kind);
          if (open) {
            db.closeIncident(open.id);
            if (browserIo) browserIo.emit('health:incident', { serverId, incident: { ...open, closed_at: Math.floor(Date.now() / 1000) }, change: 'close' });
          }
        }
      }
      if (browserIo) browserIo.emit('health:update', { serverId, kind: ev.kind, payload: ev.payload, ok: ev.ok, ts: ev.ts });
    });
```

- [ ] **Step 2: Add `version:snapshot` handler**

After the `health:check` handler:

```javascript
    socket.on('version:snapshot', (data) => {
      if (!serverId) return;
      const healthService = require('./health-service');
      const snap = {
        pip_freeze: data.pip_freeze || {},
        system_pkgs: data.system_pkgs || {},
        node_pkgs: data.node_pkgs || {},
        ts: data.ts || Math.floor(Date.now() / 1000)
      };
      db.insertVersionSnapshot(serverId, snap);

      const baseline = db.getActiveBaseline(serverId);
      if (!baseline) return;

      const baselineSnap = {
        pip_freeze: JSON.parse(baseline.pip_freeze || '{}'),
        system_pkgs: JSON.parse(baseline.system_pkgs || '{}'),
        node_pkgs: JSON.parse(baseline.node_pkgs || '{}')
      };

      const watchPip = data.watch_pip || [];
      const drift = healthService.computeVersionDrift(baselineSnap, snap, { watchPip });
      if (drift) {
        const inc = db.upsertIncident(serverId, {
          kind: 'version_drift', severity: drift.severity,
          title: 'Library versions differ from baseline',
          details: drift.diff,
          suggested_actions: [{ label: 'View diff (UI)', command: '# Open Health → Versions tab' }]
        });
        if (browserIo) browserIo.emit('health:incident', { serverId, incident: inc, change: 'open' });
      } else {
        const open = db.getOpenIncidents(serverId).find(i => i.kind === 'version_drift');
        if (open) {
          db.closeIncident(open.id);
          if (browserIo) browserIo.emit('health:incident', { serverId, incident: { ...open, closed_at: Math.floor(Date.now() / 1000) }, change: 'close' });
        }
      }
    });
```

- [ ] **Step 3: Smoke test that the existing tests still pass**

Run: `npm test`
Expected: all PASS, no regression.

- [ ] **Step 4: Commit**

```bash
git add agent-server.js
git commit -m "feat(server): handle health:check and version:snapshot socket events"
```

---

## Task 8: Cleanup retention extension

**Files:**
- Modify: `cleanup.js`
- Modify: `db.js` (add `cleanupExcessBaselines`)

- [ ] **Step 1: Add baselines pruning helper to db.js**

In `db.js` `prepareStatements()`, add:

```javascript
  stmts.cleanupExcessBaselines = db.prepare(`
    DELETE FROM baselines WHERE id IN (
      SELECT id FROM baselines
      WHERE server_id = ? AND active = 0
      ORDER BY created_at DESC
      LIMIT -1 OFFSET 3
    )
  `);
```

In db.js, add helper:

```javascript
function cleanupExcessBaselines() {
  const servers = stmts.getServers.all();
  for (const s of servers) {
    stmts.cleanupExcessBaselines.run(s.id);
  }
}
```

Add to exports:
```javascript
  cleanupExcessBaselines,
```

- [ ] **Step 2: Extend `cleanup.js` `run()`**

Modify `cleanup.js` `run()` to:

```javascript
function run() {
  try {
    db.cleanupOldMetrics();
    db.cleanupExcessLogs();
    db.cleanupOldGitPulls();
    db.cleanupOldHealthEvents();
    db.cleanupOldVersionSnapshots();
    db.cleanupOldIncidents();
    db.cleanupExcessBaselines();
    for (const sb of db.getScoreboards()) {
      db.cleanupExcessScoreboardLogs(sb.id);
    }
    console.log(`[Cleanup] Done at ${new Date().toISOString()}`);
  } catch (err) {
    console.error(`[Cleanup] Error: ${err.message}`);
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS, no regression.

- [ ] **Step 4: Commit**

```bash
git add db.js cleanup.js
git commit -m "feat(cleanup): retention for health_events, version_snapshots, incidents, baselines"
```

---

## Task 9: agent/health-collector.js — skeleton + probeHostHealth

**Files:**
- Create: `agent/health-collector.js`

- [ ] **Step 1: Create skeleton with timers and probeHostHealth**

```javascript
const { execSync } = require('child_process');
const fs = require('fs');

let timers = [];
let socket = null;
let config = null;
let lastDmesgTs = 0;

function _safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: opts.timeout || 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function _readMeminfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => {
      const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1]) * 1024 : 0;
    };
    return {
      total: get('MemTotal'),
      used: get('MemTotal') - get('MemAvailable'),
      swap_total: get('SwapTotal'),
      swap_used: get('SwapTotal') - get('SwapFree'),
    };
  } catch { return null; }
}

function _readDisks(mounts) {
  const out = [];
  for (const mount of mounts) {
    const text = _safeExec(`df -B1 -P "${mount}" 2>/dev/null | tail -n 1`);
    if (!text) continue;
    const parts = text.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const total = parseInt(parts[parts.length - 5]);
    const used = parseInt(parts[parts.length - 4]);
    if (isNaN(total) || isNaN(used) || total === 0) continue;
    out.push({ mount, total, used, percent: (used / total) * 100 });
  }
  return out;
}

function _readGpu() {
  const list = _safeExec('nvidia-smi -L');
  if (!list) return null;
  const csv = _safeExec('nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu,utilization.gpu --format=csv,noheader,nounits');
  if (!csv) return { lost: true, errors: ['nvidia-smi query failed'] };
  const line = csv.split('\n').find(l => l.trim().length > 0);
  if (!line) return { lost: true, errors: ['empty GPU response'] };
  const parts = line.split(',').map(s => parseFloat(s.trim()));
  if (parts.some(isNaN)) return { lost: true, errors: ['unparseable GPU response'] };
  return {
    lost: false,
    mem_used: parts[0] * 1048576,
    mem_total: parts[1] * 1048576,
    temp: parts[2],
    util: parts[3],
  };
}

function _readOomEvents() {
  const out = _safeExec('dmesg -T 2>/dev/null | grep -ci "out of memory"');
  if (out == null) return 0;
  const total = parseInt(out.trim()) || 0;
  if (lastDmesgTs === 0) {
    lastDmesgTs = total;
    return 0;
  }
  const delta = Math.max(0, total - lastDmesgTs);
  lastDmesgTs = total;
  return delta;
}

async function probeHostHealth() {
  const errors = [];
  const ram = _readMeminfo();
  if (!ram) errors.push('meminfo unreadable');
  const mounts = (config && config.monitored_mounts) || ['/'];
  const disk = _readDisks(mounts);
  const gpu = _readGpu();
  const oom = _readOomEvents();

  const payload = { ram, disk, gpu, oom_events: oom };
  return {
    kind: 'host_health',
    ok: errors.length === 0 && (!gpu || !gpu.lost),
    payload, errors,
    ts: Math.floor(Date.now() / 1000),
  };
}

function start(_socket, _config) {
  socket = _socket;
  config = _config || {};
  if (!config.enabled) return;

  const hostInterval = config.host_interval || 60000;
  timers.push(setInterval(async () => {
    if (!socket || !socket.connected) return;
    try {
      const ev = await probeHostHealth();
      socket.emit('health:check', ev);
    } catch (err) {
      console.error('[health] probeHostHealth error:', err.message);
    }
  }, hostInterval));

  console.log(`[health] Started — host every ${hostInterval/1000}s`);
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

module.exports = { start, stop, probeHostHealth };
```

- [ ] **Step 2: Commit**

```bash
git add agent/health-collector.js
git commit -m "feat(agent): health-collector skeleton with probeHostHealth"
```

---

## Task 10: agent/health-collector.js — probeExternalDeps

**Files:**
- Modify: `agent/health-collector.js`
- Modify: `agent/package.json`

- [ ] **Step 1: Add deps to `agent/package.json`**

```json
{
  "name": "server-monitor-agent",
  "version": "1.0.0",
  "description": "Lightweight monitoring agent",
  "main": "agent.js",
  "dependencies": {
    "socket.io-client": "^4.7.5",
    "mongodb": "^6.5.0",
    "@aws-sdk/client-s3": "^3.500.0"
  }
}
```

- [ ] **Step 2: Add `probeExternalDeps` to health-collector.js**

Append to `health-collector.js` (above `start()`):

```javascript
async function _pingMongo(cfg) {
  if (!cfg || !cfg.uri) return null;
  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); }
  catch { return { ok: false, error: 'mongodb module not installed' }; }
  const client = new MongoClient(cfg.uri, { serverSelectionTimeoutMS: cfg.timeout_ms || 5000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await client.close().catch(() => {});
  }
}

async function _probeS3(cfg) {
  if (!cfg || !cfg.bucket || !cfg.endpoint) return null;
  let S3;
  try { ({ S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3')); }
  catch { return { ok: false, error: '@aws-sdk/client-s3 not installed' }; }
  const client = new S3Client({
    endpoint: cfg.endpoint, region: cfg.region || 'auto',
    credentials: { accessKeyId: cfg.access_key, secretAccessKey: cfg.secret_key },
    requestHandler: { requestTimeout: cfg.timeout_ms || 5000 }
  });
  try {
    await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function _probeTailscale() {
  const out = _safeExec('tailscale status --json 2>/dev/null');
  if (!out) return { ok: false, error: 'tailscale CLI not available' };
  try {
    const parsed = JSON.parse(out);
    const online = parsed.Self && parsed.Self.Online === true;
    return online ? { ok: true } : { ok: false, error: 'Self.Online=false' };
  } catch (err) {
    return { ok: false, error: 'cannot parse tailscale status' };
  }
}

async function probeExternalDeps() {
  const cfg = (config && config.external_deps) || {};
  const errors = [];
  const mongo = await _pingMongo(cfg.mongo);
  const s3 = await _probeS3(cfg.s3);
  const tailscale = (cfg.tailscale && cfg.tailscale.enabled === false) ? null : _probeTailscale();

  const payload = { mongo, s3, tailscale };
  for (const [name, status] of Object.entries(payload)) {
    if (status && status.ok === false) errors.push(`${name}: ${status.error}`);
  }
  const ok = !Object.values(payload).some(s => s && s.ok === false);
  return { kind: 'ext_deps', ok, payload, errors, ts: Math.floor(Date.now() / 1000) };
}
```

Note: the destructured `S3Client, ListObjectsV2Command` need declaration via `let`. Replace the line `let S3;` with `let S3Client, ListObjectsV2Command;` and remove `let S3;`. Final form:

```javascript
async function _probeS3(cfg) {
  if (!cfg || !cfg.bucket || !cfg.endpoint) return null;
  let S3Client, ListObjectsV2Command;
  try { ({ S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3')); }
  catch { return { ok: false, error: '@aws-sdk/client-s3 not installed' }; }
  const client = new S3Client({
    endpoint: cfg.endpoint, region: cfg.region || 'auto',
    credentials: { accessKeyId: cfg.access_key, secretAccessKey: cfg.secret_key },
    requestHandler: { requestTimeout: cfg.timeout_ms || 5000 }
  });
  try {
    await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

- [ ] **Step 3: Add ext-deps timer in `start()`**

Inside `start()`, after the host timer:

```javascript
  const extInterval = config.ext_deps_interval || 60000;
  timers.push(setInterval(async () => {
    if (!socket || !socket.connected) return;
    try {
      const ev = await probeExternalDeps();
      socket.emit('health:check', ev);
    } catch (err) {
      console.error('[health] probeExternalDeps error:', err.message);
    }
  }, extInterval));
  console.log(`[health] ext-deps every ${extInterval/1000}s`);
```

Also add `probeExternalDeps` to module.exports:
```javascript
module.exports = { start, stop, probeHostHealth, probeExternalDeps };
```

- [ ] **Step 4: Commit**

```bash
git add agent/health-collector.js agent/package.json
git commit -m "feat(agent): probeExternalDeps for Mongo/S3/Tailscale"
```

---

## Task 11: agent/health-collector.js — snapshotVersions

**Files:**
- Modify: `agent/health-collector.js`

- [ ] **Step 1: Add `snapshotVersions` and timer**

Append above `start()`:

```javascript
function _pipFreeze(venvPath) {
  const pip = `${venvPath}/bin/pip`;
  const out = _safeExec(`"${pip}" freeze 2>/dev/null`, { timeout: 30000 });
  if (!out) return null;
  const result = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_\-.]+)==(.+)$/);
    if (m) result[m[1].toLowerCase()] = m[2].trim();
  }
  return result;
}

function _systemPkgs(patterns) {
  const result = {};
  for (const pattern of patterns) {
    const out = _safeExec(`dpkg-query -W -f='\${Package}=\${Version}\\n' '${pattern}' 2>/dev/null`);
    if (!out) continue;
    for (const line of out.split('\n')) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) result[m[1].trim()] = m[2].trim();
    }
  }
  const driver = _safeExec(`nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1`);
  if (driver) result['nvidia-driver'] = driver.trim();
  const cuda = _safeExec(`nvcc --version 2>/dev/null | grep -oE 'release [0-9.]+' | awk '{print $2}'`);
  if (cuda) result['cuda-toolkit'] = cuda.trim();
  return result;
}

function _nodeVersions() {
  const result = {};
  const node = _safeExec('node -v 2>/dev/null');
  if (node) result.node = node.trim().replace(/^v/, '');
  const npm = _safeExec('npm -v 2>/dev/null');
  if (npm) result.npm = npm.trim();
  const pm2 = _safeExec('pm2 -v 2>/dev/null');
  if (pm2) result.pm2 = pm2.trim();
  const globals = _safeExec('npm list -g --depth=0 --json 2>/dev/null', { timeout: 15000 });
  if (globals) {
    try {
      const parsed = JSON.parse(globals);
      result.globals = {};
      for (const [name, info] of Object.entries(parsed.dependencies || {})) {
        result.globals[name] = info.version;
      }
    } catch { /* ignore */ }
  }
  return result;
}

async function snapshotVersions() {
  const venvs = (config && config.monitored_python_envs) || [];
  const sysPatterns = (config && config.monitored_system_pkgs) || [];

  const pip_freeze = {};
  for (const venv of venvs) {
    const r = _pipFreeze(venv);
    if (r) pip_freeze[venv] = r;
  }
  const system_pkgs = _systemPkgs(sysPatterns);
  const node_pkgs = _nodeVersions();
  const watch_pip = (config && config.watch_pip_packages) || [];

  return { pip_freeze, system_pkgs, node_pkgs, watch_pip, ts: Math.floor(Date.now() / 1000) };
}
```

- [ ] **Step 2: Add version timer in `start()`**

Append after the ext-deps timer:

```javascript
  const verInterval = config.version_interval || 300000;
  timers.push(setInterval(async () => {
    if (!socket || !socket.connected) return;
    try {
      const snap = await snapshotVersions();
      socket.emit('version:snapshot', snap);
    } catch (err) {
      console.error('[health] snapshotVersions error:', err.message);
    }
  }, verInterval));
  console.log(`[health] versions every ${verInterval/1000}s`);
```

Update exports:
```javascript
module.exports = { start, stop, probeHostHealth, probeExternalDeps, snapshotVersions };
```

- [ ] **Step 3: Commit**

```bash
git add agent/health-collector.js
git commit -m "feat(agent): snapshotVersions for pip, system pkgs, node ecosystem"
```

---

## Task 12: agent/agent.js — wire health-collector

**Files:**
- Modify: `agent/agent.js`
- Modify: `agent/agent-config.json`

- [ ] **Step 1: Update agent-config.json template**

Replace `agent/agent-config.json` content:

```json
{
  "dashboard_url": "http://DASHBOARD_IP:3000",
  "interval": 10000,
  "server_name": "my-server",
  "custom_ip": "",
  "health": {
    "enabled": false,
    "host_interval": 60000,
    "ext_deps_interval": 60000,
    "version_interval": 300000,
    "monitored_mounts": ["/"],
    "monitored_python_envs": [],
    "monitored_system_pkgs": ["tensorrt*", "libcudnn*", "cuda-*", "nvidia-driver-*"],
    "watch_pip_packages": ["torch", "ultralytics", "tensorrt", "opencv-python"],
    "external_deps": {
      "mongo": { "uri": "", "timeout_ms": 5000 },
      "s3": { "endpoint": "", "bucket": "", "access_key": "", "secret_key": "", "region": "auto", "timeout_ms": 5000 },
      "tailscale": { "enabled": true }
    }
  }
}
```

- [ ] **Step 2: Wire health-collector into agent.js**

In `agent/agent.js`, find the line `console.log(\`[Agent] Connecting to ${DASHBOARD_URL}...\`);` (around line 15) and after the `socket = io(...)` block (around line 22), add:

```javascript
const healthCollector = require('./health-collector');
```

Then in `socket.on('connect', ...)` handler (around line 201), after the `socket.emit('register', ...)` line, add:

```javascript
  if (config.health && config.health.enabled) {
    healthCollector.start(socket, config.health);
  }
```

And in `socket.on('disconnect', ...)` handler, add:

```javascript
  healthCollector.stop();
```

- [ ] **Step 3: Smoke test**

Run: `cd agent && node -e "require('./health-collector')"`
Expected: no error (module loads).

- [ ] **Step 4: Commit**

```bash
git add agent/agent.js agent/agent-config.json
git commit -m "feat(agent): integrate health-collector with config-gated startup"
```

---

## Task 13: API endpoints — health & incidents

**Files:**
- Modify: `routes/api.js`

- [ ] **Step 1: Add health/incidents endpoints**

In `routes/api.js`, append before `module.exports = router;` (or wherever it currently ends):

```javascript
router.get('/servers/:id/health', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const events = db.getRecentHealthEvents(req.params.id, since);
  const open = db.getOpenIncidents(req.params.id);

  const latestByKind = {};
  for (const e of events) {
    if (!latestByKind[e.kind]) latestByKind[e.kind] = e;
  }

  res.json({
    server,
    open_incidents: open.map(i => ({ ...i, details: JSON.parse(i.details || '{}'), suggested_actions: JSON.parse(i.suggested_actions || '[]') })),
    latest_host_health: latestByKind.host_health ? { ...latestByKind.host_health, payload: JSON.parse(latestByKind.host_health.payload || '{}'), errors: JSON.parse(latestByKind.host_health.errors || '[]') } : null,
    latest_ext_deps: latestByKind.ext_deps ? { ...latestByKind.ext_deps, payload: JSON.parse(latestByKind.ext_deps.payload || '{}'), errors: JSON.parse(latestByKind.ext_deps.errors || '[]') } : null,
  });
});

router.get('/servers/:id/incidents', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const range = parseInt(req.query.range) || 30;
  const since = Math.floor(Date.now() / 1000) - range * 24 * 3600;
  const filters = {};
  if (req.query.kind) filters.kind = req.query.kind;
  if (req.query.severity) filters.severity = req.query.severity;
  const rows = db.getIncidentHistory(req.params.id, since, filters);
  res.json(rows.map(r => ({ ...r, details: JSON.parse(r.details || '{}'), suggested_actions: JSON.parse(r.suggested_actions || '[]') })));
});

router.post('/incidents/:id/ack', (req, res) => {
  const inc = db.getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  db.ackIncident(req.params.id);
  res.json(db.getIncident(req.params.id));
});

router.post('/incidents/:id/close', (req, res) => {
  const inc = db.getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  db.closeIncident(req.params.id);
  res.json(db.getIncident(req.params.id));
});
```

- [ ] **Step 2: Manual sanity check**

Run: `npm start` (in another terminal), then:
```bash
curl http://localhost:3000/api/servers/<some-id>/health
```
Expected: 404 if id wrong, or JSON with empty arrays for a real server.

- [ ] **Step 3: Commit**

```bash
git add routes/api.js
git commit -m "feat(api): GET /servers/:id/health, /incidents endpoints"
```

---

## Task 14: API endpoints — versions & baselines

**Files:**
- Modify: `routes/api.js`

- [ ] **Step 1: Add endpoints**

```javascript
router.get('/servers/:id/versions/current', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const snap = db.getLatestVersionSnapshot(req.params.id);
  if (!snap) return res.json(null);
  res.json({
    ts: snap.ts,
    pip_freeze: JSON.parse(snap.pip_freeze || '{}'),
    system_pkgs: JSON.parse(snap.system_pkgs || '{}'),
    node_pkgs: JSON.parse(snap.node_pkgs || '{}')
  });
});

router.get('/servers/:id/baselines', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const rows = db.listBaselines(req.params.id);
  res.json(rows.map(b => ({
    id: b.id, label: b.label, active: b.active, created_at: b.created_at,
    pip_freeze: JSON.parse(b.pip_freeze || '{}'),
    system_pkgs: JSON.parse(b.system_pkgs || '{}'),
    node_pkgs: JSON.parse(b.node_pkgs || '{}')
  })));
});

router.post('/servers/:id/baselines', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const snap = db.getLatestVersionSnapshot(req.params.id);
  if (!snap) return res.status(400).json({ error: 'No version snapshot available yet for this server' });
  const baseline = db.saveBaseline(req.params.id, {
    pip_freeze: JSON.parse(snap.pip_freeze || '{}'),
    system_pkgs: JSON.parse(snap.system_pkgs || '{}'),
    node_pkgs: JSON.parse(snap.node_pkgs || '{}')
  }, req.body && req.body.label);

  const open = db.getOpenIncidents(req.params.id).find(i => i.kind === 'version_drift');
  if (open) db.closeIncident(open.id);

  res.status(201).json(baseline);
});

router.post('/baselines/:id/accept', (req, res) => {
  const updated = db.acceptBaseline(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Baseline not found' });
  const open = db.getOpenIncidents(updated.server_id).find(i => i.kind === 'version_drift');
  if (open) db.closeIncident(open.id);
  res.json(updated);
});
```

- [ ] **Step 2: Commit**

```bash
git add routes/api.js
git commit -m "feat(api): version snapshots and baseline endpoints"
```

---

## Task 15: UI — Health tab structure + status grid

**Files:**
- Modify: `views/index.ejs`
- Modify: `public/css/style.css` (or create `public/css/health.css`)
- Create: `public/js/health.js`
- Modify: `public/js/app.js` (wire tab activation)

> **NOTE for implementer:** Read `views/index.ejs` and `public/js/app.js` first to understand the existing tab pattern (Overview / Logs). The exact DOM structure depends on what's already there. The steps below describe behavior; adapt selectors to match.

- [ ] **Step 1: Add "Health" tab navigation in `views/index.ejs`**

Locate the tab nav for the server detail panel (e.g. a `<div class="tabs">` with `data-tab="overview"` etc.). Add a new tab button and panel:

```html
<button class="tab-btn" data-tab="health">Health</button>
```

And matching panel:

```html
<div class="tab-panel" data-tab-panel="health" hidden>
  <div class="health-status-grid"></div>
  <div class="health-incidents"></div>
  <div class="health-versions"></div>
  <div class="health-history"></div>
</div>
```

- [ ] **Step 2: Add CSS for status grid**

Append to `public/css/style.css`:

```css
.health-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
.health-card { padding: 12px; border-radius: 6px; background: #1e293b; border-left: 4px solid #475569; }
.health-card.ok { border-left-color: #10b981; }
.health-card.warn { border-left-color: #f59e0b; }
.health-card.critical { border-left-color: #ef4444; }
.health-card .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; }
.health-card .value { font-size: 18px; font-weight: 600; margin-top: 4px; }
.health-card .sub { font-size: 11px; color: #64748b; margin-top: 4px; }
.incident-banner { padding: 10px 12px; margin-bottom: 8px; border-radius: 6px; background: #7f1d1d; }
.incident-banner.warn { background: #78350f; }
.incident-banner .actions { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.incident-banner button { font-size: 12px; padding: 4px 8px; }
```

- [ ] **Step 3: Create `public/js/health.js`**

```javascript
(function() {
  const state = {
    serverId: null,
    socket: null,
    notificationsEnabled: false,
  };

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B','KB','MB','GB','TB']; let i=0; while (n>=1024 && i<u.length-1){n/=1024;i++;}
    return `${n.toFixed(1)} ${u[i]}`;
  }
  function fmtPct(n) { return n == null ? '—' : `${n.toFixed(1)}%`; }
  function classifyPct(p, warn, crit) {
    if (p >= crit) return 'critical';
    if (p >= warn) return 'warn';
    return 'ok';
  }

  async function loadHealth(serverId) {
    state.serverId = serverId;
    const res = await fetch(`/api/servers/${serverId}/health`);
    const data = await res.json();
    renderStatusGrid(data);
    renderIncidents(data.open_incidents || []);
    loadIncidentHistory();
  }

  function renderStatusGrid(data) {
    const root = document.querySelector('[data-tab-panel="health"] .health-status-grid');
    if (!root) return;
    const host = data.latest_host_health ? data.latest_host_health.payload : {};
    const ext = data.latest_ext_deps ? data.latest_ext_deps.payload : {};

    const cards = [];

    // Disk (one card per mount)
    if (host.disk) {
      for (const d of host.disk) {
        const cls = classifyPct(d.percent, 85, 95);
        cards.push(card(`Disk ${d.mount}`, fmtPct(d.percent), `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`, cls));
      }
    }

    // RAM + swap
    if (host.ram) {
      const ramPct = host.ram.total ? (host.ram.used / host.ram.total) * 100 : 0;
      const swapPct = host.ram.swap_total ? (host.ram.swap_used / host.ram.swap_total) * 100 : 0;
      const cls = classifyPct(ramPct, 85, 95);
      const oom = host.oom_events || 0;
      cards.push(card('RAM', fmtPct(ramPct), `Swap ${fmtPct(swapPct)} • OOM(5min): ${oom}`, cls));
    }

    // GPU
    if (host.gpu) {
      if (host.gpu.lost) {
        cards.push(card('GPU', 'LOST', (host.gpu.errors || []).join('; '), 'critical'));
      } else {
        const memPct = host.gpu.mem_total ? (host.gpu.mem_used / host.gpu.mem_total) * 100 : 0;
        const tempCls = host.gpu.temp >= 90 ? 'critical' : host.gpu.temp >= 85 ? 'warn' : 'ok';
        cards.push(card('GPU', `${host.gpu.util}% util`, `Mem ${fmtPct(memPct)} • ${host.gpu.temp}°C`, tempCls));
      }
    }

    // External deps
    for (const [name, status] of Object.entries(ext)) {
      if (!status) continue;
      const cls = status.ok ? 'ok' : 'critical';
      cards.push(card(name, status.ok ? 'OK' : 'FAIL', status.error || '', cls));
    }

    root.innerHTML = cards.join('');
  }

  function card(label, value, sub, cls) {
    return `<div class="health-card ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ''}</div></div>`;
  }

  function renderIncidents(incidents) {
    const root = document.querySelector('[data-tab-panel="health"] .health-incidents');
    if (!root) return;
    if (incidents.length === 0) { root.innerHTML = '<p style="color:#64748b">No active incidents.</p>'; return; }
    root.innerHTML = incidents.map(i => incidentHtml(i)).join('');
    root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', onActionClick);
    });
  }

  function incidentHtml(inc) {
    const actions = (inc.suggested_actions || []).map((a, idx) =>
      `<button data-action="exec" data-incident="${inc.id}" data-cmd="${encodeURIComponent(a.command)}">${escapeHtml(a.label)}</button>`
    ).join('');
    return `<div class="incident-banner ${inc.severity}">
      <strong>${escapeHtml(inc.title)}</strong> <small>(${inc.kind})</small>
      <div class="actions">
        ${inc.acked_at ? '' : `<button data-action="ack" data-incident="${inc.id}">Acknowledge</button>`}
        <button data-action="close" data-incident="${inc.id}">Close</button>
        ${actions}
      </div>
    </div>`;
  }

  async function onActionClick(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    const id = btn.dataset.incident;
    if (action === 'ack') {
      await fetch(`/api/incidents/${id}/ack`, { method: 'POST' });
      loadHealth(state.serverId);
    } else if (action === 'close') {
      await fetch(`/api/incidents/${id}/close`, { method: 'POST' });
      loadHealth(state.serverId);
    } else if (action === 'exec') {
      const cmd = decodeURIComponent(btn.dataset.cmd);
      if (!confirm(`Run: ${cmd}\n\non server?`)) return;
      if (state.socket) {
        state.socket.emit('execute:request', { serverId: state.serverId, command: cmd });
      }
    }
  }

  async function loadIncidentHistory() {
    const root = document.querySelector('[data-tab-panel="health"] .health-history');
    if (!root) return;
    const res = await fetch(`/api/servers/${state.serverId}/incidents?range=30`);
    const items = await res.json();
    if (items.length === 0) { root.innerHTML = '<p style="color:#64748b">No history.</p>'; return; }
    root.innerHTML = '<h4>History (30d)</h4>' + items.map(i => `
      <div style="padding:6px 0;border-bottom:1px solid #1e293b">
        <span style="color:${i.severity==='critical'?'#ef4444':'#f59e0b'}">${i.severity}</span>
        <strong>${escapeHtml(i.title)}</strong>
        <small>${new Date(i.opened_at*1000).toLocaleString()} ${i.closed_at?'→ '+new Date(i.closed_at*1000).toLocaleString():'(open)'}</small>
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function onSocketHealthUpdate(msg) {
    if (msg.serverId !== state.serverId) return;
    loadHealth(state.serverId);
  }

  function onSocketHealthIncident(msg) {
    if (msg.serverId !== state.serverId) return;
    loadHealth(state.serverId);
    if (state.notificationsEnabled && msg.change === 'open' && msg.incident.severity === 'critical') {
      try { new Notification(msg.incident.title, { body: msg.incident.kind }); } catch {}
    }
  }

  window.HealthTab = {
    init(socket) {
      state.socket = socket;
      socket.on('health:update', onSocketHealthUpdate);
      socket.on('health:incident', onSocketHealthIncident);
    },
    show(serverId) { loadHealth(serverId); },
    enableNotifications() {
      if (!('Notification' in window)) return alert('Notifications not supported');
      Notification.requestPermission().then(p => { state.notificationsEnabled = p === 'granted'; });
    }
  };
})();
```

- [ ] **Step 4: Wire into `public/js/app.js`**

Read `public/js/app.js` first. Find where the socket is created (likely `io()` call) and where tabs are activated. Add at the top after `const socket = io();`:

```javascript
if (window.HealthTab) HealthTab.init(socket);
```

In the tab-click handler, when `data-tab === 'health'`:

```javascript
if (tabName === 'health' && window.HealthTab) HealthTab.show(currentServerId);
```

Include the script in `views/index.ejs`:

```html
<script src="/js/health.js"></script>
```

(Place after `app.js` script tag.)

- [ ] **Step 5: Commit**

```bash
git add views/index.ejs public/css/style.css public/js/health.js public/js/app.js
git commit -m "feat(ui): Health tab with status grid, incidents, history"
```

---

## Task 16: UI — Versions panel + baseline

**Files:**
- Modify: `public/js/health.js`

- [ ] **Step 1: Extend health.js with versions rendering**

Add to `health.js`:

```javascript
  async function loadVersions() {
    const root = document.querySelector('[data-tab-panel="health"] .health-versions');
    if (!root) return;
    const [curRes, baseRes] = await Promise.all([
      fetch(`/api/servers/${state.serverId}/versions/current`),
      fetch(`/api/servers/${state.serverId}/baselines`)
    ]);
    const current = await curRes.json();
    const baselines = await baseRes.json();
    const active = baselines.find(b => b.active === 1) || null;

    if (!current) {
      root.innerHTML = '<p style="color:#64748b">No version snapshot yet.</p>';
      return;
    }

    root.innerHTML = `
      <h4>Versions <small>(snapshot ${new Date(current.ts*1000).toLocaleString()})</small></h4>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button id="hb-save-baseline">${active ? 'Save new baseline' : 'Save current as baseline'}</button>
        <span style="color:#94a3b8;font-size:12px;align-self:center">${active ? 'Active baseline: '+(active.label||active.created_at) : 'No active baseline'}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div><h5>System</h5>${diffTable(active && active.system_pkgs, current.system_pkgs)}</div>
        <div><h5>Pip (per venv)</h5>${pipDiffHtml(active && active.pip_freeze, current.pip_freeze)}</div>
        <div><h5>Node</h5>${diffTable(active && active.node_pkgs, current.node_pkgs)}</div>
      </div>
    `;

    document.getElementById('hb-save-baseline').addEventListener('click', async () => {
      if (!confirm('Save current versions as the active baseline?')) return;
      await fetch(`/api/servers/${state.serverId}/baselines`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
      loadVersions();
      loadHealth(state.serverId);
    });
  }

  function diffTable(baseline, current) {
    if (!current) return '<i>(none)</i>';
    const all = new Set([...Object.keys(baseline || {}), ...Object.keys(current || {})]);
    const rows = [];
    for (const pkg of [...all].sort()) {
      const b = baseline ? baseline[pkg] : undefined;
      const c = current[pkg];
      let cls = '', mark = '';
      if (b == null && c != null) { cls = 'color:#10b981'; mark = '+ '; }
      else if (b != null && c == null) { cls = 'color:#94a3b8;text-decoration:line-through'; mark = '− '; }
      else if (b !== c) { cls = 'color:#ef4444'; mark = '~ '; }
      rows.push(`<div style="${cls};font-family:monospace;font-size:12px">${mark}${escapeHtml(pkg)}: ${escapeHtml(c || b)}${b !== c && b ? ` (was ${escapeHtml(b)})` : ''}</div>`);
    }
    return rows.join('') || '<i>(empty)</i>';
  }

  function pipDiffHtml(baselinePip, currentPip) {
    const venvs = new Set([...Object.keys(baselinePip || {}), ...Object.keys(currentPip || {})]);
    if (venvs.size === 0) return '<i>(none)</i>';
    return [...venvs].map(venv => `<div><strong style="font-size:11px">${escapeHtml(venv)}</strong>${diffTable(baselinePip && baselinePip[venv], currentPip && currentPip[venv])}</div>`).join('');
  }
```

Update `loadHealth` to also call versions:

```javascript
  async function loadHealth(serverId) {
    state.serverId = serverId;
    const res = await fetch(`/api/servers/${serverId}/health`);
    const data = await res.json();
    renderStatusGrid(data);
    renderIncidents(data.open_incidents || []);
    loadIncidentHistory();
    loadVersions();
  }
```

- [ ] **Step 2: Commit**

```bash
git add public/js/health.js
git commit -m "feat(ui): versions panel with baseline save and diff highlight"
```

---

## Task 17: UI — browser notification toggle

**Files:**
- Modify: `views/index.ejs` (add toggle button)
- Modify: `public/js/health.js` (already has `enableNotifications`)

- [ ] **Step 1: Add toggle in Health tab**

In the Health panel HTML in `views/index.ejs`, near top of `data-tab-panel="health"`:

```html
<div style="margin-bottom:12px">
  <button id="hb-enable-notifications">🔔 Enable browser notifications</button>
</div>
```

Wire in `app.js` or inline script:

```javascript
document.getElementById('hb-enable-notifications').addEventListener('click', () => HealthTab.enableNotifications());
```

- [ ] **Step 2: Persist preference per server in localStorage**

Modify `health.js` `enableNotifications` and `init`:

```javascript
    init(socket) {
      state.socket = socket;
      socket.on('health:update', onSocketHealthUpdate);
      socket.on('health:incident', onSocketHealthIncident);
      // Restore preference
      try {
        state.notificationsEnabled = localStorage.getItem('hb-notif-' + (state.serverId || 'default')) === '1' && Notification.permission === 'granted';
      } catch {}
    },
    enableNotifications() {
      if (!('Notification' in window)) return alert('Notifications not supported');
      Notification.requestPermission().then(p => {
        state.notificationsEnabled = p === 'granted';
        try { localStorage.setItem('hb-notif-' + state.serverId, p === 'granted' ? '1' : '0'); } catch {}
      });
    }
```

- [ ] **Step 3: Commit**

```bash
git add views/index.ejs public/js/health.js public/js/app.js
git commit -m "feat(ui): browser notification toggle for critical incidents"
```

---

## Task 18: End-to-end smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Run dashboard**

Run: `npm start`
Expected: server starts on port 3000, no errors.

- [ ] **Step 2: Hit endpoints**

```bash
# Pick any existing server id from /api/servers
curl http://localhost:3000/api/servers
SID="<copy id>"
curl http://localhost:3000/api/servers/$SID/health
curl http://localhost:3000/api/servers/$SID/baselines
```

Expected: JSON responses (empty arrays / null fields are fine if no data yet).

- [ ] **Step 3: Open dashboard in browser**

Visit `http://localhost:3000`. Click a server. Click "Health" tab. Verify:
- Tab shows up.
- Empty state messages render (no 500 errors in console).
- "Save baseline" button is disabled or returns 400 if no snapshot (acceptable).

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Final commit**

If any tweaks were needed:
```bash
git add -A
git commit -m "chore: final smoke-test fixes"
```

If everything was clean, just announce completion.

---

## Self-Review Notes (filled in after writing the plan)

- **Spec coverage:**
  - ✅ Active health checks (GPU/CUDA, Disk, RAM/Swap, Mongo/S3/Tailscale): Tasks 9–11
  - ✅ Version snapshot + drift: Tasks 5–6, 11
  - ✅ Manual baseline + Accept new baseline: Tasks 3, 14
  - ✅ Incident state machine: Tasks 4, 6
  - ✅ UI status grid + incidents + versions + history: Tasks 15–17
  - ✅ Suggested action buttons via existing `socket.on('execute')`: Task 15 step 3 (`onActionClick`)
  - ✅ Browser notification: Task 17
  - ✅ Cleanup retention: Task 8
  - ✅ Per-server agent config: Task 12
- **Placeholder scan:** No "TBD"/"TODO" leaked into steps. The "execute via dashboard" comment in `tailscale_down` `suggested_actions` is harmless metadata, not a placeholder for implementation.
- **Type consistency:** All `server_id` values are TEXT (UUID) — matches existing `db.js`. Spec said INTEGER; plan overrides correctly. Function signatures match between db helpers, health-service, agent-server.js handlers, and routes.
- **Note on `socket.on('execute:request')`:** UI emits `execute:request` to the **dashboard's browser socket**, but the existing agent-side handler is `socket.on('execute')` on the agent socket. Implementer must add a relay in `agent-server.js` browser→agent. **Fix added below as Task 15 supplementary step:** in browser side just emit directly via the existing PM2-control flow if it exists; otherwise add a relay endpoint. Defer to existing pattern in `pm2-operations.js` — adapt as needed.

---

## Open Decision for Implementer

**`socket.emit('execute:request', ...)` in `health.js` action click:** the dashboard already has a PM2 control flow (likely in `pm2-operations.js` and/or via an existing browser→agent relay). Use that channel. If no such relay exists, add one in `agent-server.js` browser-side that listens for `execute:request` and forwards to the corresponding agent socket via `socket.emit('execute', { command }, callback)`. Match the existing convention; don't invent a new one.
