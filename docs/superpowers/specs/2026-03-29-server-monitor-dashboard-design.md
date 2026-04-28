# Server Monitor Dashboard — Design Spec

## Overview

A web-based dashboard to monitor local servers managed via Tailscale, tracking PM2 processes, logs, and system metrics (CPU, iGPU, RAM) without manual SSH.

**Runs on:** Windows (current machine)
**Servers:** Ubuntu/Debian with PM2, Node.js, Python. Currently 2, scaling to 50.
**Network:** Tailscale (100.x.x.x IPs)
**Auth:** None (local use only)
**Theme:** Dark

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│           Dashboard Server (Windows)              │
│  Express + Socket.IO + SQLite                     │
│  Web UI: port 3000 | Agent receiver: port 3001    │
└──────────────┬────────────────────┬───────────────┘
               │ WebSocket          │ SSH (fallback)
          Tailscale Network
               │                    │
        ┌──────┴──────┐      ┌──────┴──────┐
        │  Server A   │      │  Server B   │
        │  Agent mode │      │  SSH mode   │
        └─────────────┘      └─────────────┘
```

### Data collection modes

- **Agent mode:** Agent on server pushes heartbeat + metrics via WebSocket every 10s
- **SSH mode (fallback):** Dashboard SSHes into server every 30s to pull metrics
- **Auto-fallback:** If agent goes silent >60s and SSH config exists, automatically switch to SSH polling

### Offline detection

- No heartbeat/SSH response for >60s → mark server offline
- Retain last-known metrics and PM2 state for display
- When server comes back online, resume normal collection

---

## Data Model (SQLite)

### Table: `servers`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (UUID) | Primary key |
| name | TEXT | User-assigned server name |
| ip | TEXT | Tailscale IP (100.x.x.x) |
| mode | TEXT | `agent` or `ssh` |
| ssh_user | TEXT | SSH username (nullable) |
| ssh_key_path | TEXT | Path to SSH private key (nullable) |
| ssh_password | TEXT | SSH password, encrypted at rest (nullable) |
| status | TEXT | `online` / `offline` |
| last_seen | INTEGER | Unix timestamp of last data received |
| created_at | INTEGER | Unix timestamp |

### Table: `metrics`

Rolling storage, kept for 24 hours.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto increment PK |
| server_id | TEXT | FK → servers.id |
| cpu_percent | REAL | CPU usage % |
| ram_total | INTEGER | Total RAM (bytes) |
| ram_used | INTEGER | Used RAM (bytes) |
| igpu_percent | REAL | iGPU usage % (nullable) |
| igpu_mem_used | INTEGER | iGPU memory used (nullable) |
| timestamp | INTEGER | Unix timestamp |

### Table: `pm2_apps`

Latest snapshot only (overwritten each update).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto increment PK |
| server_id | TEXT | FK → servers.id |
| pm_id | INTEGER | PM2 process id |
| name | TEXT | App name |
| status | TEXT | `online` / `stopped` / `errored` |
| cpu | REAL | CPU % |
| memory | INTEGER | Memory usage (bytes) |
| uptime | INTEGER | Uptime (ms) |
| restarts | INTEGER | Restart count |
| updated_at | INTEGER | Unix timestamp |

### Table: `pm2_logs`

Cached logs, max 500 lines per app.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto increment PK |
| server_id | TEXT | FK → servers.id |
| app_name | TEXT | PM2 app name |
| log_type | TEXT | `out` / `error` |
| message | TEXT | Log line content |
| timestamp | INTEGER | Unix timestamp |

### Cleanup job

Runs every hour:
- Delete metrics older than 24h
- Trim logs exceeding 500 lines per app (keep newest)

---

## Agent (installed on each Linux server)

A lightweight Node.js script, managed by PM2 itself.

### Config (`agent-config.json`)

```json
{
  "dashboard_url": "ws://100.x.x.x:3001",
  "interval": 10000,
  "server_name": "server-a"
}
```

### Metrics collection

- **CPU/RAM:** Read `/proc/stat` and `/proc/meminfo`
- **iGPU (Intel):** Run `intel_gpu_top -J -s 1000 -l 1`, parse JSON. If unavailable, send null.
- **PM2:** Use `pm2 jlist` command, parse JSON output

### Heartbeat payload

```json
{
  "type": "heartbeat",
  "hostname": "server-a",
  "metrics": {
    "cpu_percent": 23.5,
    "ram_total": 8589934592,
    "ram_used": 3221225472,
    "igpu_percent": 12.0,
    "igpu_mem_used": 134217728
  },
  "pm2": [
    {
      "pm_id": 0,
      "name": "api-server",
      "status": "online",
      "cpu": 5.2,
      "memory": 104857600,
      "uptime": 86400000,
      "restarts": 0
    }
  ]
}
```

### Reconnection

If connection to dashboard lost → retry every 5s with exponential backoff (max 30s).

---

## SSH Fallback

### When used

- Server configured with `mode: "ssh"`
- Or agent-mode server where agent is offline >60s and SSH credentials are configured

### Polling (every 30s)

```bash
# CPU + RAM
top -bn1 | head -5

# PM2 processes
pm2 jlist

# PM2 logs (50 lines per app)
pm2 logs --nostream --lines 50
```

### iGPU via SSH

Run `intel_gpu_top -J -s 1000 -l 1`. If command not found, record that server has no iGPU and skip in future polls.

### Connection management

- Use `node-ssh` package
- Reuse connections (keep alive, 120s timeout)
- After 3 consecutive failures → mark offline, stop polling, retry every 5 minutes

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/servers` | List all servers with status |
| POST | `/api/servers` | Add server (name, ip, mode, ssh config) |
| PUT | `/api/servers/:id` | Update server info |
| DELETE | `/api/servers/:id` | Remove server |
| GET | `/api/servers/:id/metrics?range=24h` | Metrics history for charts |
| GET | `/api/servers/:id/pm2` | Current PM2 apps |
| GET | `/api/servers/:id/logs/:appName?lines=200` | PM2 app logs |

### Error responses

- Invalid IP → 400
- Server not found → 404
- SSH connection fail → return error, keep server record for retry

---

## Socket.IO Events

### Dashboard → Browser (port 3000)

| Event | Payload | Description |
|-------|---------|-------------|
| `server:update` | `{ serverId, metrics, pm2 }` | New metrics received |
| `server:status` | `{ serverId, status, lastSeen }` | Online/offline change |
| `server:log` | `{ serverId, appName, logType, message }` | New log line (agent mode) |

### Agent → Dashboard (port 3001)

| Event | Payload | Description |
|-------|---------|-------------|
| `register` | `{ hostname, ip }` | Agent first connection |
| `heartbeat` | `{ metrics, pm2 }` | Every 10s |
| `logs` | `{ appName, logType, lines[] }` | New log lines |

---

## Web UI

### Tech

- EJS templates + vanilla JS (no build step)
- Chart.js (CDN) for line charts
- Socket.IO client for real-time updates
- Dark theme: background `#1a1a2e`, cards `#16213e`, accent `#0f3460`, text `#e0e0e0`

### Views

1. **Server Grid (main page):** Card per server showing status, CPU/RAM/iGPU summary, PM2 app count. Green border = online, gray = offline.
2. **Server Detail:** Click card → charts (CPU/RAM/iGPU over 24h) + PM2 apps table
3. **Log Viewer:** Click "Logs" on PM2 app → log panel, auto-scroll, stdout (white) / stderr (red)
4. **Add Server Modal:** Form for name, IP, mode (agent/ssh), SSH credentials if SSH mode

---

## Project Structure

```
server-monitor/
├── package.json
├── server.js                 # Entry point — Express + Socket.IO
├── agent-server.js           # WebSocket server port 3001 for agents
├── db.js                     # SQLite setup + queries
├── ssh-poller.js             # SSH polling logic
├── cleanup.js                # Cleanup job for old metrics/logs
├── routes/
│   └── api.js                # REST API routes
├── public/
│   ├── css/
│   │   └── style.css         # Dark theme CSS
│   └── js/
│       ├── app.js            # Main UI logic + Socket.IO client
│       ├── charts.js         # Chart.js setup
│       └── logs.js           # Log viewer logic
├── views/
│   ├── layout.ejs            # Base layout
│   └── index.ejs             # Main dashboard page
├── agent/
│   ├── agent.js              # Agent script (deploy to servers)
│   ├── agent-config.json     # Config template
│   └── package.json          # Agent dependencies
├── data/
│   └── monitor.db            # SQLite database (auto-created)
└── docs/
    └── agent-setup.txt       # Agent installation guide
```

### Dashboard dependencies

- `express`, `socket.io`, `ejs` — web server
- `better-sqlite3` — SQLite
- `node-ssh` — SSH fallback
- `uuid` — server ID generation
- `chart.js` (CDN) — charts in browser

### Agent dependencies

- `socket.io-client` — connect to dashboard
- `pm2` — programmatic API
