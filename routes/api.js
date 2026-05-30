const express = require('express');
const router = express.Router();
const db = require('../db');
const gitOps = require('../git-operations');
const pm2Ops = require('../pm2-operations');
const sshPoller = require('../ssh-poller');
const scoreboardMgr = require('../scoreboard-manager');
const { findAgentSocket } = require('../agent-utils');
const accessManager = require('../access-manager');

function isValidIp(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

// List all servers
router.get('/servers', (req, res) => {
  const servers = db.getServers();
  res.json(servers);
});

// Add server
router.post('/servers', (req, res) => {
  const { name, ip, mode, ssh_user, ssh_key_path, ssh_password, git_repo_path } = req.body;
  const access_model = accessManager.normalizeAccessModel(req.body.access_model);

  if (!name || !ip) {
    return res.status(400).json({ error: 'name and ip are required' });
  }
  if (!isValidIp(ip)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  const server = db.addServer({ name, ip, mode, ssh_user, ssh_key_path, ssh_password, git_repo_path, access_model });
  res.status(201).json(server);
});

// Update server
router.put('/servers/:id', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (req.body.ip && !isValidIp(req.body.ip)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  const fields = { ...req.body };
  if (fields.access_model !== undefined) {
    fields.access_model = accessManager.normalizeAccessModel(fields.access_model);
  }
  const updated = db.updateServer(req.params.id, fields);
  res.json(updated);
});

// Delete server
router.delete('/servers/:id', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  db.deleteServer(req.params.id);
  res.status(204).end();
});

// Get metrics
router.get('/servers/:id/metrics', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const range = parseInt(req.query.range) || 48;
  const metrics = accessManager.enrichMetrics(server, db.getMetrics(req.params.id, range));
  res.json(metrics);
});

// Get PM2 apps
router.get('/servers/:id/pm2', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const apps = db.getPm2Apps(req.params.id);
  res.json(apps);
});

// Get logs
router.get('/servers/:id/logs/:appName', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const lines = parseInt(req.query.lines) || 200;
  const logs = db.getLogs(req.params.id, req.params.appName, lines);
  res.json(logs);
});

// Execute git pull on single server
router.post('/servers/:id/pull', async (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (!server.git_repo_path || server.git_repo_path.trim() === '') {
    return res.status(400).json({ error: 'Git repository path not configured' });
  }

  if (!server.git_repo_path.startsWith('/')) {
    return res.status(400).json({ error: 'Repository path must be absolute (start with /)' });
  }

  try {
    const browserIo = req.app.get('browserIo');
    const result = await gitOps.executePull(req.params.id, browserIo);
    res.json({ pullId: result.pullId, status: 'started' });
  } catch (error) {
    console.error('[API] Pull error:', error.message);
    
    if (error.message.includes('offline')) {
      return res.status(503).json({ error: 'Server is offline' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Execute git pull on all servers
router.post('/pull-all', async (req, res) => {
  const servers = db.getServers().filter(s => s.git_repo_path && s.git_repo_path.trim() !== '');
  
  if (servers.length === 0) {
    return res.json({ operations: [] });
  }

  const browserIo = req.app.get('browserIo');
  const operations = [];

  // Execute pulls in parallel
  const promises = servers.map(async (server) => {
    try {
      const result = await gitOps.executePull(server.id, browserIo);
      operations.push({ serverId: server.id, pullId: result.pullId, status: 'started' });
    } catch (error) {
      console.error(`[API] Pull error for ${server.id}:`, error.message);
      operations.push({ serverId: server.id, pullId: null, status: 'error', error: error.message });
    }
  });

  await Promise.all(promises);
  res.json({ operations });
});

// Test repository accessibility
router.post('/servers/:id/test-repo', async (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (!server.git_repo_path || server.git_repo_path.trim() === '') {
    return res.status(400).json({ error: 'Git repository path not configured' });
  }

  // Test will be implemented similar to pull but with 'git status' command
  // For now, return a simple validation
  res.json({ success: true, message: 'Repository path configured' });
});

// Get pull history for server
router.get('/servers/:id/pulls', (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const limit = parseInt(req.query.limit) || 10;
  const pulls = db.getGitPulls(req.params.id, limit);
  res.json(pulls);
});

// Get specific pull details
router.get('/pulls/:pullId', (req, res) => {
  const pull = db.getGitPull(req.params.pullId);
  if (!pull) return res.status(404).json({ error: 'Pull operation not found' });

  res.json(pull);
});

// PM2 process control actions
router.post('/servers/:id/pm2/:appName/:action', async (req, res) => {
  const { id: serverId, appName, action } = req.params;

  // Validate action
  if (!['delete', 'restart', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  // Validate server
  const server = db.getServer(serverId);
  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }

  if (server.status !== 'online') {
    return res.status(503).json({ error: 'Server is offline' });
  }

  try {
    const result = await pm2Ops.executePM2Action(serverId, appName, action);
    
    if (!result.success) {
      console.error(`[PM2] Action failed for ${serverId}/${appName}/${action}:`, result.error);
      return res.status(500).json({ error: result.error });
    }

    // Emit real-time update
    const browserIo = req.app.get('browserIo');
    
    // Fetch updated PM2 apps list
    // Give PM2 a moment to update its state
    setTimeout(() => {
      const updatedApps = db.getPm2Apps(serverId);
      browserIo.emit('pm2:update', { serverId, pm2Apps: updatedApps });
    }, 500);

    res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('[PM2] Action error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reconnect SSH server (stop + start polling)
router.post('/servers/:id/reconnect', async (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (server.mode !== 'ssh') {
    return res.status(400).json({ error: 'Server is not in SSH mode' });
  }

  try {
    // Stop existing polling and close connection
    sshPoller.stopPolling(server.id);

    // Test connection first
    const result = await sshPoller.testConnection(server);
    if (result.success) {
      sshPoller.startPolling(server);
      db.updateServerStatus(server.id, 'online');

      const browserIo = req.app.get('browserIo');
      browserIo.emit('server:status', { serverId: server.id, status: 'online', lastSeen: Math.floor(Date.now() / 1000) });

      return res.json({ success: true });
    }
    return res.json({ success: false, error: result.error });
  } catch (error) {
    return res.json({ success: false, error: error.message || 'Reconnect failed' });
  }
});

// Test SSH connection for a server
router.post('/servers/:id/test-connection', async (req, res) => {
  const server = db.getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (server.mode !== 'ssh') {
    return res.status(400).json({ error: 'Server is not in SSH mode' });
  }

  try {
    const result = await sshPoller.testConnection(server);
    if (result.success) {
      sshPoller.startPolling(server);
      return res.json({ success: true, message: 'Connection successful' });
    }
    return res.json({ success: false, error: result.error });
  } catch (error) {
    return res.json({ success: false, error: error.message || 'Connection failed' });
  }
});

// --- Scoreboards ---

router.get('/scoreboards', (req, res) => {
  const list = db.getScoreboards().map(sb => ({
    ...sb,
    running: scoreboardMgr.isRunning(sb.id),
  }));
  res.json(list);
});

router.post('/scoreboards', (req, res) => {
  const { name, scoreboard_id, script_type } = req.body;
  if (!name || !scoreboard_id) {
    return res.status(400).json({ error: 'name and scoreboard_id are required' });
  }
  if (script_type && !['mission', 'academy'].includes(script_type)) {
    return res.status(400).json({ error: 'script_type must be mission or academy' });
  }

  const sb = db.addScoreboard({ name, scoreboard_id, script_type });
  scoreboardMgr.start(sb);
  res.status(201).json({ ...sb, running: true });
});

router.delete('/scoreboards/:id', (req, res) => {
  const sb = db.getScoreboard(req.params.id);
  if (!sb) return res.status(404).json({ error: 'Scoreboard not found' });

  scoreboardMgr.stop(req.params.id);
  db.deleteScoreboard(req.params.id);
  res.status(204).end();
});

router.get('/scoreboards/:id/logs', (req, res) => {
  const sb = db.getScoreboard(req.params.id);
  if (!sb) return res.status(404).json({ error: 'Scoreboard not found' });

  const lines = parseInt(req.query.lines) || 500;
  const logs = db.getScoreboardLogs(req.params.id, lines);
  res.json(logs);
});

router.post('/scoreboards/:id/restart', (req, res) => {
  const sb = db.getScoreboard(req.params.id);
  if (!sb) return res.status(404).json({ error: 'Scoreboard not found' });

  scoreboardMgr.stop(req.params.id);
  setTimeout(() => scoreboardMgr.start(sb), 500);
  res.json({ status: 'restarting' });
});

// --- Health management ---

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
  const decode = (e) => e ? { ...e, payload: JSON.parse(e.payload || '{}'), errors: JSON.parse(e.errors || '[]') } : null;

  res.json({
    server,
    open_incidents: open.map(i => ({
      ...i,
      details: JSON.parse(i.details || '{}'),
      suggested_actions: JSON.parse(i.suggested_actions || '[]')
    })),
    latest_host_health: decode(latestByKind.host_health),
    latest_ext_deps: decode(latestByKind.ext_deps),
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
  res.json(rows.map(r => ({
    ...r,
    details: JSON.parse(r.details || '{}'),
    suggested_actions: JSON.parse(r.suggested_actions || '[]')
  })));
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

router.post('/incidents/:id/run-action', (req, res) => {
  const inc = db.getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const { command } = req.body || {};
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command required' });
  if (command.startsWith('#')) return res.status(400).json({ error: 'UI-only action; not executable' });

  const agent = findAgentSocket(inc.server_id);
  if (!agent) return res.status(503).json({ error: 'Agent not connected' });

  const timeout = setTimeout(() => res.status(504).json({ error: 'Action timed out' }), 15000);
  agent.emit('execute', { command }, (response) => {
    clearTimeout(timeout);
    if (res.headersSent) return;
    if (response && response.error) return res.status(500).json({ error: response.error, output: response.output || '' });
    res.json({ output: (response && response.output) || '' });
  });
});

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

module.exports = router;
