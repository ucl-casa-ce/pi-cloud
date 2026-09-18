/**
 * PiCloud Digital Twin - 3D Three.js Wall Engine
 * Renders an interactive 8-column x 6-row physical wall matrix of 48 Raspberry Pis
 * with dynamic thermal heatmap shading, spinning PoE fans, tactical locator reticle FX,
 * shelf MQTT telemetry pulse rings, and visual reactions for REBOOTING and OFFLINE states.
 */

export class PiCloudTwin3D {
  constructor(containerElement, onSelectNodeCallback) {
    this.container = containerElement;
    this.onSelectNode = onSelectNodeCallback;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this.piMeshes = new Map(); // hostname -> { group, pcbMesh, poeMesh, fanMesh, pwrLed, actLed, mqttPulseMesh, mqttCoreMesh, rebootSpinner, rebootMat, labelSprite, rippleMesh, auraMesh, data, lastStatus }
    this.hoveredNode = null;
    this.selectedNode = null;
    this.clock = new THREE.Clock();

    this.colorMode = 'off'; // 'off' | 'temp' | 'cpu' | 'power'
    this.isZoomedIn = false;

    this.init();
  }

  init() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || 500;

    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0d14);
    this.scene.fog = new THREE.FogExp2(0x0a0d14, 0.015);

    // 2. Camera setup
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this.camera.position.set(0, 5, 28);

    // 3. Renderer setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // 4. OrbitControls
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxDistance = 55;
    this.controls.minDistance = 3;
    this.controls.target.set(0, 5.5, 0);

    // 5. Lighting
    this.setupLighting();

    // 6. Environment & Rack Shelves
    this.buildServerRackFrame();

    // 7. Construct 48 Raspberry Pi 3D Models
    this.build48PiNodes();

    // 8. Event Listeners
    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.renderer.domElement.addEventListener('mousemove', this.onMouseMove.bind(this));
    this.renderer.domElement.addEventListener('click', this.onClick.bind(this));

    // 9. Start Animation Loop
    this.animate();
  }

  setupLighting() {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(15, 20, 20);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    this.scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.6);
    rimLight.position.set(-15, -5, -10);
    this.scene.add(rimLight);

    const topFill = new THREE.DirectionalLight(0x818cf8, 0.4);
    topFill.position.set(0, 25, 5);
    this.scene.add(topFill);
  }

  buildServerRackFrame() {
    const gridHelper = new THREE.GridHelper(50, 50, 0x334155, 0x1e293b);
    gridHelper.position.y = -1.5;
    this.scene.add(gridHelper);

    const chassisMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.8,
      metalness: 0.6
    });

    const shelfWidth = 28.8;

    for (let r = 0; r < 6; r++) {
      const y = r * 2.3 + 0.15;
      const shelfGeom = new THREE.BoxGeometry(shelfWidth, 0.12, 1.8);
      const shelf = new THREE.Mesh(shelfGeom, chassisMat);
      shelf.position.set(0, y, -0.2);
      shelf.receiveShadow = true;
      this.scene.add(shelf);
    }

    // 5 vertical support beams (outer left, 3 bay dividers, outer right)
    // separating each shelf into 4 equal bays of 2 Pis each
    [-14.4, -7.2, 0.0, 7.2, 14.4].forEach((x) => {
      const postGeom = new THREE.BoxGeometry(0.35, 15, 1.8);
      const post = new THREE.Mesh(postGeom, chassisMat);
      post.position.set(x, 6, -0.2);
      post.receiveShadow = true;
      this.scene.add(post);
    });
  }

  getNodeX(c) {
    // 4 equal bays of 2 Pis per shelf (8 Pis total), evenly spaced:
    // Bay 0 (cols 0, 1): center = -10.8
    // Bay 1 (cols 2, 3): center = -3.6
    // Bay 2 (cols 4, 5): center = +3.6
    // Bay 3 (cols 6, 7): center = +10.8
    const bay = Math.floor(c / 2); // 0, 1, 2, 3
    const bayIndex = c % 2; // 0 or 1
    const bayCenter = (bay - 1.5) * 7.2;
    const dx = 2.8;

    return bayIndex === 0 ? bayCenter - dx / 2 : bayCenter + dx / 2;
  }

  build48PiNodes() {
    const COLS = 8;
    const ROWS = 6;
    const SPACING_Y = 2.3;
    const START_Y = 0.5;

    let nodeIndex = 1;

    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        const hostname = `picloud-${nodeIndex}`;
        const x = this.getNodeX(c);
        const y = START_Y + r * SPACING_Y;
        const z = 0;

        const piGroup = this.createSinglePiMesh(hostname, nodeIndex);
        piGroup.position.set(x, y, z);
        this.scene.add(piGroup);

        nodeIndex++;
      }
    }
  }

  createSinglePiMesh(hostname, id) {
    const group = new THREE.Group();
    group.name = hostname;
    group.userData = { hostname, id };

    // 1. PCB Mainboard
    const pcbWidth = 2.3;
    const pcbHeight = 0.1;
    const pcbDepth = 1.5;
    const pcbGeom = new THREE.BoxGeometry(pcbWidth, pcbHeight, pcbDepth);
    const pcbMat = new THREE.MeshStandardMaterial({
      color: 0x10b981,
      roughness: 0.35,
      metalness: 0.1,
      emissive: 0x047857,
      emissiveIntensity: 0.05
    });
    const pcbMesh = new THREE.Mesh(pcbGeom, pcbMat);
    pcbMesh.castShadow = true;
    pcbMesh.receiveShadow = true;
    pcbMesh.userData = { hostname, id };
    group.add(pcbMesh);

    // 2. Ethernet Jack
    const ethGeom = new THREE.BoxGeometry(0.55, 0.45, 0.6);
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0xcfd8dc,
      metalness: 0.85,
      roughness: 0.25
    });
    const ethMesh = new THREE.Mesh(ethGeom, metalMat);
    ethMesh.position.set(pcbWidth / 2 - 0.35, pcbHeight / 2 + 0.22, pcbDepth / 2 - 0.35);
    group.add(ethMesh);

    // 3. USB Ports
    [-0.2, 0.35].forEach((offsetZ) => {
      const usbGeom = new THREE.BoxGeometry(0.45, 0.45, 0.45);
      const usbMesh = new THREE.Mesh(usbGeom, metalMat);
      usbMesh.position.set(pcbWidth / 2 - 0.9, pcbHeight / 2 + 0.22, offsetZ);
      group.add(usbMesh);
    });

    // 4. Broadcom SoC
    const cpuGeom = new THREE.BoxGeometry(0.5, 0.06, 0.5);
    const cpuMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.5,
      metalness: 0.4
    });
    const cpuMesh = new THREE.Mesh(cpuGeom, cpuMat);
    cpuMesh.position.set(-0.2, pcbHeight / 2 + 0.03, 0);
    group.add(cpuMesh);

    // 5. PoE HAT board
    const poeGeom = new THREE.BoxGeometry(1.8, 0.06, 1.35);
    const poeMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.5,
      metalness: 0.3
    });
    const poeMesh = new THREE.Mesh(poeGeom, poeMat);
    poeMesh.position.set(-0.1, 0.45, 0);
    poeMesh.castShadow = true;
    group.add(poeMesh);

    // Brass standoffs
    const standoffGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8);
    const standoffMat = new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.8, roughness: 0.2 });
    [
      [-0.9, -0.55],
      [-0.9, 0.55],
      [0.7, -0.55],
      [0.7, 0.55]
    ].forEach(([sx, sz]) => {
      const standoff = new THREE.Mesh(standoffGeom, standoffMat);
      standoff.position.set(sx, 0.25, sz);
      group.add(standoff);
    });

    // 6. PoE Cooling Fan
    const fanRingGeom = new THREE.TorusGeometry(0.35, 0.04, 8, 24);
    const fanRingMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const fanRing = new THREE.Mesh(fanRingGeom, fanRingMat);
    fanRing.rotation.x = Math.PI / 2;
    fanRing.position.set(-0.1, 0.5, 0);
    group.add(fanRing);

    const fanBladesGeom = new THREE.BoxGeometry(0.65, 0.01, 0.1);
    const fanBladesMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    const fanMesh = new THREE.Mesh(fanBladesGeom, fanBladesMat);
    fanMesh.position.set(-0.1, 0.51, 0);
    group.add(fanMesh);

    // 7. Power & Activity LEDs
    const ledGeom = new THREE.SphereGeometry(0.05, 8, 8);
    const pwrLedMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    const pwrLed = new THREE.Mesh(ledGeom, pwrLedMat);
    pwrLed.position.set(-1.0, 0.12, 0.65);
    group.add(pwrLed);

    const actLedMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
    const actLed = new THREE.Mesh(ledGeom, actLedMat);
    actLed.position.set(-0.85, 0.12, 0.65);
    group.add(actLed);

    // 8. MQTT Telemetry Ping Pulse (Shelf surface under Pi - balanced visibility)
    const mqttPulseGeom = new THREE.RingGeometry(0.45, 0.95, 48);
    const mqttPulseMat = new THREE.MeshBasicMaterial({
      color: 0x00d2ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const mqttPulseMesh = new THREE.Mesh(mqttPulseGeom, mqttPulseMat);
    mqttPulseMesh.rotation.x = -Math.PI / 2;
    mqttPulseMesh.position.set(0, -0.26, 0);
    group.add(mqttPulseMesh);

    // Inner glowing flash disc directly under the board on the shelf
    const mqttCoreGeom = new THREE.CircleGeometry(0.95, 32);
    const mqttCoreMat = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const mqttCoreMesh = new THREE.Mesh(mqttCoreGeom, mqttCoreMat);
    mqttCoreMesh.rotation.x = -Math.PI / 2;
    mqttCoreMesh.position.set(0, -0.265, 0);
    group.add(mqttCoreMesh);

    // 9. Status Orbital Spinner Arc (Standing upright at 90 deg above Pi, facing front like a loading symbol)
    // Raised to y = 1.05 for clean air gap above PoE fan (fan top at y=0.54)
    const rebootGeom = new THREE.RingGeometry(0.24, 0.35, 32, 1, 0, Math.PI * 1.55);
    const rebootMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const rebootSpinner = new THREE.Mesh(rebootGeom, rebootMat);
    // Upright 90 degrees to Pi: facing front camera (rotation.x = 0)
    rebootSpinner.position.set(0, 1.05, 0);
    group.add(rebootSpinner);

    // 10. Online recovery ripple ring (hidden by default)
    const rippleGeom = new THREE.RingGeometry(0.5, 0.7, 32);
    const rippleMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    });
    const rippleMesh = new THREE.Mesh(rippleGeom, rippleMat);
    rippleMesh.rotation.x = -Math.PI / 2;
    rippleMesh.position.set(0, 0.1, 0);
    group.add(rippleMesh);

    // 11. Thermal glow aura plate on shelf
    const auraGeom = new THREE.PlaneGeometry(2.9, 2.0);
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0x06b6d4,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    });
    const auraMesh = new THREE.Mesh(auraGeom, auraMat);
    auraMesh.rotation.x = -Math.PI / 2;
    auraMesh.position.set(0, -0.05, 0);
    group.add(auraMesh);

    // 12. Hostname and metric value tag (proud of shelf to avoid geometry clipping)
    const labelSprite = this.createLabelSprite(`#${id}`, 'offline');
    labelSprite.position.set(0, -0.08, 1.25);
    group.add(labelSprite);

    this.piMeshes.set(hostname, {
      group,
      pcbMesh,
      poeMesh,
      fanMesh,
      pwrLed,
      actLed,
      mqttPulseMesh,
      mqttCoreMesh,
      rebootSpinner,
      rebootMat,
      rippleMesh,
      labelSprite,
      auraMesh,
      data: null,
      lastStatus: 'offline',
      isIdentifyingActive: false,
      rippleScale: 0,
      mqttPulseScale: 0,
      mqttPulseOpacity: 0,
      mqttFlash: 0
    });

    return group;
  }

  getThermalHexColor(temp) {
    if (!temp || temp < 40) return '#06b6d4';
    if (temp < 50) return '#10b981';
    if (temp < 65) return '#f59e0b';
    return '#ef4444';
  }

  getCpuHexColor(cpu) {
    if (cpu < 25) return '#10b981';
    else if (cpu < 50) return '#06b6d4';
    else if (cpu < 75) return '#f59e0b';
    return '#ef4444';
  }

  getPowerHexColor(watts) {
    if (!watts || watts < 2.5) return '#06b6d4';
    if (watts < 4.5) return '#10b981';
    if (watts < 7.0) return '#f59e0b';
    return '#ef4444';
  }

  createLabelSprite(text, status, metricColor = '#38bdf8') {
    // Measure text width dynamically to ensure zero clipping inside badge
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    measureCtx.font = 'bold 20px Inter, system-ui, -apple-system, sans-serif';
    const textWidth = measureCtx.measureText(text).width;

    const canvasWidth = Math.max(220, Math.ceil(textWidth + 44));
    const canvasHeight = 64;

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    let borderColor = metricColor;
    let bgColor = 'rgba(15, 23, 42, 0.92)';
    let textColor = '#ffffff';

    if (status === 'offline') {
      borderColor = '#64748b';
      bgColor = 'rgba(30, 41, 59, 0.88)';
      textColor = '#94a3b8';
    } else if (status === 'rebooting') {
      borderColor = '#f59e0b';
      bgColor = 'rgba(120, 53, 15, 0.92)';
      textColor = '#fbbf24';
    } else if (status === 'shutdown') {
      borderColor = '#ef4444';
      bgColor = 'rgba(127, 29, 29, 0.92)';
      textColor = '#fca5a5';
    } else if (status === 'identifying') {
      borderColor = '#0284c7';
      bgColor = 'rgba(12, 74, 110, 0.95)';
      textColor = '#38bdf8';
    }

    ctx.fillStyle = bgColor;
    ctx.roundRect(4, 4, canvasWidth - 8, canvasHeight - 8, 12);
    ctx.fill();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3.5;
    ctx.stroke();

    ctx.font = 'bold 20px Inter, system-ui, -apple-system, sans-serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvasWidth / 2, canvasHeight / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false // Renders cleanly on top without depth clipping
    });
    const sprite = new THREE.Sprite(spriteMat);
    const aspect = canvasWidth / canvasHeight;
    sprite.scale.set(0.44 * aspect, 0.44, 1);
    sprite.renderOrder = 999;
    return sprite;
  }

  updateLabelSprite(nodeObj, id, status, data) {
    const isIdentifying = data?.identifying_until && data.identifying_until > Date.now();
    let labelText = `#${id}`;
    let metricColor = '#38bdf8';
    let labelStatus = status;

    if (isIdentifying) {
      labelText = `🎯 #${id} LOCATE`;
      metricColor = '#00d2ff';
      labelStatus = 'identifying';
    } else if (status === 'rebooting') {
      labelText = `🔄 #${id}`;
      metricColor = '#f59e0b';
    } else if (status === 'shutdown') {
      labelText = `🛑 #${id}`;
      metricColor = '#ef4444';
    } else if (status === 'offline') {
      labelText = `❌ #${id}`;
      metricColor = '#64748b';
    } else if (this.colorMode === 'off') {
      labelText = `#${id}`;
      metricColor = '#22c55e';
    } else if (data) {
      if (this.colorMode === 'cpu') {
        const c = typeof data.cpu_percent === 'number' ? `${data.cpu_percent.toFixed(1)}%` : `${data.cpu_percent || 0}%`;
        labelText = `#${id}  ${c}`;
        metricColor = this.getCpuHexColor(data.cpu_percent);
      } else if (this.colorMode === 'power') {
        const wattsVal = data.poe?.current_watts;
        const w = typeof wattsVal === 'number' ? `${wattsVal.toFixed(1)}W` : `${wattsVal || 0}W`;
        labelText = `#${id}  ${w}`;
        metricColor = this.getPowerHexColor(wattsVal);
      } else if (this.colorMode === 'temp') {
        const tVal = data.temp_c;
        const t = typeof tVal === 'number' ? `${tVal.toFixed(1)}°C` : (tVal ? `${tVal}°C` : '--');
        labelText = `#${id}  ${t}`;
        metricColor = this.getThermalHexColor(data.temp_c);
      }
    }

    const newSprite = this.createLabelSprite(labelText, labelStatus, metricColor);
    newSprite.position.copy(nodeObj.labelSprite.position);
    nodeObj.group.remove(nodeObj.labelSprite);
    nodeObj.labelSprite = newSprite;
    nodeObj.group.add(newSprite);
  }

  updateNodeData(hostname, data) {
    const nodeObj = this.piMeshes.get(hostname);
    if (!nodeObj) return;

    const previousStatus = nodeObj.data ? nodeObj.data.status : 'offline';
    nodeObj.data = data;
    const currentStatus = data.status || 'offline';
    const temp = data.temp_c || 0;
    const cpu = data.cpu_percent || 0;
    const isIdentifying = data.identifying_until && data.identifying_until > Date.now();

    // Trigger green ripple wave on offline/rebooting/shutdown -> online transition!
    if ((previousStatus === 'offline' || previousStatus === 'rebooting' || previousStatus === 'shutdown') && currentStatus === 'online') {
      nodeObj.rippleScale = 0.1;
      nodeObj.rippleMesh.material.opacity = 1.0;
    }

    // ==========================================
    // 1. STATE-BASED SHADING & MATERIALS
    // ==========================================
    if (currentStatus === 'offline') {
      // OFFLINE: Dark muted slate grey, zero glow, LEDs off, aura dark
      nodeObj.pcbMesh.material.color.setHex(0x334155);
      nodeObj.pcbMesh.material.emissive.setHex(0x000000);
      nodeObj.pcbMesh.material.emissiveIntensity = 0;
      nodeObj.actLed.material.color.setHex(0x0a0a0a); // unlit
      nodeObj.pwrLed.material.color.setHex(0x3b0707); // very dim red
      nodeObj.rebootMat.opacity = 0;
      if (nodeObj.auraMesh) nodeObj.auraMesh.material.opacity = 0;
    } else if (currentStatus === 'rebooting') {
      // REBOOTING: Pulsing amber/orange material, flashing amber ACT LED, orbital reboot spinner
      nodeObj.pcbMesh.material.color.setHex(0xd97706);
      nodeObj.pcbMesh.material.emissive.setHex(0xf59e0b);
      nodeObj.pcbMesh.material.emissiveIntensity = 0.45;
      nodeObj.actLed.material.color.setHex(0xf59e0b);
      nodeObj.pwrLed.material.color.setHex(0xef4444);

      nodeObj.rebootMat.color.setHex(0xf59e0b);
      nodeObj.rebootMat.opacity = 0.95;
      if (nodeObj.auraMesh) {
        nodeObj.auraMesh.material.color.setHex(0xf59e0b);
        nodeObj.auraMesh.material.opacity = 0.45;
      }
    } else if (currentStatus === 'shutdown') {
      // SHUTDOWN: Red loading spinner arc and red pulsing glow (mirrors reboot in red)
      nodeObj.pcbMesh.material.color.setHex(0xb91c1c);
      nodeObj.pcbMesh.material.emissive.setHex(0xef4444);
      nodeObj.pcbMesh.material.emissiveIntensity = 0.45;
      nodeObj.actLed.material.color.setHex(0xef4444);
      nodeObj.pwrLed.material.color.setHex(0xef4444);

      nodeObj.rebootMat.color.setHex(0xef4444);
      nodeObj.rebootMat.opacity = 0.95;
      if (nodeObj.auraMesh) {
        nodeObj.auraMesh.material.color.setHex(0xef4444);
        nodeObj.auraMesh.material.opacity = 0.45;
      }
    } else {
      // ONLINE or WARNING
      nodeObj.rebootMat.opacity = 0;
      nodeObj.pwrLed.material.color.setHex(0xef4444);

      if (this.colorMode === 'off') {
        // Shading OFF: Standard Pi green PCB, no shelf thermal aura
        nodeObj.pcbMesh.material.color.setHex(0x15803d);
        if (nodeObj.auraMesh) {
          nodeObj.auraMesh.material.opacity = 0;
        }

        if (data.power_and_hardware?.throttled?.healthy === false) {
          nodeObj.pcbMesh.material.emissive.setHex(0xd97706);
          nodeObj.pcbMesh.material.emissiveIntensity = 0.35;
        } else {
          nodeObj.pcbMesh.material.emissive.setHex(0x000000);
          nodeObj.pcbMesh.material.emissiveIntensity = 0;
        }
      } else {
        // Shading ON: Dynamic Heatmap / CPU / Power
        let targetColor = new THREE.Color(0x10b981);

        if (this.colorMode === 'cpu') {
          if (cpu < 25) targetColor.setHex(0x10b981);
          else if (cpu < 50) targetColor.setHex(0x06b6d4);
          else if (cpu < 75) targetColor.setHex(0xf59e0b);
          else targetColor.setHex(0xef4444);
        } else if (this.colorMode === 'power') {
          const watts = data.poe?.current_watts || 2.0;
          if (watts < 2.5) targetColor.setHex(0x06b6d4);
          else if (watts < 4.5) targetColor.setHex(0x10b981);
          else if (watts < 7.0) targetColor.setHex(0xf59e0b);
          else targetColor.setHex(0xef4444);
        } else {
          // Thermal Heatmap (High contrast gradient)
          if (temp < 40) targetColor.setHex(0x06b6d4);
          else if (temp < 50) targetColor.setHex(0x10b981);
          else if (temp < 65) targetColor.setHex(0xf59e0b);
          else targetColor.setHex(0xef4444);
        }

        nodeObj.pcbMesh.material.color.copy(targetColor);

        // Glowing aura plate on shelf beneath the node
        if (nodeObj.auraMesh) {
          nodeObj.auraMesh.material.color.copy(targetColor);
          nodeObj.auraMesh.material.opacity = this.colorMode === 'temp' ? 0.45 : 0.35;
        }

        if (data.power_and_hardware?.throttled?.healthy === false) {
          nodeObj.pcbMesh.material.emissive.setHex(0xd97706);
          nodeObj.pcbMesh.material.emissiveIntensity = 0.35;
        } else {
          nodeObj.pcbMesh.material.emissive.copy(targetColor);
          nodeObj.pcbMesh.material.emissiveIntensity = 0.15;
        }
      }

      // Identify Strobe Setup (Electric Blue)
      if (isIdentifying) {
        nodeObj.actLed.material.color.setHex(0x00d2ff);
        if (nodeObj.auraMesh) {
          nodeObj.auraMesh.material.color.setHex(0x00d2ff);
          nodeObj.auraMesh.material.opacity = 0.85;
        }
      } else {
        nodeObj.actLed.material.color.setHex(0x22c55e);
      }
    }

    // Always update the 3D label sprite to reflect live metric & status
    this.updateLabelSprite(nodeObj, nodeObj.group.userData.id, currentStatus, data);
  }

  updateAllNodes(nodesMap) {
    for (const [hostname, data] of Object.entries(nodesMap)) {
      this.updateNodeData(hostname, data);
    }
  }

  triggerMqttPulse(hostname) {
    const item = this.piMeshes.get(hostname);
    if (!item || !item.mqttPulseMesh) return;
    item.mqttPulseScale = 1.0;
    item.mqttPulseOpacity = 1.0;
    item.mqttFlash = 1.0;
    item.mqttPulseMesh.scale.set(1.0, 1.0, 1);
    item.mqttPulseMesh.material.opacity = 1.0;
    if (item.mqttCoreMesh) {
      item.mqttCoreMesh.material.opacity = 0.75;
    }
  }

  onMouseMove(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const interactables = [];
    this.piMeshes.forEach((item) => interactables.push(item.pcbMesh));

    const intersects = this.raycaster.intersectObjects(interactables);
    const tooltip = document.getElementById('twin-tooltip');

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const hostname = hit.userData.hostname;
      const nodeObj = this.piMeshes.get(hostname);

      if (this.hoveredNode !== hostname) {
        if (this.hoveredNode && this.piMeshes.get(this.hoveredNode)) {
          this.piMeshes.get(this.hoveredNode).group.scale.set(1, 1, 1);
        }
        this.hoveredNode = hostname;
        nodeObj.group.scale.set(1.06, 1.06, 1.06);
      }

      if (tooltip && nodeObj.data) {
        const d = nodeObj.data;
        const statusIcon = d.status === 'online' ? '🟢 Online' : d.status === 'rebooting' ? '🔄 Rebooting...' : d.status === 'shutdown' ? '🛑 Shutting down...' : d.status === 'warning' ? '🟡 Warning' : '❌ Offline';
        const statusColor = d.status === 'online' ? 'text-emerald-400' : d.status === 'rebooting' ? 'text-amber-400' : d.status === 'shutdown' ? 'text-rose-400' : d.status === 'warning' ? 'text-amber-400' : 'text-slate-400';

        // Modal tooltip respects whether shading is on or off
        let modeHighlight = '';
        if (this.colorMode === 'off') {
          modeHighlight = '';
        } else if (this.colorMode === 'cpu') {
          modeHighlight = `
            <div class="mt-2 p-1.5 rounded bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-between font-mono">
              <span class="text-indigo-300 font-sans font-semibold">Active Shading (CPU):</span>
              <span class="text-white font-bold text-sm">${d.cpu_percent || 0}%</span>
            </div>
          `;
        } else if (this.colorMode === 'power') {
          modeHighlight = `
            <div class="mt-2 p-1.5 rounded bg-amber-500/15 border border-amber-500/30 flex items-center justify-between font-mono">
              <span class="text-amber-300 font-sans font-semibold">Active Shading (Power):</span>
              <span class="text-white font-bold text-sm">${d.poe?.current_watts || 0} W</span>
            </div>
          `;
        } else if (this.colorMode === 'temp') {
          const tColor = this.getThermalHexColor(d.temp_c);
          modeHighlight = `
            <div class="mt-2 p-1.5 rounded bg-sky-500/15 border border-sky-500/30 flex items-center justify-between font-mono">
              <span class="text-sky-300 font-sans font-semibold">Active Shading (Heat):</span>
              <span class="font-bold text-sm" style="color: ${tColor}">${d.temp_c ? d.temp_c + '°C' : 'N/A'}</span>
            </div>
          `;
        }

        tooltip.innerHTML = `
          <div class="font-bold flex items-center justify-between gap-2 border-b border-slate-800 pb-1.5 mb-1.5">
            <span class="text-sky-400 font-mono">${d.hostname} (#${d.node_id})</span>
            <span class="text-[11px] font-medium ${statusColor}">${statusIcon}</span>
          </div>
          <div class="text-xs text-slate-300 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
            <span>🌡️ Temp: <b class="text-white">${d.temp_c || '--'}°C</b></span>
            <span>⚡ Power: <b class="text-white">${d.poe?.current_watts || 0}W</b></span>
            <span>🧠 CPU: <b class="text-white">${d.cpu_percent || 0}%</b></span>
            <span>⏱️ Ping: <b class="text-white">${d.network?.ping_ms || '--'}ms</b></span>
          </div>
          ${modeHighlight}
          ${d.status === 'rebooting' ? '<div class="mt-1.5 text-[10px] text-amber-300 font-semibold bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">🔄 Reboot in progress...</div>' : ''}
          ${d.status === 'shutdown' ? '<div class="mt-1.5 text-[10px] text-rose-300 font-semibold bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">🛑 Shutting down...</div>' : ''}
          ${d.status === 'offline' ? '<div class="mt-1.5 text-[10px] text-rose-300 font-semibold bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">❌ Offline (No heartbeat)</div>' : ''}
        `;

        // Calculate relative coordinates inside the 3D container
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;

        const tipWidth = tooltip.offsetWidth || 230;
        const tipHeight = tooltip.offsetHeight || 140;

        // Horizontal: default 16px to right of cursor; flip to left if near container right edge
        let tipLeft = localX + 16;
        if (tipLeft + tipWidth > rect.width - 15) {
          tipLeft = localX - tipWidth - 16;
        }
        tipLeft = Math.max(10, Math.min(tipLeft, rect.width - tipWidth - 10));

        // Vertical: if hovering bottom half/shelves or if tip would clip, flip ABOVE cursor!
        let tipTop = localY - tipHeight / 2;
        if (localY > rect.height * 0.52 || tipTop + tipHeight > rect.height - 15) {
          tipTop = localY - tipHeight - 12;
        }
        if (tipTop < 10) {
          tipTop = localY + 16;
        }
        tipTop = Math.max(10, Math.min(tipTop, rect.height - tipHeight - 10));

        tooltip.style.left = `${tipLeft}px`;
        tooltip.style.top = `${tipTop}px`;
        tooltip.classList.remove('hidden');
      }
    } else {
      if (this.hoveredNode && this.piMeshes.get(this.hoveredNode)) {
        this.piMeshes.get(this.hoveredNode).group.scale.set(1, 1, 1);
      }
      this.hoveredNode = null;
      if (tooltip) tooltip.classList.add('hidden');
    }
  }

  onClick() {
    if (this.hoveredNode && this.onSelectNode) {
      const nodeObj = this.piMeshes.get(this.hoveredNode);
      if (nodeObj && nodeObj.data) {
        this.onSelectNode(nodeObj.data);
      }
    }
  }

  setCameraPreset(presetName) {
    if (!this.controls) return;

    if (presetName === 'front') {
      this.isZoomedIn = false;
      gsapFly(this.camera.position, { x: 0, y: 6.5, z: 27 }, 1.0);
      gsapFly(this.controls.target, { x: 0, y: 6.5, z: 0 }, 1.0);
    } else if (presetName === 'iso') {
      this.isZoomedIn = false;
      gsapFly(this.camera.position, { x: 22, y: 14, z: 24 }, 1.2);
      gsapFly(this.controls.target, { x: 0, y: 5.5, z: 0 }, 1.2);
    } else if (presetName === 'top') {
      this.isZoomedIn = false;
      gsapFly(this.camera.position, { x: 0, y: 32, z: 4 }, 1.2);
      gsapFly(this.controls.target, { x: 0, y: 5.5, z: 0 }, 1.2);
    } else if (presetName === 'hot') {
      let hottest = null;
      let maxT = -1;
      this.piMeshes.forEach((item) => {
        if (item.data && item.data.status !== 'offline' && item.data.temp_c > maxT) {
          maxT = item.data.temp_c;
          hottest = item;
        }
      });
      if (hottest) {
        this.isZoomedIn = true;
        const p = hottest.group.position;
        gsapFly(this.camera.position, { x: p.x, y: p.y + 1, z: p.z + 5 }, 1.2);
        gsapFly(this.controls.target, { x: p.x, y: p.y, z: p.z }, 1.2);
        if (this.onSelectNode && hottest.data) this.onSelectNode(hottest.data);
      }
    }
  }

  focusNode(hostname) {
    const nodeObj = this.piMeshes.get(hostname);
    if (!nodeObj) return;
    this.isZoomedIn = true;
    const p = nodeObj.group.position;
    gsapFly(this.camera.position, { x: p.x, y: p.y + 0.8, z: p.z + 4.5 }, 1.0);
    gsapFly(this.controls.target, { x: p.x, y: p.y, z: p.z }, 1.0);
  }

  resetView() {
    this.isZoomedIn = false;
    gsapFly(this.camera.position, { x: 0, y: 6.0, z: 28 }, 1.0);
    gsapFly(this.controls.target, { x: 0, y: 5.5, z: 0 }, 1.0);
  }

  onWindowResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  animate() {
    requestAnimationFrame(this.animate.bind(this));

    const delta = this.clock.getDelta();

    this.piMeshes.forEach((item) => {
      const status = item.data?.status || 'offline';

      // Fans only spin if online or warning and fan_state > 0
      if (status === 'online' || status === 'warning') {
        const fanState = item.data?.power_and_hardware?.fan_state ?? 0;
        if (fanState > 0) {
          const speed = fanState * 8.0;
          item.fanMesh.rotation.y += speed * delta;
        }
      }

      // Rebooting (amber) or Shutdown (red) orbital spinner & pulsing glow
      if (status === 'rebooting') {
        item.pcbMesh.material.emissiveIntensity = 0.35 + Math.sin(Date.now() * 0.008) * 0.25;
        item.actLed.material.color.setHex(Math.sin(Date.now() * 0.012) > 0 ? 0xf59e0b : 0x000000);
        item.rebootSpinner.rotation.z -= delta * 5.5;
      } else if (status === 'shutdown') {
        item.pcbMesh.material.emissiveIntensity = 0.35 + Math.sin(Date.now() * 0.008) * 0.25;
        item.actLed.material.color.setHex(Math.sin(Date.now() * 0.012) > 0 ? 0xef4444 : 0x000000);
        item.rebootSpinner.rotation.z -= delta * 5.5;
      }

      // Online Recovery Ripple Wave animation
      if (item.rippleScale > 0) {
        item.rippleScale += delta * 2.5;
        item.rippleMesh.scale.set(item.rippleScale, item.rippleScale, 1);
        item.rippleMesh.material.opacity = Math.max(0, 1.0 - item.rippleScale / 3.0);
        if (item.rippleScale > 3.0) {
          item.rippleScale = 0;
          item.rippleMesh.material.opacity = 0;
        }
      }

      // MQTT Telemetry Pulse Ping Ring animation (shelf surface under Pi - balanced size)
      if (item.mqttPulseOpacity > 0) {
        item.mqttPulseScale += delta * 2.2;
        item.mqttPulseOpacity -= delta * 1.4;
        if (item.mqttPulseOpacity <= 0) {
          item.mqttPulseOpacity = 0;
          item.mqttPulseMesh.material.opacity = 0;
          if (item.mqttCoreMesh) item.mqttCoreMesh.material.opacity = 0;
        } else {
          item.mqttPulseMesh.scale.set(item.mqttPulseScale, item.mqttPulseScale, 1);
          item.mqttPulseMesh.material.opacity = item.mqttPulseOpacity;
          if (item.mqttCoreMesh) item.mqttCoreMesh.material.opacity = item.mqttPulseOpacity * 0.75;
        }
      }

      // Momentary blue flash on PCB upon MQTT telemetry receipt
      if (item.mqttFlash > 0) {
        item.mqttFlash -= delta * 2.2;
        if (item.data?.status === 'online') {
          item.pcbMesh.material.emissive.lerp(new THREE.Color(0x0284c7), Math.max(0, item.mqttFlash));
          item.pcbMesh.material.emissiveIntensity = Math.max(0.15, item.mqttFlash * 0.6);
        }
      }

      // Identify: Rapid flashing strobe at bottom of board (shelf underglow aura) and PCB glow in ELECTRIC BLUE (No bounding box)
      if (item.data?.identifying_until && item.data.identifying_until > Date.now()) {
        item.isIdentifyingActive = true;
        // Rapid strobe (~6 Hz)
        const strobe = Math.sin(Date.now() * 0.038) > 0 ? 1.0 : 0.05;

        // Rapid flashing shelf underglow directly under the board (Electric Blue)
        if (item.auraMesh) {
          item.auraMesh.material.color.setHex(0x00d2ff);
          item.auraMesh.material.opacity = 0.12 + strobe * 0.85;
        }

        // Rapid flashing PCB emissive beacon and ACT LED in Electric Blue
        item.pcbMesh.material.emissive.setHex(0x00d2ff);
        item.pcbMesh.material.emissiveIntensity = 0.15 + strobe * 0.8;
        item.actLed.material.color.setHex(strobe > 0.5 ? 0x00d2ff : 0x000000);
      } else if (item.isIdentifyingActive) {
        item.isIdentifyingActive = false;
        // Restore standard node shading and aura appearance
        this.updateNodeData(item.group.name, item.data || {});
      }
    });

    if (this.controls) this.controls.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

function gsapFly(targetVector, destCoords, durationSec) {
  const startX = targetVector.x;
  const startY = targetVector.y;
  const startZ = targetVector.z;
  const startTime = performance.now();
  const durationMs = durationSec * 1000;

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / durationMs);
    const ease = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;

    targetVector.x = startX + (destCoords.x - startX) * ease;
    targetVector.y = startY + (destCoords.y - startY) * ease;
    targetVector.z = startZ + (destCoords.z - startZ) * ease;

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  }
  requestAnimationFrame(step);
}
