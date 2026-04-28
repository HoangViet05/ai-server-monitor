const { getAgentIo } = require('./agent-server');

/**
 * Find agent socket by server ID
 * @param {string} serverId - Server ID
 * @returns {object|null} Socket.IO socket or null
 */
function findAgentSocket(serverId) {
  const agentIo = getAgentIo();

  if (!agentIo) return null;

  for (const [id, socket] of agentIo.sockets.sockets) {
    if (socket.serverId === serverId) {
      return socket;
    }
  }

  return null;
}

module.exports = { findAgentSocket };
