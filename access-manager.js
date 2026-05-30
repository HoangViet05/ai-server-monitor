const ACCESS_MODELS = {
  gt1030: {
    label: 'GT 1030',
    capacity: 1,
    cpuThreshold: 15,
    coreThreshold: null,
  },
  gtx1660s: {
    label: 'GTX 1660S',
    capacity: 5,
    cpuThreshold: null,
    coreThreshold: 20,
    coresPerDevice: 2,
  },
};

function normalizeAccessModel(value) {
  return ACCESS_MODELS[value] ? value : 'gt1030';
}

function parseGpuNames(gpuNames) {
  if (!gpuNames) return null;
  if (typeof gpuNames === 'object') return gpuNames;
  if (typeof gpuNames === 'string') {
    try {
      return JSON.parse(gpuNames);
    } catch {
      return null;
    }
  }
  return null;
}

function inferAccessModel(server) {
  const gpuNames = parseGpuNames(server && server.gpu_names);
  const combined = [gpuNames && gpuNames.igpu, gpuNames && gpuNames.dgpu]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\b1660\s*(s|super)?\b/.test(combined)) return 'gtx1660s';
  if (/\b1030\b/.test(combined)) return 'gt1030';
  return null;
}

function getEffectiveAccessModel(server) {
  const inferred = inferAccessModel(server);
  if (inferred) return inferred;
  return normalizeAccessModel(server && server.access_model);
}

function enrichServer(server) {
  if (!server) return server;
  const modelKey = getEffectiveAccessModel(server);
  const model = ACCESS_MODELS[modelKey];
  return {
    ...server,
    access_model_effective: modelKey,
    access_model_label: model.label,
    access_capacity: model.capacity,
  };
}

function parseCores(cpuCores) {
  if (!cpuCores) return [];
  if (Array.isArray(cpuCores)) return cpuCores;
  if (typeof cpuCores === 'string') {
    try {
      const parsed = JSON.parse(cpuCores);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function calculateAccess(server, metric) {
  const modelKey = getEffectiveAccessModel(server);
  const model = ACCESS_MODELS[modelKey];

  let activeDevices = 0;
  let activeCores = null;
  let signal = 'idle';

  if (modelKey === 'gt1030') {
    const cpuPercent = metric && metric.cpu_percent;
    if (typeof cpuPercent === 'number' && cpuPercent >= model.cpuThreshold) {
      activeDevices = 1;
      signal = 'cpu';
    }
  } else if (modelKey === 'gtx1660s') {
    const cores = parseCores(metric && metric.cpu_cores);
    activeCores = cores.filter(c => typeof c.percent === 'number' && c.percent >= model.coreThreshold).length;
    activeDevices = Math.min(model.capacity, Math.floor(activeCores / model.coresPerDevice));
    signal = activeCores > 0 ? 'cores' : 'idle';
  }

  return {
    access_model: modelKey,
    access_model_label: model.label,
    access_capacity: model.capacity,
    access_active_devices: activeDevices,
    access_active_cores: activeCores,
    access_signal: signal,
  };
}

function enrichMetric(server, metric) {
  if (!metric) return metric;
  return {
    ...metric,
    ...calculateAccess(server, metric),
  };
}

function enrichMetrics(server, metrics) {
  return (metrics || []).map(metric => enrichMetric(server, metric));
}

module.exports = {
  ACCESS_MODELS,
  normalizeAccessModel,
  getEffectiveAccessModel,
  enrichServer,
  calculateAccess,
  enrichMetric,
  enrichMetrics,
};
