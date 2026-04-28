const { Server } = require('socket.io');
const db = require('./db');

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

      if (pm2 && Array.isArray(pm2)) {
        db.upsertPm2Apps(serverId, pm2);
      }

      if (browserIo) {
        browserIo.emit('server:update', { serverId, metrics, pm2 });
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
