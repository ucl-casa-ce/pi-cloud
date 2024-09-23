# PiCloud Cluster
## Resources for the Pi Cloud Cluster in the CE Lab to support teaching. 

This repository provides the resources for setting up and managing a 48-node Raspberry Pi cluster designed for students in Connected Environments programme. This cluster empowers students to:

**Develop code:** Utilize the cluster's processing power to write and test code for their projects.
**Store data:** Securely store their project data on the cluster for collaboration and access across sessions.
**Learn distributed systems:** Gain hands-on experience with distributed computing concepts.

![Pis On the Desk](./images/pis-poe-on-desk.png)

## Getting Started
This repository contains the following resources to help you set up and manage your Pi-Cloud:

**Design Files:** Schematics or diagrams outlining the hardware layout of the cluster.
**Ansible Playbooks:** Playbooks automate software configuration and deployment across the Raspberry Pi nodes. These playbooks can be used to:
   - Install the desired operating system (e.g., Raspbian Bookworm)
   - Configure network settings
   - Set up user accounts and permissions
   - Install additional software packages

## Prerequisites:

- Familiarity with Raspberry Pi and Linux administration.
- An SSH client for connecting to the Raspberry Pi nodes.

## Deployment Steps

**Hardware Setup:** 
Software Installation: Prepare your preferred SD card image (e.g., Raspbian Bookworm).
 - Flash the image onto SD cards for each Raspberry Pi.
 - Boot the Raspberry Pis.
 - Configure network settings on the switch to assign IP address for each pi or use network management tools.

**Ansible Configuration:**
- Install Ansible on a control machine.
   - ```brew install ansible```
   - ```brew install ansible-link```
   - ```brew install hudochenkov/sshpass/sshpass```    
- Configure Ansible inventory file to list the Raspberry Pi nodes.
- Run the Ansible playbooks to automate software installation and configuration across all nodes. See Ansible README for more information
   - ```ansible-playbook tasks/utils/reboot.yml --check```    

**Custom Scripts:** This sections provides various utilites to allow communication and control of each pi in the cluster.
- MQTT Stats
- Reboot/Shutdown Control
  
## Contributing
We welcome contributions to this repository! This can include:

  - Adding new Ansible playbooks for specific software packages.
  - Developing additional bash scripts for managing the cluster.

Please refer to the CONTRIBUTING.md file for more information on how to contribute.

## Disclaimer
This repository is provided for educational purposes only. We are not responsible for any hardware or software issues that may arise during the setup or operation of the Pi-Cloud cluster.
