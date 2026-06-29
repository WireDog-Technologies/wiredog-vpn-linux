/**
 * Unix Socket client for communicating with the WireDog VPN Linux Service
 * Uses JSON-RPC 2.0 protocol over Unix sockets
 */

const net = require('net');
const log = require('electron-log');
const { execSync, exec } = require('child_process');
const { createRequest, parseResponse, parseNotification } = require('./json-rpc');

// Socket paths for production and development
const SOCKET_PATH = process.env.NODE_ENV === 'development'
  ? '/tmp/wiredog-dev.sock'
  : '/var/run/wiredog/wiredog.sock';

const CONNECT_TIMEOUT = 5000;
const REQUEST_TIMEOUT = 30000;

/**
 * ServiceClient - Connects to the WireDog VPN Linux Service via Unix socket
 */
class ServiceClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.pendingRequests = new Map();
    this.notificationHandlers = new Map();
    this.buffer = '';
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  /**
   * Connect to the service
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, CONNECT_TIMEOUT);

      this.socket = net.createConnection(SOCKET_PATH, () => {
        clearTimeout(timeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        log.info(`Connected to service at ${SOCKET_PATH}`);
        resolve();
      });

      this.socket.on('data', (data) => this.handleData(data));

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Service connection error:', err.message);
        this.handleDisconnect();
        reject(err);
      });

      this.socket.on('close', () => {
        log.info('Service connection closed');
        this.handleDisconnect();
      });
    });
  }

  /**
   * Disconnect from the service
   */
  disconnect() {
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.rejectPendingRequests(new Error('Disconnected'));
  }

  /**
   * Send a request and wait for response
   * @param {string} method - Method name
   * @param {object} params - Method parameters
   * @returns {Promise<any>} Response result
   */
  async request(method, params = null) {
    if (!this.connected) {
      await this.connect();
    }

    const message = createRequest(method, params);
    const id = JSON.parse(message).id;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.send(message);
    });
  }

  /**
   * Register a handler for notifications
   * @param {string} method - Notification method name
   * @param {function} handler - Handler function
   */
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Send raw message
   * @param {string} message - JSON string
   */
  send(message) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to service');
    }
    this.socket.write(message + '\n');
    log.debug('Sent:', message);
  }

  /**
   * Handle incoming data
   * @param {Buffer} data
   */
  handleData(data) {
    this.buffer += data.toString('utf-8');

    // Process complete lines
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        this.handleMessage(line.trim());
      }
    }
  }

  /**
   * Handle a complete message
   * @param {string} json - JSON string
   */
  handleMessage(json) {
    log.debug('Received:', json);

    // Check if notification
    const notification = parseNotification(json);
    if (notification) {
      const handler = this.notificationHandlers.get(notification.method);
      if (handler) {
        try {
          handler(notification.params);
        } catch (err) {
          log.error('Notification handler error:', err);
        }
      }
      return;
    }

    // Parse as response
    try {
      const parsed = JSON.parse(json);
      const pending = this.pendingRequests.get(parsed.id);

      if (pending) {
        this.pendingRequests.delete(parsed.id);

        if (parsed.error) {
          const error = new Error(parsed.error.message);
          error.code = parsed.error.code;
          error.data = parsed.error.data;
          pending.reject(error);
        } else {
          pending.resolve(parsed.result);
        }
      }
    } catch (err) {
      log.error('Failed to parse message:', err);
    }
  }

  /**
   * Handle disconnect
   */
  handleDisconnect() {
    this.connected = false;
    this.socket = null;
    this.rejectPendingRequests(new Error('Connection lost'));
    this.scheduleReconnect();
  }

  /**
   * Reject all pending requests
   * @param {Error} error
   */
  rejectPendingRequests(error) {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.warn('Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    log.info(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        log.warn('Reconnect failed:', err.message);
      }
    }, delay);
  }

  /**
   * Clear reconnect timer
   */
  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============ High-level API methods ============

  /**
   * Ping the service
   * @returns {Promise<{version: string, uptime: number}>}
   */
  async ping() {
    return this.request('ping');
  }

  /**
   * Get service configuration
   * @returns {Promise<{localMode: boolean, devMode: boolean}>}
   */
  async getConfig() {
    return this.request('getConfig');
  }

  /**
   * Check system dependencies for WireGuard
   * @returns {Promise<{ok: boolean, missing: string[], instructions: string}>}
   */
  async checkDependencies() {
    return this.request('checkDependencies');
  }

  /**
   * Connect to VPN
   * @param {string} serverId - Server ID
   * @param {object} config - WireGuard config
   * @param {boolean} killSwitch - Enable kill switch
   * @param {boolean} localMode - Local testing mode
   * @param {object|null} splitTunneling - Split tunneling config
   * @returns {Promise<{sessionId: string, assignedIp: string}>}
   */
  async vpnConnect(serverId, config, killSwitch = false, localMode = false, splitTunneling = null) {
    return this.request('connect', {
      serverId,
      config,
      killSwitch,
      localMode,
      splitTunneling
    });
  }

  /**
   * Disconnect from VPN
   * @returns {Promise<{success: boolean}>}
   */
  async vpnDisconnect(options = {}) {
    return this.request('disconnect', options);
  }

  /**
   * Get VPN status
   * @returns {Promise<{state: string, killSwitchActive: boolean, ...}>}
   */
  async getStatus() {
    return this.request('getStatus');
  }

  /**
   * Get VPN statistics
   * @returns {Promise<{bytesIn: number, bytesOut: number}>}
   */
  async getStats() {
    return this.request('getStats');
  }

  /**
   * Enable kill switch
   * @param {string} serverIp - VPN server IP
   * @param {number} interfaceIndex - VPN interface index (unused on Linux)
   * @returns {Promise<{success: boolean}>}
   */
  async enableKillSwitch(serverIp, interfaceIndex = 0) {
    return this.request('enableKillSwitch', { serverIp, interfaceIndex });
  }

  /**
   * Disable kill switch
   * @returns {Promise<{success: boolean}>}
   */
  async disableKillSwitch() {
    return this.request('disableKillSwitch');
  }

  /**
   * Get split tunneling diagnostics
   * @returns {Promise<object>}
   */
  async getSplitTunnelDiagnostics() {
    return this.request('getSplitTunnelDiagnostics');
  }

  /**
   * Start the Linux systemd service
   * @returns {Promise<void>}
   */
  async startService() {
    return new Promise((resolve, reject) => {
      exec('pkexec systemctl start wiredog-vpn.service', (error, stdout, stderr) => {
        if (error) {
          log.error('Failed to start service:', stderr);
          reject(new Error('Failed to start WireDog VPN service'));
          return;
        }
        log.info('Service started successfully');
        // Wait for service to be ready
        setTimeout(resolve, 2000);
      });
    });
  }

  /**
   * Check if service is running
   * @returns {Promise<boolean>}
   */
  async isServiceRunning() {
    return new Promise((resolve) => {
      exec('systemctl is-active wiredog-vpn.service', (error, stdout) => {
        resolve(stdout.trim() === 'active');
      });
    });
  }
}

// Export singleton instance
const serviceClient = new ServiceClient();
module.exports = serviceClient;
