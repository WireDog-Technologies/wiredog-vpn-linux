const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const log = require('electron-log');
const serviceClient = require('../ipc/service-client');

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

    try {
      // 1. Get connection config from backend API
      log.info('VPN: Fetching connection config from backend...');
      log.info('VPN: API URL:', this.apiBaseUrl);
      const requestPayload = {
        serverId,
        localMode: settings.localMode || false
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
        throw new Error(error.error || `API error: ${response.status}`);
      }

      const responseData = await response.json();
      const { config, sessionId, server } = responseData;

      log.info('VPN: Received connection config');
      log.info('VPN: Full API Response:', JSON.stringify(responseData, null, 2));
      log.info('VPN: Server location:', server?.city && server?.stateCode ? `${server.city}, ${server.stateCode}` : 'unknown');
      log.info('VPN: Server Endpoint (IP:Port):', config?.Endpoint || config?.endpoint || config?.peer?.endpoint);
      const publicKey = config?.serverPublicKey || config?.ServerPublicKey || config?.peer?.publicKey;
      log.info('VPN: Server Public Key:', publicKey ? publicKey.substring(0, 10) + '...' : 'undefined');
      log.info('VPN: Assigned Address:', config?.Address || config?.address);

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

      // 3. Store session info
      this.currentSession = {
        sessionId,
        server,
        assignedIp: result.assignedIp,
        connectedAt: new Date().toISOString()
      };

      // Persist server details so they can be restored if the app restarts
      this.saveSessionCache(this.currentSession);

      log.info('VPN: Connected successfully');
      this.notifyStatusChange();
      return this.currentSession;

    } catch (error) {
      log.error('VPN: Connection failed:', error);

      // Clean up the partial tunnel state. If permanentKillSwitch is set, keep
      // the kill switch rules active so the user stays protected after a failed
      // reconnect attempt. Otherwise remove them so internet is restored.
      try {
        const keepKillSwitch = !!(settings.permanentKillSwitch);
        await serviceClient.vpnDisconnect({ keepKillSwitch });
      } catch (cleanupError) {
        log.warn('VPN: Cleanup failed:', cleanupError.message);
      }

      throw error;
    }
  }

  /**
   * Disconnect from VPN
   * @param {string} token - JWT token for API call
   */
  async disconnect(token = '', options = {}) {
    const { disableProtection = true } = options;
    log.info(`VPN: Disconnect request (disableProtection=${disableProtection})`);

    // Null the session BEFORE the service call so the monitor can't race:
    // if it fires while WireGuard is being torn down it would see
    // currentSession!=null + state=disconnected and wrongly emit 'error'.
    const savedSession = this.currentSession;
    this.currentSession = null;

    try {
      // Pass keepKillSwitch so the service knows whether to tear down iptables rules.
      // "Stay Protected" keeps rules active; "Turn Off Always-On" removes them.
      await serviceClient.vpnDisconnect({ keepKillSwitch: !disableProtection });

      // Notify backend (don't fail if this errors)
      if (savedSession) {
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          await fetch(`${this.apiBaseUrl}/vpn/disconnect`, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({ sessionId: savedSession.sessionId })
          });
        } catch (apiError) {
          log.warn('VPN: Failed to notify backend of disconnect:', apiError);
        }
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
        status: derivedStatus,
        session: this.currentSession,
        killSwitchEnabled: status.killSwitchActive,
        advancedKillSwitchActive,
      };
    } catch (error) {
      return {
        status: this.currentSession ? 'error' : 'disconnected',
        session: this.currentSession,
        killSwitchEnabled: false,
        advancedKillSwitchActive: false,
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
   * Called once at startup. If a cached sessionId exists on disk but the tunnel
   * is not running (crash/kill recovery), notify the backend to decrement the
   * connection counter, then clear the stale cache.
   */
  async performStartupCleanup(token = '') {
    const cached = this.loadSessionCache();
    if (!cached?.sessionId) return;

    try {
      const status = await serviceClient.getStatus();
      if (status.state === 'connected') return; // Tunnel still active — session valid
    } catch {
      return; // Can't determine tunnel state — skip cleanup
    }

    log.info('VPN: Startup cleanup — stale session found, notifying backend');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${this.apiBaseUrl}/vpn/disconnect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: cached.sessionId })
      });
    } catch (err) {
      log.warn('VPN: Startup cleanup API call failed (non-critical):', err.message);
    }

    this.clearSessionCache();
    log.info('VPN: Startup cleanup complete');
  }

  restoreSession(savedSession) {
    if (!this.currentSession && savedSession) {
      this.currentSession = savedSession;
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
