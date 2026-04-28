const db = require('./db');
const sshPoller = require('./ssh-poller');

let intervalHandle = null;
let browserIo = null;

function start(_browserIo) {
  browserIo = _browserIo;
  intervalHandle = setInterval(check, 15000); // Check every 15s
  console.log('[Heartbeat] Monitor started — checking every 15s');
}

function check() {
  const now = Math.floor(Date.now() / 1000);
  const servers = db.getServers();

  for (const server of servers) {
    if (server.status === 'online' && server.last_seen > 0 && (now - server.last_seen) > 60) {
      console.log(`[Heartbeat] ${server.name} timed out — marking offline`);
      db.updateServerStatus(server.id, 'offline');

      if (browserIo) {
        browserIo.emit('server:status', { serverId: server.id, status: 'offline', lastSeen: server.last_seen });
      }

      // If agent-mode server has SSH config, try SSH fallback
      if (server.mode === 'agent' && (server.ssh_user || server.ssh_key_path || server.ssh_password)) {
        console.log(`[Heartbeat] Attempting SSH fallback for ${server.name}`);
        sshPoller.startPolling(server);
      }
    }
  }
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop };
