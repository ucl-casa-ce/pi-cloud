/**
 * PiCloud Digital Twin - Client Application Logic
 * Manages WebSocket state sync, 3D twin bindings, 2D matrix view,
 * Chart.js real-time telemetry, and OIDC command authorization.
 */

import { PiCloudTwin3D } from './twin3d.js';
import { PiCloudWallTwin } from './twin-wall.js';

class PiCloudApp {
  constructor() {
    this.nodes = {};
    this.summary = {};
    this.history = [];
    this.events = [];
    this.eventFilter = 'all';
    this.eventSearch = '';
    this.selectedHostname = null;
    this.currentUser = null;

    this.wallTwin = null;
    this.twin3d = null;
    this.ws = null;
    this.charts = {};

    this.fanDrawerState = {
      mode: 'auto',
      speed: 2,
      temp_on: 48,
      temp_off: 42
    };

    const params = new URLSearchParams(window.location.search);
    if (params.get('modal') === 'login') {
      document.getElementById('login-modal')?.classList.remove('hidden');
    }

    this.init();
  }

  async init() {
    // 1. Setup Auth & check Auth status immediately
    this.setupAuthHandlers();
    await this.checkAuthStatus();

    // 2. Setup View Switcher Tabs & Controls
    this.setupViewTabs();
    this.setupCameraPresets();
    this.setupShadingModes();
    this.setupFullscreen();

    // 3. Setup Drawer, Command, Fan & Modal Handlers
    this.setupDrawerHandlers();
    this.setupCommandHandlers();
    this.setupFanControls();
    this.setupEventLogHandlers();

    // 4. Initialize Real-Time Charts & Search Filter
    this.initCharts();
    const searchInput = document.getElementById('search-nodes');
    if (searchInput) {
      searchInput.addEventListener('input', () => this.render2DMatrix());
    }

    // 5. Connect to Real-Time WebSocket Server
    this.connectWebSocket();

    // 6. Initialize Physical 3D Mounting Wall Digital Twin
    const wallContainer = document.getElementById('wall-canvas-container');
    if (wallContainer) {
      this.wallTwin = new PiCloudWallTwin('wall-canvas-container', {
        onNodeClick: (hostname) => {
          this.openDrawer(hostname);
        }
      });
    }

    // 7. Initialize 3D Shelf Canvas
    const canvasContainer = document.getElementById('twin-canvas-container');
    if (canvasContainer) {
      this.twin3d = new PiCloudTwin3D(canvasContainer, (nodeData) => {
        this.openDrawer(nodeData.hostname);
      });
    }

    // Deep-link query parameters support (?modal=login, ?drawer=picloud-X)
    const params = new URLSearchParams(window.location.search);
    if (params.get('modal') === 'login') {
      this.openLoginModal();
    }
    if (params.get('drawer')) {
      setTimeout(() => this.openDrawer(params.get('drawer')), 300);
    }
  }

  // ==========================================
  // WEBSOCKET REAL-TIME SYNC
  // ==========================================
  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected to PiCloud real-time stream.');
      this.updateMqttBadge(true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleWsMessage(msg);
      } catch (err) {
        console.warn('[WS] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.warn('[WS] Disconnected. Retrying in 3s...');
      this.updateMqttBadge(false);
      setTimeout(() => this.connectWebSocket(), 3000);
    };

    this.ws.onerror = (err) => {
      console.warn('[WS] Error:', err);
    };
  }

  handleWsMessage(msg) {
    if (msg.type === 'INIT') {
      this.nodes = msg.nodes || {};
      this.summary = msg.summary || {};
      this.history = msg.history || [];
      this.events = msg.events || [];

      if (this.twin3d) this.twin3d.updateAllNodes(this.nodes);
      if (this.wallTwin) this.wallTwin.updateNodes(this.nodes);
      this.updateKpiBanner(this.summary);
      this.render2DMatrix();
      this.updateCharts(this.history);
      this.updateEventBadge();
      this.renderEventLog();
      this.updateShadingHud(this.twin3d?.colorMode || 'off');
      if (!document.getElementById('view-container-heatmap')?.classList.contains('hidden')) {
        this.renderWallHeatmap();
      }

      const drawerParam = new URLSearchParams(window.location.search).get('drawer');
      if (drawerParam && this.nodes[drawerParam]) {
        this.openDrawer(drawerParam);
        if (new URLSearchParams(window.location.search).get('scroll') === 'bottom') {
          setTimeout(() => {
            const drawerBody = document.querySelector('#node-drawer .overflow-y-auto') || document.getElementById('node-drawer');
            if (drawerBody) drawerBody.scrollTop = drawerBody.scrollHeight;
          }, 100);
        }
      }
    } else if (msg.type === 'NODE_UPDATE') {
      if (msg.hostname && msg.data) {
        this.nodes[msg.hostname] = msg.data;
        if (this.twin3d) {
          this.twin3d.updateNodeData(msg.hostname, msg.data);
          this.twin3d.triggerMqttPulse(msg.hostname);
        }
        if (this.wallTwin) {
          this.wallTwin.updateNodes({ [msg.hostname]: { ...msg.data, _justUpdated: true } });
        }
        this.update2DCard(msg.hostname, msg.data);
        if (this.selectedHostname === msg.hostname) {
          this.updateDrawerContent(msg.data);
        }
      }
      if (msg.summary) {
        this.summary = msg.summary;
        this.updateKpiBanner(msg.summary);
        this.updateShadingHud(this.twin3d?.colorMode || 'off');
      }
      if (!document.getElementById('view-container-heatmap')?.classList.contains('hidden')) {
        this.renderWallHeatmap();
      }
    } else if (msg.type === 'BATCH_UPDATE') {
      if (msg.updates) {
        const wallPatch = {};
        msg.updates.forEach((item) => {
          this.nodes[item.hostname] = item.data;
          wallPatch[item.hostname] = { ...item.data, _justUpdated: true };
          if (this.twin3d) {
            this.twin3d.updateNodeData(item.hostname, item.data);
            this.twin3d.triggerMqttPulse(item.hostname);
          }
          this.update2DCard(item.hostname, item.data);
          if (this.selectedHostname === item.hostname) {
            this.updateDrawerContent(item.data);
          }
        });
        if (this.wallTwin) {
          this.wallTwin.updateNodes(wallPatch);
        }
      }
      if (msg.summary) {
        this.summary = msg.summary;
        this.updateKpiBanner(msg.summary);
        this.updateShadingHud(this.twin3d?.colorMode || 'off');
      }
      if (!document.getElementById('view-container-heatmap')?.classList.contains('hidden')) {
        this.renderWallHeatmap();
      }
    } else if (msg.type === 'CLUSTER_EVENT') {
      if (msg.event) {
        this.events.unshift(msg.event);
        if (this.events.length > 200) this.events.pop();
        this.updateEventBadge();
        this.renderEventLog();
      }
    } else if (msg.type === 'IDENTIFY_TRIGGER') {
      const dur = parseInt(msg.duration, 10) || 10;
      const targets = msg.hostname === 'all' ? Object.keys(this.nodes) : [msg.hostname];
      targets.forEach((h) => {
        // Highlight on 2D Card
        const card = document.getElementById(`card-${h}`);
        if (card) {
          card.classList.add('identifying-beacon');
          setTimeout(() => card.classList.remove('identifying-beacon'), dur * 1000);
        }
        if (this.nodes[h]) {
          this.nodes[h].identifying_until = msg.expiresAt || (Date.now() + dur * 1000);
        }
      });
      // Trigger locator reticle on 3D Wall Twin
      if (this.wallTwin?.triggerIdentify) {
        this.wallTwin.triggerIdentify(msg.hostname, dur);
      }
      // Trigger strobe on 3D Shelf Twin
      if (this.twin3d?.triggerIdentify) {
        this.twin3d.triggerIdentify(msg.hostname, dur);
      }
    }
  }

  updateMqttBadge(connected) {
    const badge = document.getElementById('mqtt-status-badge');
    const text = document.getElementById('mqtt-status-text');
    if (!badge || !text) return;
    if (connected) {
      badge.classList.replace('border-rose-700/60', 'border-slate-700/60');
      text.textContent = 'Connected';
      text.className = 'text-emerald-400';
    } else {
      badge.classList.replace('border-slate-700/60', 'border-rose-700/60');
      text.textContent = 'Reconnecting...';
      text.className = 'text-rose-400';
    }
  }

  // ==========================================
  // TOP KPI BANNER UPDATES
  // ==========================================
  updateKpiBanner(s) {
    if (!s) return;
    setText('kpi-watts', s.totalWatts ?? '--');
    setText('kpi-amps', `${s.totalAmps ?? '0.00'} A`);
    setText('kpi-kwh', s.totalEnergyKwh ?? '0.00');

    setText('kpi-avg-temp', s.avgTempC ?? '--');
    setText('kpi-max-temp', `${s.maxTempC ?? '--'}°C`);
    setText('kpi-max-host', s.maxTempHost ?? '--');

    setText('kpi-avg-cpu', s.avgCpuPercent ?? '--');
    setText('kpi-avg-mem', `${s.avgMemoryPercent ?? '--'}%`);

    setText('kpi-online', s.onlineCount ?? '--');
    setText('kpi-offline', s.offlineCount ?? '0');
    setText('kpi-rebooting', s.rebootingCount ?? '0');
    setText('kpi-gigabit', s.gigabitCount ?? '--');
    setText('kpi-100m', s.lowSpeedCount ?? '0');

    setText('kpi-throttled', s.throttledCount ?? '0');
    const throttledEl = document.getElementById('kpi-throttled');
    if (throttledEl) {
      throttledEl.className = s.throttledCount > 0 ? 'text-amber-400 font-bold' : 'text-emerald-400';
    }

    setText('kpi-users', s.totalActiveUsers ?? '0');
    setText('cluster-heartbeat', new Date().toTimeString().slice(0, 8));
  }

  // ==========================================
  // VIEW SWITCHING (3D vs 2D vs Wall Heatmap vs Charts vs Event Log)
  // ==========================================
  setupViewTabs() {
    const tabTwin = document.getElementById('tab-twin');
    const tab3d = document.getElementById('tab-3d');
    const tab2d = document.getElementById('tab-2d');
    const tabHeatmap = document.getElementById('tab-heatmap');
    const tabCharts = document.getElementById('tab-charts');
    const tabEvents = document.getElementById('tab-events');

    const vTwin = document.getElementById('view-container-twin');
    const v3d = document.getElementById('view-container-3d');
    const v2d = document.getElementById('view-container-2d');
    const vHeatmap = document.getElementById('view-container-heatmap');
    const vCharts = document.getElementById('view-container-charts');
    const vEvents = document.getElementById('view-container-events');
    const vControls = document.getElementById('view-controls');

    const setTab = (activeTab, activeView) => {
      [tabTwin, tab3d, tab2d, tabHeatmap, tabCharts, tabEvents].forEach((t) => t?.classList.remove('active'));
      [vTwin, v3d, v2d, vHeatmap, vCharts, vEvents].forEach((v) => v?.classList.add('hidden'));

      activeTab?.classList.add('active');
      activeView?.classList.remove('hidden');

      if (activeTab === tabTwin || activeTab === tab3d) {
        vControls?.classList.remove('hidden');
        if (activeTab === tabTwin && this.wallTwin) {
          setTimeout(() => this.wallTwin?.onWindowResize(), 20);
        }
        if (activeTab === tab3d && this.twin3d) {
          setTimeout(() => this.twin3d?.onWindowResize(), 20);
        }
      } else {
        vControls?.classList.add('hidden');
        if (vTwin?.classList.contains('fullscreen-active')) {
          this.toggleWallFullscreen(false);
        }
        if (v3d?.classList.contains('fullscreen-active')) {
          this.toggleFullscreen(false);
        }
      }

      if (activeTab === tabHeatmap) {
        this.renderWallHeatmap();
      }

      if (activeTab === tabCharts) {
        this.renderCharts();
      }

      if (activeTab === tabEvents) {
        this.renderEventLog();
      }
    };

    tabTwin?.addEventListener('click', () => setTab(tabTwin, vTwin));
    tab3d?.addEventListener('click', () => setTab(tab3d, v3d));
    tabHeatmap?.addEventListener('click', () => setTab(tabHeatmap, vHeatmap));
    tab2d?.addEventListener('click', () => {
      setTab(tab2d, v2d);
      this.render2DMatrix();
    });
    tabCharts?.addEventListener('click', () => setTab(tabCharts, vCharts));
    tabEvents?.addEventListener('click', () => setTab(tabEvents, vEvents));

    // Setup fullscreen toggles
    this.setupWallFullscreen();
  }

  setupCameraPresets() {
    document.getElementById('cam-front')?.addEventListener('click', () => {
      this.wallTwin?.setCameraPreset('front');
      this.twin3d?.setCameraPreset('front');
    });
    document.getElementById('cam-iso')?.addEventListener('click', () => {
      this.wallTwin?.setCameraPreset('iso');
      this.twin3d?.setCameraPreset('iso');
    });
    document.getElementById('cam-top')?.addEventListener('click', () => {
      this.wallTwin?.setCameraPreset('top');
      this.twin3d?.setCameraPreset('top');
    });
    document.getElementById('cam-hot')?.addEventListener('click', () => {
      this.wallTwin?.setCameraPreset('hot');
      this.twin3d?.setCameraPreset('hot');
    });
  }

  setupShadingModes() {
    const modeTemp = document.getElementById('mode-temp');
    const modeCpu = document.getElementById('mode-cpu');
    const modePower = document.getElementById('mode-power');
    const buttons = [
      { mode: 'temp', el: modeTemp },
      { mode: 'cpu', el: modeCpu },
      { mode: 'power', el: modePower }
    ];

    const inactiveClass = 'px-2 py-1 rounded text-slate-400 hover:text-white font-medium flex items-center gap-1 transition';
    const activeClass = 'px-2 py-1 rounded bg-sky-500/20 text-sky-400 border border-sky-500/30 font-medium flex items-center gap-1 transition';

    let currentMode = 'off';

    const toggleMode = (targetMode) => {
      // Toggle logic: clicking active mode toggles it off
      currentMode = (currentMode === targetMode) ? 'off' : targetMode;

      if (this.twin3d) {
        this.twin3d.colorMode = currentMode;
        this.twin3d.updateAllNodes(this.nodes);
      }
      if (this.wallTwin) {
        this.wallTwin.setShadingMode(currentMode);
        this.wallTwin.updateNodes(this.nodes);
      }

      buttons.forEach(({ mode, el }) => {
        if (!el) return;
        el.className = (mode === currentMode) ? activeClass : inactiveClass;
      });

      this.updateShadingHud(currentMode);
    };

    modeTemp?.addEventListener('click', () => toggleMode('temp'));
    modeCpu?.addEventListener('click', () => toggleMode('cpu'));
    modePower?.addEventListener('click', () => toggleMode('power'));

    // Shading is off by default
    this.updateShadingHud('off');
  }

  updateShadingHud(mode) {
    const hud = document.getElementById('twin-hud-overlay');
    if (mode === 'off') {
      hud?.classList.add('hidden');
      return;
    }
    hud?.classList.remove('hidden');

    const icon = document.getElementById('hud-mode-icon');
    const title = document.getElementById('hud-mode-title');
    const bar = document.getElementById('hud-spectrum-bar');
    const ticks = document.getElementById('hud-spectrum-ticks');
    const statPrimary = document.getElementById('hud-stat-primary');
    const statSecondary = document.getElementById('hud-stat-secondary');
    const descText = document.getElementById('hud-desc-text');

    if (!title) return;

    if (mode === 'cpu') {
      if (icon) icon.textContent = '🧠';
      title.textContent = 'CPU Utilization Shading (%)';
      if (bar) bar.className = 'w-full h-2 rounded-full bg-gradient-to-r from-emerald-500 via-cyan-400 via-amber-500 to-rose-500 shadow-inner';
      if (ticks) {
        ticks.innerHTML = `
          <span>0% (Idle)</span>
          <span>25%</span>
          <span>50%</span>
          <span>75%+ (Heavy)</span>
        `;
      }
      if (statPrimary) statPrimary.innerHTML = `Cluster Avg: <b class="text-white font-mono">${this.summary.avgCpuPercent ?? '--'}%</b>`;
      if (statSecondary) statSecondary.innerHTML = `Online: <b class="text-emerald-400 font-mono">${this.summary.onlineCount ?? 0} / 48</b>`;
      if (descText) descText.textContent = 'Shading PCB & shelf aura by active CPU processor workload';
    } else if (mode === 'power') {
      if (icon) icon.textContent = '⚡';
      title.textContent = 'PoE Power Draw Shading (Watts)';
      if (bar) bar.className = 'w-full h-2 rounded-full bg-gradient-to-r from-cyan-400 via-emerald-500 via-amber-500 to-rose-500 shadow-inner';
      if (ticks) {
        ticks.innerHTML = `
          <span>&lt;2.5W (Idle)</span>
          <span>4.5W (Nominal)</span>
          <span>7.0W (Heavy)</span>
          <span>&gt;10W (Peak)</span>
        `;
      }
      if (statPrimary) statPrimary.innerHTML = `Total Power: <b class="text-white font-mono">${this.summary.totalWatts ?? '--'} W</b>`;
      if (statSecondary) statSecondary.innerHTML = `Cumulative: <b class="text-sky-400 font-mono">${this.summary.totalEnergyKwh ?? '0.00'} kWh</b>`;
      if (descText) descText.textContent = 'Shading PCB & shelf aura by PoE Hat wattage consumption';
    } else {
      // temp / heatview
      if (icon) icon.textContent = '🔥';
      title.textContent = 'Thermal Heatview (°C)';
      if (bar) bar.className = 'w-full h-2 rounded-full bg-gradient-to-r from-cyan-400 via-emerald-500 via-amber-500 to-rose-500 shadow-inner';
      if (ticks) {
        ticks.innerHTML = `
          <span>&lt;40°C (Cool)</span>
          <span>40-50°C (Optimal)</span>
          <span>50-65°C (Warm)</span>
          <span>&gt;65°C (Hot)</span>
        `;
      }
      if (statPrimary) statPrimary.innerHTML = `Cluster Avg: <b class="text-white font-mono">${this.summary.avgTempC ?? '--'}°C</b>`;
      if (statSecondary) statSecondary.innerHTML = `Peak: <b class="text-amber-400 font-mono">${this.summary.maxTempC ?? '--'}°C (${this.summary.maxTempHost ?? '--'})</b>`;
      if (descText) descText.textContent = 'Shading PCB & shelf heat aura by SoC junction temperature';
    }
  }

  // ==========================================
  // WALL TWIN FULLSCREEN VIEW
  // ==========================================
  setupWallFullscreen() {
    document.getElementById('wall-fullscreen-btn')?.addEventListener('click', () => {
      this.toggleWallFullscreen();
    });
  }

  toggleWallFullscreen(forceState = null) {
    const container = document.getElementById('view-container-twin');
    const expandIcon = document.getElementById('wall-fullscreen-expand-icon');
    const collapseIcon = document.getElementById('wall-fullscreen-collapse-icon');
    const btn = document.getElementById('wall-fullscreen-btn');

    if (!container) return;

    const shouldBeFullscreen = forceState !== null 
      ? forceState 
      : !container.classList.contains('fullscreen-active');

    if (shouldBeFullscreen) {
      container.classList.add('fullscreen-active');
      expandIcon?.classList.add('hidden');
      collapseIcon?.classList.remove('hidden');
      if (btn) btn.title = 'Exit Fullscreen (Esc)';
    } else {
      container.classList.remove('fullscreen-active');
      expandIcon?.classList.remove('hidden');
      collapseIcon?.classList.add('hidden');
      if (btn) btn.title = 'Expand to Fullscreen';
    }

    setTimeout(() => {
      if (this.wallTwin) {
        this.wallTwin.onWindowResize();
      }
    }, 40);
  }

  // ==========================================
  // 3D SHELF FULLSCREEN VIEW
  // ==========================================
  setupFullscreen() {
    document.getElementById('twin-fullscreen-btn')?.addEventListener('click', () => {
      this.toggleFullscreen();
    });
  }

  toggleFullscreen(forceState = null) {
    const container = document.getElementById('view-container-3d');
    const expandIcon = document.getElementById('fullscreen-expand-icon');
    const collapseIcon = document.getElementById('fullscreen-collapse-icon');
    const btn = document.getElementById('twin-fullscreen-btn');

    if (!container) return;

    const shouldBeFullscreen = forceState !== null 
      ? forceState 
      : !container.classList.contains('fullscreen-active');

    if (shouldBeFullscreen) {
      container.classList.add('fullscreen-active');
      expandIcon?.classList.add('hidden');
      collapseIcon?.classList.remove('hidden');
      if (btn) btn.title = 'Exit Fullscreen (Esc)';
    } else {
      container.classList.remove('fullscreen-active');
      expandIcon?.classList.remove('hidden');
      collapseIcon?.classList.add('hidden');
      if (btn) btn.title = 'Expand to Fullscreen';
    }

    // Adapt Three.js camera & renderer to the new viewport dimensions
    setTimeout(() => {
      if (this.twin3d) {
        this.twin3d.onWindowResize();
      }
    }, 40);
  }

  // ==========================================
  // DEDICATED OVERALL WALL HEATMAP VIEW
  // ==========================================
  renderWallHeatmap() {
    const container = document.getElementById('wall-heatmap-shelves');
    if (!container) return;

    container.innerHTML = '';

    // Cluster is 6 shelves ordered Shelf 1 (Bottom Rack) to Shelf 6 (Top Rack), 8 columns each
    const ROWS = 6;
    const COLS = 8;

    for (let r = 1; r <= ROWS; r++) {
      const shelfRow = document.createElement('div');
      shelfRow.className = 'flex flex-col gap-2 p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/80 shadow-lg';

      // Shelf label
      const startNode = (r - 1) * COLS + 1;
      const endNode = r * COLS;
      const shelfHeader = document.createElement('div');
      shelfHeader.className = 'flex items-center justify-between text-xs text-slate-400 font-mono px-1';
      shelfHeader.innerHTML = `
        <span class="font-bold text-slate-200">Shelf ${r} ${r === 1 ? '(Bottom Rack)' : r === 6 ? '(Top Rack)' : ''}</span>
        <span class="text-slate-500">picloud-${startNode} &rarr; picloud-${endNode}</span>
      `;
      shelfRow.appendChild(shelfHeader);

      // 8 Columns grid
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5';

      for (let c = 0; c < COLS; c++) {
        const nodeId = startNode + c;
        const hostname = `picloud-${nodeId}`;
        const d = this.nodes[hostname] || { hostname, node_id: nodeId, status: 'offline', temp_c: 0, cpu_percent: 0, poe: {} };

        const cell = document.createElement('div');
        cell.className = `rounded-xl p-3 cursor-pointer transition hover:scale-[1.03] border flex flex-col justify-between ${this.getThermalCardClass(d)}`;
        cell.onclick = () => this.openDrawer(hostname);

        let tempDisplay = '--°C';
        let statusBadge = 'Offline';
        let badgeColor = 'text-slate-500';

        if (d.status === 'rebooting') {
          tempDisplay = 'REBOOT';
          statusBadge = 'Restarting';
          badgeColor = 'text-amber-400';
        } else if (d.status === 'shutdown') {
          tempDisplay = 'SHUTDOWN';
          statusBadge = 'Shutting Down';
          badgeColor = 'text-rose-400';
        } else if (d.status === 'offline') {
          tempDisplay = 'OFFLINE';
          statusBadge = 'No Heartbeat';
          badgeColor = 'text-slate-500';
        } else if (d.temp_c) {
          tempDisplay = `${d.temp_c}°C`;
          if (d.temp_c < 40) {
            statusBadge = 'Cool';
            badgeColor = 'text-cyan-400';
          } else if (d.temp_c < 50) {
            statusBadge = 'Optimal';
            badgeColor = 'text-emerald-400';
          } else if (d.temp_c < 65) {
            statusBadge = 'Warm';
            badgeColor = 'text-amber-400';
          } else {
            statusBadge = 'Hot';
            badgeColor = 'text-rose-400 font-bold';
          }
        }

        cell.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="font-mono font-bold text-xs text-white">#${d.node_id}</span>
            <span class="text-[10px] font-mono ${badgeColor}">${statusBadge}</span>
          </div>
          <div class="my-2 text-center">
            <div class="text-xl font-extrabold font-mono tracking-tight ${this.getTempColorClass(d.temp_c)}">
              ${tempDisplay}
            </div>
          </div>
          <div class="text-[10px] text-slate-400 flex items-center justify-between font-mono border-t border-slate-800/60 pt-1.5">
            <span>🧠 ${d.cpu_percent || 0}%</span>
            <span>⚡ ${d.poe?.current_watts || 0}W</span>
          </div>
        `;

        grid.appendChild(cell);
      }

      shelfRow.appendChild(grid);
      container.appendChild(shelfRow);
    }
  }

  getThermalCardClass(d) {
    if (d.status === 'rebooting') return 'rebooting-card';
    if (d.status === 'shutdown') return 'shutdown-card';
    if (d.status === 'offline') return 'thermal-card-offline';
    const temp = d.temp_c || 0;
    if (temp < 40) return 'thermal-card-cool';
    if (temp < 50) return 'thermal-card-opt';
    if (temp < 65) return 'thermal-card-warm';
    return 'thermal-card-hot';
  }

  // ==========================================
  // 2D WALL MATRIX GRID (8 cols x 6 rows)
  // ==========================================
  render2DMatrix() {
    const grid = document.getElementById('grid-2d-matrix');
    if (!grid) return;

    const filterText = document.getElementById('search-nodes')?.value.toLowerCase().trim() || '';

    grid.innerHTML = '';

    for (let i = 1; i <= 48; i++) {
      const hostname = `picloud-${i}`;
      const d = this.nodes[hostname] || { hostname, node_id: i, status: 'offline', temp_c: 0, cpu_percent: 0, poe: {} };

      // Apply search filter
      if (filterText) {
        const matches =
          hostname.includes(filterText) ||
          (d.ip && d.ip.includes(filterText)) ||
          (d.status && d.status.includes(filterText)) ||
          (filterText === 'hot' && d.temp_c > 60) ||
          (filterText === 'warning' && d.status === 'warning') ||
          (filterText === 'reboot' && d.status === 'rebooting') ||
          (filterText === 'shutdown' && d.status === 'shutdown') ||
          (filterText === 'offline' && d.status === 'offline') ||
          (filterText === '100m' && d.network?.eth_speed_mbps === 100) ||
          (filterText === 'user' && (d.active_users > 0 || d.logged_in_user)) ||
          (filterText === 'ssh' && d.active_users > 0) ||
          (filterText === 'login' && d.active_users > 0) ||
          (d.logged_in_user && d.logged_in_user.toLowerCase().includes(filterText));
        if (!matches) continue;
      }

      const card = document.createElement('div');
      card.id = `card-${hostname}`;
      card.className = this.getCardClasses(d);
      card.onclick = () => this.openDrawer(hostname);
      card.innerHTML = this.getCardInnerHtml(d);

      grid.appendChild(card);
    }
  }

  update2DCard(hostname, data) {
    const card = document.getElementById(`card-${hostname}`);
    if (!card) return;
    card.className = this.getCardClasses(data);
    card.innerHTML = this.getCardInnerHtml(data);
  }

  getCardClasses(d) {
    const base = 'glass-panel rounded-xl p-3 cursor-pointer transition hover:scale-[1.02] flex flex-col justify-between border-slate-800';
    if (d.status === 'rebooting') {
      return `${base} rebooting-card`;
    }
    if (d.status === 'shutdown') {
      return `${base} shutdown-card`;
    }
    if (d.status === 'offline') {
      return `${base} offline-card`;
    }
    return `${base} ${this.getHeatBorderClass(d.temp_c)}`;
  }

  getCardInnerHtml(d) {
    if (d.status === 'rebooting') {
      return `
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
            <span class="font-bold text-xs text-white">#${d.node_id}</span>
          </div>
          <span class="text-[10px] font-mono font-bold text-amber-400 uppercase animate-pulse">REBOOT</span>
        </div>
        <div class="mt-2 text-[10px] text-amber-300/90 flex items-center justify-between font-mono">
          <span>🔄 Restarting...</span>
          <span>⚡ ${d.poe?.current_watts || 0}W</span>
        </div>
      `;
    }

    if (d.status === 'shutdown') {
      return `
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
            <span class="font-bold text-xs text-white">#${d.node_id}</span>
          </div>
          <span class="text-[10px] font-mono font-bold text-rose-400 uppercase animate-pulse">SHUTDOWN</span>
        </div>
        <div class="mt-2 text-[10px] text-rose-300/90 flex items-center justify-between font-mono">
          <span>🛑 Powering off...</span>
          <span>⚡ ${d.poe?.current_watts || 0}W</span>
        </div>
      `;
    }

    if (d.status === 'offline') {
      return `
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-slate-600"></span>
            <span class="font-bold text-xs text-slate-400">#${d.node_id}</span>
          </div>
          <span class="text-[10px] font-mono font-bold text-slate-500 uppercase">OFFLINE</span>
        </div>
        <div class="mt-2 text-[10px] text-slate-500 flex items-center justify-between font-mono">
          <span>❌ Heartbeat lost</span>
          <span>-- W</span>
        </div>
      `;
    }

    const dotColor = d.status === 'online' ? 'bg-emerald-400' : 'bg-amber-400';
    const activeLogins = d.active_users || 0;
    return `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full ${dotColor}"></span>
          <span class="font-bold text-xs text-white">#${d.node_id}</span>
          ${activeLogins > 0 ? `<span class="text-[9px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 font-mono font-semibold" title="${activeLogins} active SSH ${activeLogins === 1 ? 'login' : 'logins'}">🔑 ${activeLogins}</span>` : ''}
        </div>
        <span class="text-[11px] font-mono font-semibold ${this.getTempColorClass(d.temp_c)}">${d.temp_c ? d.temp_c + '°C' : '--'}</span>
      </div>
      <div class="mt-2 text-[10px] text-slate-400 flex items-center justify-between font-mono">
        <span>🧠 ${d.cpu_percent || 0}%</span>
        <span>⚡ ${d.poe?.current_watts || 0}W</span>
      </div>
    `;
  }

  getHeatBorderClass(temp) {
    if (!temp || temp < 42) return 'heat-border-cool';
    if (temp < 52) return 'heat-border-opt';
    if (temp < 65) return 'heat-border-warm';
    return 'heat-border-hot';
  }

  getTempColorClass(temp) {
    if (!temp || temp < 42) return 'text-cyan-400';
    if (temp < 52) return 'text-emerald-400';
    if (temp < 65) return 'text-amber-400';
    return 'text-rose-400';
  }

  // ==========================================
  // REAL-TIME CHARTS (Chart.js)
  // ==========================================
  initCharts() {
    const powerCtx = document.getElementById('chart-power')?.getContext('2d');
    const tempCtx = document.getElementById('chart-temp')?.getContext('2d');
    const cpuCtx = document.getElementById('chart-cpu')?.getContext('2d');

    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(51, 65, 85, 0.2)' }, ticks: { color: '#94a3b8', font: { size: 9 }, maxTicksLimit: 6 } },
        y: { grid: { color: 'rgba(51, 65, 85, 0.2)' }, ticks: { color: '#94a3b8', font: { size: 9 } } }
      }
    };

    if (powerCtx) {
      this.charts.power = new Chart(powerCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.1)', fill: true, tension: 0.3 }] },
        options: commonOpts
      });
    }

    if (tempCtx) {
      this.charts.temp = new Chart(tempCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            { data: [], borderColor: '#10b981', label: 'Avg', tension: 0.3 },
            { data: [], borderColor: '#f59e0b', label: 'Peak', tension: 0.3 }
          ]
        },
        options: commonOpts
      });
    }

    if (cpuCtx) {
      this.charts.cpu = new Chart(cpuCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#818cf8', backgroundColor: 'rgba(129, 140, 248, 0.1)', fill: true, tension: 0.3 }] },
        options: commonOpts
      });
    }
  }

  updateCharts(history) {
    if (!history || !history.length) return;
    const labels = history.map((h) => h.time);

    if (this.charts.power) {
      this.charts.power.data.labels = labels;
      this.charts.power.data.datasets[0].data = history.map((h) => h.totalWatts);
      this.charts.power.update();
    }

    if (this.charts.temp) {
      this.charts.temp.data.labels = labels;
      this.charts.temp.data.datasets[0].data = history.map((h) => h.avgTemp);
      this.charts.temp.data.datasets[1].data = history.map((h) => (this.summary.maxTempC || h.avgTemp));
      this.charts.temp.update();
    }

    if (this.charts.cpu) {
      this.charts.cpu.data.labels = labels;
      this.charts.cpu.data.datasets[0].data = history.map((h) => h.avgCpu);
      this.charts.cpu.update();
    }
  }

  renderCharts() {
    this.updateCharts(this.history);
  }

  // ==========================================
  // NODE INSPECTION DRAWER & ACTIONS
  // ==========================================
  openDrawer(hostname) {
    this.selectedHostname = hostname;
    const node = this.nodes[hostname];
    if (!node) return;

    // Load and mirror current settings from the node's MQTT telemetry
    this.loadNodeFanSettings(node);

    // Ensure recent history collapsible is closed by default
    const historyDetails = document.getElementById('drawer-ssh-history-details');
    if (historyDetails) {
      historyDetails.removeAttribute('open');
    }

    this.updateDrawerContent(node);
    this.updateDrawerInteractiveState(node);
    document.getElementById('node-drawer')?.classList.remove('translate-x-full');

    // Also focus camera in 3D
    if (this.wallTwin) {
      this.wallTwin.focusNode(hostname);
    }
    if (this.twin3d) {
      this.twin3d.focusNode(hostname);
    }
  }

  closeDrawer() {
    this.selectedHostname = null;
    document.getElementById('node-drawer')?.classList.add('translate-x-full');
    if (this.wallTwin) {
      this.wallTwin.setCameraPreset('front');
    }
    if (this.twin3d) {
      this.twin3d.resetView();
    }
  }

  formatHumanDuration(totalSeconds) {
    const sec = Math.max(0, parseInt(totalSeconds, 10) || 0);
    if (sec < 60) return '<1 min';

    const totalMins = Math.floor(sec / 60);
    if (totalMins < 60) {
      return totalMins === 1 ? '1 min' : `${totalMins} mins`;
    }

    const totalHours = Math.floor(totalMins / 60);
    const minsRem = totalMins % 60;
    const minStr = minsRem === 1 ? '1 min' : `${minsRem} mins`;

    if (totalHours < 24) {
      const hrStr = totalHours === 1 ? '1 hr' : `${totalHours} hrs`;
      return `${hrStr} ${minStr}`;
    }

    const days = Math.floor(totalHours / 24);
    const hoursRem = totalHours % 24;
    const dayStr = days === 1 ? '1 day' : `${days} days`;
    const hrStr = hoursRem === 1 ? '1 hour' : `${hoursRem} hours`;
    return `${dayStr} ${hrStr} ${minStr}`;
  }

  parseAndFormatDuration(durStr) {
    if (!durStr || typeof durStr !== 'string' || durStr === 'N/A' || durStr === 'Active') {
      return durStr;
    }
    const matchWithDays = durStr.match(/^(\d+)\+(\d{1,2}):(\d{2})$/);
    if (matchWithDays) {
      const days = parseInt(matchWithDays[1], 10);
      const hrs = parseInt(matchWithDays[2], 10);
      const mins = parseInt(matchWithDays[3], 10);
      const sec = ((days * 24 + hrs) * 60 + mins) * 60;
      return this.formatHumanDuration(sec);
    }
    const matchHhMm = durStr.match(/^(\d{1,2}):(\d{2})$/);
    if (matchHhMm) {
      const hrs = parseInt(matchHhMm[1], 10);
      const mins = parseInt(matchHhMm[2], 10);
      const sec = (hrs * 60 + mins) * 60;
      return this.formatHumanDuration(sec);
    }
    return durStr;
  }

  updateDrawerContent(d) {
    setText('drawer-id', `#${d.node_id}`);
    setText('drawer-hostname', d.hostname);
    setText('drawer-ip', d.ip);

    const statusBadge = document.getElementById('drawer-status-badge');
    if (statusBadge) {
      if (d.status === 'online') {
        statusBadge.textContent = '● Online';
        statusBadge.className = 'text-emerald-400 font-medium';
      } else if (d.status === 'rebooting') {
        statusBadge.textContent = '🔄 Rebooting...';
        statusBadge.className = 'text-amber-400 font-medium animate-pulse';
      } else if (d.status === 'shutdown') {
        statusBadge.textContent = '🛑 Shutting down...';
        statusBadge.className = 'text-rose-400 font-medium animate-pulse';
      } else if (d.status === 'warning') {
        statusBadge.textContent = '⚠️ Warning';
        statusBadge.className = 'text-amber-400 font-medium';
      } else {
        statusBadge.textContent = '❌ Offline';
        statusBadge.className = 'text-slate-500 font-medium';
      }
    }

    setText('drawer-temp', `${d.temp_c || '--'}°C`);
    setText('drawer-cpu', `${d.cpu_percent || '--'}%`);
    setText('drawer-power', `${d.poe?.current_watts || '--'} W`);

    setText('drawer-amps', `${d.poe?.current_amps || 0} A`);
    setText('drawer-energy', `${d.power_and_hardware?.cumulative_energy_wh || 0} Wh`);
    setText('drawer-fan', `Level ${d.power_and_hardware?.fan_state ?? 0}`);
    setText('drawer-freq', `${d.cpu_freq_mhz || 0} MHz`);

    // Update PoE Fan Control UI
    this.updateDrawerFanUI(d);

    // Throttled bitmask
    const throttled = d.power_and_hardware?.throttled;
    const throttledBadge = document.getElementById('drawer-throttled-badge');
    if (throttledBadge) {
      if (throttled?.healthy === false) {
        throttledBadge.textContent = `${throttled.hex} (Throttled!)`;
        throttledBadge.className = 'font-mono text-amber-400 font-bold';
      } else {
        throttledBadge.textContent = '0x0 (Healthy)';
        throttledBadge.className = 'font-mono text-emerald-400';
      }
    }

    setText('drawer-mem', `${d.memory_percent || 0}%`);
    setText('drawer-ram', `${d.memory_available_mb || 0} MB`);
    setText('drawer-disk', `${d.disk_percent || 0}%`);
    setText('drawer-disk-free', `${d.disk_free_gb || 0} GB`);
    setText('drawer-zram', d.zram ? `${d.zram.ratio}x` : 'N/A');

    const uptimeHrs = Math.floor((d.uptime_seconds || 0) / 3600);
    setText('drawer-uptime', `${uptimeHrs}h (${d.active_users || 0} users)`);

    setText('drawer-eth-speed', `${d.network?.eth_speed_mbps || 0} Mbps`);
    setText('drawer-ping', `${d.network?.ping_ms || 0} ms`);
    setText('drawer-rx', `${d.network?.rx_kb_s || 0} KB/s`);
    setText('drawer-tx', `${d.network?.tx_kb_s || 0} KB/s`);

    // SSH & Active Sessions Section
    const ssh = d.ssh || {};
    // Exclusively track interactive SSH sessions (pts/*) - strictly ignore local console autologins (tty1, etc.)
    const activeSessions = (ssh.active_sessions || []).filter((s) => {
      const term = s.terminal || '';
      return term.startsWith('pts') || (s.host && s.host !== 'local' && !term.startsWith('tty'));
    });
    const activeLoginsCount = activeSessions.length;

    const sshStatusBadge = document.getElementById('drawer-ssh-status-badge');
    if (sshStatusBadge) {
      if (ssh.sshd_running === false) {
        sshStatusBadge.textContent = 'SSH Inactive';
        sshStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 font-mono';
      } else if (activeLoginsCount > 0) {
        sshStatusBadge.textContent = '● Active Session';
        sshStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono font-medium';
      } else {
        sshStatusBadge.textContent = 'SSH Listening';
        sshStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 font-mono';
      }
    }

    setText('drawer-ssh-active-count', `${activeLoginsCount}`);
    
    const activeStateEl = document.getElementById('drawer-ssh-active-state');
    if (activeStateEl) {
      activeStateEl.textContent = activeLoginsCount > 0 ? 'Active' : 'Idle';
      activeStateEl.className = activeLoginsCount > 0 ? 'text-emerald-400 font-mono font-semibold' : 'text-slate-400 font-mono';
    }

    if (activeSessions.length > 0) {
      const first = activeSessions[0];
      const sec = Math.max(0, parseInt(first.duration_seconds, 10) || 0);
      let durText;
      if (typeof first.duration_seconds === 'number' && !isNaN(first.duration_seconds)) {
        durText = this.formatHumanDuration(sec);
      } else if (first.duration && (first.duration.includes(':') || first.duration.includes('+'))) {
        durText = this.parseAndFormatDuration(first.duration);
      } else {
        durText = first.duration || '<1 min';
      }
      setText('drawer-ssh-client-ip', first.host || 'local');
      setText('drawer-ssh-duration', durText);
    } else {
      setText('drawer-ssh-client-ip', '--');
      setText('drawer-ssh-duration', '--');
    }

    // Helper to test if a terminal or session represents remote SSH (accept pts, ssh, or remote host)
    const isSshSession = (s) => {
      if (!s) return false;
      const term = s.terminal || '';
      return term.startsWith('pts') || term.includes('ssh') || term === 'ssh' || (s.host && s.host !== 'local' && !term.startsWith('tty'));
    };

    // Recent Sessions History List (Collapsible) - filter to genuine SSH sessions
    const recent = (ssh.recent_sessions || []).filter(isSshSession);
    setText('drawer-ssh-history-count', `${recent.length}`);

    // Last Login Details (ignore local tty consoles)
    const lastLogin = (ssh.last_login && isSshSession(ssh.last_login))
      ? ssh.last_login
      : (recent.length > 0 ? recent[0] : null);

    if (lastLogin) {
      const hostPart = lastLogin.host && lastLogin.host !== 'local' ? `${lastLogin.host} · ` : '';
      const rawTime = (lastLogin.time || lastLogin.login_time || '--').replace(/\s*-\s*$/, '').trim();
      const loginStr = `${hostPart}${rawTime}`;
      setText('drawer-ssh-last-login-info', loginStr);
      const el = document.getElementById('drawer-ssh-last-login-info');
      if (el) el.title = loginStr;
    } else {
      setText('drawer-ssh-last-login-info', '--');
    }

    // Last Logout / Session Closed Event (ignore local tty consoles)
    const lastLogout = (ssh.last_logout && (isSshSession(ssh.last_logout) || ssh.last_logout.logout_time))
      ? ssh.last_logout
      : (recent.find((s) => !s.is_active) || null);

    if (lastLogout) {
      const formattedDur = this.parseAndFormatDuration(lastLogout.duration);
      const rawLogoutTime = (lastLogout.logout_time || '--').replace(/\s*-\s*$/, '').trim();
      const logoutStr = `${rawLogoutTime} (${formattedDur || '--'})`;
      setText('drawer-ssh-last-logout-info', logoutStr);
      const el = document.getElementById('drawer-ssh-last-logout-info');
      if (el) el.title = logoutStr;
    } else {
      setText('drawer-ssh-last-logout-info', 'None recorded');
    }

    const recentListEl = document.getElementById('drawer-ssh-recent-list');
    if (recentListEl) {
      if (recent.length > 0) {
        recentListEl.innerHTML = recent.slice(0, 5).map((s) => {
          const durDisplay = s.is_active ? 'Active' : this.parseAndFormatDuration(s.duration);
          return `
            <div class="p-1.5 rounded bg-slate-950/70 border border-slate-800/80 flex items-center justify-between text-[10px]">
              <div class="flex items-center gap-1.5 truncate max-w-[55%]">
                <span class="${s.is_active ? 'text-emerald-400' : 'text-slate-500'}">●</span>
                <span class="font-mono text-slate-200 font-semibold truncate" title="${s.host || 'local'}">${s.host || 'local'}</span>
                <span class="text-slate-500 font-mono text-[9px]">${s.terminal}</span>
              </div>
              <div class="text-right text-slate-400 font-mono text-[10px] truncate max-w-[45%]" title="${s.is_active ? 'Logged In' : (s.logout_time || '--')} (${durDisplay})">
                ${s.is_active ? '<span class="text-emerald-400 font-medium">Logged In</span>' : `${s.logout_time || '--'}`}
                <span class="text-slate-500">(${durDisplay})</span>
              </div>
            </div>
          `;
        }).join('');
      } else {
        recentListEl.innerHTML = '<div class="text-slate-500 italic text-[10px]">No recent session history recorded.</div>';
      }
    }

    // Update command button states based on auth
    this.updateCommandButtonsState();
  }

  setupDrawerHandlers() {
    document.getElementById('close-drawer-btn')?.addEventListener('click', () => this.closeDrawer());
    document.getElementById('hint-login-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openLoginModal();
    });

    // Escape key handling: in fullscreen mode, exits fullscreen and closes side view;
    // in normal mode, closes model drawer / modals and zooms back out to show all shelves.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const confirmModal = document.getElementById('confirm-modal');
        const loginModal = document.getElementById('login-modal');
        const drawer = document.getElementById('node-drawer');
        const container = document.getElementById('view-container-3d');

        const isConfirmOpen = confirmModal && !confirmModal.classList.contains('hidden');
        const isLoginOpen = loginModal && !loginModal.classList.contains('hidden');
        const isFullscreen = container && container.classList.contains('fullscreen-active');

        if (isConfirmOpen) {
          confirmModal.classList.add('hidden');
          return;
        }

        if (isLoginOpen) {
          loginModal.classList.add('hidden');
          return;
        }

        const wallContainer = document.getElementById('view-container-twin');
        const isWallFullscreen = wallContainer && wallContainer.classList.contains('fullscreen-active');
        if (isWallFullscreen) {
          this.toggleWallFullscreen(false);
          this.closeDrawer();
          return;
        }

        if (isFullscreen) {
          // If in fullscreen mode: exit fullscreen and close side view
          this.toggleFullscreen(false);
          this.closeDrawer();
          return;
        }

        // In normal mode: close drawer if open and reset view
        const isDrawerOpen = drawer && !drawer.classList.contains('translate-x-full');
        if (isDrawerOpen || this.selectedHostname || (this.twin3d && this.twin3d.isZoomedIn)) {
          this.closeDrawer();
        }
      }
    });
  }

  // ==========================================
  // POE FAN CONTROLLER & TELEMETRY
  // ==========================================
  loadNodeFanSettings(node) {
    if (!node) return;
    const fan = node.power_and_hardware?.fan || {};
    const fanState = node.power_and_hardware?.fan_state ?? fan.state ?? 0;

    let mode = 'auto';
    if (fan.mode && ['auto', 'on', 'off'].includes(fan.mode.toLowerCase())) {
      mode = fan.mode.toLowerCase();
    } else if (fan.manual_override) {
      mode = fanState > 0 ? 'on' : 'off';
    }

    let speed = parseInt(fan.speed, 10);
    if (isNaN(speed) || speed < 1 || speed > 4) {
      speed = fanState > 0 ? fanState : 2;
    }

    let tempOn = parseInt(fan.temp_on, 10);
    if (isNaN(tempOn)) tempOn = 48;

    let tempOff = parseInt(fan.temp_off, 10);
    if (isNaN(tempOff)) tempOff = 42;

    this.fanDrawerState = {
      mode,
      speed,
      temp_on: tempOn,
      temp_off: tempOff
    };
  }

  updateDrawerFanUI(d) {
    this.renderFanUI(d);
  }

  renderFanUI(d) {
    const node = d || (this.selectedHostname ? this.nodes[this.selectedHostname] : null);
    const fan = node?.power_and_hardware?.fan || {};
    const fanState = node?.power_and_hardware?.fan_state ?? fan.state ?? 0;
    const mode = this.fanDrawerState.mode;
    const speed = this.fanDrawerState.speed;
    const tempOn = this.fanDrawerState.temp_on;
    const tempOff = this.fanDrawerState.temp_off;

    // 1. Live status badge
    const badge = document.getElementById('drawer-fan-status-badge');
    if (badge) {
      if (mode === 'on') {
        badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span> Forced ON (L${speed || fanState || 2})`;
        badge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono font-medium flex items-center gap-1';
      } else if (mode === 'off') {
        badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> Forced OFF`;
        badge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 font-mono font-medium flex items-center gap-1';
      } else {
        if (fanState > 0) {
          badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-spin"></span> Active (L${fanState})`;
          badge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 font-mono font-medium flex items-center gap-1';
        } else {
          badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Idle (Off)`;
          badge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 font-mono font-medium flex items-center gap-1';
        }
      }
    }

    // 2. Mode buttons highlighting
    const modeAutoBtn = document.getElementById('fan-mode-auto-btn');
    const modeOnBtn = document.getElementById('fan-mode-on-btn');
    const modeOffBtn = document.getElementById('fan-mode-off-btn');
    const modeDesc = document.getElementById('fan-mode-desc');

    const inactiveModeClass = 'px-2 py-1.5 rounded-md font-medium text-center transition flex items-center justify-center gap-1 text-slate-400 hover:text-white border border-transparent hover:bg-slate-800/60 cursor-pointer';
    if (modeAutoBtn) {
      modeAutoBtn.className = (mode === 'auto')
        ? 'px-2 py-1.5 rounded-md font-medium text-center transition flex items-center justify-center gap-1 bg-sky-600/30 text-sky-300 border border-sky-500/40 shadow-sm cursor-pointer'
        : inactiveModeClass;
    }
    if (modeOnBtn) {
      modeOnBtn.className = (mode === 'on')
        ? 'px-2 py-1.5 rounded-md font-medium text-center transition flex items-center justify-center gap-1 bg-amber-600/30 text-amber-300 border border-amber-500/40 shadow-sm cursor-pointer'
        : inactiveModeClass;
    }
    if (modeOffBtn) {
      modeOffBtn.className = (mode === 'off')
        ? 'px-2 py-1.5 rounded-md font-medium text-center transition flex items-center justify-center gap-1 bg-rose-600/30 text-rose-300 border border-rose-500/40 shadow-sm cursor-pointer'
        : inactiveModeClass;
    }

    if (modeDesc) {
      if (mode === 'on') modeDesc.textContent = 'Manual Override: Forced ON';
      else if (mode === 'off') modeDesc.textContent = 'Manual Override: Forced OFF';
      else modeDesc.textContent = 'Automatic Thermal Policy';
    }

    // 3. Thresholds container opacity in manual modes
    const threshContainer = document.getElementById('fan-thresholds-container');
    if (threshContainer) {
      threshContainer.style.opacity = (mode === 'auto') ? '1' : '0.65';
    }

    // 4. Running Speed Level label & toggle buttons
    const speedDesc = document.getElementById('fan-speed-desc');
    const speedNames = ['', 'Level 1 (Quiet)', 'Level 2 (Balanced)', 'Level 3 (High)', 'Level 4 (Max)'];
    if (speedDesc) speedDesc.textContent = speedNames[speed] || `Level ${speed}`;

    for (let s = 1; s <= 4; s++) {
      const btn = document.getElementById(`fan-speed-${s}-btn`);
      if (btn) {
        if (s === speed) {
          btn.className = 'py-1 rounded text-center font-mono text-[11px] bg-sky-600/30 text-sky-300 border border-sky-500/40 font-semibold shadow-sm cursor-pointer';
        } else {
          btn.className = 'py-1 rounded text-center font-mono text-[11px] text-slate-400 hover:text-white border border-transparent hover:bg-slate-800/60 font-normal cursor-pointer';
        }
      }
    }

    // 5. Sliders and text values
    const onSlider = document.getElementById('fan-temp-on-slider');
    const offSlider = document.getElementById('fan-temp-off-slider');
    const onVal = document.getElementById('fan-temp-on-val');
    const offVal = document.getElementById('fan-temp-off-val');
    const hystInfo = document.getElementById('fan-hysteresis-info');

    if (onSlider && document.activeElement !== onSlider) onSlider.value = tempOn;
    if (offSlider && document.activeElement !== offSlider) offSlider.value = tempOff;
    if (onVal) onVal.textContent = `${tempOn}°C`;
    if (offVal) offVal.textContent = `${tempOff}°C`;

    if (hystInfo) {
      const diff = tempOn - tempOff;
      const curT = node?.temp_c ? ` • Current: ${node.temp_c}°C` : '';
      hystInfo.textContent = `${diff}°C deadband (Off ≤ ${tempOff}°C • On ≥ ${tempOn}°C${curT})`;
    }

    this.updateDrawerInteractiveState(node);
  }

  async setFanMode(m) {
    if (!this.selectedHostname) return;
    const node = this.nodes[this.selectedHostname];
    if (!node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning')) return;
    this.fanDrawerState.mode = m;

    if (node) {
      if (!node.power_and_hardware) node.power_and_hardware = {};
      if (!node.power_and_hardware.fan) node.power_and_hardware.fan = {};
      node.power_and_hardware.fan.mode = m;
      node.power_and_hardware.fan.manual_override = (m === 'on' || m === 'off');
      if (m === 'on') {
        node.power_and_hardware.fan_state = this.fanDrawerState.speed;
        node.power_and_hardware.fan.state = this.fanDrawerState.speed;
      } else if (m === 'off') {
        node.power_and_hardware.fan_state = 0;
        node.power_and_hardware.fan.state = 0;
      }
    }

    // Immediately highlight when pressed
    this.renderFanUI(node);

    // Immediately send MQTT command to set fans
    await this.sendNodeCommand(this.selectedHostname, 'fan', {
      mode: m,
      speed: this.fanDrawerState.speed,
      temp_on: this.fanDrawerState.temp_on,
      temp_off: this.fanDrawerState.temp_off
    });
  }

  setFanSpeedLevel(s) {
    if (!this.selectedHostname) return;
    const node = this.nodes[this.selectedHostname];
    if (!node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning')) return;
    this.fanDrawerState.speed = s;

    // Adjust sliders according to selected speed level profile
    const speedProfiles = {
      1: { on: 55, off: 48 }, // Level 1 (Quiet)
      2: { on: 48, off: 42 }, // Level 2 (Balanced)
      3: { on: 44, off: 38 }, // Level 3 (High)
      4: { on: 40, off: 35 }  // Level 4 (Max)
    };

    const prof = speedProfiles[s] || speedProfiles[2];
    this.fanDrawerState.temp_on = prof.on;
    this.fanDrawerState.temp_off = prof.off;

    // Toggles button, changes label, adjusts sliders (applied when Apply button is pressed)
    this.renderFanUI();
  }

  async applyFanSettings() {
    if (!this.selectedHostname) return;
    const node = this.nodes[this.selectedHostname];
    if (!node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning')) return;
    const applyBtn = document.getElementById('fan-apply-btn');
    const originalHtml = applyBtn ? applyBtn.innerHTML : '';
    if (applyBtn) {
      applyBtn.innerHTML = '<span>⏳</span> Sending MQTT Command...';
      applyBtn.disabled = true;
    }
    if (node) {
      if (!node.power_and_hardware) node.power_and_hardware = {};
      if (!node.power_and_hardware.fan) node.power_and_hardware.fan = {};
      node.power_and_hardware.fan.mode = this.fanDrawerState.mode;
      node.power_and_hardware.fan.speed = this.fanDrawerState.speed;
      node.power_and_hardware.fan.temp_on = this.fanDrawerState.temp_on;
      node.power_and_hardware.fan.temp_off = this.fanDrawerState.temp_off;
      if (this.fanDrawerState.mode === 'on') {
        node.power_and_hardware.fan_state = this.fanDrawerState.speed;
      }
    }

    await this.sendNodeCommand(this.selectedHostname, 'fan', {
      mode: this.fanDrawerState.mode,
      speed: this.fanDrawerState.speed,
      temp_on: this.fanDrawerState.temp_on,
      temp_off: this.fanDrawerState.temp_off
    });

    this.renderFanUI(node);

    if (applyBtn) {
      applyBtn.innerHTML = `<span>✓</span> Applied to ${this.selectedHostname} (Level ${this.fanDrawerState.speed})!`;
      setTimeout(() => {
        applyBtn.innerHTML = originalHtml;
        applyBtn.disabled = false;
      }, 2000);
    }
  }

  setupFanControls() {
    const updateLocalHysteresis = () => {
      const onVal = document.getElementById('fan-temp-on-val');
      const offVal = document.getElementById('fan-temp-off-val');
      const hystInfo = document.getElementById('fan-hysteresis-info');
      if (onVal) onVal.textContent = `${this.fanDrawerState.temp_on}°C`;
      if (offVal) offVal.textContent = `${this.fanDrawerState.temp_off}°C`;
      if (hystInfo) {
        const diff = this.fanDrawerState.temp_on - this.fanDrawerState.temp_off;
        const node = this.selectedHostname ? this.nodes[this.selectedHostname] : null;
        const curT = node?.temp_c ? ` • Current: ${node.temp_c}°C` : '';
        hystInfo.textContent = `${diff}°C deadband (Off ≤ ${this.fanDrawerState.temp_off}°C • On ≥ ${this.fanDrawerState.temp_on}°C${curT})`;
      }
    };

    // Mode button clicks: immediately highlights and dispatches MQTT command
    document.getElementById('fan-mode-auto-btn')?.addEventListener('click', () => this.setFanMode('auto'));
    document.getElementById('fan-mode-on-btn')?.addEventListener('click', () => this.setFanMode('on'));
    document.getElementById('fan-mode-off-btn')?.addEventListener('click', () => this.setFanMode('off'));

    // Speed button clicks: toggles active button, changes label, adjusts sliders
    for (let s = 1; s <= 4; s++) {
      document.getElementById(`fan-speed-${s}-btn`)?.addEventListener('click', () => {
        this.setFanSpeedLevel(s);
      });
    }

    // Slider inputs
    const onSlider = document.getElementById('fan-temp-on-slider');
    const offSlider = document.getElementById('fan-temp-off-slider');

    onSlider?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      this.fanDrawerState.temp_on = val;
      if (val <= this.fanDrawerState.temp_off) {
        this.fanDrawerState.temp_off = Math.max(30, val - 2);
        if (offSlider) offSlider.value = this.fanDrawerState.temp_off;
      }
      updateLocalHysteresis();
    });

    offSlider?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      this.fanDrawerState.temp_off = val;
      if (val >= this.fanDrawerState.temp_on) {
        this.fanDrawerState.temp_on = Math.min(75, val + 2);
        if (onSlider) onSlider.value = this.fanDrawerState.temp_on;
      }
      updateLocalHysteresis();
    });

    // Presets
    const applyPreset = (on, off, spd) => {
      this.fanDrawerState.temp_on = on;
      this.fanDrawerState.temp_off = off;
      if (spd) this.fanDrawerState.speed = spd;
      this.renderFanUI();
    };
    document.getElementById('fan-preset-cool')?.addEventListener('click', () => applyPreset(44, 38, 3));
    document.getElementById('fan-preset-balanced')?.addEventListener('click', () => applyPreset(48, 42, 2));
    document.getElementById('fan-preset-silent')?.addEventListener('click', () => applyPreset(55, 48, 1));

    // Apply button: sends settings over MQTT
    document.getElementById('fan-apply-btn')?.addEventListener('click', () => {
      this.applyFanSettings();
    });
  }

  // ==========================================
  // COMMAND ACTIONS & OIDC PROTECTION
  // ==========================================
  setupCommandHandlers() {
    // 1. Identify / Locate (Public or Auth)
    document.getElementById('cmd-identify-btn')?.addEventListener('click', () => {
      if (!this.selectedHostname) return;
      const node = this.nodes[this.selectedHostname];
      if (!node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning')) return;
      this.sendNodeCommand(this.selectedHostname, 'identify', { duration: 10 });
    });

    // 2. Poll Metrics (Public or Auth)
    document.getElementById('cmd-poll-btn')?.addEventListener('click', () => {
      if (!this.selectedHostname) return;
      const node = this.nodes[this.selectedHostname];
      if (!node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning')) return;
      this.sendNodeCommand(this.selectedHostname, 'metrics');
    });

    // 3. Cluster Refresh Poll
    document.getElementById('refresh-all-btn')?.addEventListener('click', () => {
      this.sendNodeCommand('all', 'metrics');
    });

    // 4. Reboot (Protected)
    document.getElementById('cmd-reboot-btn')?.addEventListener('click', () => {
      if (!this.selectedHostname) return;
      const node = this.nodes[this.selectedHostname];
      if (!node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning')) return;
      this.promptProtectedAction('reboot', `Reboot ${this.selectedHostname}? It will restart and reconnect in ~15 seconds.`, () => {
        this.sendNodeCommand(this.selectedHostname, 'reboot');
      });
    });

    // 5. Shutdown (Protected)
    document.getElementById('cmd-shutdown-btn')?.addEventListener('click', () => {
      if (!this.selectedHostname) return;
      const node = this.nodes[this.selectedHostname];
      if (!node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning')) return;
      this.promptProtectedAction(
        'shutdown',
        `Halt and power off ${this.selectedHostname}?`,
        () => {
          this.sendNodeCommand(this.selectedHostname, 'shutdown');
        },
        'Warning: The unit will have to be manually switched back on if pressed.'
      );
    });
  }

  promptProtectedAction(actionType, message, onConfirm, warningText) {
    if (!this.currentUser) {
      this.openLoginModal();
      return;
    }

    const modal = document.getElementById('confirm-modal');
    const title = document.getElementById('modal-title');
    const desc = document.getElementById('modal-desc');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    const cancelBtn = document.getElementById('modal-cancel-btn');
    const warningBox = document.getElementById('modal-warning-box');
    const warningEl = document.getElementById('modal-warning-text');

    if (!modal) return;
    title.textContent = `Confirm ${actionType.toUpperCase()}`;
    desc.textContent = message;

    if (warningBox) {
      if (warningText || actionType === 'shutdown') {
        if (warningEl) {
          warningEl.textContent = warningText || 'Warning: The unit will have to be manually switched back on if pressed.';
        }
        warningBox.classList.remove('hidden');
      } else {
        warningBox.classList.add('hidden');
      }
    }

    modal.classList.remove('hidden');

    const handleConfirm = () => {
      modal.classList.add('hidden');
      cleanup();
      onConfirm();
    };

    const handleCancel = () => {
      modal.classList.add('hidden');
      cleanup();
    };

    const cleanup = () => {
      confirmBtn.removeEventListener('click', handleConfirm);
      cancelBtn.removeEventListener('click', handleCancel);
    };

    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
  }

  async sendNodeCommand(hostname, cmd, options = {}) {
    if (hostname !== 'all') {
      const node = this.nodes[hostname];
      if (node && (node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning'))) {
        console.warn(`[CMD] Cannot dispatch command to offline node ${hostname}`);
        return;
      }
    }
    try {
      const res = await fetch(`/api/nodes/${hostname}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, ...options })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          this.openLoginModal();
        } else {
          alert(`Command error: ${data.error}`);
        }
        return;
      }
      console.log(`[CMD] ${data.message}`);

      // User notification for dispatched MQTT command
      let cmdTitle = cmd.toUpperCase();
      if (cmd === 'identify') cmdTitle = 'Identify (Locate 10s)';
      else if (cmd === 'metrics') cmdTitle = hostname === 'all' ? 'Poll All Metrics' : 'Poll Metrics';
      else if (cmd === 'reboot') cmdTitle = 'Reboot Node';
      else if (cmd === 'shutdown') cmdTitle = 'Halt / Shutdown';
      else if (cmd === 'fan') {
        const modeLabel = options.mode ? options.mode.toUpperCase() : 'AUTO';
        cmdTitle = `PoE Fan Control (${modeLabel})`;
      }

      const targetLabel = hostname === 'all' ? 'Cluster (All 48 Nodes)' : hostname;
      this.showMqttNotification(cmdTitle, targetLabel);
    } catch (err) {
      console.error('[CMD] Failed to dispatch command:', err);
    }
  }

  showMqttNotification(title, target) {
    const container = document.getElementById('mqtt-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'pointer-events-auto transform transition-all duration-300 ease-out -translate-y-4 opacity-0 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-900/95 border border-sky-500/40 shadow-2xl shadow-sky-950/80 backdrop-blur-md text-white cursor-pointer select-none';
    
    const timeStr = new Date().toLocaleTimeString();

    toast.innerHTML = `
      <div class="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 text-sm shadow-inner shrink-0">
        📡
      </div>
      <div class="flex flex-col min-w-0 pr-1">
        <div class="text-xs font-semibold flex items-center gap-2 flex-wrap">
          <span class="text-sky-400 font-mono font-bold text-[10px] bg-sky-950/90 px-1.5 py-0.5 rounded border border-sky-500/30 tracking-wider">MQTT CMD SENT</span>
          <span class="text-slate-100">${title}</span>
          <span class="text-sky-300 font-mono text-[11px] font-medium">&bull; ${target}</span>
        </div>
        <div class="text-[11px] text-slate-400 mt-0.5 flex items-center gap-2">
          <span>Sent: <span class="font-mono text-slate-200 font-medium">${timeStr}</span></span>
          <span class="text-slate-600">&bull;</span>
          <span class="text-emerald-400 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Dispatched to broker</span>
        </div>
      </div>
    `;

    toast.title = 'Click to dismiss';
    toast.addEventListener('click', () => {
      toast.classList.remove('translate-y-0', 'opacity-100');
      toast.classList.add('-translate-y-4', 'opacity-0');
      setTimeout(() => toast.remove(), 250);
    });

    container.appendChild(toast);

    // Trigger enter transition
    requestAnimationFrame(() => {
      toast.classList.remove('-translate-y-4', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
    });

    // Auto dismiss after 3.8s
    setTimeout(() => {
      if (!toast.parentNode) return;
      toast.classList.remove('translate-y-0', 'opacity-100');
      toast.classList.add('-translate-y-4', 'opacity-0');
      setTimeout(() => toast.remove(), 250);
    }, 3800);
  }

  // ==========================================
  // OIDC & AUTH MANAGEMENT
  // ==========================================
  async checkAuthStatus() {
    try {
      const res = await fetch('/auth/me');
      const data = await res.json();
      this.currentUser = data.authenticated ? data.user : null;
      this.updateAuthUi();

      // Dev mode button: if AUTH_DEV_MODE=false, hide Quick Dev Mode Sign-in button
      const devLoginBtn = document.getElementById('dev-login-btn');
      if (devLoginBtn) {
        devLoginBtn.classList.toggle('hidden', data.devMode === false);
      }

      // OIDC provider label on login button
      const oidcLabel = document.getElementById('oidc-login-label');
      if (oidcLabel) {
        if (data.oidcProvider && data.oidcProvider.trim()) {
          oidcLabel.textContent = `Sign in with ${data.oidcProvider}`;
        } else {
          oidcLabel.textContent = 'Sign in with OIDC Provider';
        }
      }
    } catch (err) {
      console.warn('[AUTH] Could not check session:', err);
    }
  }

  updateAuthUi() {
    const loginBtn = document.getElementById('login-btn');
    const userProfile = document.getElementById('user-profile');
    const userName = document.getElementById('user-name');
    const userEmail = document.getElementById('user-email');
    const userAvatar = document.getElementById('user-avatar');

    if (this.currentUser) {
      loginBtn?.classList.add('hidden');
      userProfile?.classList.remove('hidden');
      if (userName) userName.textContent = this.currentUser.name || 'Admin';
      if (userEmail) {
        userEmail.textContent = this.currentUser.email || '';
        userEmail.classList.toggle('hidden', !this.currentUser.email);
      }
      if (userAvatar) {
        const avatar = this.currentUser.avatar;
        if (avatar && (avatar.startsWith('http') || avatar.startsWith('/') || avatar.startsWith('data:image'))) {
          userAvatar.innerHTML = `<img src="${avatar}" alt="${this.currentUser.name || 'User'}" class="w-full h-full rounded-full object-cover" onerror="this.onerror=null; this.parentElement.textContent='👤';" />`;
        } else {
          userAvatar.textContent = avatar || '👤';
        }
      }
    } else {
      loginBtn?.classList.remove('hidden');
      userProfile?.classList.add('hidden');
    }

    this.updateCommandButtonsState();
  }

  updateCommandButtonsState() {
    this.updateDrawerInteractiveState();
  }

  updateDrawerInteractiveState(node) {
    if (!node) {
      if (this.selectedHostname && this.nodes[this.selectedHostname]) {
        node = this.nodes[this.selectedHostname];
      }
    }

    const isOffline = !node || node.status === 'offline' || (node.status !== 'online' && node.status !== 'warning');

    const interactiveSelectors = [
      '#fan-mode-auto-btn',
      '#fan-mode-on-btn',
      '#fan-mode-off-btn',
      '#fan-speed-1-btn',
      '#fan-speed-2-btn',
      '#fan-speed-3-btn',
      '#fan-speed-4-btn',
      '#fan-temp-on-slider',
      '#fan-temp-off-slider',
      '#fan-preset-cool',
      '#fan-preset-balanced',
      '#fan-preset-silent',
      '#fan-apply-btn',
      '#cmd-identify-btn',
      '#cmd-poll-btn'
    ];

    interactiveSelectors.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.disabled = isOffline;
        el.classList.toggle('opacity-40', isOffline);
        el.classList.toggle('cursor-not-allowed', isOffline);
      }
    });

    const rebootBtn = document.getElementById('cmd-reboot-btn');
    const shutdownBtn = document.getElementById('cmd-shutdown-btn');
    const allowPrivileged = !isOffline && Boolean(this.currentUser);

    if (rebootBtn) {
      rebootBtn.disabled = !allowPrivileged;
      rebootBtn.classList.toggle('opacity-40', !allowPrivileged);
      rebootBtn.classList.toggle('cursor-not-allowed', !allowPrivileged);
    }
    if (shutdownBtn) {
      shutdownBtn.disabled = !allowPrivileged;
      shutdownBtn.classList.toggle('opacity-40', !allowPrivileged);
      shutdownBtn.classList.toggle('cursor-not-allowed', !allowPrivileged);
    }
  }

  setupAuthHandlers() {
    document.getElementById('login-btn')?.addEventListener('click', () => this.openLoginModal());
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      window.location.href = '/auth/logout';
    });
    document.getElementById('close-login-modal')?.addEventListener('click', () => this.closeLoginModal());
    document.getElementById('login-cancel-btn')?.addEventListener('click', () => this.closeLoginModal());

    document.getElementById('dev-login-btn')?.addEventListener('click', async () => {
      try {
        const res = await fetch('/auth/dev-login', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          this.currentUser = data.user;
          this.updateAuthUi();
          this.closeLoginModal();
        }
      } catch (err) {
        alert('Dev login failed: ' + err.message);
      }
    });
  }

  openLoginModal() {
    document.getElementById('login-modal')?.classList.remove('hidden');
  }

  closeLoginModal() {
    document.getElementById('login-modal')?.classList.add('hidden');
  }

  // ==========================================
  // EVENT LOG & AUDIT TRAIL
  // ==========================================
  updateEventBadge() {
    const badge = document.getElementById('event-badge');
    if (badge) {
      badge.textContent = this.events.length;
    }
  }

  setupEventLogHandlers() {
    const filterBtns = document.querySelectorAll('.event-filter-btn');
    filterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        filterBtns.forEach((b) => {
          b.classList.remove('active', 'text-sky-400');
          b.classList.add('text-slate-400');
        });
        btn.classList.add('active', 'text-sky-400');
        btn.classList.remove('text-slate-400');

        this.eventFilter = btn.getAttribute('data-filter') || 'all';
        this.renderEventLog();
      });
    });

    const searchInput = document.getElementById('search-events');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.eventSearch = e.target.value;
        this.renderEventLog();
      });
    }

    const clearBtn = document.getElementById('clear-events-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.eventFilter = 'all';
        this.eventSearch = '';
        if (searchInput) searchInput.value = '';
        filterBtns.forEach((b) => {
          const isAll = b.getAttribute('data-filter') === 'all';
          b.classList.toggle('active', isAll);
          b.classList.toggle('text-sky-400', isAll);
          b.classList.toggle('text-slate-400', !isAll);
        });
        this.renderEventLog();
      });
    }
  }

  renderEventLog() {
    const tbody = document.getElementById('event-log-tbody');
    const emptyState = document.getElementById('event-log-empty');
    const totalCountEl = document.getElementById('event-total-count');
    if (!tbody) return;

    if (totalCountEl) {
      totalCountEl.textContent = `(${this.events.length} events)`;
    }

    const filter = this.eventFilter || 'all';
    const search = (this.eventSearch || '').toLowerCase().trim();

    const filtered = this.events.filter((e) => {
      // Type filter
      if (filter !== 'all') {
        if (filter === 'offline' && e.type !== 'offline') return false;
        if (filter === 'online' && e.type !== 'online') return false;
        if (filter === 'reboot' && e.type !== 'reboot') return false;
        if (filter === 'warning' && e.type !== 'warning') return false;
      }
      // Search query filter
      if (search) {
        const matches =
          (e.hostname && e.hostname.toLowerCase().includes(search)) ||
          (e.message && e.message.toLowerCase().includes(search)) ||
          (e.user && e.user.toLowerCase().includes(search)) ||
          (e.type && e.type.toLowerCase().includes(search));
        if (!matches) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    tbody.innerHTML = filtered
      .map((e) => {
        let badgeHtml = '';
        if (e.type === 'online') {
          badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold">● ONLINE</span>';
        } else if (e.type === 'offline') {
          badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/30 font-semibold">❌ OFFLINE</span>';
        } else if (e.type === 'reboot') {
          badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold">🔄 REBOOT</span>';
        } else if (e.type === 'shutdown') {
          badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] bg-rose-600/20 text-rose-300 border border-rose-500/30 font-semibold">🛑 SHUTDOWN</span>';
        } else if (e.type === 'warning') {
          badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold">⚠️ WARNING</span>';
        } else {
          badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 font-semibold">ℹ️ INFO</span>';
        }

        const isNode = e.hostname && e.hostname.startsWith('picloud-');
        const targetHtml = isNode
          ? `<button class="text-sky-400 hover:text-sky-300 hover:underline font-bold" onclick="window.piCloudApp?.openDrawer('${e.hostname}')">${e.hostname}</button>`
          : `<span class="text-slate-300">${escapeHtml(e.hostname || 'Cluster')}</span>`;

        return `
          <tr class="hover:bg-slate-900/40 transition">
            <td class="py-2 px-3 whitespace-nowrap text-slate-400 text-[11px]">
              <span class="text-slate-200">${escapeHtml(e.timeStr)}</span>
              <span class="text-slate-500 text-[10px] ml-1">${escapeHtml(e.dateStr)}</span>
            </td>
            <td class="py-2 px-3 whitespace-nowrap">${badgeHtml}</td>
            <td class="py-2 px-3 whitespace-nowrap">${targetHtml}</td>
            <td class="py-2 px-3 text-slate-300 font-sans text-xs">${escapeHtml(e.message)}</td>
            <td class="py-2 px-3 whitespace-nowrap text-slate-400 text-xs font-sans">
              <span class="px-1.5 py-0.5 rounded bg-slate-800 text-[11px] text-slate-300 border border-slate-700">${escapeHtml(e.user || 'System')}</span>
            </td>
          </tr>
        `;
      })
      .join('');
  }
}

function setText(elementId, value) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = value;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Instantiate on DOM Load
window.addEventListener('DOMContentLoaded', () => {
  window.piCloudApp = new PiCloudApp();
});


