# PiCloud Node MQTT Stats & Control

Collects and reports system health, PoE power, hardware diagnostics, and workload metrics over MQTT. Also listens for remote control commands (`metrics`, `identify`, `reboot`, `shutdown`).

---

## Installation & Deployment

Managed automatically across the cluster via Ansible:
```bash
# Deploy to a canary node
ansible-playbook -i hosts.ini tasks/pi-setup/node-stats.yml --limit picloud-48

# Deploy to all 48 nodes
ansible-playbook -i hosts.ini tasks/pi-setup/node-stats.yml
```

### Supervisor Service Commands (on any node)
```bash
sudo supervisorctl status picloud-node-mqtt
sudo supervisorctl restart picloud-node-mqtt
sudo supervisorctl tail -f picloud-node-mqtt
```

---

## MQTT Command Topics

Each node subscribes to both its own node-specific command topic and the cluster-wide broadcast topics:
* **Node-specific command:** `student/PiCloud/<hostname>/cmd` (e.g. `student/PiCloud/picloud-48/cmd`)
* **Cluster broadcast command:** `student/PiCloud/cmd` and `student/PiCloud/all/cmd`

---

## Supported Commands

### 1. `identify` / `locate` / `blink` (Visual Physical Locator)
Flashes the onboard green ACT LED rapidly in a non-blocking background thread for 10 seconds (or a custom duration) so you can physically spot the exact Pi on the wall rack. Automatically restores normal SD activity LED trigger (`mmc0`) when done.

* **Simple text:**
  ```bash
  mosquitto_pub -h <broker> -t "student/PiCloud/picloud-48/cmd" -m "identify"
  ```
* **Custom duration via JSON (e.g., 20 seconds):**
  ```bash
  mosquitto_pub -h <broker> -t "student/PiCloud/picloud-48/cmd" -m '{"cmd": "identify", "duration": 20}'
  ```

### 2. `metrics` / `status` / `poll` (On-Demand Metrics Request)
Forces the node(s) to immediately sample all sensors and publish their consolidated JSON report and individual subtopics:

* **Query a single node:**
  ```bash
  mosquitto_pub -h <broker> -t "student/PiCloud/picloud-48/cmd" -m "metrics"
  ```
* **Query the entire 48-node wall at once:**
  ```bash
  mosquitto_pub -h <broker> -t "student/PiCloud/cmd" -m "metrics"
  ```
* **Reply to a custom endpoint/topic:**
  ```bash
  mosquitto_pub -h <broker> -t "student/PiCloud/picloud-48/cmd" -m '{"cmd": "metrics", "endpoint": "student/PiCloud/dashboard/reports"}'
  ```

### 3. `reboot` / `shutdown`
* `reboot`: Safely reboots the node (`shutdown -r now`)
* `shutdown`: Gracefully halts the node (`shutdown -h now`)

---

## MQTT Metrics Published

Metrics stream periodically every 5 seconds and are also triggered immediately on command.

### 1. Consolidated JSON Report
* **Topic:** `student/PiCloud/<hostname>/metrics`
* **Sample Payload:**
```json
{
  "hostname": "picloud-48",
  "ip": "10.129.111.48",
  "uptime_seconds": 124800,
  "active_users": 1,
  "logged_in_user": "pi",
  "ssh": {
    "active_users_count": 1,
    "active_users": ["pi"],
    "primary_user": "pi",
    "active_sessions": [
      {
        "user": "pi",
        "terminal": "pts/0",
        "host": "10.129.111.100",
        "login_time": "2026-09-17 21:30:15",
        "duration": "1h 12m",
        "duration_seconds": 4320
      }
    ],
    "last_login": {
      "user": "pi",
      "host": "10.129.111.100",
      "terminal": "pts/0",
      "time": "Thu Sep 17 21:30:15 2026"
    },
    "last_logout": {
      "user": "student1",
      "host": "10.129.111.42",
      "terminal": "pts/1",
      "login_time": "Thu Sep 17 19:10:00 2026",
      "logout_time": "Thu Sep 17 20:05:14 2026",
      "duration": "00:55"
    },
    "recent_sessions": [
      { "user": "pi", "terminal": "pts/0", "host": "10.129.111.100", "login_time": "Thu Sep 17 21:30:15 2026", "logout_time": "Active", "duration": "Active", "is_active": true }
    ],
    "sshd_running": true
  },
  "temp_c": 43.8,
  "cpu_percent": 14.2,
  "cpu_freq_mhz": 1800,
  "load_averages": {
    "1m": 0.35,
    "5m": 0.28,
    "15m": 0.15
  },
  "memory_percent": 28.4,
  "memory_available_mb": 718.5,
  "disk_percent": 34.2,
  "disk_free_gb": 19.12,
  "network": {
    "eth_speed_mbps": 1000,
    "rx_kb_s": 14.8,
    "tx_kb_s": 32.1,
    "ping": "success",
    "ping_ms": "10.4"
  },
  "power_and_hardware": {
    "throttled": {
      "hex": "0x0",
      "healthy": true,
      "undervoltage_now": false,
      "freq_capped_now": false,
      "throttled_now": false,
      "soft_temp_limit_now": false,
      "undervoltage_has_occurred": false,
      "freq_capped_has_occurred": false,
      "throttled_has_occurred": false,
      "soft_temp_limit_has_occurred": false
    },
    "fan_state": 1,
    "cumulative_energy_wh": 14.8231
  },
  "poe": {
    "POWER_SUPPLY_NAME": "rpi-poe",
    "POWER_SUPPLY_TYPE": "PoE",
    "POWER_SUPPLY_HEALTH": "Good",
    "POWER_SUPPLY_ONLINE": 1,
    "current_now_amps": 1150000,
    "current_max_amps": 2500000,
    "current_amps": 1.15,
    "current_watts": 5.75
  },
  "zram": {
    "orig_mb": 42.5,
    "compressed_mb": 14.2,
    "ratio": 2.99
  },
  "heartbeat": "18:15:00",
  "heartbeat_ms": 1773767700000000,
  "timestamp": 1773767700.123
}
```

### 2. Individual Subtopics (for Dashboards & Node-RED)
* `student/PiCloud/<hostname>/cpu_percent`: CPU utilization percentage
* `student/PiCloud/<hostname>/cpu_freq_mhz`: Current CPU clock speed in MHz (e.g. 600–2400)
* `student/PiCloud/<hostname>/temp_c`: CPU temperature in °C
* `student/PiCloud/<hostname>/ip`: Primary IPv4 address
* `student/PiCloud/<hostname>/ip_hostname`: Hostname
* `student/PiCloud/<hostname>/fan_state`: PoE fan speed level (0=off, 1=low, 2=med, 3=high, 4=max)
* `student/PiCloud/<hostname>/throttled_hex`: Raspberry Pi firmware throttled bitmask (`0x0` = normal)
* `student/PiCloud/<hostname>/eth_speed_mbps`: Negotiated Ethernet link speed (e.g. 1000 vs 100)
* `student/PiCloud/<hostname>/energy_wh`: Cumulative watt-hours consumed since boot
* `student/PiCloud/<hostname>/ping`: Gateway/Internet ping status (`success`/`failed`)
* `student/PiCloud/<hostname>/ping_ms`: Ping round-trip latency in milliseconds
* `student/PiCloud/<hostname>/heartbeat`: Local time string (`HH:MM:SS`)
* `student/PiCloud/<hostname>/heartbeat_ms`: Microsecond unix timestamp
* `student/PiCloud/<hostname>/poe/*`: Raw PoE HAT power supply attributes