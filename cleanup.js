const db = require('./db');

let intervalHandle = null;

function start() {
  console.log('[Cleanup] Started — runs every hour');

  // Run immediately on start
  run();

  // Then every hour
  intervalHandle = setInterval(run, 3600000);
}

function run() {
  try {
    db.cleanupOldMetrics();
    db.cleanupExcessLogs();
    db.cleanupOldGitPulls();
    for (const sb of db.getScoreboards()) {
      db.cleanupExcessScoreboardLogs(sb.id);
    }
    console.log(`[Cleanup] Done at ${new Date().toISOString()}`);
  } catch (err) {
    console.error(`[Cleanup] Error: ${err.message}`);
  }
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop, run };
