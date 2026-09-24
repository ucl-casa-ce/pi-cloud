const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Explicitly load .env file from the website directory (or cwd as fallback)
const envPath = path.resolve(__dirname, '.env');
const cwdEnvPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[CONFIG] Loaded environment configuration from: ${envPath}`);
} else if (fs.existsSync(cwdEnvPath)) {
  dotenv.config({ path: cwdEnvPath });
  console.log(`[CONFIG] Loaded environment configuration from: ${cwdEnvPath}`);
} else if (process.env.MQTT_HOST || process.env.NODE_ENV || process.env.PORT) {
  // In Docker containers, Kubernetes, or cloud PaaS platforms, environment variables are injected directly
  console.log('[CONFIG] Loaded environment variables from container/system environment');
} else {
  dotenv.config();
  console.warn('[CONFIG] Warning: No .env file found and no environment variables detected');
}

const http = require('http');
const express = require('express');
const session = require('express-session');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const { Issuer, generators } = require('openid-client');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = parseInt(process.env.MQTT_PORT, 10) || 1883;
const MQTT_USER = process.env.MQTT_USER || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC_PREFIX = (process.env.MQTT_TOPIC_PREFIX || '').trim().replace(/['"]/g, '').replace(/\/+$/, '');

if (!MQTT_HOST) {
  console.warn('[CONFIG WARNING] MQTT_HOST is not set in environment or .env');
}
if (!MQTT_TOPIC_PREFIX) {
  console.warn('[CONFIG WARNING] MQTT_TOPIC_PREFIX is not set in environment or .env');
}

const AUTH_DEV_MODE = process.env.AUTH_DEV_MODE !== 'false';
const TOTAL_NODES = 48;
const HEARTBEAT_TIMEOUT_MS = 18000; // 18s without metrics -> mark offline

// OIDC Base URL & derived Callback URL for production/dev
const OIDC_BASE_URL = (
  process.env.OIDC_BASE_URL ||
  `http://${process.env.HOST === '0.0.0.0' ? 'localhost' : (process.env.HOST || 'localhost')}:${PORT}`
).replace(/\/+$/, '');
const OIDC_CALLBACK_URL = process.env.OIDC_CALLBACK_URL || `${OIDC_BASE_URL}/auth/callback`;
const OIDC_SCOPES = (process.env.OIDC_SCOPES || 'openid profile email').trim();
const OIDC_PROVIDER = process.env.OIDC_PROVIDER || process.env.OIDC_Provider || process.env.OIDC_PROVIDER_NAME || '';

// Kiosk Auto-Tour cycle intervals
const KIOSK_NODE_INTERVAL = Math.max(3, parseInt(process.env.KIOSK_NODE_INTERVAL || process.env.KIOSK_INTERVAL || '20', 10) || 20);
const KIOSK_OVERVIEW_INTERVAL = Math.max(1, parseInt(process.env.KIOSK_OVERVIEW_INTERVAL || '5', 10) || 5);

// ==========================================
// 1. CLUSTER STATE & EVENT LOG STORE
// ==========================================
const nodes = {};
const clusterEvents = [];
const MAX_EVENTS = 250;
const clusterHistory = [];
const MAX_HISTORY_POINTS = 40;

function addClusterEvent(type, hostname, message, user = 'System') {
  const now = new Date();
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    timeStr: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    dateStr: now.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    type, // 'online' | 'offline' | 'reboot' | 'shutdown' | 'warning' | 'info'
    hostname,
    message,
    user
  };

  clusterEvents.unshift(event);
  if (clusterEvents.length > MAX_EVENTS) {
    clusterEvents.pop();
  }

  // Broadcast to all WebSocket clients
  broadcastWs({
    type: 'CLUSTER_EVENT',
    event
  });

  return event;
}

// Initialize node registry
for (let i = 1; i <= TOTAL_NODES; i++) {
  const hostname = `picloud-${i}`;
  nodes[hostname] = {
    hostname,
    node_id: i,
    ip: `10.129.111.${i}`,
    status: 'offline', // 'online' | 'warning' | 'rebooting' | 'offline'
    last_seen: null,
    reboot_started_at: null,
    uptime_seconds: 0,
    active_users: 0,
    logged_in_user: null,
    ssh: {
      active_users_count: 0,
      active_users: [],
      primary_user: null,
      active_sessions: [],
      last_login: null,
      last_logout: null,
      recent_sessions: [],
      sshd_running: true
    },
    temp_c: 0,
    cpu_percent: 0,
    cpu_freq_mhz: 0,
    load_averages: { '1m': 0, '5m': 0, '15m': 0 },
    memory_percent: 0,
    memory_available_mb: 0,
    disk_percent: 0,
    disk_free_gb: 0,
    network: {
      eth_speed_mbps: 1000,
      rx_kb_s: 0,
      tx_kb_s: 0,
      ping: 'pending',
      ping_ms: '0'
    },
    power_and_hardware: {
      throttled: {
        hex: '0x0',
        healthy: true,
        undervoltage_now: false,
        freq_capped_now: false,
        throttled_now: false,
        soft_temp_limit_now: false,
        undervoltage_has_occurred: false,
        freq_capped_has_occurred: false,
        throttled_has_occurred: false,
        soft_temp_limit_has_occurred: false
      },
      fan_state: 0,
      fan: {
        mode: 'auto',
        temp_on: 48,
        temp_off: 42,
        speed: 2,
        state: 0,
        manual_override: false
      },
      cumulative_energy_wh: 0
    },
    poe: {
      POWER_SUPPLY_NAME: 'rpi-poe',
      current_amps: 0,
      current_watts: 0
    },
    zram: null,
    heartbeat: '--:--:--',
    timestamp: 0,
    identifying_until: 0
  };
}

function formatHumanDuration(totalSeconds) {
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

function parseAndFormatDuration(durStr) {
  if (!durStr || typeof durStr !== 'string' || durStr === 'N/A' || durStr === 'Active') {
    return durStr;
  }
  const matchWithDays = durStr.match(/^(\d+)\+(\d{1,2}):(\d{2})$/);
  if (matchWithDays) {
    const days = parseInt(matchWithDays[1], 10);
    const hrs = parseInt(matchWithDays[2], 10);
    const mins = parseInt(matchWithDays[3], 10);
    const sec = ((days * 24 + hrs) * 60 + mins) * 60;
    return formatHumanDuration(sec);
  }
  const matchHhMm = durStr.match(/^(\d{1,2}):(\d{2})$/);
  if (matchHhMm) {
    const hrs = parseInt(matchHhMm[1], 10);
    const mins = parseInt(matchHhMm[2], 10);
    const sec = (hrs * 60 + mins) * 60;
    return formatHumanDuration(sec);
  }
  return durStr;
}

let liveMqttReceived = false;

function computeClusterSummary() {
  let onlineCount = 0;
  let warningCount = 0;
  let rebootingCount = 0;
  let offlineCount = 0;
  let totalWatts = 0;
  let totalAmps = 0;
  let totalEnergyWh = 0;
  let totalTemp = 0;
  let maxTemp = 0;
  let maxTempHost = 'N/A';
  let totalCpu = 0;
  let totalMem = 0;
  let totalActiveUsers = 0;
  const activeUserSet = new Set();
  let throttledCount = 0;
  let gigabitCount = 0;
  let lowSpeedCount = 0;

  for (let i = 1; i <= TOTAL_NODES; i++) {
    const n = nodes[`picloud-${i}`];
    if (n.status === 'online' || n.status === 'warning') {
      onlineCount++;
      if (n.status === 'warning') warningCount++;

      const watts = parseFloat(n.poe?.current_watts) || 0;
      const amps = parseFloat(n.poe?.current_amps) || 0;
      const energy = parseFloat(n.power_and_hardware?.cumulative_energy_wh) || 0;
      const temp = parseFloat(n.temp_c) || 0;
      const cpu = parseFloat(n.cpu_percent) || 0;
      const mem = parseFloat(n.memory_percent) || 0;

      totalWatts += watts;
      totalAmps += amps;
      totalEnergyWh += energy;
      totalTemp += temp;
      totalCpu += cpu;
      totalMem += mem;
      const uCount = parseInt(n.active_users, 10) || 0;
      totalActiveUsers += uCount;
      if (n.logged_in_user) activeUserSet.add(n.logged_in_user);
      if (Array.isArray(n.ssh?.active_users)) {
        n.ssh.active_users.forEach((u) => activeUserSet.add(u));
      }

      if (temp > maxTemp) {
        maxTemp = temp;
        maxTempHost = n.hostname;
      }

      if (n.power_and_hardware?.throttled?.healthy === false) {
        throttledCount++;
      }

      if (n.network?.eth_speed_mbps >= 1000) {
        gigabitCount++;
      } else if (n.network?.eth_speed_mbps > 0) {
        lowSpeedCount++;
      }
    } else if (n.status === 'rebooting') {
      rebootingCount++;
    } else {
      offlineCount++;
    }
  }

  const activeCount = onlineCount > 0 ? onlineCount : 1;
  return {
    totalNodes: TOTAL_NODES,
    onlineCount,
    offlineCount,
    warningCount,
    rebootingCount,
    totalWatts: Math.round(totalWatts * 100) / 100,
    totalAmps: Math.round(totalAmps * 1000) / 1000,
    totalEnergyKwh: Math.round((totalEnergyWh / 1000) * 1000) / 1000,
    avgTempC: onlineCount ? Math.round((totalTemp / activeCount) * 10) / 10 : 0,
    maxTempC: Math.round(maxTemp * 10) / 10,
    maxTempHost,
    avgCpuPercent: onlineCount ? Math.round((totalCpu / activeCount) * 10) / 10 : 0,
    avgMemoryPercent: onlineCount ? Math.round((totalMem / activeCount) * 10) / 10 : 0,
    totalActiveUsers,
    activeUserNames: Array.from(activeUserSet),
    throttledCount,
    gigabitCount,
    lowSpeedCount,
    timestamp: Date.now()
  };
}

// History rolling buffer
setInterval(() => {
  const summary = computeClusterSummary();
  clusterHistory.push({
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    avgCpu: summary.avgCpuPercent,
    avgTemp: summary.avgTempC,
    totalWatts: summary.totalWatts,
    onlineCount: summary.onlineCount
  });
  if (clusterHistory.length > MAX_HISTORY_POINTS) {
    clusterHistory.shift();
  }
}, 2000);

// ==========================================
// 2. WATCHDOG FOR OFFLINE & REBOOT TIMEOUTS
// ==========================================
setInterval(() => {
  const now = Date.now();
  let stateChanged = false;

  for (let i = 1; i <= TOTAL_NODES; i++) {
    const hostname = `picloud-${i}`;
    const node = nodes[hostname];
    if (!node) continue;

    if (node.status === 'rebooting') {
      // If node is rebooting and hasn't returned after 60s, transition to offline
      if (node.reboot_started_at && now - node.reboot_started_at > 60000) {
        node.status = 'offline';
        node.reboot_started_at = null;
        stateChanged = true;
        addClusterEvent('offline', hostname, `${hostname} failed to return after reboot (timeout)`);
        broadcastWs({ type: 'NODE_UPDATE', hostname, data: node, summary: computeClusterSummary() });
      }
    } else if (node.status === 'shutdown') {
      // If node was commanded to shut down, play red shutdown animation for 20s then transition to offline
      if (node.shutdown_started_at && now - node.shutdown_started_at > 20000) {
        node.status = 'offline';
        node.shutdown_started_at = null;
        stateChanged = true;
        addClusterEvent('offline', hostname, `${hostname} powered off completely (halted)`);
        broadcastWs({ type: 'NODE_UPDATE', hostname, data: node, summary: computeClusterSummary() });
      }
    } else if (node.status !== 'offline') {
      // If node has not reported metrics for HEARTBEAT_TIMEOUT_MS, mark offline
      if (node.last_seen && now - node.last_seen > HEARTBEAT_TIMEOUT_MS) {
        const prevStatus = node.status;
        node.status = 'offline';
        stateChanged = true;
        addClusterEvent('offline', hostname, `${hostname} went offline (telemetry heartbeat lost)`);
        broadcastWs({ type: 'NODE_UPDATE', hostname, data: node, summary: computeClusterSummary() });
      }
    }
  }
}, 4000);

// ==========================================
// 3. EXPRESS & SESSION SETUP
// ==========================================
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    } else if (filePath.endsWith('.glb')) {
      res.setHeader('Content-Type', 'model/gltf-binary');
    }
  }
}));

// Trust reverse-proxy headers (e.g. Traefik, Caddy, Nginx in Coolify/Docker)
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

/**
 * Production-ready session store with TTL pruning and bounded memory capacity.
 * Replaces default express-session MemoryStore to eliminate memory leak warnings in production.
 */
class ClusterSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.maxSessions = options.maxSessions || 10000;
    this.pruneIntervalMs = options.pruneIntervalMs || 15 * 60 * 1000; // 15 mins
    this.pruneTimer = setInterval(() => this.pruneExpired(), this.pruneIntervalMs);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  pruneExpired() {
    const now = Date.now();
    for (const [sid, sess] of this.sessions.entries()) {
      if (sess && sess.cookie && sess.cookie.expires) {
        if (new Date(sess.cookie.expires).getTime() <= now) {
          this.sessions.delete(sid);
        }
      }
    }
  }

  get(sid, fn) {
    const sess = this.sessions.get(sid);
    if (!sess) return fn(null, null);
    if (sess.cookie && sess.cookie.expires && new Date(sess.cookie.expires).getTime() <= Date.now()) {
      this.sessions.delete(sid);
      return fn(null, null);
    }
    try {
      return fn(null, JSON.parse(JSON.stringify(sess)));
    } catch (err) {
      return fn(err);
    }
  }

  set(sid, sess, fn) {
    try {
      if (this.sessions.size >= this.maxSessions) {
        this.pruneExpired();
        if (this.sessions.size >= this.maxSessions) {
          const firstKey = this.sessions.keys().next().value;
          if (firstKey) this.sessions.delete(firstKey);
        }
      }
      this.sessions.set(sid, JSON.parse(JSON.stringify(sess)));
      if (fn) fn(null);
    } catch (err) {
      if (fn) fn(err);
    }
  }

  destroy(sid, fn) {
    this.sessions.delete(sid);
    if (fn) fn(null);
  }

  touch(sid, sess, fn) {
    const cur = this.sessions.get(sid);
    if (cur && sess && sess.cookie) {
      cur.cookie = sess.cookie;
    }
    if (fn) fn(null);
  }

  all(fn) {
    const result = {};
    for (const [sid, sess] of this.sessions.entries()) {
      result[sid] = sess;
    }
    if (fn) fn(null, result);
  }

  length(fn) {
    if (fn) fn(null, this.sessions.size);
  }

  clear(fn) {
    this.sessions.clear();
    if (fn) fn(null);
  }
}

app.use(
  session({
    store: new ClusterSessionStore(),
    secret: process.env.SESSION_SECRET || 'picloud-default-session-secret-change-in-env',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

// ==========================================
// 4. OIDC AUTHENTICATION (OpenID Connect)
// ==========================================
let oidcClient = null;

// Helper to fetch user details from arbitrary OIDC / OAuth2 endpoints with Bearer token
async function fetchOidcEndpoint(endpointUrl, accessToken) {
  if (!endpointUrl || !accessToken) return null;
  try {
    const res = await fetch(endpointUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json, image/*, */*'
      }
    });
    if (!res.ok) {
      console.warn(`[OIDC] Endpoint ${endpointUrl} returned HTTP ${res.status}`);
      return null;
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await res.json();
    } else if (contentType.startsWith('image/')) {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } else {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        return text.trim();
      }
    }
  } catch (err) {
    console.warn(`[OIDC] Error querying endpoint ${endpointUrl}:`, err.message);
    return null;
  }
}

async function initOidc() {
  let issuerUrl = (process.env.OIDC_ISSUER_URL || '').trim();
  const clientId = (process.env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = (process.env.OIDC_CLIENT_SECRET || '').trim();

  if (issuerUrl && clientId) {
    try {
      console.log(`[OIDC] Discovering issuer at: ${issuerUrl}`);
      console.log(`[OIDC] Base URL: ${OIDC_BASE_URL}`);
      console.log(`[OIDC] Callback URL: ${OIDC_CALLBACK_URL}`);
      console.log(`[OIDC] Scopes: ${OIDC_SCOPES}`);

      let issuer;
      try {
        issuer = await Issuer.discover(issuerUrl);
      } catch (discErr) {
        // If discovery failed and URL does not have realms path (common in Keycloak), try /realms/ce
        if (!issuerUrl.includes('/realms/')) {
          const fallbackUrl = `${issuerUrl.replace(/\/+$/, '')}/realms/ce`;
          console.log(`[OIDC] Retrying discovery with Keycloak realm at: ${fallbackUrl}`);
          issuer = await Issuer.discover(fallbackUrl);
          issuerUrl = fallbackUrl;
        } else {
          throw discErr;
        }
      }

      const clientConfig = {
        client_id: clientId,
        redirect_uris: [OIDC_CALLBACK_URL],
        response_types: ['code']
      };
      if (clientSecret) {
        clientConfig.client_secret = clientSecret;
      } else {
        // Support Public PKCE client configuration without secret
        clientConfig.token_endpoint_auth_method = 'none';
      }

      oidcClient = new issuer.Client(clientConfig);
      console.log('[OIDC] Client initialized successfully.');
    } catch (err) {
      console.warn(`[OIDC] Discovery warning: ${err.message}. (Dev Mode remains available)`);
    }
  } else {
    console.log('[OIDC] Missing OIDC_ISSUER_URL or OIDC_CLIENT_ID. Dev Mode auth is enabled.');
    console.log(`[OIDC] Configured Base URL: ${OIDC_BASE_URL}`);
    console.log(`[OIDC] Generated Callback URL: ${OIDC_CALLBACK_URL}`);
  }
}

initOidc().catch(console.error);

function requireAuth(req, res, next) {
  const cmd = (req.body?.cmd || '').toLowerCase();
  const destructiveCommands = ['reboot', 'shutdown'];

  // Destructive actions strictly require authenticated session
  if (destructiveCommands.includes(cmd)) {
    if (req.session && req.session.user) {
      return next();
    }
    return res.status(401).json({
      error: 'Authentication required. Please sign in via OIDC to perform node management actions (Reboot/Shutdown).',
      authUrl: '/auth/login'
    });
  }

  // Non-destructive actions (fan control, identify, metrics poll) allowed for dashboard operators
  if (!req.session?.user) {
    req.session = req.session || {};
    req.session.user = {
      name: 'Lab Operator',
      email: 'operator@casa.ucl.ac.uk',
      role: 'operator',
      provider: 'local-operator'
    };
  }
  return next();
}

// Auth status & OIDC info
app.get('/auth/me', (req, res) => {
  res.json({
    authenticated: !!req.session?.user,
    user: req.session?.user || null,
    devMode: AUTH_DEV_MODE,
    oidcProvider: OIDC_PROVIDER,
    oidcConfigured: !!oidcClient,
    oidcBaseUrl: OIDC_BASE_URL,
    oidcCallbackUrl: OIDC_CALLBACK_URL,
    oidcScopes: OIDC_SCOPES
  });
});

// Kiosk Auto-Tour configuration and view route
app.get('/api/kiosk-config', (req, res) => {
  res.json({
    nodeInterval: KIOSK_NODE_INTERVAL,
    overviewInterval: KIOSK_OVERVIEW_INTERVAL
  });
});

app.get('/kiosk', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Dev Mode login
app.post('/auth/dev-login', (req, res) => {
  if (!AUTH_DEV_MODE) {
    return res.status(403).json({ error: 'Dev mode authentication is disabled.' });
  }
  req.session.user = {
    name: 'CASA Lab Admin',
    email: 'admin@casa.ucl.ac.uk',
    role: 'cluster-admin',
    provider: 'dev-mode',
    avatar: 'https://ui-avatars.com/api/?name=CASA+Lab+Admin&background=0284c7&color=fff&bold=true&size=128'
  };
  addClusterEvent('info', 'Cluster', `Admin signed in via Dev Mode (${req.session.user.name})`, req.session.user.name);
  res.json({ success: true, user: req.session.user });
});

// OIDC Login redirect
app.get('/auth/login', (req, res) => {
  if (!oidcClient) {
    if (AUTH_DEV_MODE) {
      req.session.user = {
        name: 'CASA Lab Admin',
        email: 'admin@casa.ucl.ac.uk',
        role: 'cluster-admin',
        provider: 'dev-mode',
        avatar: 'https://ui-avatars.com/api/?name=CASA+Lab+Admin&background=0284c7&color=fff&bold=true&size=128'
      };
      addClusterEvent('info', 'Cluster', `Admin signed in via Dev Mode (${req.session.user.name})`, req.session.user.name);
      return res.redirect('/?login=success');
    }
    return res.status(503).send('OIDC client is not configured and Dev Mode is disabled.');
  }

  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  req.session.code_verifier = code_verifier;

  const authUrl = oidcClient.authorizationUrl({
    scope: OIDC_SCOPES,
    code_challenge,
    code_challenge_method: 'S256'
  });
  res.redirect(authUrl);
});

// OIDC Callback - Pulls user profile, name, email, and avatar from standard OIDC & configured endpoints
app.get('/auth/callback', async (req, res) => {
  if (!oidcClient) return res.redirect('/');
  try {
    const params = oidcClient.callbackParams(req);
    const tokenSet = await oidcClient.callback(
      OIDC_CALLBACK_URL,
      params,
      { code_verifier: req.session.code_verifier }
    );
    delete req.session.code_verifier;

    const accessToken = tokenSet.access_token;
    const claims = typeof tokenSet.claims === 'function' ? tokenSet.claims() : {};

    // 1. Standard OIDC Userinfo
    let userinfo = null;
    try {
      if (oidcClient.userinfo && accessToken) {
        userinfo = await oidcClient.userinfo(accessToken);
      }
    } catch (uErr) {
      console.warn('[OIDC] Standard userinfo call warning:', uErr.message);
    }

    // 2. Fetch specific profile, name, email, and avatar endpoints if configured
    const profileUrl = process.env.OIDC_PROFILE_URL || (userinfo ? null : oidcClient.issuer?.userinfo_endpoint);
    const nameUrl = process.env.OIDC_NAME_URL;
    const emailUrl = process.env.OIDC_EMAIL_URL;
    const avatarUrl = process.env.OIDC_AVATAR_URL;

    const [profileData, nameData, emailData, avatarData] = await Promise.all([
      profileUrl ? fetchOidcEndpoint(profileUrl, accessToken) : null,
      nameUrl ? fetchOidcEndpoint(nameUrl, accessToken) : null,
      emailUrl ? fetchOidcEndpoint(emailUrl, accessToken) : null,
      avatarUrl ? fetchOidcEndpoint(avatarUrl, accessToken) : null
    ]);

    // 3. Resolve Full Name
    let resolvedName = '';
    if (nameData) {
      if (typeof nameData === 'string' && nameData.trim()) resolvedName = nameData.trim();
      else if (nameData.name) resolvedName = nameData.name;
      else if (nameData.displayName) resolvedName = nameData.displayName;
      else if (nameData.given_name || nameData.family_name) {
        resolvedName = [nameData.given_name, nameData.family_name].filter(Boolean).join(' ');
      }
    }
    if (!resolvedName && profileData) {
      if (profileData.name) resolvedName = profileData.name;
      else if (profileData.displayName) resolvedName = profileData.displayName;
      else if (profileData.given_name || profileData.family_name) {
        resolvedName = [profileData.given_name, profileData.family_name].filter(Boolean).join(' ');
      } else if (profileData.preferred_username) {
        resolvedName = profileData.preferred_username;
      }
    }
    if (!resolvedName && userinfo) {
      if (userinfo.name) resolvedName = userinfo.name;
      else if (userinfo.given_name || userinfo.family_name) {
        resolvedName = [userinfo.given_name, userinfo.family_name].filter(Boolean).join(' ');
      } else if (userinfo.preferred_username) {
        resolvedName = userinfo.preferred_username;
      }
    }
    if (!resolvedName && claims) {
      if (claims.name) resolvedName = claims.name;
      else if (claims.given_name || claims.family_name) {
        resolvedName = [claims.given_name, claims.family_name].filter(Boolean).join(' ');
      } else if (claims.preferred_username) {
        resolvedName = claims.preferred_username;
      }
    }

    // 4. Resolve Email
    let resolvedEmail = '';
    if (emailData) {
      if (typeof emailData === 'string' && emailData.includes('@')) resolvedEmail = emailData.trim();
      else if (Array.isArray(emailData) && emailData.length > 0) {
        const primary = emailData.find((e) => e.primary) || emailData[0];
        resolvedEmail = typeof primary === 'string' ? primary : (primary.email || '');
      } else if (emailData.email) {
        resolvedEmail = emailData.email;
      }
    }
    if (!resolvedEmail && profileData?.email) resolvedEmail = profileData.email;
    if (!resolvedEmail && userinfo?.email) resolvedEmail = userinfo.email;
    if (!resolvedEmail && claims?.email) resolvedEmail = claims.email;

    if (!resolvedName) {
      resolvedName = resolvedEmail ? resolvedEmail.split('@')[0] : (claims.sub || 'OIDC User');
    }

    // 5. Resolve Profile Picture / Avatar
    let resolvedAvatar = '';
    if (avatarData) {
      if (typeof avatarData === 'string' && avatarData.trim()) resolvedAvatar = avatarData.trim();
      else if (avatarData.url || avatarData.avatar_url || avatarData.picture) {
        resolvedAvatar = avatarData.url || avatarData.avatar_url || avatarData.picture;
      }
    }
    if (!resolvedAvatar && profileData) {
      resolvedAvatar = profileData.picture || profileData.avatar || profileData.avatar_url || profileData.image || profileData.photo || profileData.profile_image || '';
    }
    if (!resolvedAvatar && userinfo) {
      resolvedAvatar = userinfo.picture || userinfo.avatar || userinfo.avatar_url || userinfo.image || userinfo.photo || userinfo.profile_image || '';
    }
    if (!resolvedAvatar && claims) {
      resolvedAvatar = claims.picture || claims.avatar || claims.avatar_url || '';
    }

    // If avatar URL is relative, prefix with issuer origin
    if (resolvedAvatar && typeof resolvedAvatar === 'string' && resolvedAvatar.startsWith('/') && !resolvedAvatar.startsWith('//')) {
      try {
        const issuerUrlObj = new URL(process.env.OIDC_ISSUER_URL || 'https://auth.cetools.org');
        resolvedAvatar = `${issuerUrlObj.origin}${resolvedAvatar}`;
      } catch (_) {}
    }

    // High quality avatar fallback if provider did not supply one
    if (!resolvedAvatar || typeof resolvedAvatar !== 'string' || !resolvedAvatar.trim()) {
      resolvedAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(resolvedName)}&background=0284c7&color=fff&bold=true&size=128`;
    }

    req.session.user = {
      name: resolvedName,
      email: resolvedEmail,
      role: 'cluster-admin',
      provider: 'oidc',
      avatar: resolvedAvatar,
      username: userinfo?.preferred_username || claims?.preferred_username || ''
    };

    addClusterEvent('info', 'Cluster', `User signed in via OIDC (${req.session.user.name})`, req.session.user.name);
    res.redirect('/?login=success');
  } catch (err) {
    console.error('[OIDC] Callback error:', err);
    res.redirect('/?login=error');
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  const userName = req.session?.user?.name || 'User';
  req.session.destroy(() => {
    addClusterEvent('info', 'Cluster', `${userName} signed out`, userName);
    res.redirect('/');
  });
});

// ==========================================
// 5. REST API ROUTES
// ==========================================

// App Settings & Configuration (Public read-only)
app.get('/api/settings', (req, res) => {
  res.json({
    port: PORT,
    host: HOST,
    oidc: {
      baseUrl: OIDC_BASE_URL,
      callbackUrl: OIDC_CALLBACK_URL,
      issuerUrl: process.env.OIDC_ISSUER_URL || null,
      configured: !!oidcClient,
      devMode: AUTH_DEV_MODE
    },
    mqtt: {
      host: MQTT_HOST,
      port: MQTT_PORT,
      topicPrefix: MQTT_TOPIC_PREFIX,
      connected: !!(mqttClient && mqttClient.connected)
    },
    cluster: {
      totalNodes: TOTAL_NODES,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS
    }
  });
});

// Cluster stats & history (Public)
app.get('/api/cluster', (req, res) => {
  res.json({
    summary: computeClusterSummary(),
    history: clusterHistory
  });
});

// Event Log (Public)
app.get('/api/events', (req, res) => {
  res.json(clusterEvents);
});

// All nodes (Public)
app.get('/api/nodes', (req, res) => {
  res.json(nodes);
});

// Single node (Public)
app.get('/api/nodes/:hostname', (req, res) => {
  const node = nodes[req.params.hostname];
  if (!node) return res.status(404).json({ error: 'Node not found' });
  res.json(node);
});

// Node Control Command (PROTECTED via OIDC)
app.post('/api/nodes/:hostname/cmd', requireAuth, (req, res) => {
  const { hostname } = req.params;
  const { cmd, duration, endpoint, mode, temp_on, temp_off, speed } = req.body;

  if (!cmd) {
    return res.status(400).json({ error: "Missing 'cmd' in request body." });
  }

  const validCommands = ['identify', 'locate', 'blink', 'metrics', 'status', 'reboot', 'shutdown', 'fan'];
  if (!validCommands.includes(cmd.toLowerCase())) {
    return res.status(400).json({ error: `Unsupported command '${cmd}'. Supported: ${validCommands.join(', ')}` });
  }

  const targetTopic =
    hostname === 'all'
      ? `${MQTT_TOPIC_PREFIX}/cmd`
      : `${MQTT_TOPIC_PREFIX}/${hostname}/cmd`;

  let payload = cmd;
  if (cmd.toLowerCase() === 'fan') {
    payload = JSON.stringify({
      cmd: 'fan',
      mode: mode || 'auto',
      temp_on: temp_on !== undefined ? Number(temp_on) : 48,
      temp_off: temp_off !== undefined ? Number(temp_off) : 42,
      speed: speed !== undefined ? Number(speed) : 2
    });
  } else if (duration || endpoint) {
    payload = JSON.stringify({ cmd, duration: duration || 10, endpoint });
  }

  console.log(`[COMMAND] User ${req.session.user.email} -> ${targetTopic}: ${payload}`);

  // Publish to MQTT if connected
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(targetTopic, payload, { qos: 1 }, (err) => {
      if (err) console.error(`[MQTT] Publish error on ${targetTopic}:`, err);
    });
  }

  // Visual/State transitions for commands
  const cmdLower = cmd.toLowerCase();

  if (['identify', 'locate', 'blink'].includes(cmdLower)) {
    const dur = parseInt(duration, 10) || 10;
    const expiresAt = Date.now() + dur * 1000;
    if (hostname === 'all') {
      for (let i = 1; i <= TOTAL_NODES; i++) {
        nodes[`picloud-${i}`].identifying_until = expiresAt;
      }
      setTimeout(() => {
        for (let i = 1; i <= TOTAL_NODES; i++) {
          if (nodes[`picloud-${i}`].identifying_until <= expiresAt) {
            nodes[`picloud-${i}`].identifying_until = 0;
          }
        }
      }, (dur + 1) * 1000);
    } else if (nodes[hostname]) {
      nodes[hostname].identifying_until = expiresAt;
      setTimeout(() => {
        if (nodes[hostname] && nodes[hostname].identifying_until <= expiresAt) {
          nodes[hostname].identifying_until = 0;
        }
      }, (dur + 1) * 1000);
    }
    broadcastWs({
      type: 'IDENTIFY_TRIGGER',
      hostname,
      duration: dur,
      expiresAt
    });
    addClusterEvent('info', hostname, `Visual locator (ACT LED blink) triggered for ${dur}s`, req.session.user.name);
  } else if (cmdLower === 'fan') {
    const targets = hostname === 'all' ? Object.keys(nodes) : [hostname];
    targets.forEach((h) => {
      if (nodes[h]) {
        if (!nodes[h].power_and_hardware) {
          nodes[h].power_and_hardware = { throttled: { hex: '0x0', healthy: true }, fan_state: 0, cumulative_energy_wh: 0 };
        }
        const prevFan = nodes[h].power_and_hardware.fan || {};
        const effectiveMode = mode || prevFan.mode || 'auto';
        const effectiveTempOn = temp_on !== undefined ? Number(temp_on) : (prevFan.temp_on ?? 48);
        const effectiveTempOff = temp_off !== undefined ? Number(temp_off) : (prevFan.temp_off ?? 42);
        const effectiveSpeed = speed !== undefined ? Number(speed) : (prevFan.speed ?? 2);
        let effectiveState = nodes[h].power_and_hardware.fan_state ?? 0;

        if (effectiveMode === 'on') effectiveState = effectiveSpeed;
        else if (effectiveMode === 'off') effectiveState = 0;
        else {
          const curTemp = nodes[h].temp_c || 40;
          if (curTemp >= effectiveTempOn) effectiveState = effectiveSpeed;
          else if (curTemp <= effectiveTempOff) effectiveState = 0;
        }

        nodes[h].power_and_hardware.fan_state = effectiveState;
        nodes[h].power_and_hardware.fan = {
          mode: effectiveMode,
          temp_on: effectiveTempOn,
          temp_off: effectiveTempOff,
          speed: effectiveSpeed,
          state: effectiveState,
          manual_override: (effectiveMode === 'on' || effectiveMode === 'off')
        };

        broadcastWs({ type: 'NODE_UPDATE', hostname: h, data: nodes[h], summary: computeClusterSummary() });
      }
    });
    const modeLabel = mode === 'on' ? 'Override ON' : mode === 'off' ? 'Override OFF' : `Auto (${temp_on || 48}°C / ${temp_off || 42}°C)`;
    addClusterEvent('info', hostname, `PoE Fan Control applied: ${modeLabel}`, req.session.user.name);
  } else if (cmdLower === 'reboot') {
    const targets = hostname === 'all' ? Object.keys(nodes) : [hostname];
    targets.forEach((h) => {
      if (nodes[h]) {
        nodes[h].status = 'rebooting';
        nodes[h].reboot_started_at = Date.now();
        broadcastWs({ type: 'NODE_UPDATE', hostname: h, data: nodes[h], summary: computeClusterSummary() });
      }
    });
    addClusterEvent('reboot', hostname, `Reboot command dispatched to ${hostname}`, req.session.user.name);
  } else if (cmdLower === 'shutdown') {
    const targets = hostname === 'all' ? Object.keys(nodes) : [hostname];
    targets.forEach((h) => {
      if (nodes[h]) {
        nodes[h].status = 'shutdown';
        nodes[h].shutdown_started_at = Date.now();
        broadcastWs({ type: 'NODE_UPDATE', hostname: h, data: nodes[h], summary: computeClusterSummary() });
      }
    });
    addClusterEvent('shutdown', hostname, `Shutdown command dispatched to ${hostname}`, req.session.user.name);
  } else if (cmdLower === 'metrics') {
    addClusterEvent('info', hostname, `On-demand metrics poll requested for ${hostname}`, req.session.user.name);
  }

  res.json({
    success: true,
    message: `Command '${cmd}' dispatched to ${hostname}`,
    targetTopic,
    user: req.session.user.name,
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 6. WEBSOCKET REAL-TIME BROADCAST
// ==========================================
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcastWs(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'INIT',
      nodes,
      summary: computeClusterSummary(),
      history: clusterHistory,
      events: clusterEvents,
      timestamp: Date.now()
    })
  );
});

// ==========================================
// 7. MQTT INTEGRATION
// ==========================================
let mqttClient = null;

function connectMqtt() {
  if (!MQTT_HOST || !MQTT_TOPIC_PREFIX) {
    console.warn('[MQTT] MQTT connection skipped: MQTT_HOST and MQTT_TOPIC_PREFIX must be configured in .env');
    return;
  }
  const brokerUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
  console.log(`[MQTT] Connecting to broker at ${brokerUrl}...`);

  const options = {
    clientId: `picloud_web_twin_${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 5000
  };

  if (MQTT_USER) {
    options.username = MQTT_USER;
    options.password = MQTT_PASSWORD;
  }

  mqttClient = mqtt.connect(brokerUrl, options);

  mqttClient.on('connect', () => {
    console.log('[MQTT] Connected to broker successfully!');
    const subscribeTopics = [
      `${MQTT_TOPIC_PREFIX}/+/metrics`,
      `${MQTT_TOPIC_PREFIX}/+/cmd/response`
    ];
    subscribeTopics.forEach((topic) => {
      console.log(`[MQTT] Subscribing to: ${topic}`);
      mqttClient.subscribe(topic, { qos: 0 });
    });
  });

  mqttClient.on('message', (topic, messageBuffer) => {
    try {
      if (MQTT_TOPIC_PREFIX && !topic.startsWith(MQTT_TOPIC_PREFIX)) return;
      const subTopic = MQTT_TOPIC_PREFIX
        ? topic.slice(MQTT_TOPIC_PREFIX.length).replace(/^\/+/, '')
        : topic;
      const parts = subTopic.split('/');
      const hostname = parts[0];
      const messageType = parts[1];
      const action = parts[2];

      if (!hostname || !nodes[hostname]) return;

      const raw = messageBuffer.toString();
      const payload = JSON.parse(raw);

      if (messageType === 'metrics') {
        liveMqttReceived = true;

        const node = nodes[hostname];
        const previousStatus = node.status;
        const wasOfflineOrRebooting = previousStatus === 'offline' || previousStatus === 'rebooting' || previousStatus === 'shutdown';
        const previousUsers = node.active_users || 0;
        const previousPrimaryUser = node.logged_in_user;
        const previousLastLogoutTime = node.ssh?.last_logout?.logout_time;

        node.last_seen = Date.now();
        node.reboot_started_at = null;
        node.shutdown_started_at = null;

        node.temp_c = payload.temp_c ?? node.temp_c;
        node.cpu_percent = payload.cpu_percent ?? node.cpu_percent;
        node.cpu_freq_mhz = payload.cpu_freq_mhz ?? node.cpu_freq_mhz;
        node.uptime_seconds = payload.uptime_seconds ?? node.uptime_seconds;
        // Clean and normalize SSH sessions: ignore Linux boot console autologin (tty1) and isolate genuine SSH (pts/*)
        let sshObj = payload.ssh ? JSON.parse(JSON.stringify(payload.ssh)) : node.ssh;
        if (sshObj) {
          if (Array.isArray(sshObj.active_sessions)) {
            sshObj.active_sessions = sshObj.active_sessions
              .filter((s) => {
                const term = s.terminal || '';
                return term.startsWith('pts') || (s.host && s.host !== 'local' && !term.startsWith('tty'));
              })
              .map((s) => {
                const sec = Math.max(0, parseInt(s.duration_seconds, 10) || 0);
                return { ...s, duration: formatHumanDuration(sec), duration_seconds: sec };
              });
          }
          if (Array.isArray(sshObj.recent_sessions)) {
            sshObj.recent_sessions = sshObj.recent_sessions
              .filter((s) => {
                const term = s.terminal || '';
                return term.startsWith('pts') || term.includes('ssh') || term === 'ssh' || (s.host && s.host !== 'local');
              })
              .map((s) => ({
                ...s,
                duration: s.is_active ? 'Active' : parseAndFormatDuration(s.duration),
              }));
          }
          if (sshObj.last_logout && sshObj.last_logout.duration) {
            sshObj.last_logout.duration = parseAndFormatDuration(sshObj.last_logout.duration);
          }
          if (sshObj.last_login?.time) {
            sshObj.last_login.time = sshObj.last_login.time.replace(/\s*-\s*$/, '').trim();
          }
          if (sshObj.last_logout?.logout_time) {
            sshObj.last_logout.logout_time = sshObj.last_logout.logout_time.replace(/\s*-\s*$/, '').trim();
          }
          sshObj.active_users_count = sshObj.active_sessions ? sshObj.active_sessions.length : 0;
          sshObj.active_users = sshObj.active_sessions ? [...new Set(sshObj.active_sessions.map((s) => s.user))] : [];
          sshObj.primary_user = sshObj.active_users[0] || null;
        }

        const activeCount = sshObj ? (sshObj.active_sessions?.length || 0) : (parseInt(payload.active_users, 10) || 0);
        node.active_users = activeCount;
        node.logged_in_user = activeCount > 0 ? (sshObj?.primary_user || payload.logged_in_user || 'user') : null;
        node.ssh = sshObj;
        node.load_averages = payload.load_averages ?? node.load_averages;
        node.memory_percent = payload.memory_percent ?? node.memory_percent;
        node.memory_available_mb = payload.memory_available_mb ?? node.memory_available_mb;
        node.disk_percent = payload.disk_percent ?? node.disk_percent;
        node.disk_free_gb = payload.disk_free_gb ?? node.disk_free_gb;
        node.network = payload.network ?? node.network;
        if (payload.power_and_hardware) {
          const prevFan = node.power_and_hardware?.fan;
          const incomingFan = payload.power_and_hardware.fan;
          const currentFanState = payload.power_and_hardware.fan_state ?? node.power_and_hardware?.fan_state ?? 0;

          node.power_and_hardware = {
            ...node.power_and_hardware,
            ...payload.power_and_hardware,
            fan: incomingFan || {
              mode: prevFan?.mode || 'auto',
              temp_on: prevFan?.temp_on ?? 48,
              temp_off: prevFan?.temp_off ?? 42,
              speed: prevFan?.speed ?? 2,
              state: currentFanState,
              manual_override: prevFan?.manual_override ?? false
            }
          };
        }
        node.poe = payload.poe ?? node.poe;
        node.zram = payload.zram ?? node.zram;
        node.heartbeat = payload.heartbeat ?? node.heartbeat;
        node.timestamp = payload.timestamp ?? Date.now() / 1000;

        // Warning state check
        if (
          node.temp_c > 70 ||
          node.power_and_hardware?.throttled?.healthy === false ||
          node.cpu_percent > 90
        ) {
          node.status = 'warning';
        } else {
          node.status = 'online';
        }

        // Log online recovery event
        if (wasOfflineOrRebooting) {
          addClusterEvent('online', hostname, `${hostname} reconnected and is online (IP: ${node.ip}, Uptime: ${node.uptime_seconds}s)`);
        } else if (node.status === 'warning' && previousStatus === 'online') {
          if (node.power_and_hardware?.throttled?.healthy === false) {
            addClusterEvent('warning', hostname, `${hostname} reported firmware throttling/undervoltage (${node.power_and_hardware.throttled.hex})`);
          } else if (node.temp_c > 70) {
            addClusterEvent('warning', hostname, `${hostname} high temperature alert (${node.temp_c}°C)`);
          }
        }

        // Detect SSH Session Login / Logout Events
        const currentLogout = node.ssh?.last_logout;
        if (currentLogout && currentLogout.logout_time && currentLogout.logout_time !== previousLastLogoutTime) {
          addClusterEvent(
            'info',
            hostname,
            `SSH session ended on ${hostname} from ${currentLogout.host || 'client'} (duration: ${currentLogout.duration || 'ended'})`,
            'SSH'
          );
        } else if (previousUsers > 0 && node.active_users === 0 && !wasOfflineOrRebooting) {
          addClusterEvent(
            'info',
            hostname,
            `SSH session closed on ${hostname}`,
            'SSH'
          );
        }

        if (node.active_users > previousUsers && !wasOfflineOrRebooting) {
          const clientIp = node.ssh?.last_login?.host || node.ssh?.active_sessions?.[0]?.host || 'remote';
          addClusterEvent(
            'info',
            hostname,
            `SSH session opened on ${hostname} from ${clientIp}`,
            'SSH'
          );
        }

        // Broadcast update via WebSocket
        broadcastWs({
          type: 'NODE_UPDATE',
          hostname,
          data: node,
          summary: computeClusterSummary()
        });
      } else if (messageType === 'cmd' && action === 'response') {
        if (payload && payload.action === 'fan' && payload.fan && nodes[hostname]) {
          if (!nodes[hostname].power_and_hardware) nodes[hostname].power_and_hardware = {};
          nodes[hostname].power_and_hardware.fan = payload.fan;
          if (payload.fan.state !== undefined) {
            nodes[hostname].power_and_hardware.fan_state = payload.fan.state;
          }
          broadcastWs({
            type: 'NODE_UPDATE',
            hostname,
            data: nodes[hostname],
            summary: computeClusterSummary()
          });
        }
        broadcastWs({
          type: 'CMD_RESPONSE',
          hostname,
          payload
        });
      }
    } catch (err) {
      console.warn(`[MQTT] Parse error on ${topic}:`, err.message);
    }
  });

  mqttClient.on('error', (err) => {
    console.warn(`[MQTT] Broker connection error: ${err.message}`);
  });
}

connectMqtt();

// ==========================================
// 8. SERVER START
// ==========================================
server.listen(PORT, HOST, () => {
  console.log(`
=====================================================
  PiCloud Digital Twin Dashboard is Running!
  URL:           http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}
  OIDC Base:     ${OIDC_BASE_URL}
  OIDC Callback: ${OIDC_CALLBACK_URL}
  MQTT:          ${MQTT_HOST}:${MQTT_PORT} (${MQTT_TOPIC_PREFIX})
  Dev Auth:      ${AUTH_DEV_MODE ? 'ENABLED (/auth/dev-login)' : 'DISABLED'}
=====================================================
  `);
});

