sudo apt install supervisor
sudo mkdir /opt/picloud-node/

.... after pushing script to /opt/picloud-node ...

sudo chmod +x /opt/picloud-node/stats.py
sudo chown -R pi:pi /opt/picloud-node

sudo systemctl restart supervisor

sudo supervisorctl status picloud-node-mqtt
sudo supervisorctl tail picloud-node-mqtt