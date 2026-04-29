const { spawn, execSync } = require('child_process');
const path = require('path');
const db = require('./db');

const SCRIPTS = {
  mission: path.join(__dirname, 'test_socket_mission.js'),
  academy: path.join(__dirname, 'test_socket_academy.js'),
};

const processes = new Map(); // id -> { proc, restartTimer, stopping }
let browserIo = null;

function init(io) {
  browserIo = io;
}

function isRunning(id) {
  const entry = processes.get(id);
  return !!(entry && entry.proc && !entry.proc.killed);
}

function emitLog(scoreboardId, stream, message) {
  const lines = message.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return;
  for (const line of lines) {
    db.insertScoreboardLog(scoreboardId, stream, line);
  }
  if (browserIo) {
    browserIo.emit('scoreboard:log', { scoreboardId, stream, lines });
  }
}

function start(scoreboard) {
  if (isRunning(scoreboard.id)) return;

  const scriptPath = SCRIPTS[scoreboard.script_type] || SCRIPTS.mission;

  const proc = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, SCOREBOARD_ID: scoreboard.scoreboard_id },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry = { proc, restartTimer: null, stopping: false };
  processes.set(scoreboard.id, entry);

  emitLog(scoreboard.id, 'system', `[manager] Started PID ${proc.pid} (${scoreboard.script_type})`);
  if (browserIo) browserIo.emit('scoreboard:status', { scoreboardId: scoreboard.id, running: true });

  proc.stdout.on('data', (data) => emitLog(scoreboard.id, 'stdout', data.toString()));
  proc.stderr.on('data', (data) => emitLog(scoreboard.id, 'stderr', data.toString()));

  proc.on('close', (code) => {
    emitLog(scoreboard.id, 'system', `[manager] Exited with code ${code}`);
    if (browserIo) browserIo.emit('scoreboard:status', { scoreboardId: scoreboard.id, running: false });
    processes.delete(scoreboard.id);

    if (entry.stopping) return;

    // Auto-restart after 5s if scoreboard still exists in DB
    entry.restartTimer = setTimeout(() => {
      const sb = db.getScoreboard(scoreboard.id);
      if (sb) {
        emitLog(scoreboard.id, 'system', '[manager] Auto-restarting...');
        start(sb);
      }
    }, 5000);
  });

  proc.on('error', (err) => {
    emitLog(scoreboard.id, 'system', `[manager] Spawn error: ${err.message}`);
  });
}

function stop(id) {
  const entry = processes.get(id);
  if (!entry) return;

  entry.stopping = true;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);

  if (entry.proc && !entry.proc.killed) {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${entry.proc.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        entry.proc.kill();
      }
    } else {
      entry.proc.kill('SIGTERM');
    }
  }
  processes.delete(id);
}

function stopAll() {
  for (const id of [...processes.keys()]) {
    stop(id);
  }
}

function resumeAll() {
  const list = db.getScoreboards();
  for (const sb of list) start(sb);
}

function getStatus(id) {
  return { running: isRunning(id) };
}

module.exports = { init, start, stop, stopAll, resumeAll, isRunning, getStatus };
