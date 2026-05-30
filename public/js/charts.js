const Charts = (() => {
  const chartInstances = {};
  const chartData = {};
  let currentTimeRange = '5h';
  const TIME_RANGE_SECONDS = {
    '5m': 300,
    '10m': 600,
    '30m': 1800,
    '1h': 3600,
    '5h': 18000,
    'all': 0
  };

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: {
        type: 'category',
        ticks: { color: '#444', maxTicksLimit: 8, autoSkip: true },
        grid: { color: '#1a1a1a' }
      },
      y: {
        ticks: { color: '#444' },
        grid: { color: '#1a1a1a' },
        beginAtZero: true
      }
    },
    plugins: {
      legend: { display: false }
    }
  };

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function createChart(canvasId, label, color, unit) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    if (chartInstances[canvasId]) {
      chartInstances[canvasId].destroy();
    }

    // Initialize data storage for this chart
    if (!chartData[canvasId]) {
      chartData[canvasId] = [];
    }

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label,
          data: [],
          borderColor: color,
          backgroundColor: color + '22',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        ...commonOptions,
        scales: {
          ...commonOptions.scales,
          x: { ...commonOptions.scales.x },
          y: {
            ...commonOptions.scales.y,
            max: unit === '%' ? 100 : undefined,
            ticks: {
              ...commonOptions.scales.y.ticks,
              callback: (v) => unit === 'GB' ? (v / 1073741824).toFixed(1) + ' GB' : v + (unit || '')
            }
          }
        }
      }
    });

    chartInstances[canvasId] = chart;
    return chart;
  }

  function updateChart(canvasId, metrics, valueKey) {
    const chart = chartInstances[canvasId];
    if (!chart) {
      console.warn(`Chart ${canvasId} not found in updateChart`);
      return;
    }

    // Validate metrics is an array
    if (!Array.isArray(metrics)) {
      console.warn(`Invalid metrics data for chart ${canvasId}: expected array`);
      return;
    }

    // Store raw data with timestamp and value
    chartData[canvasId] = metrics.map(m => ({
      timestamp: m.timestamp,
      value: m[valueKey]
    }));

    // Apply current time range filter before rendering
    const filtered = filterDataByRange(chartData[canvasId], currentTimeRange);
    chart.data.labels = filtered.map(m => formatTime(m.timestamp));
    chart.data.datasets[0].data = filtered.map(m => m.value);
    chart.update('none');
  }

  function appendPoint(canvasId, timestamp, value) {
    const chart = chartInstances[canvasId];
    if (!chart) return; // silently skip if chart doesn't exist

    // Validate timestamp and value
    if (typeof timestamp !== 'number' || typeof value !== 'number') {
      return;
    }

    // Add new point to raw data storage
    if (!chartData[canvasId]) {
      chartData[canvasId] = [];
    }
    chartData[canvasId].push({ timestamp, value });

    // For 'all' mode: maintain max 17280 points (48h at 10s interval)
    if (currentTimeRange === 'all') {
      if (chartData[canvasId].length > 17280) {
        chartData[canvasId].shift();
      }
    }

    // Check if point is within current time range
    const startTime = calculateStartTimestamp(currentTimeRange);
    if (currentTimeRange !== 'all' && timestamp < startTime) {
      // Point is outside time range, don't add to chart
      return;
    }

    // For non-'all' ranges: implement sliding window
    if (currentTimeRange !== 'all') {
      // Remove old points that are now outside the time window
      const filtered = filterDataByRange(chartData[canvasId], currentTimeRange);
      chart.data.labels = filtered.map(m => formatTime(m.timestamp));
      chart.data.datasets[0].data = filtered.map(m => m.value);
    } else {
      // For 'all' mode: just append the point
      chart.data.labels.push(formatTime(timestamp));
      chart.data.datasets[0].data.push(value);

      // Keep max 17280 points in chart display
      if (chart.data.labels.length > 17280) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
      }
    }

    chart.update('none');
  }

  function calculateStartTimestamp(range) {
    if (range === 'all') {
      return 0;
    }
    const now = Math.floor(Date.now() / 1000);
    const seconds = TIME_RANGE_SECONDS[range];

    // Warn if range is not recognized
    if (seconds === undefined) {
      console.warn(`Unknown time range: ${range}, treating as 'all'`);
      return 0;
    }

    return now - seconds;
  }

  function filterDataByRange(dataArray, range) {
    if (!dataArray || dataArray.length === 0) {
      return [];
    }
    if (range === 'all') {
      return dataArray;
    }
    const startTime = calculateStartTimestamp(range);
    return dataArray.filter(point => point.timestamp >= startTime);
  }

  function setTimeRange(range) {
    const validRanges = ['all', '5h', '1h', '30m', '10m', '5m'];
    if (!validRanges.includes(range)) {
      console.warn(`Invalid time range: ${range}, defaulting to 'all'`);
      range = 'all';
    }

    currentTimeRange = range;

    // Update all active charts with filtered data
    for (const canvasId of Object.keys(chartInstances)) {
      const chart = chartInstances[canvasId];
      if (!chart) continue;
      if (!chartData[canvasId]) continue;

      const filtered = filterDataByRange(chartData[canvasId], range);
      chart.data.labels = filtered.map(m => formatTime(m.timestamp));
      chart.data.datasets[0].data = filtered.map(m => m.value);
      chart.update('none');
    }
  }

  function getCurrentTimeRange() {
    return currentTimeRange;
  }

  function hasChart(canvasId) {
    return !!chartInstances[canvasId];
  }

  function destroyAll() {
    for (const key of Object.keys(chartInstances)) {
      chartInstances[key].destroy();
      delete chartInstances[key];
    }
    // Clear all chart data
    for (const key of Object.keys(chartData)) {
      delete chartData[key];
    }
  }

  return { createChart, updateChart, appendPoint, destroyAll, setTimeRange, getCurrentTimeRange, hasChart };
})();
