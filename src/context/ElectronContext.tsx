import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';

// Extend the Window interface to include our electronAPI
declare global {
  interface Window {
    electronAPI: {
      minimizeWindow: () => Promise<void>;
      maximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      quitApp: () => Promise<void>;
      getAppVersion: () => Promise<string>;
      getBuildNumber: () => Promise<number>;
      getOsVersion: () => Promise<string>;
      isWindowMaximized: () => Promise<boolean>;
      openExternal: (url: string) => Promise<boolean>;
      logs: {
        openAppLogs: () => Promise<{ success: boolean; error?: string }>;
        openServiceLogs: () => Promise<{ success: boolean; error?: string }>;
      };
      connectVPN: (serverId: string) => Promise<{ success: boolean; serverId: string }>;
      disconnectVPN: () => Promise<{ success: boolean }>;
      getSettings: () => Promise<any>;
      setSettings: (settings: any) => Promise<boolean>;
      update: {
        signalReady: () => Promise<void>;
        checkForUpdates: () => Promise<{ upToDate: boolean }>;
        downloadUpdate: () => Promise<void>;
        installUpdate: () => Promise<void>;
        onAvailable: (callback: (data: any) => void) => () => void;
        onDownloaded: (callback: (data: any) => void) => () => void;
        onForceRequired: (callback: (data: any) => void) => () => void;
        onMaintenance: (callback: (data: any) => void) => () => void;
        onDownloadProgress: (callback: (data: any) => void) => () => void;
      };
      onUpdateAvailable: (callback: () => void) => () => void;
      onUpdateDownloaded: (callback: () => void) => () => void;
      platform: string;
      isMac: boolean;
      isWindows: boolean;
      isLinux: boolean;
      isDev: boolean;
    };
  }
}

interface ElectronContextType {
  // Window controls
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  getOsVersion: () => Promise<string>;
  isWindowMaximized: () => Promise<boolean>;

  // System operations
  openExternal: (url: string) => Promise<boolean>;

  // Log directories
  openAppLogs: () => Promise<{ success: boolean; error?: string }>;
  openServiceLogs: () => Promise<{ success: boolean; error?: string }>;

  // VPN operations
  connectVPN: (serverId: string) => Promise<{ success: boolean; serverId: string }>;
  disconnectVPN: () => Promise<{ success: boolean }>;

  // Settings
  getSettings: () => Promise<any>;
  setSettings: (settings: any) => Promise<boolean>;

  // Update events
  onUpdateAvailable: (callback: () => void) => () => void;
  onUpdateDownloaded: (callback: () => void) => () => void;

  // Platform info
  platform: string;
  isMac: boolean;
  isWindows: boolean;
  isLinux: boolean;
  isDev: boolean;

  // App state
  isElectron: boolean;
}

const ElectronContext = createContext<ElectronContextType | undefined>(undefined);

// Mock electronAPI for web environment
const mockElectronAPI = {
  minimizeWindow: async () => { console.log('minimizeWindow called (web mode)'); },
  maximizeWindow: async () => { console.log('maximizeWindow called (web mode)'); },
  closeWindow: async () => { console.log('closeWindow called (web mode)'); },
  getAppVersion: async () => '1.0.0-web',
  getOsVersion: async () => 'Unknown',
  isWindowMaximized: async () => false,
  openExternal: async (url: string) => { window.open(url, '_blank'); return true; },
  logs: {
    openAppLogs: async () => { console.log('openAppLogs called (web mode)'); return { success: false, error: 'Not available in web mode' }; },
    openServiceLogs: async () => { console.log('openServiceLogs called (web mode)'); return { success: false, error: 'Not available in web mode' }; },
  },
  connectVPN: async (serverId: string) => ({ success: true, serverId }),
  disconnectVPN: async () => ({ success: true }),
  getSettings: async () => ({ autoStart: false, killSwitch: true, notifications: true }),
  setSettings: async () => true,
  onUpdateAvailable: () => () => {},
  onUpdateDownloaded: () => () => {},
  platform: 'web',
  isMac: false,
  isWindows: false,
  isLinux: false,
  isDev: true
};

export const ElectronProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    // Check if we're running in Electron
    setIsElectron(!!window.electronAPI);
  }, []);

  // Use real electronAPI if available, otherwise use mock
  const electronAPI = isElectron ? window.electronAPI : mockElectronAPI;

  const value: ElectronContextType = {
    minimizeWindow: electronAPI.minimizeWindow,
    maximizeWindow: electronAPI.maximizeWindow,
    closeWindow: electronAPI.closeWindow,
    getAppVersion: electronAPI.getAppVersion,
    getOsVersion: electronAPI.getOsVersion,
    isWindowMaximized: electronAPI.isWindowMaximized,
    openExternal: electronAPI.openExternal,
    openAppLogs: electronAPI.logs.openAppLogs,
    openServiceLogs: electronAPI.logs.openServiceLogs,
    connectVPN: electronAPI.connectVPN,
    disconnectVPN: electronAPI.disconnectVPN,
    getSettings: electronAPI.getSettings,
    setSettings: electronAPI.setSettings,
    onUpdateAvailable: electronAPI.onUpdateAvailable,
    onUpdateDownloaded: electronAPI.onUpdateDownloaded,
    platform: electronAPI.platform,
    isMac: electronAPI.isMac,
    isWindows: electronAPI.isWindows,
    isLinux: electronAPI.isLinux,
    isDev: electronAPI.isDev,
    isElectron
  };

  return (
    <ElectronContext.Provider value={value}>
      {children}
    </ElectronContext.Provider>
  );
};

export const useElectron = () => {
  const context = useContext(ElectronContext);
  if (!context) {
    throw new Error('useElectron must be used within an ElectronProvider');
  }
  return context;
};