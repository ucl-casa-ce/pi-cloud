
## Topic 
```student/picloud/picloud-X/metrics```

## JSON Object
```json
{
  "hostname": "picloud-1",
  "ip": "",
  "uptime_seconds": 424360,
  "active_users": 0,
  "logged_in_user": null,
  "ssh": {
    "active_users_count": 0,
    "active_users": [],
    "primary_user": null,
    "active_sessions": [],
    "last_login": {
      "user": "pi",
      "host": "",
      "terminal": "pts/0",
      "time": "Sat Sep 19 00:55"
    },
    "last_logout": {
      "user": "pi",
      "host": "",
      "terminal": "pts/0",
      "login_time": "Sat Sep 19 00:55",
      "logout_time": "00:55",
      "duration": "<1 min"
    },
    "recent_sessions": [
      {
        "user": "pi",
        "terminal": "pts/0",
        "host": "",
        "login_time": "Sat Sep 19 00:55",
        "logout_time": "00:55",
        "duration": "<1 min",
        "is_active": false
      },
      {
        "user": "pi",
        "terminal": "pts/0",
        "host": "",
        "login_time": "Sat Sep 19 00:55",
        "logout_time": "00:55",
        "duration": "<1 min",
        "is_active": false
      }
    ],
    "sshd_running": true
  },
  "temp_c": 46.74,
  "cpu_percent": 4.5,
  "cpu_freq_mhz": 800,
  "load_averages": {
    "1m": 0.15,
    "5m": 0.14,
    "15m": 0.09
  },
  "memory_percent": 12,
  "memory_available_mb": 3339.1,
  "disk_percent": 26.8,
  "disk_free_gb": 20.08,
  "network": {
    "eth_speed_mbps": 1000,
    "rx_kb_s": 0.5,
    "tx_kb_s": 0.8,
    "ping": "success",
    "ping_ms": "2.382"
  },
  "power_and_hardware": {
    "throttled": {
      "hex": "0x0",
      "undervoltage_now": false,
      "freq_capped_now": false,
      "throttled_now": false,
      "soft_temp_limit_now": false,
      "undervoltage_has_occurred": false,
      "freq_capped_has_occurred": false,
      "throttled_has_occurred": false,
      "soft_temp_limit_has_occurred": false,
      "healthy": true
    },
    "fan_state": 1,
    "cumulative_energy_wh": 199.6685,
    "fan": {
      "state": 1,
      "mode": "auto",
      "temp_on": 48,
      "temp_off": 42,
      "speed": 2,
      "manual_override": false
    }
  },
  "heartbeat": "23:08:30",
  "heartbeat_ms": 1790201310688342,
  "timestamp": 1790201310.688343,
  "poe": {
    "DEVTYPE": "power_supply",
    "OF_NAME": "rpi-poe-power-supply",
    "OF_FULLNAME": "/rpi-poe-power-supply",
    "OF_COMPATIBLE_0": "raspberrypi,rpi-poe-power-supply",
    "OF_COMPATIBLE_N": "1",
    "POWER_SUPPLY_NAME": "rpi-poe",
    "POWER_SUPPLY_TYPE": "Mains",
    "POWER_SUPPLY_HEALTH": "Good",
    "POWER_SUPPLY_ONLINE": "1",
    "POWER_SUPPLY_CURRENT_MAX": "5000000",
    "POWER_SUPPLY_CURRENT_NOW": "360000",
    "current_amps": 0.36,
    "current_watts": 1.8
  },
  "zram": {
    "orig_mb": 0,
    "compressed_mb": 0,
    "ratio": 1
  }
}
```