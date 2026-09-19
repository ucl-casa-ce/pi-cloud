/**
 * PiCloudWallTwin - 3D Wall Digital Twin Engine
 * 
 * Renders the actual physical mounting wall (Picloud_FrameDraco.glb) and mounts
 * 48 fully interactive Raspberry Pi 4 nodes at their exact CAD positions (Picloud_RpisDraco.glb),
 * proud of the backboard, with dynamic spinning PoE fans, thermal heatmap PCB shading,
 * live LEDs, tactical locator reticle, and click-to-inspect drawer integration.
 * 
 * Powered by Three.js WebGPURenderer (with seamless WebGL2 fallback).
 */

import * as THREE from '/libs/three-bundle.js';
import { OrbitControls, GLTFLoader, DRACOLoader, WebGLRenderer } from '/libs/three-bundle.js';

// Exact 1-to-1 CAD-to-Cluster Hostname Mapping
// Each node (picloud-1 to picloud-48) mounts precisely at its corresponding rectangular space
// on the silver backing frame (FrameDraco), ordered left-to-right, top-to-bottom within each column.
export const WALL_NODE_COORDINATES = [
  { hostname: "picloud-1",  id: 1,  cadName: "pi1",  x:  1.47308, y: 0.08812, z:  0.24349 },
  { hostname: "picloud-2",  id: 2,  cadName: "pi2",  x:  1.49082, y: 0.08812, z:  0.09841 },
  { hostname: "picloud-3",  id: 3,  cadName: "pi3",  x:  1.52933, y: 0.08811, z: -0.08963 },
  { hostname: "picloud-4",  id: 4,  cadName: "pi4",  x:  1.33884, y: 0.08811, z:  0.29631 },
  { hostname: "picloud-5",  id: 5,  cadName: "pi5",  x:  1.35165, y: 0.08812, z: -0.05777 },
  { hostname: "picloud-6",  id: 6,  cadName: "pi6",  x:  1.26975, y: 0.08812, z:  0.12456 },
  { hostname: "picloud-7",  id: 7,  cadName: "pi7",  x:  1.23026, y: 0.08811, z:  0.01748 },
  { hostname: "picloud-8",  id: 8,  cadName: "pi8",  x:  1.17202, y: 0.08811, z:  0.25485 },
  { hostname: "picloud-9",  id: 9,  cadName: "pi9",  x:  1.07870, y: 0.08812, z:  0.13390 },
  { hostname: "picloud-10", id: 10, cadName: "pi10", x:  1.04170, y: 0.08812, z: -0.09213 },
  { hostname: "picloud-11", id: 11, cadName: "pi11", x:  0.98739, y: 0.08811, z:  0.27555 },
  { hostname: "picloud-12", id: 12, cadName: "pi12", x:  0.94398, y: 0.08811, z:  0.04185 },
  { hostname: "picloud-13", id: 13, cadName: "pi13", x:  0.87082, y: 0.08812, z: -0.12722 },
  { hostname: "picloud-14", id: 14, cadName: "pi14", x:  0.85466, y: 0.08812, z:  0.16955 },
  { hostname: "picloud-15", id: 15, cadName: "pi15", x:  0.77643, y: 0.08811, z:  0.03531 },
  { hostname: "picloud-16", id: 16, cadName: "pi16", x:  0.64167, y: 0.09109, z:  0.17409 },
  { hostname: "picloud-17", id: 17, cadName: "pi17", x:  0.64925, y: 0.09109, z: -0.08785 },
  { hostname: "picloud-18", id: 18, cadName: "pi18", x:  0.59625, y: 0.09109, z:  0.01006 },
  { hostname: "picloud-19", id: 19, cadName: "pi19", x:  0.48673, y: 0.09109, z:  0.14786 },
  { hostname: "picloud-20", id: 20, cadName: "pi20", x:  0.42315, y: 0.09109, z:  0.02925 },
  { hostname: "picloud-21", id: 21, cadName: "pi21", x:  0.29695, y: 0.09109, z:  0.12615 },
  { hostname: "picloud-22", id: 22, cadName: "pi22", x:  0.21406, y: 0.09109, z: -0.05239 },
  { hostname: "picloud-23", id: 23, cadName: "pi23", x:  0.12600, y: 0.08951, z:  0.03259 },
  { hostname: "picloud-24", id: 24, cadName: "pi24", x:  0.07763, y: 0.09109, z:  0.20968 },
  { hostname: "picloud-25", id: 25, cadName: "pi25", x:  0.03234, y: 0.09109, z:  0.31041 },
  { hostname: "picloud-26", id: 26, cadName: "pi26", x:  0.02294, y: 0.08949, z:  0.12162 },
  { hostname: "picloud-27", id: 27, cadName: "pi27", x: -0.02695, y: 0.09109, z: -0.05749 },
  { hostname: "picloud-28", id: 28, cadName: "pi28", x: -0.17041, y: 0.09109, z:  0.30086 },
  { hostname: "picloud-29", id: 29, cadName: "pi29", x: -0.15000, y: 0.09109, z:  0.19693 },
  { hostname: "picloud-30", id: 30, cadName: "pi30", x: -0.26101, y: 0.09109, z:  0.11466 },
  { hostname: "picloud-31", id: 31, cadName: "pi31", x: -0.24642, y: 0.09109, z: -0.07087 },
  { hostname: "picloud-32", id: 32, cadName: "pi32", x: -0.32490, y: 0.09109, z:  0.24923 },
  { hostname: "picloud-33", id: 33, cadName: "pi33", x: -0.43565, y: 0.08812, z:  0.03624 },
  { hostname: "picloud-34", id: 34, cadName: "pi34", x: -0.44203, y: 0.08812, z: -0.11551 },
  { hostname: "picloud-35", id: 35, cadName: "pi35", x: -0.50517, y: 0.08812, z:  0.24155 },
  { hostname: "picloud-36", id: 36, cadName: "pi36", x: -0.55107, y: 0.08812, z:  0.11020 },
  { hostname: "picloud-37", id: 37, cadName: "pi37", x: -0.55680, y: 0.08812, z: -0.04728 },
  { hostname: "picloud-38", id: 38, cadName: "pi38", x: -0.70603, y: 0.08812, z: -0.10731 },
  { hostname: "picloud-39", id: 39, cadName: "pi39", x: -0.74937, y: 0.08812, z:  0.06813 },
  { hostname: "picloud-40", id: 40, cadName: "pi40", x: -0.83864, y: 0.08812, z:  0.16249 },
  { hostname: "picloud-41", id: 41, cadName: "pi41", x: -0.82077, y: 0.08812, z: -0.05493 },
  { hostname: "picloud-42", id: 42, cadName: "pi42", x: -0.96362, y: 0.08812, z:  0.21605 },
  { hostname: "picloud-43", id: 43, cadName: "pi43", x: -0.98465, y: 0.08812, z:  0.12742 },
  { hostname: "picloud-44", id: 44, cadName: "pi44", x: -0.96042, y: 0.08812, z: -0.01094 },
  { hostname: "picloud-45", id: 45, cadName: "pi45", x: -1.12429, y: 0.08812, z:  0.18481 },
  { hostname: "picloud-46", id: 46, cadName: "pi46", x: -1.08475, y: 0.08812, z:  0.03943 },
  { hostname: "picloud-47", id: 47, cadName: "pi47", x: -1.07837, y: 0.08812, z: -0.08172 },
  { hostname: "picloud-48", id: 48, cadName: "pi48", x: -1.20653, y: 0.08812, z:  0.09490 }
];

export class PiCloudWallTwin {
  constructor(containerId = 'wall-canvas-container', options = {}) {
    this.container = document.getElementById(containerId);
    this.onNodeClick = options.onNodeClick || null;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.isWebGPU = false;

    this.wallRootGroup = new THREE.Group();
    this.frameMesh = null;
    this.piMeshes = new Map(); // hostname -> item state

    this.shadingMode = 'default'; // 'default', 'temp', 'cpu', 'power'
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-999, -999);
    this.hoveredHostname = null;

    this.timer = THREE.Timer ? new THREE.Timer() : (THREE.Clock ? new THREE.Clock() : null);
    this.isInitialized = false;

    this.init();
  }

  async init() {
    if (!this.container) {
      console.warn('[WallTwin] Canvas container not found');
      return;
    }

    const width = this.container.clientWidth || 1000;
    const height = this.container.clientHeight || 580;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x060913);

    // 2. Camera: Focused on wall center (X ~ -0.15m, Y ~ -0.02m), looking from front
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 50);
    this.camera.position.set(-0.15, -0.02, 2.75);

    // 3. Renderer: WebGPURenderer with automatic WebGL fallback
    try {
      this.renderer = new THREE.WebGPURenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance'
      });
      await this.renderer.init();
      this.isWebGPU = !this.renderer.backend?.isWebGLBackend;
      console.log(`[WallTwin] Initialized with backend: ${this.isWebGPU ? 'WebGPU' : 'WebGL2 Fallback'}`);
    } catch (err) {
      console.warn('[WallTwin] WebGPURenderer initialization failed, falling back to WebGLRenderer:', err);
      this.renderer = new WebGLRenderer({ antialias: true });
      this.isWebGPU = false;
    }

    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Update WebGPU / WebGL Badge in HUD
    this.updateGpuBadge();

    // 4. OrbitControls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(-0.15, -0.02, 0.0);
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 6.0;
    this.controls.maxPolarAngle = Math.PI - 0.05;

    // 5. Lighting Setup
    this.setupLighting();

    // 6. Wall Root Group Orientation:
    // Arms on the back point downwards, Pis face forward towards the camera (+Z), picloud-1 on left
    this.wallRootGroup.rotation.set(-Math.PI / 2, 0, Math.PI);
    this.scene.add(this.wallRootGroup);

    // 7. Build Interactive Pis from Verified CAD Coordinates
    this.buildWallPis();

    // 8. Load Physical Mounting Wall (FrameDraco.glb)
    this.loadFrameModel();

    // 9. Event Listeners
    this.setupEvents();

    this.isInitialized = true;

    // 10. Start Animation Loop
    this.animate();
  }

  updateGpuBadge() {
    const badge = document.getElementById('wall-gpu-badge');
    if (badge) {
      if (this.isWebGPU) {
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> ⚡ WebGPU';
        badge.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5';
      } else {
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-sky-400"></span> 🌐 WebGL2';
        badge.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-sky-500/20 text-sky-400 border border-sky-500/30 flex items-center gap-1.5';
      }
    }
  }

  setupLighting() {
    // Soft studio ambient light
    const ambientLight = new THREE.AmbientLight(0xdbeafe, 0.85);
    this.scene.add(ambientLight);

    // Primary directional light (key light from top-right)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.25);
    dirLight.position.set(2.0, 3.5, 3.0);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 10;
    dirLight.shadow.bias = -0.0005;
    const d = 2.0;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    this.scene.add(dirLight);

    // Secondary soft fill light (cyan tint from bottom-left)
    const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
    fillLight.position.set(-2.5, -1.5, 2.0);
    this.scene.add(fillLight);

    // Subtle edge rim light (purple/blue)
    const rimLight = new THREE.DirectionalLight(0x818cf8, 0.3);
    rimLight.position.set(0, 0, -2.5);
    this.scene.add(rimLight);
  }

  loadFrameModel() {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('/libs/draco/');

    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);

    gltfLoader.load(
      '/models/Picloud_FrameDraco.glb',
      (gltf) => {
        const frameScene = gltf.scene;
        frameScene.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            // Bright architectural brushed silver metal frame
            child.material = new THREE.MeshStandardMaterial({
              color: 0xd1d9e2,
              roughness: 0.28,
              metalness: 0.88,
              envMapIntensity: 1.2
            });
          }
        });
        this.frameMesh = frameScene;
        this.wallRootGroup.add(frameScene);
        console.log('[WallTwin] FrameDraco model successfully loaded & mounted');
      },
      undefined,
      (err) => {
        console.warn('[WallTwin] Failed to load FrameDraco.glb, rendering procedural backboard fallback:', err);
        this.buildFallbackBackboard();
      }
    );
  }

  buildFallbackBackboard() {
    // Procedural mounting wall backboard if GLB fails to load
    const backGeom = new THREE.BoxGeometry(3.05, 0.015, 0.85);
    const backMat = new THREE.MeshStandardMaterial({
      color: 0xc8d1dc,
      roughness: 0.3,
      metalness: 0.85
    });
    const backMesh = new THREE.Mesh(backGeom, backMat);
    backMesh.position.set(0.14, 0.075, 0.03);
    backMesh.receiveShadow = true;
    this.wallRootGroup.add(backMesh);
  }

  buildWallPis() {
    WALL_NODE_COORDINATES.forEach((coord) => {
      const piGroup = this.createPiNodeMesh(coord.hostname, coord.id);
      
      // Position at exact CAD coordinates: X (horizontal), Y (proud depth), Z (vertical in CAD)
      piGroup.position.set(coord.x, coord.y, coord.z);
      
      // Rotate 180 degrees in Y axis as specified
      piGroup.rotation.y = Math.PI;
      
      this.wallRootGroup.add(piGroup);
    });
  }

  createPiNodeMesh(hostname, id) {
    const group = new THREE.Group();
    group.name = `node-${hostname}`;

    // Real-world Pi 4 Form Factor: 85 mm long (X) × 56 mm wide (Z) × 25 mm proud (Y)
    const pcbWidth = 0.085;
    const pcbHeight = 0.0025;
    const pcbDepth = 0.056;

    // 1. PCB Board (Dynamic Thermal/CPU Material)
    const pcbGeom = new THREE.BoxGeometry(pcbWidth, pcbHeight, pcbDepth);
    const pcbMat = new THREE.MeshStandardMaterial({
      color: 0x059669,
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

    // 2. Broadcom SoC (CPU)
    const cpuGeom = new THREE.BoxGeometry(0.016, 0.0018, 0.016);
    const cpuMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.4,
      metalness: 0.5
    });
    const cpuMesh = new THREE.Mesh(cpuGeom, cpuMat);
    cpuMesh.position.set(-0.008, pcbHeight / 2 + 0.0009, 0);
    group.add(cpuMesh);

    // 3. Ethernet & Dual USB Ports (Metal housings on +X side)
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0xcfd8dc,
      metalness: 0.85,
      roughness: 0.25
    });

    const ethGeom = new THREE.BoxGeometry(0.021, 0.0135, 0.016);
    const ethMesh = new THREE.Mesh(ethGeom, metalMat);
    ethMesh.position.set(pcbWidth / 2 - 0.011, pcbHeight / 2 + 0.0067, pcbDepth / 2 - 0.014);
    ethMesh.castShadow = true;
    group.add(ethMesh);

    [-0.008, 0.012].forEach((offsetZ) => {
      const usbGeom = new THREE.BoxGeometry(0.017, 0.015, 0.014);
      const usbMesh = new THREE.Mesh(usbGeom, metalMat);
      usbMesh.position.set(pcbWidth / 2 - 0.026, pcbHeight / 2 + 0.0075, offsetZ);
      usbMesh.castShadow = true;
      group.add(usbMesh);
    });

    // 4. Brass Standoffs (4 corners supporting PoE HAT)
    const standoffGeom = new THREE.CylinderGeometry(0.0015, 0.0015, 0.012, 8);
    const standoffMat = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      metalness: 0.85,
      roughness: 0.2
    });
    [
      [-0.033, -0.021],
      [-0.033,  0.021],
      [ 0.025, -0.021],
      [ 0.025,  0.021]
    ].forEach(([sx, sz]) => {
      const standoff = new THREE.Mesh(standoffGeom, standoffMat);
      standoff.position.set(sx, 0.0065, sz);
      group.add(standoff);
    });

    // 5. PoE HAT Board
    const poeGeom = new THREE.BoxGeometry(0.065, 0.002, 0.052);
    const poeMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.5,
      metalness: 0.3
    });
    const poeMesh = new THREE.Mesh(poeGeom, poeMat);
    poeMesh.position.set(-0.004, 0.0125, 0);
    poeMesh.castShadow = true;
    poeMesh.userData = { hostname, id };
    group.add(poeMesh);

    // 6. PoE Cooling Fan
    const fanRingGeom = new THREE.TorusGeometry(0.0125, 0.0015, 8, 20);
    const fanRingMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const fanRing = new THREE.Mesh(fanRingGeom, fanRingMat);
    fanRing.rotation.x = Math.PI / 2;
    fanRing.position.set(-0.004, 0.0145, 0);
    group.add(fanRing);

    const fanBladesGeom = new THREE.BoxGeometry(0.023, 0.0006, 0.0035);
    const fanBladesMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    const fanMesh = new THREE.Mesh(fanBladesGeom, fanBladesMat);
    fanMesh.position.set(-0.004, 0.0148, 0);
    group.add(fanMesh);

    // 7. Power & Activity LEDs
    const ledGeom = new THREE.SphereGeometry(0.0018, 8, 8);
    const pwrLedMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    const pwrLed = new THREE.Mesh(ledGeom, pwrLedMat);
    pwrLed.position.set(-0.038, 0.0035, 0.024);
    group.add(pwrLed);

    const actLedMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
    const actLed = new THREE.Mesh(ledGeom, actLedMat);
    actLed.position.set(-0.032, 0.0035, 0.024);
    group.add(actLed);

    // 8. MQTT Pulse Rings (Mounted just below board on backboard)
    const mqttPulseGeom = new THREE.RingGeometry(0.015, 0.038, 32);
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
    mqttPulseMesh.position.set(0, -0.006, 0);
    group.add(mqttPulseMesh);

    const mqttCoreGeom = new THREE.CircleGeometry(0.038, 24);
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
    mqttCoreMesh.position.set(0, -0.0059, 0);
    group.add(mqttCoreMesh);

    // 9. Tactical Locator Reticle (Raised above fan, enlarged diameter)
    const reticleGeom = new THREE.RingGeometry(0.038, 0.046, 48);
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const reticleMesh = new THREE.Mesh(reticleGeom, reticleMat);
    reticleMesh.rotation.x = -Math.PI / 2;
    reticleMesh.position.set(0, 0.030, 0);
    reticleMesh.visible = false;
    group.add(reticleMesh);

    // 10. Reboot (Amber) Orbital Spinner Arc (enlarged arc with open notch so spin is clearly visible)
    const rebootGeom = new THREE.RingGeometry(0.038, 0.046, 48, 1, 0, Math.PI * 1.55);
    const rebootMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const rebootSpinner = new THREE.Mesh(rebootGeom, rebootMat);
    rebootSpinner.rotation.x = -Math.PI / 2;
    rebootSpinner.position.set(0, 0.030, 0);
    rebootSpinner.visible = false;
    group.add(rebootSpinner);

    // 11. Shutdown (Red) Orbital Spinner Arc (enlarged arc with open notch so spin is clearly visible)
    const shutdownGeom = new THREE.RingGeometry(0.038, 0.046, 48, 1, 0, Math.PI * 1.55);
    const shutdownMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const shutdownRing = new THREE.Mesh(shutdownGeom, shutdownMat);
    shutdownRing.rotation.x = -Math.PI / 2;
    shutdownRing.position.set(0, 0.030, 0);
    shutdownRing.visible = false;
    group.add(shutdownRing);

    // 12. Node Label Sprite
    const labelSprite = this.createNodeLabel(hostname);
    labelSprite.position.set(0, 0.034, 0);
    group.add(labelSprite);

    // Record reference
    this.piMeshes.set(hostname, {
      group,
      pcbMesh,
      poeMesh,
      fanMesh,
      pwrLed,
      actLed,
      mqttPulseMesh,
      mqttCoreMesh,
      reticleMesh,
      rebootSpinner,
      rebootMat,
      shutdownRing,
      shutdownMat,
      labelSprite,
      identifyingUntil: 0,
      data: null,
      lastStatus: 'offline'
    });

    return group;
  }

  createNodeLabel(hostname) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.roundRect(4, 4, 120, 32, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 15px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(hostname, 64, 20);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.045, 0.014, 1);
    return sprite;
  }

  setupEvents() {
    const el = this.renderer.domElement;

    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.handleHover();
    });

    el.addEventListener('mouseleave', () => {
      this.mouse.set(-999, -999);
      this.hideTooltip();
    });

    el.addEventListener('click', () => {
      if (this.hoveredHostname && this.onNodeClick) {
        this.onNodeClick(this.hoveredHostname);
      }
    });

    window.addEventListener('resize', () => this.onWindowResize());
  }

  handleHover() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const raycastTargets = [];
    this.piMeshes.forEach(item => {
      if (item.pcbMesh) raycastTargets.push(item.pcbMesh);
      if (item.poeMesh) raycastTargets.push(item.poeMesh);
    });
    const intersects = this.raycaster.intersectObjects(raycastTargets, false);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const hostname = hit.object.userData.hostname;
      if (this.hoveredHostname !== hostname) {
        this.hoveredHostname = hostname;
        this.renderer.domElement.style.cursor = 'pointer';
        this.showTooltip(hostname, hit.point);
      }
    } else {
      if (this.hoveredHostname !== null) {
        this.hoveredHostname = null;
        this.renderer.domElement.style.cursor = 'default';
        this.hideTooltip();
      }
    }
  }

  showTooltip(hostname, worldPos) {
    const item = this.piMeshes.get(hostname);
    const data = item?.data || {};

    let tooltip = document.getElementById('wall-twin-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'wall-twin-tooltip';
      tooltip.className = 'absolute pointer-events-none z-30 px-3 py-2 rounded-xl bg-slate-950/95 border border-sky-500/50 text-white shadow-2xl backdrop-blur-md text-xs flex flex-col gap-1 transition-opacity duration-150';
      this.container.appendChild(tooltip);
    }

    const temp = data.temp_c ? `${data.temp_c}°C` : '--';
    const cpu = data.cpu_percent !== undefined ? `${data.cpu_percent}%` : '--';
    const fanState = data.power_and_hardware?.fan_state ?? data.power_and_hardware?.fan?.state ?? 0;
    const fanMode = data.power_and_hardware?.fan?.mode || (data.power_and_hardware?.fan?.manual_override ? 'manual' : 'auto');
    const fanLabel = fanState > 0 ? `L${fanState} (${fanMode.toUpperCase()})` : `Off (${fanMode.toUpperCase()})`;

    tooltip.innerHTML = `
      <div class="flex items-center justify-between gap-3 border-b border-slate-800 pb-1 font-mono font-bold">
        <span class="text-sky-400">${hostname}</span>
        <span class="text-[10px] px-1.5 py-0.2 rounded ${data.status === 'online' ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}">
          ${data.status || 'offline'}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-300">
        <span>IP: <span class="font-mono text-slate-100">${data.ip || '--'}</span></span>
        <span>Temp: <span class="font-mono text-rose-400 font-semibold">${temp}</span></span>
        <span>CPU: <span class="font-mono text-amber-300">${cpu}</span></span>
        <span>PoE Fan: <span class="font-mono text-sky-300 font-medium">${fanLabel}</span></span>
      </div>
    `;

    // Position tooltip relative to screen
    const screenPos = worldPos.clone().project(this.camera);
    const rect = this.container.getBoundingClientRect();
    const x = (screenPos.x * 0.5 + 0.5) * rect.width;
    const y = (-screenPos.y * 0.5 + 0.5) * rect.height - 15;

    tooltip.style.left = `${Math.min(rect.width - 190, Math.max(10, x - 80))}px`;
    tooltip.style.top = `${Math.max(10, y - 70)}px`;
    tooltip.style.opacity = '1';
  }

  hideTooltip() {
    const tooltip = document.getElementById('wall-twin-tooltip');
    if (tooltip) tooltip.style.opacity = '0';
  }

  onWindowResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  flyCamera(destPos, destTarget, durationSec = 0.8) {
    if (!this.camera || !this.controls) return;
    const startCamX = this.camera.position.x;
    const startCamY = this.camera.position.y;
    const startCamZ = this.camera.position.z;

    const startTargetX = this.controls.target.x;
    const startTargetY = this.controls.target.y;
    const startTargetZ = this.controls.target.z;

    const startTime = performance.now();
    const durationMs = durationSec * 1000;

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const ease = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      this.camera.position.x = startCamX + (destPos.x - startCamX) * ease;
      this.camera.position.y = startCamY + (destPos.y - startCamY) * ease;
      this.camera.position.z = startCamZ + (destPos.z - startCamZ) * ease;

      this.controls.target.x = startTargetX + (destTarget.x - startTargetX) * ease;
      this.controls.target.y = startTargetY + (destTarget.y - startTargetY) * ease;
      this.controls.target.z = startTargetZ + (destTarget.z - startTargetZ) * ease;

      this.controls.update();

      if (progress < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  setCameraPreset(preset, animate = true) {
    if (!this.controls) return;
    let destPos = { x: -0.15, y: -0.02, z: 2.75 };
    let destTarget = { x: -0.15, y: -0.02, z: 0.0 };

    if (preset === 'front') {
      destPos = { x: -0.15, y: -0.02, z: 2.75 };
      destTarget = { x: -0.15, y: -0.02, z: 0.0 };
    } else if (preset === 'iso') {
      destPos = { x: -1.6, y: 1.0, z: 2.2 };
      destTarget = { x: -0.15, y: -0.02, z: 0.0 };
    } else if (preset === 'top') {
      destPos = { x: -0.15, y: 2.5, z: 0.5 };
      destTarget = { x: -0.15, y: -0.02, z: 0.0 };
    } else if (preset === 'hot') {
      let hottest = null;
      let maxT = -1;
      this.piMeshes.forEach((item) => {
        const t = parseFloat(item.data?.temp_c);
        if (!isNaN(t) && t > maxT) {
          maxT = t;
          hottest = item;
        }
      });
      if (hottest) {
        const p = new THREE.Vector3();
        hottest.group.getWorldPosition(p);
        destPos = { x: p.x, y: p.y + 0.02, z: p.z + 0.35 };
        destTarget = { x: p.x, y: p.y, z: p.z };
      }
    }

    if (animate) {
      this.flyCamera(destPos, destTarget, 0.8);
    } else {
      this.camera.position.set(destPos.x, destPos.y, destPos.z);
      this.controls.target.set(destTarget.x, destTarget.y, destTarget.z);
      this.controls.update();
    }
  }

  setShadingMode(mode) {
    this.shadingMode = mode;
    this.piMeshes.forEach((item) => {
      if (item.data) this.applyNodeShading(item, item.data);
    });
  }

  applyNodeShading(item, data) {
    const pcb = item.pcbMesh;
    if (!pcb) return;

    if (data.status === 'rebooting') {
      pcb.material.color.setHex(0x78350f);
      pcb.material.emissive.setHex(0xf59e0b);
      pcb.material.emissiveIntensity = 0.35;
      return;
    }

    if (data.status === 'shutdown') {
      pcb.material.color.setHex(0x7f1d1d);
      pcb.material.emissive.setHex(0xef4444);
      pcb.material.emissiveIntensity = 0.35;
      return;
    }

    if (data.status !== 'online' && data.status !== 'warning') {
      pcb.material.color.setHex(0x334155);
      pcb.material.emissive.setHex(0x0f172a);
      return;
    }

    if (this.shadingMode === 'temp') {
      const temp = parseFloat(data.temp_c) || 40;
      // 35°C (emerald/blue) -> 55°C (yellow) -> 75°C (crimson)
      const t = Math.max(0, Math.min(1, (temp - 35) / 40));
      const col = new THREE.Color();
      if (t < 0.5) col.lerpColors(new THREE.Color(0x10b981), new THREE.Color(0xf59e0b), t * 2);
      else col.lerpColors(new THREE.Color(0xf59e0b), new THREE.Color(0xef4444), (t - 0.5) * 2);
      pcb.material.color.copy(col);
      pcb.material.emissive.copy(col).multiplyScalar(0.2);
    } else if (this.shadingMode === 'cpu') {
      const cpu = parseFloat(data.cpu_percent) || 0;
      const t = Math.max(0, Math.min(1, cpu / 100));
      const col = new THREE.Color();
      col.lerpColors(new THREE.Color(0x3b82f6), new THREE.Color(0xa855f7), t);
      pcb.material.color.copy(col);
      pcb.material.emissive.copy(col).multiplyScalar(0.2);
    } else if (this.shadingMode === 'power') {
      const watts = parseFloat(data.poe?.current_watts) || 1.8;
      const t = Math.max(0, Math.min(1, (watts - 1.2) / 4.0));
      const col = new THREE.Color();
      col.lerpColors(new THREE.Color(0x06b6d4), new THREE.Color(0xf97316), t);
      pcb.material.color.copy(col);
      pcb.material.emissive.copy(col).multiplyScalar(0.2);
    } else {
      // Default sleek emerald green
      pcb.material.color.setHex(0x059669);
      pcb.material.emissive.setHex(0x047857);
      pcb.material.emissiveIntensity = 0.06;
    }
  }

  updateNodes(nodesData) {
    if (!nodesData) return;
    Object.entries(nodesData).forEach(([hostname, data]) => {
      const item = this.piMeshes.get(hostname);
      if (!item) return;

      item.data = data;
      this.applyNodeShading(item, data);

      // Trigger telemetry ping glow if recently updated
      if (data._justUpdated) {
        item.mqttPulseMesh.material.opacity = 0.8;
        item.mqttCoreMesh.material.opacity = 0.45;
      }
    });
  }

  focusNode(hostname) {
    const item = this.piMeshes.get(hostname);
    if (!item || !this.controls) return;
    const worldPos = new THREE.Vector3();
    item.group.getWorldPosition(worldPos);
    // Smoothly fly camera to face the node from the front (+Z)
    this.flyCamera(
      { x: worldPos.x, y: worldPos.y + 0.02, z: worldPos.z + 0.35 },
      { x: worldPos.x, y: worldPos.y, z: worldPos.z },
      0.8
    );
  }

  resetView() {
    this.setCameraPreset('front', true);
  }

  triggerIdentify(hostname, durationSeconds = 10) {
    const expiresAt = Date.now() + durationSeconds * 1000;
    const targetHostnames = hostname === 'all'
      ? Array.from(this.piMeshes.keys())
      : [hostname];

    targetHostnames.forEach((h) => {
      const item = this.piMeshes.get(h);
      if (item) {
        item.identifyingUntil = expiresAt;
        if (item.reticleMesh) {
          item.reticleMesh.visible = true;
          item.reticleMesh.material.opacity = 0.9;
        }
      }
    });
  }

  animate() {
    requestAnimationFrame(() => this.animate());
 
    let delta = 0.016;
    let elapsed = performance.now() / 1000;
    if (this.timer) {
      if (this.timer.update) this.timer.update();
      delta = Math.min(this.timer.getDelta ? this.timer.getDelta() : 0.016, 0.1);
      elapsed = this.timer.getElapsed ? this.timer.getElapsed() : (this.timer.getElapsedTime ? this.timer.getElapsedTime() : elapsed);
    }

    if (this.controls) this.controls.update();

    // Animate fans, LEDs, and status rings across all 48 nodes
    this.piMeshes.forEach((item) => {
      const data = item.data;

      // 1. PoE Cooling Fan Spinning
      // Fan stops completely when fan_state is 0, and spins proportionally to speed (1 to 4)
      if (data && (data.status === 'online' || data.status === 'warning')) {
        const fanState = data.power_and_hardware?.fan_state ?? data.power_and_hardware?.fan?.state ?? 0;
        if (fanState > 0) {
          const rotationSpeed = fanState * 10.0;
          item.fanMesh.rotation.y += rotationSpeed * delta;
        }
      }

      // 2. Activity LED Dynamic Blinking
      if (data?.status === 'online') {
        item.actLed.material.color.setHex(0x22c55e);
        const rx = data.network?.rx_kb_s || 0;
        const tx = data.network?.tx_kb_s || 0;
        const netActivity = Math.min(10, Math.floor((rx + tx) / 5));
        const blinkRate = 2.0 + netActivity * 1.5;
        item.actLed.visible = Math.sin(elapsed * blinkRate * Math.PI) > 0;
      } else if (data?.status !== 'rebooting' && data?.status !== 'shutdown') {
        item.actLed.visible = false;
      }

      // 3. Telemetry Ping Ring Decay
      if (item.mqttPulseMesh.material.opacity > 0.01) {
        item.mqttPulseMesh.material.opacity -= delta * 1.2;
        item.mqttCoreMesh.material.opacity -= delta * 0.9;
        item.mqttPulseMesh.scale.addScalar(delta * 0.8);
      } else {
        item.mqttPulseMesh.material.opacity = 0;
        item.mqttCoreMesh.material.opacity = 0;
        item.mqttPulseMesh.scale.set(1, 1, 1);
      }

      // 4. Identify Reticle Animation
      const identifyExpiry = item.identifyingUntil || (data?.identifying_until && Date.now() < data.identifying_until ? data.identifying_until : 0);
      const isIdentifying = identifyExpiry > 0 && Date.now() < identifyExpiry;
      if (isIdentifying) {
        item.reticleMesh.visible = true;
        item.reticleMesh.material.opacity = 0.5 + Math.sin(elapsed * 12.0) * 0.45;
        item.reticleMesh.rotation.z += delta * 3.5;
      } else {
        item.identifyingUntil = 0;
        item.reticleMesh.visible = false;
        item.reticleMesh.material.opacity = 0;
      }

      // 5. Reboot Spinner Animation (Amber open arc, visibly spins)
      if (data?.status === 'rebooting') {
        item.rebootSpinner.visible = true;
        item.rebootMat.opacity = 0.9;
        item.rebootSpinner.rotation.z -= delta * 6.0;
        item.actLed.visible = Math.sin(elapsed * 8.0) > 0;
        item.actLed.material.color.setHex(0xf59e0b);
      } else {
        item.rebootSpinner.visible = false;
        item.rebootMat.opacity = 0;
      }

      // 6. Shutdown Spinner Animation (Red open arc, visibly spins like reboot)
      if (data?.status === 'shutdown') {
        item.shutdownRing.visible = true;
        item.shutdownMat.opacity = 0.9;
        item.shutdownRing.rotation.z -= delta * 6.0;
        item.actLed.visible = Math.sin(elapsed * 8.0) > 0;
        item.actLed.material.color.setHex(0xef4444);
      } else {
        item.shutdownRing.visible = false;
        item.shutdownMat.opacity = 0;
      }
    });

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

// Attach to window so non-module scripts can consume seamlessly
if (typeof window !== 'undefined') {
  window.PiCloudWallTwin = PiCloudWallTwin;
}

