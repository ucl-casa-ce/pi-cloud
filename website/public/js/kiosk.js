/**
 * PiCloud Digital Twin - Kiosk Auto-Tour Controller
 * 
 * Drives full-screen presentation mode:
 * 1. Initial 5s full-wall overview
 * 2. Selects a random Pi node, zooms into it, and slides out read-only telemetry drawer
 * 3. Dwells for 20s (configurable via URL param ?interval= or env KIOSK_NODE_INTERVAL)
 * 4. Slides drawer away, zooms back out to full wall overview for 5s
 * 5. Cycles continuously indefinitely
 */

import { PiCloudWallTwin, WALL_NODE_COORDINATES } from '/js/twin-wall.js';

class PiCloudKiosk {
  constructor() {
    this.nodes = {};
    this.wallTwin = null;
    this.ws = null;

    // Timing configurations (defaults: 20s inspection, 5s overview, 5s initial wait)
    this.nodeInterval = 20;
    this.overviewInterval = 5;
    this.initialWait = 5;

    // Tour state
    this.currentNode = null;
    this.lastNode = null;
    this.isPaused = false;
    this.timerId = null;
    this.secondsRemaining = 5;
    this.currentPhase = 'INITIAL_OVERVIEW'; // 'INITIAL_OVERVIEW' | 'NODE_INSPECT' | 'OVERVIEW'

    // Node candidate pool (picloud-1 through picloud-48)
    this.allHostnames = WALL_NODE_COORDINATES.map((c) => c.hostname);

    this.init();
  }

  async init() {
    // 1. Parse Timing & URL Overrides
    await this.loadTimingConfig();

    // 2. Setup 3D Wall Digital Twin in full-viewport container
    this.initWallTwin();

    // 3. Connect to live WebSocket stream
    this.connectWebSocket();

    // 4. Bind Kiosk UI controls (Pause, Skip, Fullscreen, Keyboard)
    this.setupControls();

    // 5. Start Auto-Tour sequence with initial overview phase
    this.startInitialOverview();
  }

  async loadTimingConfig() {
    // Fetch server defaults from env
    try {
      const res = await fetch('/api/kiosk-config');
      if (res.ok) {
        const config = await res.json();
        if (config.nodeInterval) this.nodeInterval = config.nodeInterval;
        if (config.overviewInterval) this.overviewInterval = config.overviewInterval;
      }
    } catch (e) {
      console.warn('[KIOSK] Could not fetch /api/kiosk-config:', e);
    }

    // URL Query Parameter Overrides (?interval=20&overview=5&start=5)
    const params = new URLSearchParams(window.location.search);
    const intervalParam = params.get('interval') || params.get('node_interval') || params.get('time');
    const overviewParam = params.get('overview') || params.get('overview_interval');
    const startParam = params.get('start') || params.get('initial');

    if (intervalParam) {
      const val = parseInt(intervalParam, 10);
      if (!isNaN(val) && val > 0) this.nodeInterval = val;
    }
    if (overviewParam) {
      const val = parseInt(overviewParam, 10);
      if (!isNaN(val) && val > 0) this.overviewInterval = val;
    }
    if (startParam) {
      const val = parseInt(startParam, 10);
      if (!isNaN(val) && val >= 0) this.initialWait = val;
    }

    // Optional node pool filter: ?nodes=1,2,3 or ?nodes=picloud-1,picloud-5
    const nodesFilter = params.get('nodes');
    if (nodesFilter) {
      const parts = nodesFilter.split(',').map((p) => p.trim());
      const filtered = parts.map((p) => (p.startsWith('picloud-') ? p : `picloud-${p}`));
      const valid = filtered.filter((h) => this.allHostnames.includes(h));
      if (valid.length > 0) {
        this.allHostnames = valid;
      }
    }

    console.log(`[KIOSK] Auto-Tour configured: Node Dwell=${this.nodeInterval}s, Overview=${this.overviewInterval}s, Start=${this.initialWait}s`);
  }

  initWallTwin() {
    const container = document.getElementById('kiosk-canvas-container');
    if (!container) return;

    this.wallTwin = new PiCloudWallTwin('kiosk-canvas-container', {
      onNodeClick: (hostname) => {
        this.userInspectNode(hostname);
      }
    });
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'INIT') {
          this.nodes = msg.nodes || {};
          if (this.wallTwin) this.wallTwin.updateNodes(this.nodes);
          // If a node is currently displayed in drawer, update its content
          if (this.currentNode && this.nodes[this.currentNode]) {
            this.updateDrawerContent(this.nodes[this.currentNode]);
          }
        } else if (msg.type === 'NODE_UPDATE') {
          if (msg.hostname && msg.data) {
            this.nodes[msg.hostname] = msg.data;
            if (this.wallTwin) this.wallTwin.updateNodes(this.nodes);
            if (this.currentNode === msg.hostname) {
              this.updateDrawerContent(msg.data);
            }
          }
        }
      } catch (err) {
        console.warn('[KIOSK WS] Message error:', err);
      }
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connectWebSocket(), 3000);
    };
  }

  // ==========================================
  // AUTO-TOUR STATE MACHINE
  // ==========================================
  startInitialOverview() {
    this.currentPhase = 'INITIAL_OVERVIEW';
    this.currentNode = null;
    this.secondsRemaining = this.initialWait;
    this.updateStatusPill();

    this.clearTicker();
    this.ticker = setInterval(() => {
      if (this.isPaused) return;

      this.secondsRemaining--;
      this.updateStatusPill();

      if (this.secondsRemaining <= 0) {
        this.selectNextRandomNode();
      }
    }, 1000);
  }

  selectNextRandomNode() {
    // Pick random node from pool (avoiding immediate repetition if > 1 node)
    let candidates = this.allHostnames;
    if (candidates.length > 1 && this.lastNode) {
      candidates = candidates.filter((h) => h !== this.lastNode);
    }
    const nextHostname = candidates[Math.floor(Math.random() * candidates.length)];
    this.inspectNode(nextHostname);
  }

  inspectNode(hostname) {
    this.currentPhase = 'NODE_INSPECT';
    this.currentNode = hostname;
    this.lastNode = hostname;
    this.secondsRemaining = this.nodeInterval;
    this.updateStatusPill();

    // 1. Fly camera to node
    if (this.wallTwin) {
      this.wallTwin.focusNode(hostname);
    }

    // 2. Populate and slide out telemetry drawer
    const nodeData = this.nodes[hostname] || {
      hostname,
      node_id: parseInt(hostname.replace('picloud-', ''), 10) || 0,
      status: 'offline'
    };
    this.updateDrawerContent(nodeData);
    this.openDrawer();

    // 3. Start inspection dwell countdown
    this.clearTicker();
    this.ticker = setInterval(() => {
      if (this.isPaused) return;

      this.secondsRemaining--;
      this.updateStatusPill();

      if (this.secondsRemaining <= 0) {
        this.transitionToOverview();
      }
    }, 1000);
  }

  transitionToOverview() {
    this.currentPhase = 'OVERVIEW';
    this.currentNode = null;
    this.secondsRemaining = this.overviewInterval;
    this.updateStatusPill();

    // 1. Slide drawer away
    this.closeDrawer();

    // 2. Fly camera back out to full wall view
    if (this.wallTwin) {
      this.wallTwin.resetView();
    }

    // 3. Start overview wait countdown
    this.clearTicker();
    this.ticker = setInterval(() => {
      if (this.isPaused) return;

      this.secondsRemaining--;
      this.updateStatusPill();

      if (this.secondsRemaining <= 0) {
        this.selectNextRandomNode();
      }
    }, 1000);
  }

  userInspectNode(hostname) {
    // Manual click on a node: immediately focus and inspect that node
    this.inspectNode(hostname);
  }

  clearTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  // ==========================================
  // HUD & STATUS PILL
  // ==========================================
  updateStatusPill() {
    const pill = document.getElementById('tour-status-pill');
    const dot = document.getElementById('tour-status-dot');
    const text = document.getElementById('tour-status-text');
    if (!pill || !text || !dot) return;

    if (this.isPaused) {
      pill.className = 'px-3.5 py-1.5 rounded-xl bg-amber-950/90 border border-amber-500/40 text-amber-300 text-xs font-mono font-medium backdrop-blur-md shadow-2xl flex items-center gap-2';
      dot.className = 'w-2 h-2 rounded-full bg-amber-400';
      text.textContent = `Paused (${this.currentNode || 'Wall Overview'})`;
      return;
    }

    if (this.currentPhase === 'NODE_INSPECT') {
      pill.className = 'px-3.5 py-1.5 rounded-xl bg-slate-900/90 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-medium backdrop-blur-md shadow-2xl flex items-center gap-2';
      dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      text.textContent = `Inspecting ${this.currentNode} (${this.secondsRemaining}s)`;
    } else {
      pill.className = 'px-3.5 py-1.5 rounded-xl bg-slate-900/90 border border-sky-500/40 text-sky-300 text-xs font-mono font-medium backdrop-blur-md shadow-2xl flex items-center gap-2';
      dot.className = 'w-2 h-2 rounded-full bg-sky-400 animate-pulse';
      text.textContent = `Wall Overview (${this.secondsRemaining}s)`;
    }
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    const pauseIcon = document.getElementById('tour-pause-icon');
    if (pauseIcon) {
      pauseIcon.textContent = this.isPaused ? '▶' : '⏸';
    }
    this.updateStatusPill();
  }

  skipNext() {
    this.selectNextRandomNode();
  }

  // ==========================================
  // DRAWER UI & METRICS RENDERING
  // ==========================================
  openDrawer() {
    document.getElementById('kiosk-drawer')?.classList.remove('translate-x-full');
  }

  closeDrawer() {
    document.getElementById('kiosk-drawer')?.classList.add('translate-x-full');
  }

  setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  updateDrawerContent(d) {
    if (!d) return;

    this.setText('drawer-id', `#${d.node_id || '--'}`);
    this.setText('drawer-hostname', d.hostname || 'picloud');
    this.setText('drawer-ip', d.ip || '10.129.111.--');

    const statusBadge = document.getElementById('drawer-status-badge');
    if (statusBadge) {
      if (d.status === 'online') {
        statusBadge.textContent = '● Online';
        statusBadge.className = 'text-emerald-400 font-medium';
      } else if (d.status === 'warning') {
        statusBadge.textContent = '⚠️ Warning';
        statusBadge.className = 'text-amber-400 font-medium';
      } else if (d.status === 'rebooting') {
        statusBadge.textContent = '🔄 Rebooting';
        statusBadge.className = 'text-amber-400 font-medium animate-pulse';
      } else {
        statusBadge.textContent = '❌ Offline';
        statusBadge.className = 'text-slate-500 font-medium';
      }
    }

    // Quick Metrics
    this.setText('drawer-temp', `${d.temp_c || '--'}°C`);
    this.setText('drawer-cpu', `${d.cpu_percent || '--'}%`);
    this.setText('drawer-power', `${d.poe?.current_watts || '--'} W`);

    // PoE & Hardware
    const fan = d.power_and_hardware?.fan || {};
    const fanState = d.power_and_hardware?.fan_state ?? fan.state ?? 0;
    this.setText('drawer-amps', `${d.poe?.current_amps || 0} A`);
    this.setText('drawer-energy', `${d.power_and_hardware?.cumulative_energy_wh || 0} Wh`);
    this.setText('drawer-fan', `Level ${fanState}`);
    this.setText('drawer-freq', `${d.cpu_freq_mhz || 0} MHz`);

    const fanBadge = document.getElementById('drawer-fan-status-badge');
    if (fanBadge) {
      if (fanState > 0) {
        fanBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-spin"></span> Active (L${fanState})`;
        fanBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 font-mono font-medium flex items-center gap-1';
      } else {
        fanBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Idle (Off)`;
        fanBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 font-mono font-medium flex items-center gap-1';
      }
    }

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

    // System & Storage
    this.setText('drawer-mem', `${d.memory_percent || 0}%`);
    this.setText('drawer-ram', `${d.memory_available_mb || 0} MB`);
    this.setText('drawer-disk', `${d.disk_percent || 0}%`);
    this.setText('drawer-disk-free', `${d.disk_free_gb || 0} GB`);
    this.setText('drawer-zram', d.zram ? `${d.zram.ratio}x` : 'N/A');

    const uptimeHrs = Math.floor((d.uptime_seconds || 0) / 3600);
    this.setText('drawer-uptime', `${uptimeHrs}h (${d.active_users || 0} users)`);

    // Network
    this.setText('drawer-eth-speed', `${d.network?.eth_speed_mbps || 0} Mbps`);
    this.setText('drawer-ping', `${d.network?.ping_ms || 0} ms`);
    this.setText('drawer-rx', `${d.network?.rx_kb_s || 0} KB/s`);
    this.setText('drawer-tx', `${d.network?.tx_kb_s || 0} KB/s`);

    // SSH & User Sessions
    const ssh = d.ssh || {};
    const isSshSession = (s) => {
      if (!s) return false;
      const term = s.terminal || '';
      return term.startsWith('pts') || term.includes('ssh') || term === 'ssh' || (s.host && s.host !== 'local' && !term.startsWith('tty'));
    };

    const activeSessions = (ssh.active_sessions || []).filter(isSshSession);
    const activeCount = activeSessions.length;

    this.setText('drawer-ssh-active-count', `${activeCount}`);
    const activeStateEl = document.getElementById('drawer-ssh-active-state');
    if (activeStateEl) {
      activeStateEl.textContent = activeCount > 0 ? 'Active' : 'Idle';
      activeStateEl.className = activeCount > 0 ? 'text-emerald-400 font-mono font-semibold' : 'text-slate-400 font-mono';
    }

    if (activeSessions.length > 0) {
      const first = activeSessions[0];
      this.setText('drawer-ssh-client-ip', first.host || 'local');
      this.setText('drawer-ssh-duration', first.duration || '<1 min');
    } else {
      this.setText('drawer-ssh-client-ip', '--');
      this.setText('drawer-ssh-duration', '--');
    }

    const recent = (ssh.recent_sessions || []).filter(isSshSession);

    const lastLogin = (ssh.last_login && isSshSession(ssh.last_login))
      ? ssh.last_login
      : (recent.length > 0 ? recent[0] : null);
    if (lastLogin) {
      const hostPart = lastLogin.host && lastLogin.host !== 'local' ? `${lastLogin.host} · ` : '';
      const rawTime = (lastLogin.time || lastLogin.login_time || '--').replace(/\s*-\s*$/, '').trim();
      this.setText('drawer-ssh-last-login-info', `${hostPart}${rawTime}`);
    } else {
      this.setText('drawer-ssh-last-login-info', '--');
    }

    const lastLogout = (ssh.last_logout && (isSshSession(ssh.last_logout) || ssh.last_logout.logout_time) && ssh.last_logout.logout_time !== 'Active')
      ? ssh.last_logout
      : (recent.find((s) => !s.is_active && s.logout_time && s.logout_time !== 'Active') || null);
    if (lastLogout) {
      const rawLogout = (lastLogout.logout_time || '--').replace(/\s*-\s*$/, '').trim();
      this.setText('drawer-ssh-last-logout-info', rawLogout);
    } else {
      this.setText('drawer-ssh-last-logout-info', 'None recorded');
    }
  }

  // ==========================================
  // CONTROLS & EVENT LISTENERS
  // ==========================================
  setupControls() {
    // Pause / Resume button
    document.getElementById('tour-pause-btn')?.addEventListener('click', () => this.togglePause());

    // Skip button
    document.getElementById('tour-skip-btn')?.addEventListener('click', () => this.skipNext());

    // Close drawer button
    document.getElementById('close-drawer-btn')?.addEventListener('click', () => {
      this.transitionToOverview();
    });

    // Fullscreen toggle
    document.getElementById('tour-fullscreen-btn')?.addEventListener('click', () => {
      this.toggleFullscreen();
    });

    // Keyboard controls
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePause();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.skipNext();
      } else if (e.key === 'Escape') {
        if (this.currentPhase === 'NODE_INSPECT') {
          this.transitionToOverview();
        }
      } else if (e.key.toLowerCase() === 'f') {
        this.toggleFullscreen();
      }
    });
  }

  toggleFullscreen() {
    const expandIcon = document.getElementById('fullscreen-expand-icon');
    const collapseIcon = document.getElementById('fullscreen-collapse-icon');

    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn('[KIOSK] Fullscreen error:', err);
      });
      expandIcon?.classList.add('hidden');
      collapseIcon?.classList.remove('hidden');
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
      expandIcon?.classList.remove('hidden');
      collapseIcon?.classList.add('hidden');
    }
  }
}

// Instantiate Kiosk on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.piCloudKiosk = new PiCloudKiosk();
});

