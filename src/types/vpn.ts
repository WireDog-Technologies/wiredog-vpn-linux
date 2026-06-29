export type Protocol = 'wireguard' | 'openvpn-udp' | 'openvpn-tcp' | 'ikev2';

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

export type SplitTunnelMode = 'include' | 'exclude';

export interface SplitTunnelApp {
  name: string;
  exePath: string;
  icon?: string;
}

export interface SplitTunnelingConfig {
  enabled: boolean;
  mode: SplitTunnelMode;
  apps: SplitTunnelApp[];
  ips: string[];
}

export interface ServerLocation {
  id: string;
  state: string;
  stateCode: string;
  city: string;
  latitude: number;
  longitude: number;
  latency: number;
  load: number;
  recommended?: boolean;
  host: string;
}

export interface ConnectionInfo {
  status: ConnectionStatus;
  server: ServerLocation | null;
  ipAddress: string;
  sessionStart: Date | null;
  dataIn: number;
  dataOut: number;
}

export interface VPNSettings {
  protocol: Protocol;
  killSwitch: boolean;
  permanentKillSwitch: boolean;
  autoConnect: boolean;
  splitTunneling: SplitTunnelingConfig;
  ipv6Enabled?: boolean;
  ipv6LeakProtection?: boolean;
}

export interface User {
  id: string;
  username?: string;
  accountNumber?: string;
  isAnonymous: boolean;
  subscriptionTier: 'free' | 'premium' | 'elite';
  billingPeriod?: string;
  subscriptionStarted?: Date;
  subscriptionExpiry?: Date;
}

// Electron VPN API types
export interface VPNConnectionResult {
  sessionId: number;
  assignedIp: string;
  connectedAt: string;
  server: {
    city: string;
    stateCode: string;
    ipAddress: string;
  };
}

export interface VPNStatusUpdate {
  status: ConnectionStatus;
  session: VPNConnectionResult | null;
  killSwitchEnabled: boolean;
}

export interface VPNStats {
  bytesReceived: string;
  bytesSent: string;
}

// Extend Window interface for Electron API
declare global {
  interface Window {
    electronAPI?: {
      vpn: {
        connect: (serverId: string, settings: VPNSettings) => Promise<VPNConnectionResult>;
        disconnect: () => Promise<{ success: boolean }>;
        getStatus: () => Promise<VPNStatusUpdate>;
        getStats: () => Promise<VPNStats | null>;
        onStatusChange: (callback: (status: VPNStatusUpdate) => void) => () => void;
        emergencyReset: () => Promise<{ success: boolean }>;
      };
      getInstalledApps: () => Promise<SplitTunnelApp[]>;
      browseForApp: () => Promise<SplitTunnelApp | null>;
      measureLatency: (servers: Array<{ id: string; host: string }>) => Promise<Record<string, number>>;
      // Window controls
      minimizeWindow: () => Promise<void>;
      maximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      getAppVersion: () => Promise<string>;
      getOsVersion: () => Promise<string>;
      isWindowMaximized: () => Promise<boolean>;
      safeReload: () => Promise<void>;
      // System
      openExternal: (url: string) => Promise<boolean>;
      // Settings
      getSettings: () => Promise<Record<string, unknown>>;
      setSettings: (settings: Record<string, unknown>) => Promise<boolean>;
      setAutoLaunch: (enabled: boolean, mode: 'open' | 'minimize') => Promise<{ success: boolean; error?: string }>;
      // Platform
      platform: string;
      isMac: boolean;
      isWindows: boolean;
      isLinux: boolean;
      isDev: boolean;
    };
  }
}
