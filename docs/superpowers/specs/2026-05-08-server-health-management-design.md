# Server Health Management — Design Spec

**Date:** 2026-05-08
**Status:** Approved (pending implementation plan)
**Repo:** `server-monitor`

## Background

Mỗi server hiện chạy 5 camera AI pool. Khi server sập hoặc lệch version (đặc biệt TensorRT/CUDA/cuDNN), 5 luồng AI dừng cùng lúc — tác động lớn. Hiện tại `server-monitor` đã có metrics CPU/RAM/iGPU/PM2 và log viewer (qua agent hoặc SSH polling), nhưng chưa có:

- Active health probe các thành phần phụ thuộc (MongoDB, S3/R2, Tailscale, GPU/CUDA, swap, OOM).
- Theo dõi version (Python pip, system packages, NVIDIA driver, Node/PM2) và phát hiện drift so với baseline.
- Lưu lịch sử sự cố (incident) với severity, suggested actions, acknowledge flow.
- Cảnh báo trong UI + browser notification khi có incident critical.

Spec này định nghĩa module mới để giải quyết các thiếu sót trên.

## Scope

### In scope

- Active health checks định kỳ (không cần real-time): RAM/Swap/Disk/GPU/CUDA, MongoDB/S3/Tailscale, OOM events.
- Version snapshot + drift detection với baseline thủ công.
- Incident state machine (open / ack / close) với suggested actions.
- UI tab "Health" trên trang chi tiết server: status grid, incidents list, versions diff, incident history.
- Browser notification khi incident critical mới mở.
- Cấu hình per-server qua `agent-config.json`.

### Out of scope

- Auto-recovery (tự động restart PM2 / reboot). Chỉ hiển thị nút "Suggested action" cho user bấm.
- Alerting ngoài dashboard (Telegram/Discord/Email). Chỉ UI + browser notification.
- Health features cho server đang chạy SSH mode. Server muốn dùng phải migrate sang agent (có thể migrate dần, không bắt buộc).
- File hash tracking cho model `.pt`/`.engine`.
- Real-time streaming health (probe interval ≥ 60s).

## Architecture

### Tổng quan

```
SERVER (Linux, agent process)
─────────────────────────────────────────────────────────
agent/agent.js  (existing — heartbeat 10s)
   └─ getCpuInfo, getRamInfo, getCpuTemp, getIgpuInfo, getPm2Apps, getPm2Logs
       → socket.emit('heartbeat')
       → socket.emit('logs')

agent/health-collector.js  (NEW)
   ├─ probeHostHealth()    every 60s
   │     RAM detail (swap, OOM events), Disk mounts, GPU/CUDA, temp
   ├─ probeExternalDeps()  every 60s
   │     MongoDB ping, S3 list, Tailscale status
   └─ snapshotVersions()   every 5 phút
         pip freeze, dpkg -l filtered, node/npm/pm2 versions
   → socket.emit('health:check', { kind, ok, payload, errors, ts })
   → socket.emit('version:snapshot', { pip_freeze, system_pkgs, node_pkgs, ts })

DASHBOARD (Windows, server-monitor)
─────────────────────────────────────────────────────────
agent-server.js
   ├─ on('health:check')      → db.insertHealthEvent + healthService.evaluate
   └─ on('version:snapshot')  → db.insertVersionSnapshot + healthService.detectDrift

health-service.js  (NEW)
   ├─ evaluate(serverId, event)        — apply thresholds → open/close incidents
   ├─ detectDrift(serverId, snapshot)  — diff vs active baseline → open version_drift
   └─ ackIncident(id) / closeIncident(id)

db.js  (4 bảng mới)
   health_events, version_snapshots, baselines, incidents

routes/api.js  (endpoints mới)
   GET    /api/servers/:id/health           — current status + last 24h trend
   GET    /api/servers/:id/incidents        — list (filter: open/closed, kind, range)
   POST   /api/incidents/:id/ack            — mark acknowledged
   POST   /api/incidents/:id/close          — manually close
   GET    /api/servers/:id/versions/current — latest snapshot
   GET    /api/servers/:id/baselines        — list baselines (active first)
   POST   /api/servers/:id/baselines        — save current snapshot as new baseline (sets active)
   POST   /api/baselines/:id/accept         — make this baseline active (close drift incident)

views/index.ejs  (UI mới)
   Tab "Health" trong server detail panel.

browser
   Receives 'health:incident' qua socket → render banner + Notification API (nếu user opt-in).
```

### Data flow

**Probe → event → DB → UI:**
```
agent.health-collector probeHostHealth (every 60s)
    → socket.emit('health:check', {kind:'host_health', ok:true, payload:{ram,swap,disk,gpu,...}, ts})
agent-server.js handler
    → db.insertHealthEvent(serverId, event)
    → healthService.evaluate(serverId, event):
         - apply threshold rules
         - lookup currently-open incident of same (server_id, kind)
         - open new incident if condition triggers, or close existing if condition cleared
    → if incident changed: db.upsertIncident + browserIo.emit('health:incident', incident)
    → browserIo.emit('health:update', { serverId, kind, payload, ts })
browser
    → update status grid card
    → if 'health:incident' with severity=critical and not acked → Notification API + banner
```

**Save baseline (user-initiated):**
```
User clicks "Save baseline" in UI
    → POST /api/servers/:id/baselines
    → server: read latest version_snapshot, copy into baselines table, set active=1, deactivate previous
    → close any open version_drift incidents for this server
    → return baseline record + diff (empty)
```

**Drift detection:**
```
agent.health-collector snapshotVersions (every 5 phút)
    → socket.emit('version:snapshot', {pip_freeze, system_pkgs, node_pkgs, ts})
agent-server.js handler
    → db.insertVersionSnapshot
    → healthService.detectDrift:
         - load active baseline
         - if no baseline: skip (require user to set explicit baseline first)
         - diff(baseline, snapshot) → { added[], removed[], changed[{pkg, from, to}] }
         - if any difference:
             - severity = 'critical' nếu pkg ∈ watch_pip_packages hoặc system_pkgs nhạy
             - severity = 'warn' nếu chỉ là gói thường
             - open or update incident kind='version_drift' với details=diff
         - if no difference: close any open version_drift
```

## Components

### agent/health-collector.js

Module mới, export `start(socket, config)` và `stop()`. Quản lý 3 timer độc lập với interval khác nhau. Mỗi probe wrap trong try/catch — fail không làm crash agent, mà emit event với `ok:false` + errors.

**probeHostHealth() (~60s):**
- RAM: đọc `/proc/meminfo` (đã có) + thêm `SwapTotal`, `SwapFree`.
- OOM events: đọc `/var/log/kern.log` hoặc `dmesg -T` từ timestamp lần probe trước, đếm số dòng chứa `Out of memory`. Lưu timestamp cuối cùng đã đọc trong-process để delta.
- Disk: với mỗi mount trong `monitored_mounts`, chạy `df -B1 -P <mount>` parse total/used/percent.
- GPU/CUDA:
  - `nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu,utilization.gpu --format=csv,noheader,nounits` (nếu có).
  - Nếu lệnh fail (timeout/error) → `ok:false` với error="GPU lost or driver issue".
  - CUDA load test (lightweight): chỉ `nvidia-smi -L` để liệt kê GPU — nếu liệt kê được tức driver còn nhận GPU.

**probeExternalDeps() (~60s):**
- MongoDB: `mongosh "$MONGO_URI" --quiet --eval "db.runCommand({ping:1})"` với timeout 5s. Nếu agent không có `mongosh`, fallback dùng `node` + `mongodb` driver (cần thêm dependency vào agent's package.json).
- S3: `aws s3 ls s3://<bucket> --endpoint-url=<endpoint> --max-items=1` với credentials từ config. Hoặc dùng `@aws-sdk/client-s3` (nhỏ hơn, không cần aws cli installed).
- Tailscale: `tailscale status --json` parse `Self.Online` boolean.

**snapshotVersions() (~5 phút):**
- Python pip: với mỗi venv trong `monitored_python_envs`, chạy `<venv>/bin/pip freeze --format=json` (Pip 22.3+) hoặc parse text fallback. Output: `{ "<venv_path>": { "torch": "2.0.1", ... } }`.
- System packages: `dpkg-query -W -f='${Package}=${Version}\n' <patterns>` cho mỗi pattern trong `monitored_system_pkgs`. Plus `nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1` cho NVIDIA driver. Plus `nvcc --version | grep release` cho CUDA toolkit.
- Node: `node -v`, `npm -v`, `pm2 -v`, plus `npm list -g --depth=0 --json`.

Output object:
```js
{
  pip_freeze: { "/opt/pool/venv": { "torch": "2.0.1", ... } },
  system_pkgs: { "tensorrt": "8.6.1.6-1+cuda12.0", "libcudnn8": "...", "nvidia-driver": "535.86.10", "cuda": "12.1" },
  node_pkgs: { "node": "20.10.0", "npm": "10.2.3", "pm2": "5.3.0", "globals": { "pm2": "5.3.0", ... } },
  ts: 1746676800
}
```

### dashboard/health-service.js

Logic stateless (state lưu trong DB) — drift detection và threshold evaluation.

**evaluate(serverId, event)** — input là 1 health_event đã insert. Lookup currently-open incident cùng `(server_id, kind)`:
- Nếu probe `ok:false` hoặc vượt threshold → mở mới (nếu chưa có) hoặc update details (nếu đã có).
- Nếu probe `ok:true` và dưới threshold → đóng incident đang open (set `closed_at = now`).
- Sustained logic cho RAM/disk: chỉ mở incident sau N consecutive ticks vượt threshold, để tránh false alarm khi spike. Lưu counter trong-memory keyed by `server_id:kind` (acceptable mất khi dashboard restart).

**detectDrift(serverId, snapshot)** — diff vs active baseline. Nếu không có active baseline → skip (không thể drift nếu chưa định nghĩa "ổn định").

Logic diff:
```js
function diffSection(baseline, current) {
  const added = [], removed = [], changed = [];
  for (const pkg in current) {
    if (!(pkg in baseline)) added.push({ pkg, version: current[pkg] });
    else if (baseline[pkg] !== current[pkg]) changed.push({ pkg, from: baseline[pkg], to: current[pkg] });
  }
  for (const pkg in baseline) if (!(pkg in current)) removed.push({ pkg, version: baseline[pkg] });
  return { added, removed, changed };
}
```

Severity rule:
- `critical` nếu bất kỳ pkg trong `watch_pip_packages` (config) bị changed/removed.
- `critical` nếu bất kỳ system_pkg match `tensorrt*`/`libcudnn*`/`cuda-*`/`nvidia-driver-*` bị changed.
- `warn` ngược lại.

### db.js — 4 bảng mới

```sql
CREATE TABLE health_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,   -- 'host_health' | 'ext_deps'
  ok          INTEGER NOT NULL,   -- 0/1
  payload     TEXT,               -- JSON
  errors      TEXT,               -- JSON array of error strings
  ts          INTEGER NOT NULL    -- unix seconds
);
CREATE INDEX idx_health_server_ts ON health_events(server_id, ts DESC);
CREATE INDEX idx_health_server_kind_ts ON health_events(server_id, kind, ts DESC);

CREATE TABLE version_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  pip_freeze   TEXT,    -- JSON
  system_pkgs  TEXT,    -- JSON
  node_pkgs    TEXT,    -- JSON
  ts           INTEGER NOT NULL
);
CREATE INDEX idx_version_server_ts ON version_snapshots(server_id, ts DESC);

CREATE TABLE baselines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  label        TEXT,
  pip_freeze   TEXT,
  system_pkgs  TEXT,
  node_pkgs    TEXT,
  active       INTEGER NOT NULL DEFAULT 0,   -- chỉ 1 active per server
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_baselines_active ON baselines(server_id, active);

CREATE TABLE incidents (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id          INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind               TEXT    NOT NULL,   -- 'disk_full' | 'ram_high' | 'swap_high' | 'oom_kill' | 'gpu_lost' | 'gpu_temp' | 'mongo_down' | 's3_down' | 'tailscale_down' | 'version_drift'
  severity           TEXT    NOT NULL,   -- 'warn' | 'critical'
  title              TEXT    NOT NULL,
  details            TEXT,               -- JSON
  suggested_actions  TEXT,               -- JSON: [{label, command}]
  opened_at          INTEGER NOT NULL,
  acked_at           INTEGER,
  closed_at          INTEGER              -- NULL = open
);
CREATE INDEX idx_incidents_open ON incidents(server_id, closed_at);
CREATE INDEX idx_incidents_server_opened ON incidents(server_id, opened_at DESC);
```

Functions thêm vào `db.js`:
- `insertHealthEvent(serverId, event)`
- `getRecentHealthEvents(serverId, sinceTs, kind?)`
- `insertVersionSnapshot(serverId, snapshot)`
- `getLatestVersionSnapshot(serverId)`
- `getActiveBaseline(serverId)`
- `saveBaseline(serverId, snapshot, label?)` — set active=1 và deactivate cũ trong 1 transaction
- `acceptBaseline(baselineId)` — set active=1 cho baseline đó, deactivate khác
- `getOpenIncidents(serverId?)`
- `getIncidentByServerKind(serverId, kind)` — lookup incident đang open
- `upsertIncident(...)` — open mới hoặc update details của incident đang open
- `ackIncident(id)`, `closeIncident(id)`
- `getIncidentHistory(serverId, sinceTs, filters?)`

### Cleanup job (cleanup.js — extend)

Hourly cleanup thêm:
- `health_events` > 30 ngày → delete
- `version_snapshots` > 90 ngày → delete (giữ lâu hơn vì rare)
- `incidents` closed_at > 180 ngày → delete (cân nhắc archive flag thay vì delete; default delete)
- `baselines` không active và > 90 ngày → delete (giữ ít nhất 3 cái non-active gần nhất per server)

### views/index.ejs + public/js — Health tab

Trong server detail panel (hiện tại là 1 view), thêm tab navigation: "Overview" (current) | "Health" (new) | "Logs" (existing).

**Health tab gồm 4 section:**

1. **Status grid** — 6 thẻ:
   - Disk (mỗi mount 1 dòng nhỏ): `/`: 87% • `/data`: 45%
   - RAM + Swap: 76% RAM • 12% Swap • 0 OOM (24h)
   - GPU + CUDA: GPU0 utilization, mem, temp + driver version + CUDA toolkit
   - MongoDB: ✅ ping OK, last 60s
   - S3: ✅ list OK
   - Tailscale: ✅ Self online
   Thẻ màu xanh/vàng/đỏ theo state. Click thẻ → mở chart 24h cho metric đó.

2. **Active incidents** — banner đỏ trên cùng:
   - Mỗi incident: severity badge, title, opened_at relative time, "Acknowledge" button, "Close" button (manual override), và 0..N "Suggested action" buttons.
   - Click suggested action → confirm modal → `socket.emit('execute', {command})` → wait callback → toast result.

3. **Versions** panel — 3 cột (pip / system / node):
   - Hiển thị current snapshot.
   - Nếu có active baseline → highlight diff bằng màu (đỏ=changed, xám=removed, xanh=added).
   - Nút "Save current as baseline" (luôn).
   - Nút "Accept new baseline" (chỉ hiện khi đang có drift incident).
   - Sub-link "Baselines history" → modal list các baseline cũ (có thể restore).

4. **Incident history** — bảng lọc:
   - Cột: Opened | Closed | Kind | Severity | Title | Duration.
   - Filter: kind, severity, range (24h/7d/30d).
   - Mini bar chart phía trên: số incident/ngày trong 30 ngày.

**Browser notification:**
- Toggle switch "Enable browser notifications for this server" — store preference per server in `localStorage`.
- Khi toggle ON lần đầu: gọi `Notification.requestPermission()`.
- Khi nhận `health:incident` qua socket với severity='critical' và không phải update của incident đã có (`prevState !== 'open'`): trigger `new Notification(title, {body: details, ...})`.

### agent-config.json — fields mới

```json
{
  "dashboard_url": "...",
  "interval": 10000,
  "server_name": "...",
  "health": {
    "enabled": true,
    "host_interval": 60000,
    "ext_deps_interval": 60000,
    "version_interval": 300000,
    "monitored_mounts": ["/", "/data"],
    "monitored_python_envs": ["/opt/pool/venv"],
    "monitored_system_pkgs": ["tensorrt*", "libcudnn*", "cuda-*", "nvidia-driver-*"],
    "watch_pip_packages": ["torch", "ultralytics", "tensorrt", "opencv-python"],
    "external_deps": {
      "mongo": {
        "uri": "mongodb://...",
        "timeout_ms": 5000
      },
      "s3": {
        "endpoint": "https://...",
        "bucket": "...",
        "access_key": "...",
        "secret_key": "...",
        "timeout_ms": 5000
      },
      "tailscale": {
        "enabled": true
      }
    }
  }
}
```

Section `health` optional — agent thiếu key này hoạt động như cũ (chỉ heartbeat). Section con cũng optional — vd: server không có S3 thì bỏ trống `external_deps.s3`, không probe.

## Thresholds (default)

| Metric | Warn | Critical | Sustained ticks |
|---|---|---|---|
| Disk usage | > 85% | > 95% | 1 |
| RAM usage | > 85% | > 95% | 3 (3 phút sustained) |
| Swap usage | > 50% | > 80% | 3 |
| OOM events trong 5 phút | ≥ 1 | ≥ 3 | 1 |
| GPU temp | > 85°C | > 90°C | 1 |
| GPU memory | > 90% | > 98% | 2 |
| nvidia-smi fail | — | always | 2 |
| MongoDB ping fail | — | always | 3 (3 phút) |
| S3 fail | always | — | 3 |
| Tailscale Self.Online=false | — | always | 1 |

Threshold hardcode trong `health-service.js` ở giai đoạn này; cấu hình hóa sau nếu cần.

## Suggested actions

Mỗi loại incident có 0..N suggested action templates trong `health-service.js`:

| Incident kind | Suggested actions |
|---|---|
| `disk_full` | "View largest folders" (popup chạy `du -sh /var/log /data` qua execute) |
| `ram_high` | "Restart highest-RAM PM2 process: <name>" → `pm2 restart <name>` |
| `oom_kill` | "Show last OOM victim from dmesg" → `dmesg -T \| grep -i 'killed process' \| tail -3` |
| `gpu_lost` | "Show nvidia-smi" → `nvidia-smi`, "Reload nvidia driver" (manual confirm only) |
| `mongo_down` | "Test MongoDB connection now" → re-run probe |
| `version_drift` | "View diff" (UI), "Accept new baseline" (UI), "Restore previous baseline" (UI button → re-install? — only show but don't execute risky reinstall in v1) |
| `pm2_crash` (từ existing PM2 status) | "Restart <name>" → `pm2 restart <name>` |

Mỗi action gửi `socket.emit('execute', {command})` qua channel có sẵn ở [agent.js:215](H:\Projects\arena\server-monitor\agent\agent.js#L215). User phải confirm modal trước khi gửi.

## Migration

- Bảng mới — chạy migration SQL trong `db.js` startup nếu chưa tồn tại (idempotent `CREATE TABLE IF NOT EXISTS`).
- Agent cần update — có thể leverage feature `git:pull` đã có ([agent.js:235](H:\Projects\arena\server-monitor\agent\agent.js#L235)) để deploy bản agent mới rồi `pm2 restart monitor-agent`.
- Server đang dùng SSH mode — không bắt buộc migrate. UI tab Health hiển thị placeholder "Health management requires agent mode. [Switch to agent mode]" nếu server có `mode='ssh'`.
- `agent/package.json` cần thêm dependency: `mongodb` (cho ping fallback) và `@aws-sdk/client-s3` (cho S3 list). Nếu user không cấu hình mongo/s3 thì không import → có thể lazy-require để tránh load khi không dùng.

## Testing strategy

- Unit tests cho `health-service.js`:
  - `evaluate()` các cặp (event → expected incident state) với mock DB.
  - `detectDrift()` các cặp baseline/snapshot với expected diff/severity.
  - Sustained logic: 3 events liên tiếp vượt threshold → mở incident; event thứ 4 OK → đóng.
- Unit tests cho `db.js` các function mới: insert, lookup, baseline switch.
- Integration test cho agent → dashboard:
  - Mock socket, agent emit `health:check` với various payloads, verify DB rows + incidents.
  - Emit `version:snapshot` với drift, verify drift detection và incident creation.
- Manual UI smoke test: load Health tab, save baseline, simulate drift bằng cách chỉnh DB tay, verify diff hiển thị và "Accept new baseline" hoạt động.

## Open questions

Không còn open questions sau brainstorming. Các điểm sau confirmed:

- **Realtime**: không cần (đã chốt).
- **Auto-recovery**: không, chỉ suggested actions (đã chốt).
- **Alerting**: chỉ UI + browser notification (đã chốt).
- **Version drift**: manual baseline + drift alert (đã chốt).
- **Probe targets**: GPU/CUDA + Disk + RAM/Swap + Mongo/S3/Tailscale (đã chốt).
- **Mode**: agent-only cho health features (đã chốt).
