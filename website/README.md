# PiCloud Digital Twin & Control Dashboard

A real-time, interactive **3D Digital Twin and Monitoring Dashboard** for the 48-node Raspberry Pi cluster in the UCL CASA Connected Environments Lab.

Built with **Node.js, Express, WebSockets, Three.js, Tailwind CSS, and OpenID Connect (OIDC)**.

---

## Features

* **3D Digital Twin (Three.js)**:
  * Interactive 8-column &times; 6-row physical wall matrix of 48 Raspberry Pis with PoE HATs.
  * Real-time thermal heatmap shading (cool blue &rarr; emerald green &rarr; amber &rarr; glowing crimson).
  * Dynamic spinning PoE cooling fans reflecting actual fan speeds.
  * **Dynamic Node Lifecycle States**:
    * **Online**: Real-time thermal/CPU/Power shading, active green ACT LED, spinning PoE cooling fan.
    * **Offline**: Automatic telemetry heartbeat watchdog; turns PCB dark slate grey (`#334155`), unlights LEDs, stops fan, and updates label to `❌ #ID`.
    * **Rebooting**: Pulsing amber glow (`#f59e0b`), flashing amber ACT LED, stopped fan, amber beacon spotlight, and `🔄 #ID` label.
    * **Online Recovery Ripple**: Emits an expanding green shockwave ripple ring in 3D when an offline or rebooting node successfully reconnects.
  * Orbit controls (rotate, pan, zoom) and camera presets ("Front", "Isometric", "Top-Down", "Hottest Node").
  * Raycast selection: click any Pi in 3D to open its real-time telemetry sheet.
* **Cluster Event Audit Log & History**:
  * Real-time audit trail recording node connection, disconnect, reboot, shutdown, warnings, and operator actions.
  * Filter by category (`All`, `Offline`, `Online`, `Reboot`, `Warning`) with live text search and click-to-inspect target links.
  * Backed by WebSocket real-time broadcast and REST endpoint (`GET /api/events`).
* **High-Density 2D Wall Matrix**:
  * 48 live cards with color-coded status rings, temperatures, CPU load, and PoE Watts.
  * Dedicated badges for `REBOOTING` (pulsing amber) and `OFFLINE` (muted grey).
  * Real-time text search and filters (e.g. `hot`, `warning`, `reboot`, `offline`, `100M`, `48`).
* **Live Cluster KPI Analytics**:
  * Total cluster power (Watts & Amps) and cumulative energy consumption (kWh).
  * Online, Offline, and Rebooting node counters.
  * Average and peak temperatures across the wall.
  * Firmware under-voltage & throttling health counters (`vcgencmd get_throttled`).
  * Negotiated Ethernet link speeds (identifies 1000 Mbps Gigabit vs 100 Mbps cable faults).
  * Active student/researcher SSH sessions.
* **OpenID Connect (OIDC) Protected Controls**:
  * **Public by default**: Anyone can view the 3D twin, cluster stats, and detailed sensor data without logging in.
  * **Protected actions**: `Reboot` and `Shutdown` require logging in via OIDC (Google, Auth0, Keycloak, or UCL CASA).
  * **Visual Locator**: `Identify / Locate` sends an MQTT command to flash the physical Pi's green ACT LED for 10 seconds and illuminates a visual spotlight beam in the 3D digital twin.
* **Zero-Friction Reliability**:
  * **Staleness Watchdog**: Automatically marks nodes offline if telemetry heartbeats cease for >18s or if a reboot times out.
  * **Dev Mode Auth**: Allows one-click local admin sign-in for testing control commands before setting up an external identity provider.
  * **Containerized Deployment**: Ready for Docker and Docker Compose with health checks and non-root execution.

---

## Quick Start

### Option A: Running with Docker Compose (Recommended)

Run the dashboard directly in a production-ready container:

```bash
cd website
docker compose up -d
```

To stop the dashboard:
```bash
docker compose down
```

### Option B: Running with Node.js Locally

#### 1. Install Dependencies
```bash
cd website
npm install
```

#### 2. Configuration (`.env`)
Copy `.env.example` to `.env` and adjust as needed:
```bash
cp .env.example .env
```

Key environment variables:
| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the web dashboard |
| `HOST` | `0.0.0.0` | Listen host interface |
| `OIDC_BASE_URL` | `http://localhost:3000` | Public base URL used to construct `OIDC_CALLBACK_URL` in production |
| `OIDC_CALLBACK_URL` | `${OIDC_BASE_URL}/auth/callback` | Explicit redirect URI override if needed |
| `MQTT_HOST` | `mqtt.cetools.org` | MQTT broker hostname or IP |
| `MQTT_PORT` | `1884` | MQTT broker port |
| `MQTT_USER` | `CEDevice` | MQTT username (optional) |
| `MQTT_PASSWORD` | `...` | MQTT password (optional) |
| `MQTT_TOPIC_PREFIX` | `student/PiCloud` | Topic prefix used by nodes |
| `OIDC_ISSUER_URL` | `https://accounts.google.com` | OpenID Connect discovery endpoint |
| `OIDC_CLIENT_ID` | `""` | OIDC client ID from your IdP |
| `OIDC_CLIENT_SECRET` | `""` | OIDC client secret |
| `AUTH_DEV_MODE` | `true` | Enables quick one-click local admin login |

#### 3. Run the Dashboard
```bash
npm start
```
Open **`http://localhost:3000`** in your browser.

Inspect configuration and cluster settings via **`GET /api/settings`**.

---

## MQTT Topics & Data Contracts

### 1. Ingesting Telemetry
The dashboard subscribes to `student/PiCloud/+/metrics`. Each Pi publishes its state as a JSON object matching this schema:
```json
{
  "hostname": "picloud-48",
  "ip": "10.129.111.48",
  "uptime_seconds": 2578,
  "active_users": 2,
  "temp_c": 43.82,
  "cpu_percent": 5.9,
  "cpu_freq_mhz": 1800,
  "load_averages": { "1m": 0.33, "5m": 0.26, "15m": 0.2 },
  "memory_percent": 24.5,
  "memory_available_mb": 2866.8,
  "disk_percent": 16.8,
  "disk_free_gb": 45.76,
  "network": { "eth_speed_mbps": 1000, "rx_kb_s": 1.0, "tx_kb_s": 1.2, "ping": "success", "ping_ms": "2.335" },
  "power_and_hardware": {
    "throttled": { "hex": "0x0", "healthy": true },
    "fan_state": 2,
    "cumulative_energy_wh": 0.0245
  },
  "poe": { "current_amps": 0.362, "current_watts": 1.81 },
  "zram": { "orig_mb": 48.0, "compressed_mb": 16.0, "ratio": 3.0 }
}
```

### 2. Remote MQTT Commands
The dashboard publishes commands to `student/PiCloud/<hostname>/cmd` or `student/PiCloud/cmd`:
* **`identify`**: Flashes the physical ACT LED and triggers a 3D spotlight beam in the digital twin.
* **`metrics`**: Triggers immediate on-demand sensor reading and report publish.
* **`reboot`**: Safely reboots the node (OIDC login required).
* **`shutdown`**: Safely powers off the node (OIDC login required).

