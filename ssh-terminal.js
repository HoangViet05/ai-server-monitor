const { NodeSSH } = require('node-ssh');
const db = require('./db');

// Map: socketId -> { ssh, stream, serverId }
const sessions = new Map();

function init(browserIo) {
  browserIo.on('connection', (socket) => {
    socket.on('ssh:open', (data) => handleOpen(socket, data));
    socket.on('ssh:input', (data) => handleInput(socket, data));
    socket.on('ssh:resize', (data) => handleResize(socket, data));
    socket.on('ssh:close', () => handleClose(socket));
    socket.on('disconnect', () => handleClose(socket));
  });
}

async function handleOpen(socket, { serverId, cols, rows }) {
  // Clean up any existing session for this socket
  handleClose(socket);

  console.log(`[SSH-Term] ssh:open received for serverId=${serverId} (socket ${socket.id})`);

  const server = db.getServer(serverId);
  if (!server || server.mode !== 'ssh') {
    console.log(`[SSH-Term] Server not found or not SSH mode`);
    socket.emit('ssh:error', { error: 'Server not found or not in SSH mode' });
    return;
  }

  const ssh = new NodeSSH();
  try {
    const config = {
      host: server.ip,
      username: server.ssh_user || 'root',
      readyTimeout: 10000,
    };

    if (server.ssh_key_path) {
      config.privateKeyPath = server.ssh_key_path;
    } else if (server.ssh_password) {
      config.password = server.ssh_password;
    } else {
      socket.emit('ssh:error', { error: 'No SSH credentials configured' });
      return;
    }

    console.log(`[SSH-Term] Connecting to ${server.name} (${server.ip}) as ${config.username}...`);
    await ssh.connect(config);
    console.log(`[SSH-Term] Connected, opening shell...`);

    // Open interactive shell via raw ssh2
    const stream = await new Promise((resolve, reject) => {
      ssh.connection.shell(
        { cols: cols || 80, rows: rows || 24, term: 'xterm-256color' },
        (err, ch) => {
          if (err) return reject(err);
          resolve(ch);
        }
      );
    });

    console.log(`[SSH-Term] Shell opened for ${server.name}`);
    sessions.set(socket.id, { ssh, stream, serverId });

    stream.on('data', (data) => {
      socket.emit('ssh:data', { data: data.toString('utf-8') });
    });

    stream.stderr.on('data', (data) => {
      socket.emit('ssh:data', { data: data.toString('utf-8') });
    });

    stream.on('close', () => {
      socket.emit('ssh:close', {});
      cleanup(socket.id);
    });

    stream.on('error', (err) => {
      console.error(`[SSH-Term] Stream error: ${err.message}`);
      socket.emit('ssh:error', { error: 'Stream error: ' + err.message });
      cleanup(socket.id);
    });

    console.log(`[SSH-Term] Session ready for ${server.name} (socket ${socket.id})`);
  } catch (err) {
    console.error(`[SSH-Term] Connection failed: ${err.message}`);
    socket.emit('ssh:error', { error: 'Connection failed: ' + err.message });
    try { ssh.dispose(); } catch (_) {}
  }
}

function handleInput(socket, { data }) {
  const session = sessions.get(socket.id);
  if (session && session.stream) {
    session.stream.write(data);
  }
}

function handleResize(socket, { cols, rows }) {
  const session = sessions.get(socket.id);
  if (session && session.stream) {
    session.stream.setWindow(rows, cols, 0, 0);
  }
}

function handleClose(socket) {
  cleanup(socket.id);
}

function cleanup(socketId) {
  const session = sessions.get(socketId);
  if (!session) return;

  try {
    if (session.stream) session.stream.end();
  } catch (_) {}
  try {
    if (session.ssh) session.ssh.dispose();
  } catch (_) {}

  sessions.delete(socketId);
  console.log(`[SSH-Term] Session closed (socket ${socketId})`);
}

module.exports = { init };
