#!/usr/bin/env python3

import os
import json
import time
import socket
import psutil
import platform
import threading
import subprocess
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

def get_poe_fan_state():
    """Reads PoE HAT fan level (0=off, 1=low, 2=med, 3=high, 4=max)."""
    for path in [
        "/sys/class/thermal/cooling_device0/cur_state",
        "/sys/class/hwmon/hwmon0/pwm1",
    ]:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    return int(f.read().strip())
            except Exception:
                pass
    return 0

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
    fan_state = get_poe_fan_state()
    zram = get_zram_stats()

    # Active logged in sessions (e.g. students on SSH)
    try:
        active_users = len([u for u in psutil.users() if u.terminal])
    except Exception:
        active_users = 0

    uptime_sec = int(time.time() - psutil.boot_time())

    poe = parse_uevent_file(POE_UEVENT_FILE)
    current_watts = poe.get("current_watts", 0.0) if poe else 0.0
    energy_wh = update_energy(current_watts)

    metrics = {
        "hostname": hostname,
        "ip": ip_addr,
        "uptime_seconds": uptime_sec,
        "active_users": active_users,
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
    client = connect_mqtt()
    client.loop_start()
    publish(client)
    client.loop_stop()

if __name__ == '__main__':
    run()