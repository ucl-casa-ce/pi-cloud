#!/usr/bin/env python3

import random
import time
from paho.mqtt import client as mqtt_client
import os
import socket
import psutil
import platform
import subprocess
from dotenv import load_dotenv
from gpiozero import CPUTemperature
from subprocess import call

load_dotenv()

CONNECTED = 0

# Load MQTT credentials from environment variables
MQTT_HOST = os.getenv("MQTT_HOST")
MQTT_PORT = int(os.getenv("MQTT_PORT"))
MQTT_USER = os.getenv("MQTT_USER")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")
MQTT_TOPIC_PREFIX = os.getenv("MQTT_TOPIC_PREFIX")

hostname = socket.gethostname()
MQTT_TOPIC_PREFIX = os.getenv("MQTT_TOPIC_PREFIX") + "/" + hostname

# Generate a Client ID with the publish prefix.
client_id = f"pcloud_node_{hostname}"

def parse_uevent_file(uevent_file):
    try:
        output = subprocess.check_output(['cat', uevent_file], text=True)
    except subprocess.CalledProcessError:
        print("Error reading uevent file.")
        return None

    power_supply_info = {}

    for line in output.splitlines():
        key, value = line.split('=')
        key = key.strip()
        value = value.strip()
        power_supply_info[key] = value

    return power_supply_info

# Function to send CPU metrics
def send_cpu_metrics(client, topic):
    cpu_percent = psutil.cpu_percent(interval=1)
    client.publish(topic, f"{cpu_percent}")

# Function to send IP address
def send_ip_address(client, topic):
    host = platform.node()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("1.1.1.1", 80))
    ip_address = s.getsockname()[0]
    client.publish(topic + "_hostname", f"{host}")
    client.publish(topic + "", f"{ip_address}", 0, True)

# Function to send ping status
def send_ping_status(client, topic):
    ping_result = subprocess.run(["ping", "-c", "4", "1.1.1.1"], capture_output=True)
    ping_time = ping_result.stdout.decode().split("\n")[-2].split("/")[-3]
    if ping_result.returncode == 0:
        ping_status = "success"
    else:
        ping_status = "failed"
    client.publish(topic, f"{ping_status}")
    client.publish(topic + "_ms", ping_time)

def send_heartbeat(client, topic):
    client.publish(topic, f"{time.strftime('%H:%M:%S')}", 0, True)
    client.publish(topic + "_ms" , int(time.time() * 1e6), 0, True)

def send_temp(client, topic):
    CPUc = CPUTemperature().temperature
    client.publish(topic, f"{CPUc}")

def send_poe_data(client, topic):
    uevent_file = "/sys/devices/platform/rpi-poe-power-supply/power_supply/rpi-poe/uevent"
    power_supply_data = parse_uevent_file(uevent_file)

    if power_supply_data:
        POWER_SUPPLY_NAME = power_supply_data["POWER_SUPPLY_NAME"]
        POWER_SUPPLY_TYPE = power_supply_data["POWER_SUPPLY_TYPE"]
        POWER_SUPPLY_HEALTH = power_supply_data["POWER_SUPPLY_HEALTH"]
        POWER_SUPPLY_ONLINE = int(power_supply_data["POWER_SUPPLY_ONLINE"])
        POWER_SUPPLY_CURRENT_NOW = int(power_supply_data["POWER_SUPPLY_CURRENT_NOW"])
        POWER_SUPPLY_CURRENT_MAX = int(power_supply_data["POWER_SUPPLY_CURRENT_MAX"])

        POWER_SUPPLY_CURRENT_NOW_A = round(POWER_SUPPLY_CURRENT_NOW * 0.000001, 4)
        POWER_SUPPLY_CURRENT_NOW_W = POWER_SUPPLY_CURRENT_NOW * 0.000001 * 5

        client.publish(topic + "/poe/name", f"{POWER_SUPPLY_NAME}")
        client.publish(topic + "/poe/type", f"{POWER_SUPPLY_TYPE}")
        client.publish(topic + "/poe/health", f"{POWER_SUPPLY_HEALTH}")
        client.publish(topic + "/poe/online", f"{POWER_SUPPLY_ONLINE}")
        client.publish(topic + "/poe/current_now_amps", f"{POWER_SUPPLY_CURRENT_NOW}")
        client.publish(topic + "/poe/current_max_amps", f"{POWER_SUPPLY_CURRENT_MAX}")

        client.publish(topic + "/current_amps", f"{POWER_SUPPLY_CURRENT_NOW_A}")
        client.publish(topic + "/current_watts", f"{POWER_SUPPLY_CURRENT_NOW_W}")

def connect_mqtt():
    def on_connect(client, userdata, flags, rc):
        if rc == 0:
            print("Connected to MQTT Broker!")
            CONNECTED = 1
            print("Subscribing to topic: ", MQTT_TOPIC_PREFIX + "/cmd")
            client.subscribe(MQTT_TOPIC_PREFIX + "/cmd")    
        else:
            print("Failed to connect, return code %d\n", rc)

    def on_disconnect(client, userdata, rc):
        global connected_flag
        connected_flag=False #set flag
        print("disconnected OK")

    def on_message(client, userdata, message):
        print("Message received: ", str(message.payload.decode("utf-8")))
        payload = str(message.payload.decode("utf-8"))
        if message.topic == MQTT_TOPIC_PREFIX + "/cmd":
            print("Received command message: ", payload)
            if payload == "reboot":
                print("Received reboot message, rebooting...")
                call(['shutdown', '-r', 'now'], shell=False) #reboot host
            if payload == "shutdown":
                print("Received shutdown message, shutting down...")
                call(['shutdown', '-h', 'now'], shell=False) #shutdown host

    client = mqtt_client.Client(client_id)
    client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT)
    return client

def publish(client):
    msg_count = 1
    while True:
        send_cpu_metrics(client, MQTT_TOPIC_PREFIX + "/cpu_percent")
        send_ip_address(client, MQTT_TOPIC_PREFIX + "/ip")
        send_ping_status(client, MQTT_TOPIC_PREFIX + "/ping")
        send_heartbeat(client, MQTT_TOPIC_PREFIX + "/heartbeat")
        send_temp(client, MQTT_TOPIC_PREFIX + "/temp_c" )
        send_poe_data(client, MQTT_TOPIC_PREFIX)
        time.sleep(5)

def run():
    client = connect_mqtt()
    client.loop_start()
    publish(client)
    client.loop_stop()

if __name__ == '__main__':
    run()