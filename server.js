const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const db = require('./db');
const apiRouter = require('./routes/api');
const { createAgentServer } = require('./agent-server');
const sshPoller = require('./ssh-poller');
const sshTerminal = require('./ssh-terminal');
const cleanup = require('./cleanup');
const heartbeat = require('./heartbeat');
const scoreboardMgr = require('./scoreboard-manager');

// Initialize database
db.init();

// Express app
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', apiRouter);
app.get('/', (req, res) => {
  res.render('index');
});
app.get('/scoreboards', (req, res) => {
  res.render('scoreboards');
});

// HTTP server
const server = http.createServer(app);

// Browser Socket.IO (port 3000, same as Express)
const browserIo = new Server(server);
browserIo.on('connection', (socket) => {
  console.log(`[Browser] Client connected`);
  socket.on('disconnect', () => {
    console.log(`[Browser] Client disconnected`);
  });
});

// Make browserIo available to routes
app.set('browserIo', browserIo);

// Agent Socket.IO (same HTTP server, different path)
createAgentServer(server, browserIo);

// SSH Poller
sshPoller.init(browserIo);
sshPoller.startAllPolling();

// SSH Terminal
sshTerminal.init(browserIo);

// Heartbeat monitor
heartbeat.start(browserIo);

// Cleanup job
cleanup.start();

// Scoreboard manager — resume all from DB
scoreboardMgr.init(browserIo);
scoreboardMgr.resumeAll();

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`);
  cleanup.stop();
  heartbeat.stop();
  scoreboardMgr.stopAll();
  server.close(() => {
    db.close();
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Prevent crash on unhandled errors (e.g. SSH ECONNRESET)
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (not crashing):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection (not crashing):', reason);
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Dashboard running at http://localhost:${PORT}`);
  console.log(`[Server] Agent WebSocket path: /agent`);
});
