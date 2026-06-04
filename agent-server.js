const { Server } = require('socket.io');
const db = require('./db');
const healthService = require('./health-service');
const accessManager = require('./access-manager');

let browserIo = null;
let agentIo = null;

function createAgentServer(httpServer, _browserIo) {
  browserIo = _browserIo;

  agentIo = new Server(httpServer, {
    path: '/agent',
    cors: { origin: '*' }
  });

  agentIo.on('connection', (socket) => {
    let serverId = null;

    console.log(`[Agent] New connection from ${socket.handshake.address}`);

    socket.on('register', (data) => {
      const { hostname, ip } = data;
      console.log(`[Agent] Register: ${hostname} (${ip})`);

      let server = db.findServerByIp(ip);
      if (server) {
        serverId = server.id;
        socket.serverId = serverId; // Store for git operations
        db.updateServerStatus(serverId, 'online');
      } else {
        // Auto-register unknown agents
        const newServer = db.addServer({ name: hostname, ip, mode: 'agent' });
        serverId = newServer.id;
        socket.serverId = serverId; // Store for git operations
        db.updateServerStatus(serverId, 'online');
      }

      if (browserIo) {
        browserIo.emit('server:status', { serverId, status: 'online', lastSeen: Math.floor(Date.now() / 1000) });
      }
    });

    socket.on('heartbeat', (data) => {
      if (!serverId) return;

      const { metrics, pm2 } = data;

      db.updateServerStatus(serverId, 'online');
      db.insertMetrics(serverId, metrics);
      const server = db.getServer(serverId);
      const enrichedMetrics = accessManager.enrichMetric(server, metrics);

      if (pm2 && Array.isArray(pm2)) {
        db.upsertPm2Apps(serverId, pm2);
      }

      if (browserIo) {
        browserIo.emit('server:update', { serverId, metrics: enrichedMetrics, pm2 });
      }
    });

    socket.on('logs', (data) => {
      if (!serverId) return;

      const { appName, logType, lines } = data;
      const logEntries = lines.map(msg => ({ log_type: logType, message: msg }));
      db.insertLogs(serverId, appName, logEntries);

      if (browserIo) {
        for (const msg of lines) {
          browserIo.emit('server:log', { serverId, appName, logType, message: msg });
        }
      }
    });

    socket.on('health:check', (data) => {
      if (!serverId) return;
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

    socket.on('version:snapshot', (data) => {
      if (!serverId) return;
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

    // Git pull log relay
    socket.on('git:pull:log', (data) => {
      if (!serverId) return;
      
      if (browserIo) {
        browserIo.emit('git:pull:log', {
          serverId,
          pullId: data.pullId,
          logType: data.logType,
          message: data.message
        });
      }
    });

    // Git pull completion relay
    socket.on('git:pull:complete', (data) => {
      if (!serverId) return;
      
      if (browserIo) {
        browserIo.emit('git:pull:complete', {
          serverId,
          pullId: data.pullId,
          exitCode: data.exitCode,
          output: data.output
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Agent] Disconnected: ${serverId || 'unknown'}`);
      // Don't immediately mark offline — let the heartbeat timeout handle it
    });
  });

  return agentIo;
}

function getAgentIo() {
  return agentIo;
}

module.exports = { createAgentServer, getAgentIo };
