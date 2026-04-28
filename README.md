# Server Monitor Dashboard

Real-time monitoring dashboard for tracking PM2 processes, logs, and system metrics (CPU/iGPU/RAM) across Tailscale-connected servers.

## Features

- 🖥️ **Real-time Monitoring**: Track CPU, RAM, and iGPU usage across multiple servers
- 📊 **Live Charts**: 24-hour historical data visualization with Chart.js
- 🔄 **PM2 Integration**: Monitor PM2 processes, status, and resource usage
- 📝 **Log Viewer**: Real-time log streaming from PM2 applications
- 🌐 **Dual Mode**: Agent-based push (WebSocket) or SSH polling
- 🔌 **Auto-Fallback**: Automatic SSH fallback when agent disconnects
- 🌙 **Dark Theme**: Modern, easy-on-the-eyes interface

## Architecture

```
┌──────────────────────────────────────────────────┐
│           Dashboard Server (Windows)              │
│  Express + Socket.IO + SQLite                     │
│  Web UI: port 3000 | Agent receiver: port 3000    │
└──────────────┬────────────────────┬───────────────┘
               │ WebSocket          │ SSH (fallback)
          Tailscale Network
               │                    │
        ┌──────┴──────┐      ┌──────┴──────┐
        │  Server A   │      │  Server B   │
        │  Agent mode │      │  SSH mode   │
        └─────────────┘      └─────────────┘
```

## Tech Stack

**Dashboard:**
- Node.js + Express
- Socket.IO (real-time communication)
- SQLite (better-sqlite3)
- EJS templates
- Chart.js (CDN)
- Vanilla JavaScript

**Agent:**
- Node.js
- Socket.IO client
- System metrics from /proc

## Installation

### Dashboard (Windows)

1. Clone and install dependencies:
```bash
cd server-monitor
npm install
```

2. Start the dashboard:
```bash
npm start
```

3. Open browser at `http://localhost:3000`

### Agent (Linux Servers)

See [docs/agent-setup.txt](docs/agent-setup.txt) for detailed installation instructions.

Quick setup:
```bash
# Copy agent folder to server
scp -r agent/ user@100.x.x.x:~/monitor-agent/

# SSH into server
ssh user@100.x.x.x

# Install and configure
cd ~/monitor-agent
npm install
nano agent-config.json  # Edit dashboard_url and server_name

# Start with PM2
pm2 start agent.js --name monitor-agent
pm2 save
pm2 startup
```

## Usage

### Adding Servers

1. Click "+ Add Server" button
2. Enter server details:
   - **Name**: Friendly server name
   - **Tailscale IP**: 100.x.x.x format
   - **Mode**: 
     - **Agent**: For servers with agent installed (recommended)
     - **SSH**: For SSH-only polling
3. For SSH mode, provide credentials (key path or password)

### Monitoring

- **Server Grid**: Overview of all servers with current metrics
- **Server Detail**: Click any server card to view:
  - 24-hour CPU/RAM/iGPU charts
  - PM2 process table
  - Real-time logs per application

### Data Collection Modes

**Agent Mode (Recommended):**
- Agent pushes metrics every 10 seconds via WebSocket
- Low latency, real-time updates
- Automatic reconnection

**SSH Mode:**
- Dashboard polls server every 30 seconds via SSH
- Fallback when agent unavailable
- Requires SSH credentials

**Auto-Fallback:**
- If agent-mode server goes offline >60s and has SSH config
- Automatically switches to SSH polling
- Switches back when agent reconnects

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/servers` | List all servers |
| POST | `/api/servers` | Add new server |
| PUT | `/api/servers/:id` | Update server |
| DELETE | `/api/servers/:id` | Delete server |
| GET | `/api/servers/:id/metrics?range=24` | Get metrics history |
| GET | `/api/servers/:id/pm2` | Get PM2 apps |
| GET | `/api/servers/:id/logs/:appName?lines=200` | Get app logs |

## Socket.IO Events

**Dashboard → Browser:**
- `server:update` - New metrics received
- `server:status` - Server online/offline change
- `server:log` - New log line

**Agent → Dashboard:**
- `register` - Agent first connection
- `heartbeat` - Metrics update (every 10s)
- `logs` - Log lines batch

## Database

SQLite database stored in `data/monitor.db`

**Tables:**
- `servers` - Server configurations
- `metrics` - System metrics (24h retention)
- `pm2_apps` - PM2 process snapshots
- `pm2_logs` - Cached logs (500 lines per app)

**Cleanup:**
- Runs hourly
- Deletes metrics older than 24 hours
- Trims logs exceeding 500 lines per app

## Development

### Run Tests
```bash
npm test
```

### Development Mode (auto-reload)
```bash
npm run dev
```

### Project Structure
```
server-monitor/
├── server.js              # Main entry point
├── db.js                  # SQLite database layer
├── agent-server.js        # WebSocket server for agents
├── ssh-poller.js          # SSH polling logic
├── cleanup.js             # Cleanup job
├── heartbeat.js           # Heartbeat monitor
├── routes/
│   └── api.js            # REST API routes
├── public/
│   ├── css/style.css     # Dark theme styles
│   └── js/
│       ├── app.js        # Main UI logic
│       ├── charts.js     # Chart.js wrapper
│       └── logs.js       # Log viewer
├── views/
│   └── index.ejs         # Dashboard page
├── agent/
│   ├── agent.js          # Agent script
│   ├── agent-config.json # Agent configuration
│   └── package.json      # Agent dependencies
├── tests/
│   ├── db.test.js        # Database tests
│   └── api.test.js       # API tests
└── docs/
    └── agent-setup.txt   # Agent installation guide
```

## Configuration

### Dashboard
- Port: `PORT` environment variable (default: 3000)
- Database: `data/monitor.db`

### Agent
Edit `agent/agent-config.json`:
```json
{
  "dashboard_url": "ws://YOUR_DASHBOARD_IP:3000",
  "interval": 10000,
  "server_name": "my-server"
}
```

## Troubleshooting

### Agent Connection Issues
- Verify Tailscale is running on both machines
- Check dashboard IP in agent config
- Ensure port 3000 is accessible

### No iGPU Data
- Install intel-gpu-tools: `sudo apt install intel-gpu-tools`
- Run agent with sudo or add user to video group
- iGPU data is optional, system works without it

### SSH Connection Fails
- Verify SSH credentials
- Test manual SSH connection first
- Check SSH key permissions (chmod 600)

### Tests Failing
- Ensure no other process is using test database
- Clean up test databases: `rm tests/*.db`

## License

MIT

## Author

Built for monitoring Tailscale-connected servers with PM2 applications.
