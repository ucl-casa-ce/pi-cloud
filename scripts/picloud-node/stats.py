#!/usr/bin/env python3

import os
import json
import time
import socket
import psutil
import platform
import threading
import subprocess
import re
from dotenv import load_dotenv
from paho.mqtt import client as mqtt_client

load_dotenv()

# Load MQTT credentials from environment variables
MQTT_HOST = os.getenv("MQTT_HOST")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_USER = os.getenv("MQTT_USER")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")
MQTT_BASE_TOPIC = os.getenv("MQTT_TOPIC_PREFIX", "student/PiCloud")

hostname = socket.gethostname()
NODE_TOPIC_PREFIX = f"{MQTT_BASE_TOPIC}/{hostname}"

# Generate a Client ID. If run interactively in a terminal, add a suffix so it doesn't fight the background supervisor service.
if os.isatty(0):
    client_id = f"pcloud_node_{hostname}_test"
else:
    client_id = f"pcloud_node_{hostname}"

POE_UEVENT_FILE = "/sys/devices/platform/rpi-poe-power-supply/power_supply/rpi-poe/uevent"

# State tracking for cumulative calculations and rates
cumulative_wh = 0.0
last_energy_calc_time = time.time()
last_net_bytes = None
last_net_time = None

def parse_uevent_file(uevent_file):
    if not os.path.exists(uevent_file):
        return None
    try:
        with open(uevent_file, "r") as f:
            output = f.read()
    except Exception:
        return None

    power_supply_info = {}
    for line in output.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            power_supply_info[key.strip()] = value.strip()

    if power_supply_info:
        current_now = int(power_supply_info.get("POWER_SUPPLY_CURRENT_NOW", 0))
        power_supply_info["current_amps"] = round(current_now * 0.000001, 4)
        power_supply_info["current_watts"] = round(current_now * 0.000001 * 5, 4)

    return power_supply_info

def update_energy(current_watts):
    """Calculates cumulative watt-hours based on instantaneous watts and elapsed time."""
    global cumulative_wh, last_energy_calc_time
    now = time.time()
    dt = now - last_energy_calc_time
    last_energy_calc_time = now
    if current_watts > 0 and dt > 0:
        cumulative_wh += current_watts * (dt / 3600.0)
    return round(cumulative_wh, 4)

def get_ip_address():
    ip_address = "127.0.0.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("1.1.1.1", 80))
            ip_address = s.getsockname()[0]
    except Exception:
        pass
    return ip_address

def get_ping_status():
    try:
        ping_result = subprocess.run(["ping", "-c", "1", "-W", "1", "1.1.1.1"], capture_output=True, text=True)
        if ping_result.returncode == 0:
            lines = [line for line in ping_result.stdout.splitlines() if "rtt" in line or "round-trip" in line]
            if lines and "/" in lines[0]:
                ping_time = lines[0].split("/")[4]
            else:
                ping_time = "0"
            return "success", ping_time
    except Exception:
        pass
    return "failed", "0"

def get_cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return round(int(f.read().strip()) / 1000.0, 2)
    except Exception:
        try:
            out = subprocess.check_output(["vcgencmd", "measure_temp"], text=True)
            return float(out.replace("temp=", "").replace("'C", "").strip())
        except Exception:
            return 0.0

def get_cpu_freq_mhz():
    for path in [
        "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq",
        "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq",
    ]:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    return int(f.read().strip()) // 1000
            except Exception:
                pass
    return 0

# PoE Fan Configuration and Hardware Control
FAN_CONFIG_PATHS = [
    "/opt/picloud-node/fan_config.json",
    os.path.expanduser("~/.config/picloud/fan_config.json"),
    "/tmp/picloud_fan_config.json"
]

fan_config = {
    "mode": "auto",       # "auto", "on", "off"
    "temp_on": 48,        # Celsius threshold to activate fan
    "temp_off": 42,       # Celsius threshold to deactivate fan
    "speed": 2,           # Desired level when running (1-4)
    "manual_override": False
}

def load_fan_config():
    """Loads saved fan configuration from persistent storage."""
    global fan_config
    for path in FAN_CONFIG_PATHS:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    loaded = json.load(f)
                    if isinstance(loaded, dict):
                        fan_config.update(loaded)
                        print(f"Loaded PoE fan config from {path}: {fan_config}")
                        return
            except Exception as e:
                print(f"Error reading fan config from {path}: {e}")

def save_fan_config():
    """Persists active fan configuration to disk."""
    global fan_config
    for path in FAN_CONFIG_PATHS:
        try:
            parent_dir = os.path.dirname(path)
            if parent_dir and not os.path.exists(parent_dir):
                os.makedirs(parent_dir, exist_ok=True)
            with open(path, "w") as f:
                json.dump(fan_config, f, indent=2)
            return True
        except Exception:
            continue
    return False

def find_poe_cooling_devices():
    """Locates cooling devices associated with the PoE HAT fan."""
    devices = []
    thermal_dir = "/sys/class/thermal"
    if os.path.exists(thermal_dir):
        try:
            for name in os.listdir(thermal_dir):
                if name.startswith("cooling_device"):
                    cpath = os.path.join(thermal_dir, name)
                    type_file = os.path.join(cpath, "type")
                    dev_type = ""
                    if os.path.exists(type_file):
                        try:
                            with open(type_file, "r") as tf:
                                dev_type = tf.read().strip().lower()
                        except Exception:
                            pass
                    if "poe" in dev_type or "fan" in dev_type or name == "cooling_device0":
                        devices.append(cpath)
        except Exception:
            pass
    return devices

def find_poe_pwm_devices():
    """Locates hardware PWM nodes associated with the PoE HAT fan."""
    pwm_devs = []
    hwmon_dir = "/sys/class/hwmon"
    if os.path.exists(hwmon_dir):
        try:
            for name in os.listdir(hwmon_dir):
                hpath = os.path.join(hwmon_dir, name)
                pwm_file = os.path.join(hpath, "pwm1")
                if os.path.exists(pwm_file):
                    pwm_devs.append(hpath)
        except Exception:
            pass
    return pwm_devs

def get_poe_fan_state():
    """Reads PoE HAT fan speed level (0=off, 1=low, 2=med, 3=high, 4=max)."""
    # 1. Thermal cooling devices
    cooling_devs = find_poe_cooling_devices()
    for dev in cooling_devs:
        cur_file = os.path.join(dev, "cur_state")
        if os.path.exists(cur_file):
            try:
                with open(cur_file, "r") as f:
                    val = int(f.read().strip())
                    return min(4, max(0, val))
            except Exception:
                pass

    # 2. Hardware PWM
    for hpath in find_poe_pwm_devices():
        pwm_file = os.path.join(hpath, "pwm1")
        if os.path.exists(pwm_file):
            try:
                with open(pwm_file, "r") as f:
                    raw = int(f.read().strip())
                    if raw == 0:
                        return 0
                    elif raw <= 75:
                        return 1
                    elif raw <= 150:
                        return 2
                    elif raw <= 220:
                        return 3
                    else:
                        return 4
            except Exception:
                pass
    return 0

def set_poe_fan_hardware(level):
    """Writes target fan speed level (0-4) to kernel cooling devices and PWM nodes."""
    level = max(0, min(4, int(level)))
    success = False

    # 1. Set thermal cooling devices
    for dev in find_poe_cooling_devices():
        cur_state_file = os.path.join(dev, "cur_state")
        try:
            with open(cur_state_file, "w") as f:
                f.write(str(level))
            success = True
        except Exception:
            pass

    # 2. Set hardware PWM (scale 0-4 to 0-255)
    pwm_map = [0, 64, 128, 192, 255]
    pwm_val = pwm_map[level]
    for hpath in find_poe_pwm_devices():
        enable_file = os.path.join(hpath, "pwm1_enable")
        pwm_file = os.path.join(hpath, "pwm1")
        try:
            if os.path.exists(enable_file):
                with open(enable_file, "w") as ef:
                    # '1' is manual PWM control, '2' is automatic thermal governor
                    is_manual = (level > 0 or fan_config.get("mode") in ["on", "off"])
                    ef.write("1" if is_manual else "2")
            if os.path.exists(pwm_file):
                with open(pwm_file, "w") as pf:
                    pf.write(str(pwm_val))
            success = True
        except Exception:
            pass

    return success

def apply_fan_policy(current_temp_c):
    """Applies active policy (Auto hysteresis vs Manual Override ON/OFF)."""
    mode = fan_config.get("mode", "auto")
    speed = max(1, min(4, int(fan_config.get("speed", 2))))
    temp_on = float(fan_config.get("temp_on", 48))
    temp_off = float(fan_config.get("temp_off", 42))

    current_state = get_poe_fan_state()

    if mode == "on":
        # Force fan ON at target speed
        if current_state != speed:
            set_poe_fan_hardware(speed)
    elif mode == "off":
        # Force fan OFF
        if current_state != 0:
            set_poe_fan_hardware(0)
    else:
        # Automatic thermal hysteresis
        if current_temp_c >= temp_on:
            # Step up fan speed if significantly hot
            target_speed = min(4, speed + 1) if current_temp_c >= (temp_on + 8) else speed
            if current_state != target_speed:
                set_poe_fan_hardware(target_speed)
        elif current_temp_c <= temp_off:
            # Drop fan to 0 when cooled down
            if current_state != 0:
                set_poe_fan_hardware(0)
        # In hysteresis window between temp_off and temp_on: maintain current state


def get_throttled_info():
    """Extracts hardware under-voltage, throttling, and frequency capping flags via vcgencmd."""
    try:
        out = subprocess.check_output(["vcgencmd", "get_throttled"], text=True)
        val_str = out.strip().split("=")[1]
        val = int(val_str, 16)
        return {
            "hex": val_str,
            "undervoltage_now": bool(val & 0x1),
            "freq_capped_now": bool(val & 0x2),
            "throttled_now": bool(val & 0x4),
            "soft_temp_limit_now": bool(val & 0x8),
            "undervoltage_has_occurred": bool(val & 0x10000),
            "freq_capped_has_occurred": bool(val & 0x20000),
            "throttled_has_occurred": bool(val & 0x40000),
            "soft_temp_limit_has_occurred": bool(val & 0x80000),
            "healthy": (val == 0),
        }
    except Exception:
        return {"hex": "unknown", "healthy": True}

def get_eth_speed():
    """Checks negotiated Ethernet link speed (e.g. 1000 for Gigabit, 100 for fast ethernet)."""
    for path in ["/sys/class/net/eth0/speed", "/sys/class/net/end0/speed"]:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    speed = int(f.read().strip())
                    if speed > 0:
                        return speed
            except Exception:
                pass
    return 0

def get_network_rates():
    """Calculates instantaneous Rx and Tx throughput in KB/s."""
    global last_net_bytes, last_net_time
    now = time.time()
    rx_rate_kb = 0.0
    tx_rate_kb = 0.0
    try:
        net_io = psutil.net_io_counters(pernic=True)
        eth = net_io.get("eth0") or net_io.get("end0") or net_io.get("wlan0")
        if eth:
            if last_net_bytes is not None and last_net_time is not None:
                dt = now - last_net_time
                if dt > 0:
                    rx_rate_kb = round((eth.bytes_recv - last_net_bytes[0]) / (1024.0 * dt), 1)
                    tx_rate_kb = round((eth.bytes_sent - last_net_bytes[1]) / (1024.0 * dt), 1)
            last_net_bytes = (eth.bytes_recv, eth.bytes_sent)
            last_net_time = now
    except Exception:
        pass
    return rx_rate_kb, tx_rate_kb

def get_zram_stats():
    """Extracts compressed zram swap usage and compression ratio if zram is active."""
    zram_file = "/sys/block/zram0/mm_stat"
    if not os.path.exists(zram_file):
        return None
    try:
        with open(zram_file, "r") as f:
            stats = f.read().split()
            orig_b = int(stats[0])
            compr_b = int(stats[1])
            ratio = round(orig_b / compr_b, 2) if compr_b > 0 else 1.0
            return {
                "orig_mb": round(orig_b / (1024 * 1024), 2),
                "compressed_mb": round(compr_b / (1024 * 1024), 2),
                "ratio": ratio,
            }
    except Exception:
        return None

def identify_node(duration=10):
    """Flashes the onboard ACT LED rapidly in a background thread to physically locate the node."""
    def _blink():
        led_path = None
        for p in ["/sys/class/leds/ACT", "/sys/class/leds/led0"]:
            if os.path.exists(p):
                led_path = p
                break
        if not led_path:
            print("ACT LED path not found; skipping visual identify.")
            return

        print(f"Blinking ACT LED on {hostname} for {duration}s...")
        orig_trigger = "mmc0"
        try:
            with open(f"{led_path}/trigger", "r") as f:
                content = f.read()
                for part in content.split():
                    if part.startswith("[") and part.endswith("]"):
                        orig_trigger = part[1:-1]
                        break
        except Exception:
            pass

        try:
            subprocess.run(f"echo timer | sudo tee {led_path}/trigger >/dev/null", shell=True)
            subprocess.run(f"echo 100 | sudo tee {led_path}/delay_on >/dev/null", shell=True)
            subprocess.run(f"echo 100 | sudo tee {led_path}/delay_off >/dev/null", shell=True)
            time.sleep(duration)
        finally:
            subprocess.run(f"echo {orig_trigger} | sudo tee {led_path}/trigger >/dev/null", shell=True)
            print(f"Restored ACT LED trigger to '{orig_trigger}'.")

    threading.Thread(target=_blink, daemon=True).start()

def format_human_duration(seconds):
    """
    Formats elapsed duration in human-readable style:
    - < 60s: '<1 min'
    - 60s - 119s: '1 min'
    - 2m - 59m: 'X mins'
    - 1h - 23h: '1 hr 0 mins' / 'X hrs Y mins'
    - >= 24h: 'X days Y hours Z mins'
    """
    total_seconds = max(0, int(seconds)) if seconds is not None else 0
    if total_seconds < 60:
        return "<1 min"

    total_mins = total_seconds // 60
    if total_mins < 60:
        return "1 min" if total_mins == 1 else f"{total_mins} mins"

    total_hours = total_mins // 60
    mins_rem = total_mins % 60
    min_str = "1 min" if mins_rem == 1 else f"{mins_rem} mins"

    if total_hours < 24:
        hr_str = "1 hr" if total_hours == 1 else f"{total_hours} hrs"
        return f"{hr_str} {min_str}"

    days = total_hours // 24
    hours_rem = total_hours % 24
    day_str = "1 day" if days == 1 else f"{days} days"
    hr_str = "1 hour" if hours_rem == 1 else f"{hours_rem} hours"
    return f"{day_str} {hr_str} {min_str}"

def parse_and_format_duration(dur_str):
    """Parses raw duration from 'last' (e.g. '00:00', '01:25', '1+02:15') and returns human format."""
    if not dur_str or dur_str in ("N/A", "Active"):
        return dur_str
    m_days = re.match(r"^(\d+)\+(\d{1,2}):(\d{2})$", dur_str)
    if m_days:
        days, hrs, mins = int(m_days.group(1)), int(m_days.group(2)), int(m_days.group(3))
        sec = ((days * 24 + hrs) * 60 + mins) * 60
        return format_human_duration(sec)
    m_hhmm = re.match(r"^(\d{1,2}):(\d{2})$", dur_str)
    if m_hhmm:
        hrs, mins = int(m_hhmm.group(1)), int(m_hhmm.group(2))
        sec = (hrs * 60 + mins) * 60
        return format_human_duration(sec)
    return dur_str

def get_ssh_info():
    """Extracts active SSH sessions, logged in users, last login details, and logout events."""
    active_sessions = []
    active_user_names = []

    # 1. Live active terminal sessions using psutil
    try:
        users = psutil.users()
        for u in users:
            # Exclusively track active SSH sessions (pseudo-terminals pts/* or non-local remote host)
            # Filter out console autologins (tty1, tty2, etc.) that run automatically upon boot
            terminal = u.terminal or ""
            is_ssh = terminal.startswith("pts") or (u.host and u.host not in ("", "local", ":0") and not terminal.startswith("tty"))
            if not is_ssh:
                continue

            started_dt = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(u.started)) if u.started else "N/A"
            dur_sec = max(0, int(time.time() - u.started)) if u.started else 0
            dur_str = format_human_duration(dur_sec)
            active_sessions.append({
                "user": u.name,
                "terminal": u.terminal,
                "host": u.host or "local",
                "login_time": started_dt,
                "duration": dur_str,
                "duration_seconds": dur_sec,
            })
            if u.name not in active_user_names:
                active_user_names.append(u.name)
    except Exception:
        pass

    # 2. Historical logins and logout events from 'last'
    recent_sessions = []
    last_login = None
    last_logout = None

    try:
        raw_text = ""
        # Try full timestamp format first (-F), fallback to standard last
        try:
            res = subprocess.run(["last", "-F", "-n", "20"], capture_output=True, text=True, timeout=2)
            if res.returncode == 0 and res.stdout:
                raw_text = res.stdout
        except Exception:
            pass

        if not raw_text:
            try:
                res = subprocess.run(["last", "-n", "20"], capture_output=True, text=True, timeout=2)
                if res.returncode == 0 and res.stdout:
                    raw_text = res.stdout
            except Exception:
                pass

        for line in raw_text.splitlines():
            line = line.strip()
            if not line or line.startswith(("reboot", "shutdown", "wtmp", "begins")):
                continue
            parts = line.split()
            if len(parts) < 4:
                continue

            user = parts[0]
            tty = parts[1]

            # Only track SSH sessions (pts/*) - ignore console autologin (tty1, etc.) and non-terminal events
            if not tty.startswith("pts"):
                continue

            idx = 2
            client_ip = ""
            if not re.match(r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)", parts[2]):
                client_ip = parts[2]
                idx = 3

            rest = " ".join(parts[idx:])
            is_still_in = "still logged in" in line or "still running" in line

            logout_time = None
            duration = None
            login_time = rest

            if is_still_in:
                login_time = rest.replace("still logged in", "").replace("still running", "").strip()
                logout_time = "Active"
                duration = "Active"
            elif " - " in rest:
                time_parts = rest.split(" - ", 1)
                login_time = time_parts[0].strip()
                after_dash = time_parts[1].strip()
                dur_match = re.search(r"\((.*?)\)", after_dash)
                if dur_match:
                    duration = parse_and_format_duration(dur_match.group(1))
                    logout_time = re.sub(r"\(.*?\)", "", after_dash).strip()
                else:
                    logout_time = after_dash

            sess = {
                "user": user,
                "terminal": tty,
                "host": client_ip or "local",
                "login_time": login_time,
                "logout_time": logout_time or "N/A",
                "duration": duration or "N/A",
                "is_active": is_still_in,
            }
            if len(recent_sessions) < 5:
                recent_sessions.append(sess)

            if not last_login:
                last_login = {
                    "user": user,
                    "host": client_ip or "local",
                    "terminal": tty,
                    "time": login_time,
                }

            if not last_logout and not is_still_in and logout_time and logout_time != "N/A":
                last_logout = {
                    "user": user,
                    "host": client_ip or "local",
                    "terminal": tty,
                    "login_time": login_time,
                    "logout_time": logout_time,
                    "duration": duration or "N/A",
                }
    except Exception:
        pass

    # If last_login not populated from last, fallback to active session
    if not last_login and active_sessions:
        first = active_sessions[0]
        last_login = {
            "user": first["user"],
            "host": first["host"],
            "terminal": first["terminal"],
            "time": first["login_time"],
        }

    # Check ssh daemon status
    sshd_running = False
    try:
        sshd_res = subprocess.run(["systemctl", "is-active", "ssh"], capture_output=True, text=True, timeout=1)
        sshd_running = (sshd_res.stdout.strip() == "active")
    except Exception:
        try:
            sshd_running = any("sshd" in p.name() for p in psutil.process_iter(["name"]))
        except Exception:
            sshd_running = True

    return {
        "active_users_count": len(active_sessions),
        "active_users": active_user_names,
        "primary_user": active_user_names[0] if active_user_names else None,
        "active_sessions": active_sessions,
        "last_login": last_login,
        "last_logout": last_logout,
        "recent_sessions": recent_sessions,
        "sshd_running": sshd_running,
    }

def collect_all_metrics():
    """Gathers all node health, power, network, and workload metrics into a single dictionary."""
    ping_status, ping_ms = get_ping_status()
    ip_addr = get_ip_address()
    temp_c = get_cpu_temp()
    cpu_freq_mhz = get_cpu_freq_mhz()
    cpu_percent = psutil.cpu_percent(interval=None)

    load1, load5, load15 = os.getloadavg()
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    rx_kb_s, tx_kb_s = get_network_rates()
    eth_speed = get_eth_speed()
    throttled = get_throttled_info()
    apply_fan_policy(temp_c)
    fan_state = get_poe_fan_state()
    zram = get_zram_stats()

    # Active logged in sessions and SSH stats
    ssh_info = get_ssh_info()
    active_users = ssh_info["active_users_count"]
    logged_in_user = ssh_info["primary_user"]

    uptime_sec = int(time.time() - psutil.boot_time())

    poe = parse_uevent_file(POE_UEVENT_FILE)
    current_watts = poe.get("current_watts", 0.0) if poe else 0.0
    energy_wh = update_energy(current_watts)

    metrics = {
        "hostname": hostname,
        "ip": ip_addr,
        "uptime_seconds": uptime_sec,
        "active_users": active_users,
        "logged_in_user": logged_in_user,
        "ssh": ssh_info,
        "temp_c": temp_c,
        "cpu_percent": cpu_percent,
        "cpu_freq_mhz": cpu_freq_mhz,
        "load_averages": {
            "1m": round(load1, 2),
            "5m": round(load5, 2),
            "15m": round(load15, 2),
        },
        "memory_percent": mem.percent,
        "memory_available_mb": round(mem.available / (1024 * 1024), 1),
        "disk_percent": disk.percent,
        "disk_free_gb": round(disk.free / (1024 * 1024 * 1024), 2),
        "network": {
            "eth_speed_mbps": eth_speed,
            "rx_kb_s": rx_kb_s,
            "tx_kb_s": tx_kb_s,
            "ping": ping_status,
            "ping_ms": ping_ms,
        },
        "power_and_hardware": {
            "throttled": throttled,
            "fan_state": fan_state,
            "cumulative_energy_wh": energy_wh,
            "fan": {
                "state": fan_state,
                "mode": fan_config.get("mode", "auto"),
                "temp_on": fan_config.get("temp_on", 48),
                "temp_off": fan_config.get("temp_off", 42),
                "speed": fan_config.get("speed", 2),
                "manual_override": (fan_config.get("mode") in ["on", "off"]),
            },
        },
        "heartbeat": time.strftime("%H:%M:%S"),
        "heartbeat_ms": int(time.time() * 1e6),
        "timestamp": time.time(),
    }

    if poe:
        metrics["poe"] = poe
    if zram:
        metrics["zram"] = zram

    return metrics

def send_all_metrics(client, target_topic=None):
    """Sends all collected metrics to individual legacy subtopics and to a consolidated endpoint."""
    metrics = collect_all_metrics()

    # Publish legacy individual topics for backward compatibility
    client.publish(f"{NODE_TOPIC_PREFIX}/cpu_percent", str(metrics["cpu_percent"]))
    client.publish(f"{NODE_TOPIC_PREFIX}/cpu_freq_mhz", str(metrics["cpu_freq_mhz"]))
    client.publish(f"{NODE_TOPIC_PREFIX}/ip_hostname", metrics["hostname"])
    client.publish(f"{NODE_TOPIC_PREFIX}/ip", metrics["ip"], 0, True)
    client.publish(f"{NODE_TOPIC_PREFIX}/ping", metrics["network"]["ping"])
    client.publish(f"{NODE_TOPIC_PREFIX}/ping_ms", str(metrics["network"]["ping_ms"]))
    client.publish(f"{NODE_TOPIC_PREFIX}/heartbeat", metrics["heartbeat"], 0, True)
    client.publish(f"{NODE_TOPIC_PREFIX}/heartbeat_ms", str(metrics["heartbeat_ms"]), 0, True)
    client.publish(f"{NODE_TOPIC_PREFIX}/temp_c", str(metrics["temp_c"]))
    client.publish(f"{NODE_TOPIC_PREFIX}/fan_state", str(metrics["power_and_hardware"]["fan_state"]))
    client.publish(f"{NODE_TOPIC_PREFIX}/eth_speed_mbps", str(metrics["network"]["eth_speed_mbps"]))
    client.publish(f"{NODE_TOPIC_PREFIX}/throttled_hex", metrics["power_and_hardware"]["throttled"]["hex"])
    client.publish(f"{NODE_TOPIC_PREFIX}/energy_wh", str(metrics["power_and_hardware"]["cumulative_energy_wh"]))
    client.publish(f"{NODE_TOPIC_PREFIX}/active_users", str(metrics["active_users"]))
    if metrics.get("logged_in_user"):
        client.publish(f"{NODE_TOPIC_PREFIX}/logged_in_user", str(metrics["logged_in_user"]), 0, True)
    if metrics.get("ssh", {}).get("last_login"):
        ll = metrics["ssh"]["last_login"]
        client.publish(f"{NODE_TOPIC_PREFIX}/ssh/last_login_user", str(ll.get("user", "")), 0, True)
        client.publish(f"{NODE_TOPIC_PREFIX}/ssh/last_login_time", str(ll.get("time", "")), 0, True)
    if metrics.get("ssh", {}).get("last_logout"):
        lo = metrics["ssh"]["last_logout"]
        client.publish(f"{NODE_TOPIC_PREFIX}/ssh/last_logout_user", str(lo.get("user", "")), 0, True)
        client.publish(f"{NODE_TOPIC_PREFIX}/ssh/last_logout_time", str(lo.get("logout_time", "")), 0, True)
        client.publish(f"{NODE_TOPIC_PREFIX}/ssh/last_logout_duration", str(lo.get("duration", "")), 0, True)

    if "poe" in metrics:
        poe = metrics["poe"]
        client.publish(f"{NODE_TOPIC_PREFIX}/poe/name", poe.get("POWER_SUPPLY_NAME", "rpi-poe"))
        client.publish(f"{NODE_TOPIC_PREFIX}/poe/type", poe.get("POWER_SUPPLY_TYPE", "PoE"))
        client.publish(f"{NODE_TOPIC_PREFIX}/poe/health", poe.get("POWER_SUPPLY_HEALTH", "Good"))
        client.publish(f"{NODE_TOPIC_PREFIX}/poe/online", str(poe.get("POWER_SUPPLY_ONLINE", 1)))
        client.publish(f"{NODE_TOPIC_PREFIX}/poe/current_now_amps", str(poe.get("POWER_SUPPLY_CURRENT_NOW", 0)))
        client.publish(f"{NODE_TOPIC_PREFIX}/poe/current_max_amps", str(poe.get("POWER_SUPPLY_CURRENT_MAX", 0)))
        client.publish(f"{NODE_TOPIC_PREFIX}/current_amps", str(poe.get("current_amps", 0)))
        client.publish(f"{NODE_TOPIC_PREFIX}/current_watts", str(poe.get("current_watts", 0)))

    # Publish consolidated JSON report to the node's metrics endpoint
    json_payload = json.dumps(metrics)
    destination = target_topic or f"{NODE_TOPIC_PREFIX}/metrics"
    client.publish(destination, json_payload)
    print(f"Published all metrics to {destination}")

    # If a custom destination was requested, also update the default node metrics endpoint
    if target_topic and target_topic != f"{NODE_TOPIC_PREFIX}/metrics":
        client.publish(f"{NODE_TOPIC_PREFIX}/metrics", json_payload)

def connect_mqtt():
    def on_connect(client, userdata, flags, reason_code, properties=None):
        rc = reason_code if isinstance(reason_code, int) else (0 if not reason_code.is_failure else 1)
        if rc == 0:
            print("Connected to MQTT Broker!")
            # Subscribe to node-specific cmd topic and cluster-wide broadcast topics
            topics = [
                (f"{NODE_TOPIC_PREFIX}/cmd", 0),
                (f"{MQTT_BASE_TOPIC}/cmd", 0),
                (f"{MQTT_BASE_TOPIC}/all/cmd", 0),
            ]
            for t, qos in topics:
                print(f"Subscribing to topic: {t}")
                client.subscribe(t, qos=qos)
        else:
            print(f"Failed to connect, return code {rc}")

    def on_disconnect(client, userdata, *args):
        print("disconnected OK")

    def on_message(client, userdata, message):
        raw_payload = message.payload.decode("utf-8").strip()
        print(f"Message received on [{message.topic}]: {raw_payload}")

        cmd = raw_payload.lower()
        target_endpoint = None
        duration = 10

        # Support JSON command payload, e.g.: {"cmd": "identify", "duration": 15}
        if raw_payload.startswith("{") and raw_payload.endswith("}"):
            try:
                cmd_data = json.loads(raw_payload)
                cmd = str(cmd_data.get("cmd", "")).lower()
                target_endpoint = (
                    cmd_data.get("endpoint")
                    or cmd_data.get("reply_to")
                    or cmd_data.get("target")
                    or cmd_data.get("topic")
                )
                if "duration" in cmd_data:
                    duration = int(cmd_data["duration"])
            except Exception as e:
                print(f"Could not parse JSON command: {e}")

        if cmd in ["metrics", "stats", "status", "report", "get_metrics", "poll"]:
            print(f"Triggering on-demand metrics report (target: {target_endpoint or f'{NODE_TOPIC_PREFIX}/metrics'})...")
            send_all_metrics(client, target_topic=target_endpoint)
        elif cmd in ["identify", "locate", "blink"]:
            print(f"Triggering physical node identification (blinking ACT LED for {duration}s)...")
            identify_node(duration=duration)
            client.publish(f"{NODE_TOPIC_PREFIX}/cmd/response", json.dumps({"action": "identify", "status": "blinking", "duration": duration}))
        elif cmd == "fan":
            # Command payload: {"cmd": "fan", "mode": "on"|"off"|"auto", "temp_on": 48, "temp_off": 42, "speed": 2}
            mode_val = str(cmd_data.get("mode", fan_config.get("mode", "auto"))).lower()
            if mode_val in ["auto", "on", "off"]:
                fan_config["mode"] = mode_val

            if "temp_on" in cmd_data:
                try:
                    fan_config["temp_on"] = int(cmd_data["temp_on"])
                except (ValueError, TypeError):
                    pass

            if "temp_off" in cmd_data:
                try:
                    fan_config["temp_off"] = int(cmd_data["temp_off"])
                except (ValueError, TypeError):
                    pass

            if "speed" in cmd_data:
                try:
                    fan_config["speed"] = max(1, min(4, int(cmd_data["speed"])))
                except (ValueError, TypeError):
                    pass

            fan_config["manual_override"] = (fan_config["mode"] in ["on", "off"])
            save_fan_config()

            # Immediately enforce the new fan settings
            cur_temp = get_cpu_temp()
            apply_fan_policy(cur_temp)
            current_fan_level = get_poe_fan_state()

            print(f"Applied PoE fan settings: mode={fan_config['mode']}, temp_on={fan_config['temp_on']}, temp_off={fan_config['temp_off']}, speed={fan_config['speed']}, state={current_fan_level}")

            resp_payload = {
                "action": "fan",
                "status": "applied",
                "fan": {
                    "mode": fan_config["mode"],
                    "temp_on": fan_config["temp_on"],
                    "temp_off": fan_config["temp_off"],
                    "speed": fan_config["speed"],
                    "state": current_fan_level,
                    "manual_override": fan_config["manual_override"]
                }
            }
            client.publish(f"{NODE_TOPIC_PREFIX}/cmd/response", json.dumps(resp_payload))
            # Publish updated telemetry immediately
            send_all_metrics(client)
        elif cmd == "reboot":
            print("Received reboot message, rebooting...")
            subprocess.call(["shutdown", "-r", "now"])
        elif cmd == "shutdown":
            print("Received shutdown message, shutting down...")
            subprocess.call(["shutdown", "-h", "now"])
        else:
            print(f"Unknown command received: {raw_payload}")

    try:
        client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2, client_id)
    except (AttributeError, ValueError):
        try:
            client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION1, client_id)
        except AttributeError:
            client = mqtt_client.Client(client_id)

    client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT)
    return client

def publish(client):
    """Periodic background loop publishing health metrics every 5 seconds."""
    while True:
        send_all_metrics(client)
        time.sleep(5)

def run():
    load_fan_config()
    client = connect_mqtt()
    client.loop_start()
    publish(client)
    client.loop_stop()

if __name__ == '__main__':
    run()