import logger from '../utils/logger';
import wireguardManager from '../tunnel/wireguard-manager';
import killSwitchManager from '../firewall/kill-switch-manager';
import splitTunnelManager from '../split-tunnel/split-tunnel-manager';
import { SERVICE_VERSION } from '../version';

const startTime = Date.now();

// Current session state
let currentSession: {
  serverId: string;
  assignedIp: string;
  connectedAt: string;
  serverIp: string;
  serverPort: number;
} | null = null;

/**
 * Handle incoming JSON-RPC messages
 */
export async function handleMessage(message: any): Promise<any> {
  const { method, params } = message;

  // High-frequency polling methods logged at debug to reduce noise
  const noisyMethods = new Set(['getStatus', 'getStats']);
  if (noisyMethods.has(method)) {
    logger.debug(`Handling method: ${method}`);
  } else {
    logger.info(`Handling method: ${method}`);
  }

  switch (method) {
    case 'ping':
      return handlePing();

    case 'getConfig':
      return handleGetConfig();

    case 'checkDependencies':
      return handleCheckDependencies();

    case 'connect':
      return handleConnect(params);

    case 'disconnect':
      return handleDisconnect(params);

    case 'getStatus':
      return handleGetStatus();

    case 'getStats':
      return handleGetStats();

    case 'enableKillSwitch':
      return handleEnableKillSwitch(params);

    case 'disableKillSwitch':
      return handleDisableKillSwitch();

    case 'getSplitTunnelDiagnostics':
      return splitTunnelManager.getDiagnostics();

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/**
 * Ping - Health check
 */
function handlePing(): { version: string; uptime: number } {
  return {
    version: SERVICE_VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000)
  };
}

/**
 * Get service configuration
 */
function handleGetConfig(): { localMode: boolean; devMode: boolean } {
  return {
    localMode: process.env.LOCAL_MODE === 'true',
    devMode: process.env.NODE_ENV === 'development'
  };
}

/**
 * Check system dependencies for WireGuard
 */
function handleCheckDependencies(): {
  ok: boolean;
  missing: string[];
  instructions: string;
} {
  return wireguardManager.verifyDependencies();
}

/**
 * Connect to VPN
 */
async function handleConnect(params: {
  serverId: string;
  config: any;
  killSwitch: boolean;
  localMode: boolean;
  splitTunneling?: {
    enabled: boolean;
    mode: 'include' | 'exclude';
    apps: Array<{ name: string; exePath: string }>;
    ips: string[];
  };
}): Promise<{ sessionId: string; assignedIp: string }> {
  const { serverId, config, killSwitch, localMode, splitTunneling } = params;

  logger.info(`Connect request: serverId=${serverId}, killSwitch=${killSwitch}, localMode=${localMode}`);

  // Extract server endpoint (support nested peer structure from API)
  const endpoint = config.Endpoint || config.endpoint || config.peer?.endpoint;
  const [serverIp, serverPort] = endpoint.split(':');

  // 1. Enable kill switch in bootstrap mode if requested
  if (killSwitch) {
    logger.info('Enabling kill switch (bootstrap mode)...');
    await killSwitchManager.enableBootstrap(serverIp, parseInt(serverPort, 10));
  }

  try {
    // 2. Write WireGuard config and connect
    logger.info('Connecting WireGuard tunnel...');
    const assignedIp = await wireguardManager.connect(config);

    // 3. Transition kill switch to connected mode
    if (killSwitch) {
      logger.info('Transitioning kill switch to connected mode...');
      await killSwitchManager.enableConnected();
    }

    // 4. Apply split tunneling enforcement
    if (splitTunneling?.enabled) {
      logger.info(`Applying split tunneling: mode=${splitTunneling.mode}, apps=${splitTunneling.apps.length}, ips=${splitTunneling.ips.length}`);
      await splitTunnelManager.enable(splitTunneling);
    }

    // 5. Store session
    currentSession = {
      serverId,
      assignedIp,
      connectedAt: new Date().toISOString(),
      serverIp,
      serverPort: parseInt(serverPort, 10)
    };

    logger.info('Connected successfully');
    return {
      sessionId: `session-${Date.now()}`,
      assignedIp
    };

  } catch (error: any) {
    logger.error('Connection failed:', error);

    try { await splitTunnelManager.disable(); } catch {}
    try { await wireguardManager.disconnect(); } catch {}
    if (killSwitch) { await killSwitchManager.disable(); }

    throw error;
  }
}

/**
 * Disconnect from VPN
 */
async function handleDisconnect(params?: { keepKillSwitch?: boolean }): Promise<{ success: boolean }> {
  const keepKillSwitch = params?.keepKillSwitch ?? false;
  logger.info(`Disconnect request (keepKillSwitch=${keepKillSwitch})`);

  try {
    // 1. Disable split tunneling first (before WireGuard tears down routes)
    await splitTunnelManager.disable();

    // 2. Disconnect WireGuard
    await wireguardManager.disconnect();

    // 3. Disable kill switch only if the user chose not to stay protected.
    //    When keepKillSwitch=true the iptables rules remain active, blocking
    //    all traffic until the user explicitly reconnects.
    if (!keepKillSwitch) {
      await killSwitchManager.disable();
    }

    // 4. Clear session
    currentSession = null;

    logger.info('Disconnected successfully');
    return { success: true };

  } catch (error: any) {
    logger.error('Disconnect failed:', error);
    currentSession = null;
    throw error;
  }
}

/**
 * Get VPN status
 */
async function handleGetStatus(): Promise<{
  state: string;
  killSwitchActive: boolean;
  session?: any;
}> {
  const isConnected = await wireguardManager.isConnected();
  const killSwitchState = killSwitchManager.getState();

  return {
    state: isConnected ? 'connected' : 'disconnected',
    killSwitchActive: killSwitchState !== 'disabled',
    session: currentSession
  };
}

/**
 * Get VPN statistics
 */
async function handleGetStats(): Promise<{ bytesIn: number; bytesOut: number }> {
  const stats = await wireguardManager.getStats();
  return stats;
}

/**
 * Enable kill switch
 */
async function handleEnableKillSwitch(params: {
  serverIp: string;
  interfaceIndex: number;
}): Promise<{ success: boolean }> {
  const { serverIp } = params;

  logger.info('Enable kill switch');

  // Get server port from current session or default
  const serverPort = currentSession?.serverPort || 443;

  await killSwitchManager.enableBootstrap(serverIp, serverPort);

  // If already connected, transition to connected mode
  const isConnected = await wireguardManager.isConnected();
  if (isConnected) {
    await killSwitchManager.enableConnected();
  }

  return { success: true };
}

/**
 * Disable kill switch
 */
async function handleDisableKillSwitch(): Promise<{ success: boolean }> {
  logger.info('Disable kill switch');
  await killSwitchManager.disable();
  return { success: true };
}

export default { handleMessage };
