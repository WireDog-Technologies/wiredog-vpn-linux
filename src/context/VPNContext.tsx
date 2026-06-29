import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { ConnectionInfo, ConnectionStatus, VPNSettings, ServerLocation, User, Protocol, SplitTunnelingConfig } from '@/types/vpn';
import * as api from '@/lib/api';
import { getServerById } from '@/data/servers';
import type { MeResponse } from '@/lib/api';

interface VPNContextType {
  connection: ConnectionInfo;
  settings: VPNSettings;
  user: User | null;
  selectedServer: ServerLocation | null;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  isSubscriptionActive: boolean;
  advancedKillSwitchActive: boolean;
  connect: (server: ServerLocation) => Promise<void>;
  disconnect: (options?: { disableProtection?: boolean }) => Promise<void>;
  reconnect: () => Promise<void>;
  updateSettings: (settings: Partial<VPNSettings>) => void;
  setSelectedServer: (server: ServerLocation | null) => void;
  login: (email: string, password: string) => Promise<void>;
  anonymousLogin: (accountNumber: string) => Promise<void>;
  logout: () => void;
}

const defaultConnection: ConnectionInfo = {
  status: 'disconnected',
  server: null,
  ipAddress: '',
  sessionStart: null,
  dataIn: 0,
  dataOut: 0,
};

const defaultSplitTunneling: SplitTunnelingConfig = {
  enabled: false,
  mode: 'exclude',
  apps: [],
  ips: [],
};

const defaultSettings: VPNSettings = {
  protocol: 'wireguard',
  killSwitch: false,
  permanentKillSwitch: false,
  autoConnect: false,
  splitTunneling: defaultSplitTunneling,
  ipv6Enabled: true,
  ipv6LeakProtection: true,
};

const VPNContext = createContext<VPNContextType | undefined>(undefined);

function checkSubscriptionActive(user: User | null): boolean {
  if (!user) return false;
  if (user.subscriptionTier === 'free') return false;
  if (user.subscriptionExpiry && user.subscriptionExpiry < new Date()) return false;
  return true;
}

// Map backend /me response to frontend User type
function mapMeResponseToUser(me: MeResponse): User {
  return {
    id: String(me.id),
    username: me.accountType === 'standard' ? me.displayName : undefined,
    accountNumber: me.accountNumber,
    isAnonymous: me.accountType === 'anonymous',
    subscriptionTier: me.isActive
      ? (me.planTier as User['subscriptionTier']) || 'premium'
      : 'free',
    billingPeriod: me.billingPeriod,
    subscriptionStarted: me.subscriptionStartedAt ? new Date(me.subscriptionStartedAt) : undefined,
    subscriptionExpiry: me.subscriptionExpiresAt ? new Date(me.subscriptionExpiresAt) : undefined,
  };
}

export const VPNProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [connection, setConnection] = useState<ConnectionInfo>(defaultConnection);
  const [settings, setSettings] = useState<VPNSettings>(defaultSettings);
  const [user, setUser] = useState<User | null>(null);
  const [selectedServer, setSelectedServer] = useState<ServerLocation | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [advancedKillSwitchActive, setAdvancedKillSwitchActive] = useState(false);

  // Load settings from electron-store on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        if (window.electronAPI?.getSettings) {
          const savedSettings = await window.electronAPI.getSettings();
          if (savedSettings) {
            // Migrate old 'openvpn' protocol to 'openvpn-udp'
            if ((savedSettings as any).protocol === 'openvpn') {
              (savedSettings as any).protocol = 'openvpn-udp';
            }
            // Migrate old boolean splitTunneling to config object
            if (typeof (savedSettings as any).splitTunneling === 'boolean') {
              (savedSettings as any).splitTunneling = defaultSplitTunneling;
            }
            setSettings(prev => ({ ...prev, ...savedSettings }));

            // Apply permanently enabled kill switch on app startup
            if ((savedSettings as any).permanentKillSwitch && window.electronAPI?.vpn?.enableAdvancedKillSwitch) {
              try {
                await window.electronAPI.vpn.enableAdvancedKillSwitch();
              } catch (error) {
                console.warn('Failed to apply permanent kill switch on startup:', error);
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    };

    // Check for existing session on mount
    const checkAuth = async () => {
      try {
        const me = await api.getCurrentUser();
        if (me) {
          setUser(mapMeResponseToUser(me));
        }
      } catch {
        // Not authenticated, that's fine
      } finally {
        setIsAuthLoading(false);
      }
    };

    loadSettings();
    checkAuth();
  }, []);

  const connect = useCallback(async (server: ServerLocation) => {
    if (!checkSubscriptionActive(user)) {
      throw new Error('An active subscription is required to connect.');
    }

    setConnection(prev => ({ ...prev, status: 'connecting', server }));

    try {
      // Check if running in Electron with VPN support
      if (window.electronAPI?.vpn) {
        // Real Electron VPN connection
        const result = await window.electronAPI.vpn.connect(server.id, settings);
        setConnection({
          status: 'connected',
          server,
          ipAddress: result.server?.ipAddress || '',
          sessionStart: new Date(result.connectedAt),
          dataIn: 0,
          dataOut: 0,
        });
      } else {
        // Mock for browser development
        await new Promise(resolve => setTimeout(resolve, 1500));
        const randomIP = `10.0.0.${Math.floor(Math.random() * 254) + 2}`;
        setConnection({
          status: 'connected',
          server,
          ipAddress: randomIP,
          sessionStart: new Date(),
          dataIn: 0,
          dataOut: 0,
        });
      }
    } catch (error) {
      console.error('VPN connection failed:', error);
      setConnection(defaultConnection);
      throw error;
    }
  }, [settings, user]);

  const disconnect = useCallback(async (options?: { disableProtection?: boolean }) => {
    setConnection(prev => ({ ...prev, status: 'connecting' }));

    try {
      if (window.electronAPI?.vpn) {
        await window.electronAPI.vpn.disconnect(options);
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      // "Turn Off Always-On" — clear the setting so the UI reflects the change
      if (options?.disableProtection) {
        setSettings(prev => ({ ...prev, permanentKillSwitch: false, killSwitch: false }));
        window.electronAPI?.setSettings?.({ permanentKillSwitch: false, killSwitch: false });
      }
      setConnection(defaultConnection);
    } catch (error) {
      console.error('VPN disconnect failed:', error);
      setConnection(defaultConnection);
    }
  }, []);

  const reconnect = useCallback(async () => {
    const currentServer = connection.server;
    if (!currentServer) return;
    try {
      await disconnect();
      await new Promise(resolve => setTimeout(resolve, 500));
      await connect(currentServer);
    } catch (error) {
      console.error('VPN reconnect failed:', error);
    }
  }, [connection.server, disconnect, connect]);

  // Listen for VPN status changes from Electron
  useEffect(() => {
    if (window.electronAPI?.vpn) {
      const unsubscribe = window.electronAPI.vpn.onStatusChange((status) => {
        if (status.advancedKillSwitchActive !== undefined) {
          setAdvancedKillSwitchActive(status.advancedKillSwitchActive);
        }

        // Sync connection state based on status
        if (status.status === 'connected' && status.session) {
          // Connected - preserve existing full server data if available,
          // since connect() already set it with complete info (state, coords, etc.)
          // The backend status only has partial server data (id, city, stateCode, ipAddress)
          const backendServer = status.session.server;
          setConnection(prev => {
            // If we already have a full server from the connect() call, keep it
            // and only update the IP address from the backend
            const existingServer = prev.server;
            const hasFullServer = existingServer && existingServer.state;
            const server = hasFullServer
              ? { ...existingServer, ipAddress: backendServer?.ipAddress || existingServer.ipAddress }
              : backendServer;
            return {
              status: 'connected',
              server,
              ipAddress: backendServer?.ipAddress || prev.ipAddress || '',
              sessionStart: status.session.connectedAt ? new Date(status.session.connectedAt) : prev.sessionStart,
              dataIn: 0,
              dataOut: 0,
            };
          });
        } else if (status.status === 'connecting') {
          // Connecting - update status but keep existing server info
          setConnection(prev => ({
            ...prev,
            status: 'connecting'
          }));
        } else if (status.status === 'error') {
          // Unexpected drop — preserve server info so UI can show last known location
          setConnection(prev => ({ ...prev, status: 'error' }));
        } else if (status.status === 'disconnected') {
          // Disconnected - reset to default, but not if we're mid-connect
          setConnection(prev => {
            if (prev.status === 'connecting') return prev;
            return defaultConnection;
          });
        }
      });
      return unsubscribe;
    }
  }, []);

  // Auto-connect on app startup
  useEffect(() => {
    const attemptAutoConnect = async () => {
      // Only proceed if authenticated, not loading, and disconnected
      if (!user || isAuthLoading || connection.status !== 'disconnected') return;
      if (!window.electronAPI?.vpn || !settings.autoConnect) return;

      try {
        const savedSettings = await window.electronAPI.getSettings();
        const lastServerId = savedSettings?.lastServerId;
        if (!lastServerId) return;

        const server = getServerById(lastServerId);
        if (!server) return;

        // Small delay to let UI settle
        await new Promise(resolve => setTimeout(resolve, 500));

        await connect(server);
      } catch (error) {
        console.error('Auto-connect failed:', error);
        // Silently fail - don't interrupt user
      }
    };

    attemptAutoConnect();
  }, [user, isAuthLoading]);

  const updateSettings = useCallback((newSettings: Partial<VPNSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };

      // If standard kill switch is being disabled, also disable permanent kill switch
      if (newSettings.killSwitch === false && prev.permanentKillSwitch) {
        updated.permanentKillSwitch = false;
        newSettings = { ...newSettings, permanentKillSwitch: false };
      }

      // Persist to electron-store
      if (window.electronAPI?.setSettings) {
        window.electronAPI.setSettings(newSettings).catch((error: Error) => {
          console.error('Failed to save settings:', error);
        });
      }

      // If kill switch changed and VPN is connected, apply immediately
      if (newSettings.killSwitch !== undefined && connection.status === 'connected') {
        if (window.electronAPI?.vpn?.toggleKillSwitch) {
          window.electronAPI.vpn.toggleKillSwitch(newSettings.killSwitch).catch((error: Error) => {
            console.error('Failed to toggle kill switch:', error);
          });
        }
      }

      // If permanent kill switch changed, notify service
      if (newSettings.permanentKillSwitch !== undefined) {
        if (newSettings.permanentKillSwitch) {
          window.electronAPI?.vpn?.enableAdvancedKillSwitch().catch((error: Error) => {
            console.error('Failed to enable advanced kill switch:', error);
          });
        } else {
          window.electronAPI?.vpn?.disableAdvancedKillSwitch().catch((error: Error) => {
            console.error('Failed to disable advanced kill switch:', error);
          });
        }
      }

      return updated;
    });
  }, [connection.status]);

  const login = useCallback(async (email: string, password: string) => {
    await api.login(email, password);
    const me = await api.getCurrentUser();
    if (me) setUser(mapMeResponseToUser(me));
  }, []);

  const anonymousLogin = useCallback(async (accountNumber: string) => {
    await api.anonymousLogin(accountNumber);
    const me = await api.getCurrentUser();
    if (me) setUser(mapMeResponseToUser(me));
  }, []);

  const logout = useCallback(async () => {
    if (connection.status === 'connected') {
      disconnect();
    }
    await api.logout();
    setUser(null);
  }, [connection.status, disconnect]);

  return (
    <VPNContext.Provider
      value={{
        connection,
        settings,
        user,
        selectedServer,
        isAuthenticated: !!user,
        isAuthLoading,
        isSubscriptionActive: checkSubscriptionActive(user),
        advancedKillSwitchActive,
        connect,
        disconnect,
        reconnect,
        updateSettings,
        setSelectedServer,
        login,
        anonymousLogin,
        logout,
      }}
    >
      {children}
    </VPNContext.Provider>
  );
};

export const useVPN = () => {
  const context = useContext(VPNContext);
  if (!context) {
    throw new Error('useVPN must be used within a VPNProvider');
  }
  return context;
};
