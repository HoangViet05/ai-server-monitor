const db = require('./db');
const { NodeSSH } = require('node-ssh');
const { findAgentSocket } = require('./agent-utils');

// Timeout for PM2 operations (10 seconds)
const PM2_TIMEOUT = 10000;

/**
 * Validate app name to prevent command injection
 * @param {string} appName - PM2 app name
 * @returns {boolean} True if valid
 */
function validateAppName(appName) {
  if (!appName || typeof appName !== 'string') {
    return false;
  }
  
  // Check for shell metacharacters
  const dangerousChars = /[;|&$`\\"'<>()\[\]{}*]/;
  return !dangerousChars.test(appName);
}

/**
 * Build safe PM2 command
 * @param {string} action - PM2 action (delete, restart, stop)
 * @param {string} appName - PM2 app name
 * @returns {string} PM2 command
 */
function buildPM2Command(action, appName) {
  // Validate action whitelist
  const validActions = ['delete', 'restart', 'stop'];
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
  
  // Validate app name
  if (!validateAppName(appName)) {
    throw new Error('Invalid app name: contains dangerous characters');
  }
  
  // Escape app name for shell safety (wrap in single quotes)
  const escapedAppName = appName.replace(/'/g, "'\\''");
  
  return `pm2 ${action} '${escapedAppName}'`;
}

/**
 * Execute PM2 action on a server
 * @param {string} serverId - Server ID
 * @param {string} appName - PM2 app name
 * @param {string} action - PM2 action (delete, restart, stop)
 * @returns {Promise<object>} Action result
 */
async function executePM2Action(serverId, appName, action) {
  const server = db.getServer(serverId);
  
  if (!server) {
    throw new Error('Server not found');
  }
  
  if (server.status !== 'online') {
    throw new Error('Server is offline');
  }
  
  // Build command
  const command = buildPM2Command(action, appName);
  
  try {
    let output;
    if (server.mode === 'agent') {
      output = await executePM2ViaAgent(server, command);
    } else {
      output = await executePM2ViaSSH(server, command);
    }
    
    // Check for errors in output
    if (output.includes('error') || output.includes('not found') || output.includes('Error:')) {
      return { success: false, error: output };
    }
    
    return { success: true, message: `Process ${action} completed` };
  } catch (error) {
    console.error(`[PM2] Action error for ${serverId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Execute PM2 command via agent WebSocket
 */
async function executePM2ViaAgent(server, command) {
  return new Promise((resolve, reject) => {
    const agentSocket = findAgentSocket(server.id);
    
    if (!agentSocket) {
      reject(new Error('Agent not connected'));
      return;
    }
    
    let timeoutHandle;
    
    // Set up timeout
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error('Operation timed out'));
    }, PM2_TIMEOUT);
    
    // Send command and wait for response
    agentSocket.emit('execute', { command }, (response) => {
      clearTimeout(timeoutHandle);
      
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.output || '');
      }
    });
    
    const cleanup = () => {
      clearTimeout(timeoutHandle);
    };
  });
}

/**
 * Execute PM2 command via SSH
 */
async function executePM2ViaSSH(server, command) {
  const ssh = new NodeSSH();
  
  try {
    // Connect
    const config = {
      host: server.ip,
      port: 22,
      username: server.ssh_user || 'root',
      readyTimeout: 10000
    };
    
    if (server.ssh_key_path) {
      config.privateKeyPath = server.ssh_key_path;
    } else if (server.ssh_password) {
      config.password = server.ssh_password;
    } else {
      throw new Error('No SSH credentials configured');
    }
    
    await ssh.connect(config);
    
    // Execute command
    const result = await ssh.execCommand(command);
    
    ssh.dispose();
    
    // Return combined output
    return result.stdout + result.stderr;
  } catch (error) {
    ssh.dispose();
    throw new Error(`SSH execution failed: ${error.message}`);
  }
}

module.exports = {
  executePM2Action,
  validateAppName,
  buildPM2Command
};
