const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const log = require('electron-log');
const serviceClient = require('../ipc/service-client');

// Thrown when a connect() attempt is aborted via cancelConnect() (user tapped Connect again
// while connecting/reconnecting). Distinguished from a real failure so callers can skip
// surfacing an error toast for it.
class ConnectCancelledError extends Error {
  constructor() {
    super('Connection cancelled');
    this.name = 'ConnectCancelledError';
  }
}

// Thrown when /vpn/connect rejects the auth token (expired/invalid). Distinguished by a
// fixed sentinel message so the renderer can detect it across the IPC boundary (only
// message/name/stack survive electron's ipcRenderer.invoke error serialization) and route
// the user back to login instead of leaving them stuck on a raw "Invalid token" toast.
class UnauthorizedError extends Error {
  constructor() {
    super('WIREDOG_UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

/**
 * VPN Service - Main facade for VPN operations
 * Communicates with the Linux Service via Unix sockets
 * The Linux Service handles WireGuard and Kill Switch with iptables
 */
class VPNService {
  constructor() {
    this.currentSession = null;
    this.settings = { killSwitch: false, localMode: false };
    this.statusCallbacks = [];
    this.apiBaseUrl = process.env.NODE_ENV === 'development'
      ? (process.env.VITE_API_URL || 'http://localhost:3001/api')
      : (process.env.VITE_API_URL || 'https://api.wiredogvpn.com/api');
    this.serviceConnected = false;
    this.serviceConfig = null;
    this.monitorInterval = null;
    this.configStore = null; // injected from main.js — electron-store, for the pending-disconnect ledger
    this._getAuthToken = null; // injected from main.js — () => auth token string

    // --- Connection-counter / auto-reconnect bookkeeping ---
    this.currentServerId = null;
    this.userInitiatedDisconnect = false; // persists across the whole disconnected period
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectBaseDelay = 1.0; // seconds
    this.reconnectMaxDelay = 15.0; // seconds
    this.minimumStableConnectionDuration = 30; // seconds — a connection that drops before this never really established
    this.disconnectNotifyDelayMs = 1500; // time for tunnel to fully stop before notifying backend
    this.connectedSince = null;
    this._reconnectTimer = null;
    // Cooperative cancellation token for whichever connect() call is currently in flight
    // (either a first attempt or an auto-reconnect retry) — set by cancelConnect().
    this._connectAbortToken = null;
    // Guards against firing two concurrent /disconnect calls for the same session (e.g. a
    // crash-recovery retry and a foreground retry landing close together).
    this.sessionsPendingCleanup = new Set();
    this.hasHandledFirstFocusEvent = false;

    log.info('VPN Service initialized');
    log.info('API Base URL:', this.apiBaseUrl);

    this.sessionCachePath = path.join(app.getPath('userData'), 'last-session.json');

    this.setupNotificationHandlers();
    this.startMonitoring();
  }

  saveSessionCache(session) {
    try {
      fs.writeFileSync(this.sessionCachePath, JSON.stringify(session), 'utf-8');
    } catch (err) {
      log.warn('VPN: Failed to write session cache:', err.message);
    }
  }

  loadSessionCache() {
    try {
      if (!fs.existsSync(this.sessionCachePath)) return null;
      return JSON.parse(fs.readFileSync(this.sessionCachePath, 'utf-8'));
    } catch (err) {
      log.warn('VPN: Failed to read session cache:', err.message);
      return null;
    }
  }

  clearSessionCache() {
    try {
      if (fs.existsSync(this.sessionCachePath)) fs.unlinkSync(this.sessionCachePath);
    } catch (err) {
      log.warn('VPN: Failed to clear session cache:', err.message);
    }
  }

  /**
   * Inject the electron-store settings store — used for the durable pending-disconnect ledger.
   */
  setConfigStore(store) {
    this.configStore = store;
  }

  /**
   * Inject a function that returns the current auth token. Needed because auto-reconnect and
   * pending-disconnect retries originate from inside VPNService itself, not from an IPC call
   * that already carries a token from the renderer.
   */
  setAuthTokenProvider(fn) {
    this._getAuthToken = fn;
  }

  // --- Pending-disconnect ledger ---
  // A sessionId is written here *before* the network call is attempted, and only removed on
  // confirmed success, so a disconnect lost to a network blip / offline app survives to be
  // retried on next launch or foreground instead of leaking the backend counter forever.

  _pendingDisconnectIds() {
    if (!this.configStore) return [];
    return this.configStore.get('pendingDisconnectIds', []);
  }

  _addPendingDisconnect(sessionId) {
    if (!this.configStore) return;
    const ids = new Set(this._pendingDisconnectIds());
    ids.add(sessionId);
    this.configStore.set('pendingDisconnectIds', Array.from(ids));
  }

  _removePendingDisconnect(sessionId) {
    if (!this.configStore) return;
    const ids = new Set(this._pendingDisconnectIds());
    ids.delete(sessionId);
    this.configStore.set('pendingDisconnectIds', Array.from(ids));
  }

  /**
   * Best-effort notification to the backend that a session is no longer valid, so its
   * device-count slot is released. This is the single choke point every code path that could
   * leave a claimed-but-unreleased session routes through.
   *
   * The sessionId is persisted to the durable pending list *before* the network call, and only
   * removed on confirmed success — if the app has no connectivity right now, the call fails
   * silently, but the record survives so retryPendingDisconnects() can retry it later instead of
   * leaking the counter forever. The backend's /disconnect is NOT idempotent (unconditionally
   * decrements on every valid call), so sessionsPendingCleanup guards against firing two
   * concurrent calls for the same session.
   */
  cleanupOrphanedSession(sessionId, reason) {
    if (this.sessionsPendingCleanup.has(sessionId)) return;
    this.sessionsPendingCleanup.add(sessionId);

    log.info(`VPN: cleaning up orphaned session (${reason})`);
    this._addPendingDisconnect(sessionId);

    setTimeout(async () => {
      try {
        const token = this._getAuthToken ? this._getAuthToken() : '';
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const response = await fetch(`${this.apiBaseUrl}/vpn/disconnect`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({ sessionId }),
        });
        if (response.ok) {
          this._removePendingDisconnect(sessionId);
        }
        // Non-ok: left in the pending list, retried via retryPendingDisconnects() later.
      } catch (err) {
        log.warn('VPN: cleanupOrphanedSession disconnect failed (will retry):', err.message);
        // Left in the pending list — retried via retryPendingDisconnects() later.
      } finally {
        this.sessionsPendingCleanup.delete(sessionId);
      }
    }, this.disconnectNotifyDelayMs);
  }

  /**
   * Retries any /disconnect calls that were owed but never confirmed — e.g. the app had no
   * connectivity right as cleanupOrphanedSession()'s call went out, so nothing ever reached
   * the backend. Safe to call unconditionally: each retry goes through cleanupOrphanedSession()'s
   * own in-flight guard.
   */
  retryPendingDisconnects() {
    for (const sessionId of this._pendingDisconnectIds()) {
      this.cleanupOrphanedSession(sessionId, 'retrying pending disconnect from previous launch');
    }
  }

  /**
   * Called when the app window regains focus. The very first firing coincides with the
   * cold-start retry performStartupCleanup() already performs, so it's skipped there in favor
   * of that one.
   */
  handleAppForeground() {
    if (this.hasHandledFirstFocusEvent) {
      this.retryPendingDisconnects();
    } else {
      this.hasHandledFirstFocusEvent = true;
    }
  }

  /**
   * Poll for unexpected connection drops every 5 seconds.
   * Notifies listeners when status changes without an explicit disconnect call.
   */
  startMonitoring() {
    if (this.monitorInterval) return;
    let lastStatus = 'disconnected';
    this.monitorInterval = setInterval(async () => {
      try {
        const status = await this.getFullStatus();
        if (status.status !== lastStatus) {
          lastStatus = status.status;

          // Unexpected drop: we still hold a session, but the tunnel reports disconnected and
          // nobody called disconnect()/cancelConnect() intentionally. This is the entry point
          // into the auto-reconnect loop — subsequent retries chain themselves directly from
          // _attemptReconnect's own timer rather than depending on further poll transitions.
          if (status.status === 'error' && this.currentSession && !this.userInitiatedDisconnect) {
            this._handleUnexpectedDrop();
          }

          this.statusCallbacks.forEach(cb => {
            try { cb(status); } catch {}
          });
        }
      } catch {}
    }, 5000);
  }

  /**
   * Set up handlers for service notifications
   */
  setupNotificationHandlers() {
    serviceClient.onNotification('status_changed', (params) => {
      log.info('VPN: Status changed:', params);
      this.notifyStatusChange();
    });
  }

  /**
   * Ensure service is running (start if not available)
   */
  async ensureServiceRunning() {
    try {
      // Try to connect first
      if (this.serviceConnected) return;

      await serviceClient.connect();
      const ping = await serviceClient.ping();
      log.info('VPN: Service is running (version: %s)', ping.version);
      return true;
    } catch (error) {
      log.warn('VPN: Service not available, attempting to start...');
      try {
        await serviceClient.startService();
        log.info('VPN: Service started, attempting connection...');

        // Try to connect again after starting
        await serviceClient.connect();
        const ping = await serviceClient.ping();
        log.info('VPN: Connected to service (version: %s)', ping.version);
        return true;
      } catch (startError) {
        log.error('VPN: Failed to start service:', startError.message);
        throw new Error('VPN Service could not be started. Please ensure the application was installed correctly and you have the necessary permissions.');
      }
    }
  }

  /**
   * Initialize connection to service
   */
  async initializeService() {
    if (this.serviceConnected) return;

    try {
      await serviceClient.connect();
      const ping = await serviceClient.ping();
      log.info('VPN: Connected to service (version: %s)', ping.version);

      // Fetch service configuration
      try {
        this.serviceConfig = await serviceClient.getConfig();
        log.info('VPN: Service config retrieved:');
        log.info('  - Local Mode:', this.serviceConfig.localMode);
        log.info('  - Dev Mode:', this.serviceConfig.devMode);

        // Set localMode from service config if not already set in settings
        if (!this.settings.localMode && this.serviceConfig.localMode) {
          this.settings.localMode = this.serviceConfig.localMode;
          log.info('VPN: Local mode enabled from service configuration');
        }
      } catch (configError) {
        log.warn('VPN: Could not fetch service config:', configError.message);
        // Continue even if config fetch fails - not critical
      }

      this.serviceConnected = true;

      // Emit initial status so the UI reflects an already-connected tunnel
      // (e.g. app restarted while VPN was running). Don't await — let UI settle first.
      setTimeout(() => this.notifyStatusChange(), 200);
    } catch (error) {
      log.warn('VPN: Service not available, will retry on next operation:', error.message);
      this.serviceConnected = false;
    }
  }

  /**
   * Check if all required system dependencies are installed
   * @returns {Promise<{ok: boolean, missing: string[], instructions: string}>}
   */
  async checkDependencies() {
    try {
      await this.ensureServiceRunning();
      return await serviceClient.checkDependencies();
    } catch (error) {
      log.error('VPN: Failed to check dependencies:', error);
      return {
        ok: false,
        missing: ['VPN Service'],
        instructions: 'The WireDog VPN service is not running. Please restart the application.'
      };
    }
  }

  /**
   * Set the API base URL
   */
  setApiUrl(url) {
    this.apiBaseUrl = url;
  }

  /**
   * Connect to a VPN server
   * @param {string} serverId - Server ID to connect to
   * @param {Object} settings - VPN settings (killSwitch, protocol, localMode, etc.)
   * @param {string} token - JWT token for API authentication
   */
  async connect(serverId, settings, token = '') {
    log.info(`VPN: Connect request to server ${serverId}`);

    // Cooperative cancellation token for this specific attempt — cancelConnect() flips
    // .cancelled on whatever token is current; checked at the same two checkpoints used below
    // (right before and right after the tunnel actually comes up).
    const abortToken = { cancelled: false };
    this._connectAbortToken = abortToken;

    // Ensure service is running (start it if necessary)
    await this.ensureServiceRunning();

    // Check dependencies before attempting to connect
    log.info('VPN: Checking system dependencies...');
    const deps = await this.checkDependencies();
    if (!deps.ok) {
      log.error('VPN: Missing dependencies:', deps.missing);
      const error = new Error(`Missing required dependencies: ${deps.missing.join(', ')}\n\n${deps.instructions}`);
      error.code = 'MISSING_DEPENDENCIES';
      error.dependencies = deps;
      throw error;
    }
    log.info('VPN: All dependencies satisfied');

    // Merge settings with service config to ensure localMode is preserved
    if (this.serviceConfig?.localMode) {
      settings.localMode = true;
    }

    log.info(`VPN: Local mode: ${settings.localMode || false}`);
    this.settings = settings;

    this.connectedSince = null;
    if (!this.isReconnecting) {
      this.userInitiatedDisconnect = false;
      this.reconnectAttempts = 0;
    }

    // If we're in the stay-protected state (kill switch active, no tunnel), the
    // iptables rules block all internet including the API fetch below.
    // Disable the kill switch now — handleConnect on the service will immediately
    // re-enable it in bootstrap mode before WireGuard comes up.
    try {
      const currentStatus = await this.getFullStatus();
      if (currentStatus.advancedKillSwitchActive) {
        log.info('VPN: Stay-protected state detected — clearing kill switch before API fetch');
        await serviceClient.disableKillSwitch();
      }
    } catch (ksCheckError) {
      log.warn('VPN: Could not check/clear kill switch state:', ksCheckError.message);
    }

    // Declared outside the try block so the catch clause below can see whether a sessionId
    // was already claimed from the backend (and thus already incremented the counter) before
    // something later in this function threw.
    let sessionId, server, config;

    try {
      // 1. Get connection config from backend API
      log.info('VPN: Fetching connection config from backend...');
      log.info('VPN: API URL:', this.apiBaseUrl);
      const requestPayload = {
        serverId,
        localMode: settings.localMode || false,
        blockAds: settings.blockAdsEnabled ?? true,
        blockMalware: settings.blockMalwareEnabled ?? true,
      };
      log.info('VPN: Request payload:', JSON.stringify(requestPayload));

      const headers = {
        'Content-Type': 'application/json',
      };

      // Add Authorization header if token is available
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(`${this.apiBaseUrl}/vpn/connect`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        // The backend reuses 429 for the 5-device connection cap (the only source of 429 on
        // this endpoint) — surface a clean, actionable message instead of the raw backend text.
        if (response.status === 429 && error.error?.includes('Connection limit exceeded')) {
          throw new Error("You've reached your 5-device limit. Disconnect another device to continue.");
        }
        if (response.status === 401) {
          throw new UnauthorizedError();
        }
        throw new Error(error.error || `API error: ${response.status}`);
      }

      const responseData = await response.json();
      ({ config, sessionId, server } = responseData);
      this.currentServerId = serverId;

      log.info('VPN: Received connection config');
      log.info('VPN: Full API Response:', JSON.stringify(responseData, null, 2));
      log.info('VPN: Server location:', server?.city && server?.stateCode ? `${server.city}, ${server.stateCode}` : 'unknown');
      log.info('VPN: Server Endpoint (IP:Port):', config?.Endpoint || config?.endpoint || config?.peer?.endpoint);
      const publicKey = config?.serverPublicKey || config?.ServerPublicKey || config?.peer?.publicKey;
      log.info('VPN: Server Public Key:', publicKey ? publicKey.substring(0, 10) + '...' : 'undefined');
      log.info('VPN: Assigned Address:', config?.Address || config?.address);

      // A cancel (tap-again-to-cancel) may have arrived while awaiting everything above —
      // check before starting the tunnel.
      if (abortToken.cancelled) throw new ConnectCancelledError();

      // 2. Connect via Linux Service (handles WireGuard + Kill Switch)
      log.info('VPN: Connecting via Linux Service...');
      log.info('VPN: Sending to Linux Service:');
      log.info('  - ServerId:', serverId);
      log.info('  - Config.Endpoint:', config?.Endpoint || config?.endpoint || config?.peer?.endpoint);
      log.info('  - Kill Switch Enabled:', settings.killSwitch);
      log.info('  - Local Mode:', settings.localMode || false);
      log.info('  - Split Tunneling:', settings.splitTunneling?.enabled ? `${settings.splitTunneling.mode} mode, ${settings.splitTunneling.apps?.length || 0} apps` : 'disabled');
      const result = await serviceClient.vpnConnect(
        serverId,
        config,
        settings.killSwitch,
        settings.localMode || false,
        settings.splitTunneling || null
      );

      // The tunnel just came up — if a cancel landed in the narrow window right around this
      // call, tear it back down via the catch block's cleanup below rather than leaving an
      // untracked live tunnel.
      if (abortToken.cancelled) throw new ConnectCancelledError();

      // 3. Store session info
      // publicIp = the backend-assigned per-session SNAT exit IP (server.exitIp) — this is
      // what external services actually see when the tunnel is active. server.ipAddress is
      // only the VPN server's own address, not what the user's traffic appears to come from.
      this.currentSession = {
        sessionId,
        server,
        assignedIp: result.assignedIp,
        publicIp: server?.exitIp || server?.ipAddress || '',
        connectedAt: new Date().toISOString()
      };
      this.connectedSince = Date.now();
      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      // Persist server details so they can be restored if the app restarts
      this.saveSessionCache(this.currentSession);

      log.info('VPN: Connected successfully');
      this.notifyStatusChange();
      return this.currentSession;

    } catch (error) {
      if (error instanceof ConnectCancelledError) {
        // User-initiated cancel (tap-again-to-cancel) — expected, not a failure.
        log.info('VPN: Connect cancelled');
      } else if (error instanceof UnauthorizedError) {
        log.warn('VPN: Connect failed — auth token rejected by backend (expired or invalid)');
      } else {
        log.error('VPN: Connection failed:', error);
      }

      // Clean up the partial tunnel state. If permanentKillSwitch is set, keep
      // the kill switch rules active so the user stays protected after a failed
      // reconnect attempt. Otherwise remove them so internet is restored.
      try {
        const keepKillSwitch = !!(settings.permanentKillSwitch);
        await serviceClient.vpnDisconnect({ keepKillSwitch });
      } catch (cleanupError) {
        log.warn('VPN: Cleanup failed:', cleanupError.message);
      }

      // If we obtained a sessionId from the backend (thus incrementing its device counter)
      // before something later in this function failed, release it durably.
      if (sessionId) {
        this.cleanupOrphanedSession(sessionId, 'connect() threw after sessionId obtained');
        if (!this.isReconnecting) {
          this.currentServerId = null;
        }
      }

      throw error;
    }
  }

  /**
   * Cancels an in-progress connect() — either a first attempt (still awaiting the backend or
   * the tunnel starting) or an in-progress auto-reconnect loop (backoff wait or an active retry
   * attempt).
   */
  cancelConnect() {
    log.info('VPN: Cancel connect requested');

    // Flips whichever connect() call is currently in flight (first attempt or an active
    // reconnect retry) — checked cooperatively at the two checkpoints inside connect().
    if (this._connectAbortToken) {
      this._connectAbortToken.cancelled = true;
    }

    if (this.isReconnecting) {
      this.userInitiatedDisconnect = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      // A previous retry may have already claimed a session (and thus incremented the counter)
      // before this cancel arrived — release it so the counter stays net-zero.
      if (this.currentSession?.sessionId) {
        this.disconnect('', {}).catch(err => log.warn('VPN: cancelConnect disconnect failed:', err.message));
      }
    }
  }

  /**
   * Disconnect from VPN
   * @param {string} token - unused; cleanupOrphanedSession fetches a fresh token via the
   *   injected provider instead, since it can also fire from internal (non-IPC) code paths.
   */
  async disconnect(token = '', options = {}) {
    const { disableProtection = true } = options;
    log.info(`VPN: Disconnect request (disableProtection=${disableProtection})`);

    // Persists across the whole disconnected period so a status transition arriving after
    // disconnect() has already returned is still correctly recognized as user-initiated, not
    // an unexpected drop — reset only at the start of the next connect().
    this.userInitiatedDisconnect = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.currentServerId = null;
    this.connectedSince = null;

    // Null the session BEFORE the service call so the monitor can't race:
    // if it fires while WireGuard is being torn down it would see
    // currentSession!=null + state=disconnected and wrongly emit 'error'.
    const savedSession = this.currentSession;
    this.currentSession = null;

    try {
      // Pass keepKillSwitch so the service knows whether to tear down iptables rules.
      // "Stay Protected" keeps rules active; "Turn Off Always-On" removes them.
      await serviceClient.vpnDisconnect({ keepKillSwitch: !disableProtection });

      // Notify backend — durable cleanup (persisted + retried on failure) rather than a bare
      // fire-and-forget fetch, so a disconnect lost to a network blip doesn't leak the counter.
      if (savedSession) {
        this.cleanupOrphanedSession(savedSession.sessionId, 'user-initiated disconnect');
      }

      this.clearSessionCache();
      log.info('VPN: Disconnected successfully');
      this.notifyStatusChange();

    } catch (error) {
      log.error('VPN: Disconnect error:', error);
      this.notifyStatusChange();
      throw error;
    }
  }

  /**
   * Unexpected tunnel disconnect — we still hold a session but the service reports the tunnel
   * down and nobody called disconnect()/cancelConnect(). Cleans up the stale session (if it
   * never proved stable) and kicks off the auto-reconnect loop.
   */
  _handleUnexpectedDrop() {
    log.info('VPN: Unexpected tunnel disconnect — clearing stale session');

    const staleSessionId = this.currentSession?.sessionId;
    const serverId = this.currentServerId;
    const wasStable = this.connectedSince != null &&
      (Date.now() - this.connectedSince) >= this.minimumStableConnectionDuration * 1000;

    // Connection never proved itself stable — clean up its slot rather than letting the
    // upcoming reconnect attempt leak another increment on top of this orphaned one.
    // (A connection that *was* stable and then drops is not cleaned up here — the reconnect
    // attempt below claims a brand-new session instead; that old session's slot is only
    // reclaimed via the backend's manual /vpn/reset-connections escape hatch.)
    if (!wasStable && staleSessionId) {
      this.cleanupOrphanedSession(
        staleSessionId,
        `dropped before ${this.minimumStableConnectionDuration}s stability threshold`
      );
    }

    this.currentSession = null;
    this.connectedSince = null;
    this.clearSessionCache();

    if (serverId) {
      this._attemptReconnect(serverId);
    }

    // _attemptReconnect() above already flipped isReconnecting — broadcast now so the UI
    // shows 'connecting' immediately instead of the stale 'error' snapshot startMonitoring()
    // captured before this method ran (which won't refresh until its next 5s poll tick).
    this.notifyStatusChange();
  }

  /**
   * Auto-reconnect after an unexpected tunnel drop. Exponential backoff with jitter (1s, 2s,
   * 4s, 8s, 15s max by default), up to maxReconnectAttempts, using the same server/settings as
   * the connection that just dropped.
   *
   * Unlike a tunnel-event-driven platform, Linux's status is polled — so each attempt chains
   * the next one directly from its own failure instead of relying on a further poll transition
   * to re-trigger this loop.
   */
  _attemptReconnect(serverId) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.isReconnecting = false;
      log.error(`VPN: Reconnection failed after ${this.maxReconnectAttempts} attempts`);
      if (this.currentSession?.sessionId) {
        this.cleanupOrphanedSession(this.currentSession.sessionId, 'reconnect attempts exhausted');
      }
      this.currentServerId = null;
      this.notifyStatusChange();
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts += 1;
    log.warn(`VPN: Auto-reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

    const baseDelay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectMaxDelay
    );
    const jitterFactor = 0.5 + Math.random(); // 0.5..1.5
    const delay = baseDelay * jitterFactor;

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (this.userInitiatedDisconnect) return;
      try {
        const token = this._getAuthToken ? this._getAuthToken() : '';
        await this.connect(serverId, this.settings, token);
        // Success: connect() already reset isReconnecting/reconnectAttempts/connectedSince.
      } catch (err) {
        log.warn(`VPN: Reconnect attempt ${this.reconnectAttempts} failed: ${err.message}`);
        if (!this.userInitiatedDisconnect) {
          this._attemptReconnect(serverId);
        }
      }
    }, delay);
  }

  /**
   * Get full VPN status
   */
  async getFullStatus() {
    try {
      const status = await serviceClient.getStatus();

      // App restarted while tunnel was active — restore session from service state.
      // Merge with the on-disk cache to recover full server details (city, state, etc.).
      if (!this.currentSession && status.state === 'connected' && status.session) {
        const cached = this.loadSessionCache();
        this.currentSession = {
          sessionId: cached?.sessionId || null,
          server: cached?.server || null,
          assignedIp: status.session.assignedIp,
          publicIp: cached?.publicIp || cached?.server?.exitIp || cached?.server?.ipAddress || '',
          connectedAt: cached?.connectedAt || status.session.connectedAt,
        };
        log.info('VPN: Session restored from service (app restart with active tunnel)');
      }

      const derivedStatus = (this.currentSession && status.state === 'disconnected')
        ? 'error'
        : status.state;
      // Kill switch active with no tunnel = "disconnected but protected"
      const advancedKillSwitchActive = !this.currentSession && !!status.killSwitchActive;
      return {
        // During an auto-reconnect backoff wait, the tunnel is genuinely down (no session) so
        // the mapping above reports 'disconnected'/'error' — override so the UI shows the same
        // in-progress affordance (and cancel button) as a first connect attempt.
        status: this.isReconnecting ? 'connecting' : derivedStatus,
        session: this.currentSession,
        killSwitchEnabled: status.killSwitchActive,
        advancedKillSwitchActive,
        isReconnecting: this.isReconnecting,
      };
    } catch (error) {
      return {
        status: this.isReconnecting ? 'connecting' : (this.currentSession ? 'error' : 'disconnected'),
        session: this.currentSession,
        killSwitchEnabled: false,
        advancedKillSwitchActive: false,
        isReconnecting: this.isReconnecting,
      };
    }
  }

  /**
   * Get connection statistics (bytes transferred)
   */
  async getStats() {
    try {
      const stats = await serviceClient.getStats();
      return {
        bytesReceived: stats.bytesIn.toString(),
        bytesSent: stats.bytesOut.toString()
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Toggle kill switch while VPN is connected
   * @param {boolean} enabled - Enable or disable kill switch
   */
  async toggleKillSwitch(enabled) {
    log.info(`VPN: Toggle kill switch: ${enabled}`);

    try {
      await this.ensureServiceRunning();

      if (enabled) {
        // Get server IP from current session
        if (!this.currentSession) {
          throw new Error('VPN must be connected to enable kill switch');
        }
        const serverIp = this.currentSession.server?.endpoint?.split(':')[0];
        if (!serverIp) {
          throw new Error('Cannot determine server IP');
        }
        await serviceClient.enableKillSwitch(serverIp, 0);
      } else {
        await serviceClient.disableKillSwitch();
      }

      // Update local settings
      this.settings.killSwitch = enabled;
      log.info('VPN: Kill switch toggled successfully');
      this.notifyStatusChange();

    } catch (error) {
      log.error('VPN: Toggle kill switch failed:', error);
      throw error;
    }
  }

  async emergencyReset() {
    log.info('VPN: Emergency reset initiated');

    try {
      await this.ensureServiceRunning();

      // Disable kill switch if active
      try {
        await serviceClient.disableKillSwitch();
        log.info('VPN: Kill switch disabled');
      } catch (error) {
        log.warn('VPN: Failed to disable kill switch during reset:', error);
      }

      // Disconnect VPN
      try {
        await serviceClient.vpnDisconnect({ keepKillSwitch: false });
        log.info('VPN: VPN disconnected');
      } catch (error) {
        log.warn('VPN: Failed to disconnect VPN during reset:', error);
      }

      this.userInitiatedDisconnect = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.currentServerId = null;
      this.connectedSince = null;
      if (this.currentSession) {
        this.cleanupOrphanedSession(this.currentSession.sessionId, 'emergency reset');
      }

      // Clear session cache and state
      this.currentSession = null;
      this.clearSessionCache();
      this.settings.killSwitch = false;
      this.settings.permanentKillSwitch = false;

      log.info('VPN: Emergency reset completed successfully');
      this.notifyStatusChange();

      return { success: true };

    } catch (error) {
      log.error('VPN: Emergency reset failed:', error);
      throw error;
    }
  }

  async enableAdvancedKillSwitch() {
    log.info('VPN: Enable advanced (persistent) kill switch');
    try {
      await this.ensureServiceRunning();
      await serviceClient.enableKillSwitch('0.0.0.0', 0);
      this.settings.permanentKillSwitch = true;
      log.info('VPN: Advanced kill switch enabled');
      this.notifyStatusChange();
    } catch (error) {
      log.error('VPN: Enable advanced kill switch failed:', error);
      throw error;
    }
  }

  async disableAdvancedKillSwitch() {
    log.info('VPN: Disable advanced (persistent) kill switch');
    try {
      await this.ensureServiceRunning();
      await serviceClient.disableKillSwitch();
      this.settings.permanentKillSwitch = false;
      log.info('VPN: Advanced kill switch disabled');
      this.notifyStatusChange();
    } catch (error) {
      log.error('VPN: Disable advanced kill switch failed:', error);
      throw error;
    }
  }

  async temporarilyDisableKillSwitch() {
    log.info('VPN: Temporarily disabling kill switch (without changing settings)');
    try {
      await this.ensureServiceRunning();
      await serviceClient.disableKillSwitch();
      log.info('VPN: Kill switch temporarily disabled');
      // Note: NOT changing this.settings.permanentKillSwitch - this is temporary only
    } catch (error) {
      log.error('VPN: Temporarily disable kill switch failed:', error);
      throw error;
    }
  }

  /**
   * Called once at startup. Retries any pending-disconnect ledger entries first (pure HTTP,
   * independent of helper/tunnel availability), then — if a cached sessionId exists on disk
   * but the tunnel is not running (crash/kill recovery) — routes a durable cleanup through
   * cleanupOrphanedSession() so it survives a network blip instead of being forgotten outright.
   */
  async performStartupCleanup() {
    this.retryPendingDisconnects();

    const cached = this.loadSessionCache();
    if (!cached?.sessionId) return;

    try {
      const status = await serviceClient.getStatus();
      if (status.state === 'connected') return; // Tunnel still active — session valid
    } catch {
      return; // Can't determine tunnel state — skip cleanup
    }

    log.info('VPN: Startup cleanup — stale session found, notifying backend');
    this.cleanupOrphanedSession(cached.sessionId, 'crash recovery — stale session');
    this.clearSessionCache();
    log.info('VPN: Startup cleanup complete');
  }

  restoreSession(savedSession) {
    if (!this.currentSession && savedSession) {
      this.currentSession = savedSession;
      // Needed so an unexpected drop after a restart-while-connected can still auto-reconnect.
      this.currentServerId = savedSession.server?.id ?? savedSession.server?.serverId ?? null;
      log.info('VPN: Restored session from saved state');
    }
  }

  /**
   * Register callback for status changes
   */
  onStatusChange(callback) {
    this.statusCallbacks.push(callback);
  }

  /**
   * Notify all status change listeners
   */
  async notifyStatusChange() {
    const status = await this.getFullStatus();
    this.statusCallbacks.forEach(cb => {
      try {
        cb(status);
      } catch (error) {
        log.error('Status callback error:', error);
      }
    });
  }

  /**
   * Force cleanup (for app shutdown)
   */
  async cleanup() {
    log.info('VPN: Cleanup on shutdown');

    // Persist the sessionId to the pending-disconnect ledger so it survives even if the process
    // exits before cleanupOrphanedSession's own delayed network attempt gets to run — the actual
    // decrement then happens via retryPendingDisconnects() on the next launch.
    if (this.currentSession) {
      this.cleanupOrphanedSession(this.currentSession.sessionId, 'app quit');
    }

    try {
      await serviceClient.vpnDisconnect();
    } catch (error) {
      // Service may not be available, that's ok
      // The service will clean up its own resources
    }

    serviceClient.disconnect();
    this.currentSession = null;
  }
}

// Export singleton instance
module.exports = new VPNService();
