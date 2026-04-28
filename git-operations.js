const db = require('./db');
const { NodeSSH } = require('node-ssh');
const { findAgentSocket } = require('./agent-utils');

// Timeout for git pull operations (60 seconds)
const PULL_TIMEOUT = 60000;

/**
 * Execute git pull on a server
 * @param {string} serverId - Server ID
 * @param {object} browserIo - Socket.IO instance for browser communication
 * @returns {Promise<object>} Pull operation result
 */
async function executePull(serverId, browserIo) {
  const server = db.getServer(serverId);
  
  if (!server) {
    throw new Error('Server not found');
  }
  
  if (!server.git_repo_path || server.git_repo_path.trim() === '') {
    throw new Error('Git repository path not configured');
  }
  
  // Create pull record
  const pull = db.createGitPull(serverId);
  
  // Emit status to browser
  browserIo.emit('git:pull:status', { serverId, status: 'pulling' });
  
  try {
    let result;
    if (server.mode === 'agent') {
      result = await executePullViaAgent(server, pull.id, browserIo);
    } else {
      result = await executePullViaSSH(server, pull.id, browserIo);
    }
    
    return result;
  } catch (error) {
    console.error(`[Git Pull] Error for server ${serverId}:`, error.message);
    
    // Update database with failure
    const output = truncateOutput(error.message);
    db.updateGitPull(pull.id, {
      status: 'failed',
      output,
      completed_at: Math.floor(Date.now() / 1000)
    });
    
    // Emit completion to browser
    browserIo.emit('git:pull:complete', {
      serverId,
      pullId: pull.id,
      status: 'failed',
      conflictDetected: false
    });
    
    browserIo.emit('git:pull:status', { serverId, status: 'failed' });
    
    throw error;
  }
}

/**
 * Execute git pull via agent WebSocket
 */
async function executePullViaAgent(server, pullId, browserIo) {
  return new Promise((resolve, reject) => {
    // Find agent socket
    const agentSocket = findAgentSocket(server.id);
    
    if (!agentSocket) {
      reject(new Error('Server is offline'));
      return;
    }
    
    let output = '';
    let timeoutHandle;
    
    // Set up timeout
    timeoutHandle = setTimeout(() => {
      cleanup();
      
      const truncated = truncateOutput(output || 'Operation timed out');
      db.updateGitPull(pullId, {
        status: 'timeout',
        output: truncated,
        completed_at: Math.floor(Date.now() / 1000)
      });
      
      browserIo.emit('git:pull:complete', {
        serverId: server.id,
        pullId,
        status: 'timeout',
        conflictDetected: false
      });
      
      browserIo.emit('git:pull:status', { serverId: server.id, status: 'failed' });
      
      reject(new Error('Operation timed out'));
    }, PULL_TIMEOUT);
    
    // Listen for log events
    const logHandler = (data) => {
      if (data.pullId !== pullId) return;
      
      output += data.message + '\n';
      
      // Forward to browser
      browserIo.emit('git:pull:log', {
        serverId: server.id,
        pullId,
        logType: data.logType,
        message: data.message
      });
    };
    
    // Listen for completion
    const completeHandler = (data) => {
      if (data.pullId !== pullId) return;
      
      cleanup();
      
      output += data.output || '';
      const truncated = truncateOutput(output);
      const hasConflict = detectConflict(output);
      const status = data.exitCode === 0 ? (hasConflict ? 'conflict' : 'success') : 'failed';
      
      db.updateGitPull(pullId, {
        status,
        output: truncated,
        conflict_detected: hasConflict ? 1 : 0,
        completed_at: Math.floor(Date.now() / 1000)
      });
      
      browserIo.emit('git:pull:complete', {
        serverId: server.id,
        pullId,
        status,
        conflictDetected: hasConflict
      });
      
      browserIo.emit('git:pull:status', { 
        serverId: server.id, 
        status: status === 'success' ? 'success' : 'failed' 
      });
      
      if (status === 'success' || status === 'conflict') {
        resolve({ pullId, status });
      } else {
        reject(new Error('Git pull failed'));
      }
    };
    
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      agentSocket.off('git:pull:log', logHandler);
      agentSocket.off('git:pull:complete', completeHandler);
    };
    
    agentSocket.on('git:pull:log', logHandler);
    agentSocket.on('git:pull:complete', completeHandler);
    
    // Send pull command to agent
    agentSocket.emit('git:pull', {
      pullId,
      repoPath: server.git_repo_path
    });
  });
}

/**
 * Execute git pull via SSH
 */
async function executePullViaSSH(server, pullId, browserIo) {
  const ssh = new NodeSSH();
  let output = '';

  // Timeout via AbortController-style race
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('__TIMEOUT__')), PULL_TIMEOUT);
  });

  const pullPromise = (async () => {
    const config = {
      host: server.ip,
      port: 22,
      username: server.ssh_user
    };

    if (server.ssh_key_path) {
      config.privateKeyPath = server.ssh_key_path;
    } else if (server.ssh_password) {
      config.password = server.ssh_password;
    }

    if (!config.privateKeyPath && !config.password) {
      throw new Error('No SSH credentials configured');
    }

    await ssh.connect(config);

    const command = `cd ${server.git_repo_path} && git pull`;

    const result = await ssh.execCommand(command, {
      onStdout: (chunk) => {
        const message = chunk.toString('utf8');
        output += message;
        browserIo.emit('git:pull:log', { serverId: server.id, pullId, logType: 'stdout', message });
      },
      onStderr: (chunk) => {
        const message = chunk.toString('utf8');
        output += message;
        browserIo.emit('git:pull:log', { serverId: server.id, pullId, logType: 'stderr', message });
      }
    });

    ssh.dispose();

    const truncated = truncateOutput(output);
    const hasConflict = detectConflict(output);
    const status = result.code === 0 ? (hasConflict ? 'conflict' : 'success') : 'failed';

    db.updateGitPull(pullId, {
      status,
      output: truncated,
      conflict_detected: hasConflict ? 1 : 0,
      completed_at: Math.floor(Date.now() / 1000)
    });

    browserIo.emit('git:pull:complete', { serverId: server.id, pullId, status, conflictDetected: hasConflict });
    browserIo.emit('git:pull:status', { serverId: server.id, status: status === 'success' ? 'success' : 'failed' });

    if (status === 'success' || status === 'conflict') {
      return { pullId, status };
    }
    throw new Error('Git pull failed');
  })();

  try {
    return await Promise.race([pullPromise, timeoutPromise]);
  } catch (err) {
    ssh.dispose();

    if (err.message === '__TIMEOUT__') {
      const truncated = truncateOutput(output || 'Operation timed out');
      db.updateGitPull(pullId, { status: 'timeout', output: truncated, completed_at: Math.floor(Date.now() / 1000) });
      browserIo.emit('git:pull:complete', { serverId: server.id, pullId, status: 'timeout', conflictDetected: false });
      browserIo.emit('git:pull:status', { serverId: server.id, status: 'failed' });
      throw new Error('Operation timed out');
    }
    throw new Error(`Failed to connect via SSH: ${err.message}`);
  }
}

/**
 * Detect merge conflicts in git output
 */
function detectConflict(output) {
  if (!output) return false;
  return output.includes('CONFLICT') || output.includes('Automatic merge failed');
}

/**
 * Truncate output to maximum length
 */
function truncateOutput(output, maxLength = 5000) {
  if (!output) return '';
  if (output.length <= maxLength) return output;
  return output.substring(0, maxLength) + '\n\n[Output truncated - exceeded 5000 character limit]';
}

module.exports = {
  executePull,
  executePullViaAgent,
  executePullViaSSH,
  detectConflict,
  truncateOutput
};
