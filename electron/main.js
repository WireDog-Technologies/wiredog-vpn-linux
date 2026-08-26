// ================================
// Load environment variables FIRST
// ================================
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const dotenv = require('dotenv');
const { app } = require('electron');
const log = require('electron-log');

// Determine path to .env correctly for dev vs packaged app
const projectRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

// A packaged build's baked config lives at resourcesPath/.env — whatever
// `npm run bake-env:production` / `bake-env:integration` copied there before
// electron-builder ran (see package.json and electron-builder.json's extraResources).
// An unpackaged run (`npm run dev`, the Linux equivalent of "just run it") always defaults
// to .env.development (integration) instead, mirroring iOS's Debug config always hitting
// integration — Vite handles the equivalent split for the renderer bundle automatically via
// its own build-mode env file convention (see build:dev / build:integration in package.json).
const envPath = app.isPackaged
  ? path.join(projectRoot, '.env')
  : path.join(projectRoot, '.env.development');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
  log.info('Loaded environment config from', envPath);
} else if (app.isPackaged) {
  log.warn('No baked environment config found at', envPath, '— falling back to hardcoded production defaults');
} else {
  log.warn('No .env.development found at', envPath, '— falling back to hardcoded production defaults');
}

// Local developer override (gitignored, never shipped) — see .env.local.example.
// Not consulted in packaged builds; dev-only escape hatch (e.g. pointing at a local backend).
if (!app.isPackaged) {
  const localEnvPath = path.join(projectRoot, '.env.local');
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath, override: true });
    log.info('Loaded local overrides from', localEnvPath);
  }
}

// ================================
// Import Electron and other modules
// ================================
const { BrowserWindow, ipcMain, Menu, Tray, shell, dialog } = require('electron');
const https = require('https');
const http = require('http');
const vpnService = require('./vpn');

// Configure logging
log.transports.file.level = 'info';
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'info' : 'error';

// Log environment for debugging (no secrets or endpoint URLs)
log.info('=== Environment Configuration ===');
log.info('NODE_ENV:', process.env.NODE_ENV);
log.info('App path:', __dirname);
log.info('Platform:', process.platform);

// Settings store - will be initialized in app.whenReady()
let settingsStore;

// Keep a global reference of the window object
let mainWindow;
let compactWindow;
let tray;

// Application configuration
// In production, NODE_ENV may not be set, so detect by app.isPackaged
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = app.isPackaged ? 'production' : 'development';
}
const isDev = process.env.NODE_ENV === 'development';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// Track whether app is quitting to distinguish from minimize-to-tray
let isQuitting = false;

// Enforce single instance: if another instance is already running, focus it and exit
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

/**
 * Get icon path based on platform and packaging status
 */
function getIconPath(iconName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, iconName);
  }
  return path.join(__dirname, '../public', iconName);
}

/**
 * Create the main application window
 * Implements secure Electron best practices:
 * - Context isolation enabled
 * - Node integration disabled
 * - Web security enabled
 */
function createMainWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1350,
    height: 800,
    minWidth: 1350,
    minHeight: 800,
    webPreferences: {
      nodeIntegration: false,           // Security: Disable Node.js integration
      contextIsolation: true,           // Security: Enable context isolation
      enableRemoteModule: false,        // Security: Disable remote module
      preload: path.join(__dirname, 'preload.js'), // Secure preload script
      webSecurity: true,                // Security: Enable web security
    },
    icon: getIconPath('icon.png'),
    show: false, // Don't show until ready-to-show
    center: true, // Center window on screen
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    frame: true, // Use native frame on Linux
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Clear Chromium cache so updated ASAR is used
    mainWindow.webContents.session.clearCache().then(() => {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    });
  }

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    if (process.argv.includes('--hidden')) {
      log.info('Main window ready but started hidden');
      // Window will remain hidden, tray will be available
    } else {
      mainWindow.show();
      log.info('Main window ready and shown');
    }
  });

  // Handle window close - minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting && isLinux) {
      event.preventDefault();
      mainWindow.hide();
      log.info('Window hidden to tray');
    }
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Retries any /vpn/disconnect calls still owed from a previous launch/session — see
  // VPNService.handleAppForeground / retryPendingDisconnects.
  mainWindow.on('focus', () => {
    vpnService.handleAppForeground();
  });

  // Prevent new window creation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle renderer process crashes
  mainWindow.webContents.on('render-process-gone', async (event, details) => {
    log.error('Renderer process crashed:', details);
    log.info('Cleaning up VPN connection due to renderer crash');
    try {
      await vpnService.cleanup();
    } catch (error) {
      log.error('VPN cleanup failed after crash:', error);
    }
  });

  // Handle renderer becoming unresponsive
  mainWindow.webContents.on('unresponsive', () => {
    log.warn('Renderer process became unresponsive');
  });

  // Intercept keyboard shortcuts for reload (F5, Ctrl+R)
  mainWindow.webContents.on('before-input-event', async (event, input) => {
    // Detect Ctrl+R or F5 (reload shortcuts)
    const isReload = (input.control && input.key === 'r') || input.key === 'F5';

    if (isReload && input.type === 'keyDown') {
      event.preventDefault();
      log.info('Manual reload detected (F5/Ctrl+R) - cleaning up VPN');
      try {
        await vpnService.cleanup();
      } catch (error) {
        log.error('VPN cleanup failed during reload:', error);
      }
      mainWindow.reload();
    }
  });

  // Set Content Security Policy for additional security
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // In dev mode allow localhost API; in production restrict to HTTPS only
    const connectSrc = isDev
      ? "connect-src 'self' https: http://localhost:3001 http://localhost:5173;"
      : "connect-src 'self' https:;";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "img-src 'self' data: https:; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          connectSrc +
          " object-src 'none';"
        ]
      }
    });
  });

  log.info('Main window created');
}

/**
 * Update tray menu with current VPN status
 */
async function updateTrayMenu() {
  if (!tray) return;

  try {
    // Get current VPN status
    const vpnStatus = await vpnService.getFullStatus();
    const { status, session } = vpnStatus;

    // Update tray icon based on status
    let trayIcon;
    if (status === 'connected') {
      trayIcon = getIconPath('favicon-connected.png');
    } else {
      trayIcon = getIconPath('favicon-disconnected.png');
    }
    tray.setImage(trayIcon);

    // Build status label
    let statusLabel = 'Status: Disconnected';
    if (status === 'connecting') {
      statusLabel = 'Status: Connecting...';
    } else if (status === 'connected' && session?.server) {
      const server = session.server;
      const location = server.city ? `${server.city}, ${server.stateCode || ''}` : 'Connected';
      statusLabel = `Status: Connected to ${location}`;
    }

    // Update tooltip
    let tooltip = 'WireDog VPN - Disconnected';
    if (status === 'connecting') {
      tooltip = 'WireDog VPN - Connecting...';
    } else if (status === 'connected' && session?.server) {
      const location = session.server.city
        ? `${session.server.city}, ${session.server.stateCode || ''}`
        : 'Connected';
      tooltip = `WireDog VPN - ${location}`;
    }
    tray.setToolTip(tooltip);

    // Build and set context menu
    const contextMenu = Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: 'separator' },
      { label: 'Show WireDog VPN', click: () => mainWindow.show() },
      { label: 'Hide to Tray', click: () => mainWindow.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]);

    tray.setContextMenu(contextMenu);
  } catch (error) {
    log.error('Failed to update tray menu:', error);
    // Fallback to basic menu on error
    const fallbackMenu = Menu.buildFromTemplate([
      { label: 'Status: Unknown', enabled: false },
      { type: 'separator' },
      { label: 'Show WireDog VPN', click: () => mainWindow.show() },
      { label: 'Hide to Tray', click: () => mainWindow.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(fallbackMenu);
  }
}

/**
 * Create system tray icon
 */
function createTray() {
  if (isMac) return; // macOS handles tray differently

  // Use PNG icons on Linux
  const trayIcon = getIconPath('favicon-disconnected.png');
  tray = new Tray(trayIcon);

  // Set initial menu with status
  updateTrayMenu();

  tray.on('click', () => {
    if (compactWindow && compactWindow.isVisible()) {
      compactWindow.hide();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      showCompactWindow();
    }
  });

  log.info('System tray created');
}

/**
 * Create compact window for tray
 */
function createCompactWindow() {
  if (isMac) return; // macOS doesn't need compact window

  // Get screen dimensions to position window in bottom-right
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const windowWidth = 350;
  const windowHeight = 480;
  const x = width - windowWidth - 10; // 10px from right edge
  const y = height - windowHeight - 10; // 10px from bottom (above tray)

  compactWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
    icon: getIconPath('icon.png'),
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
  });

  // Load the compact window route
  if (isDev) {
    const url = 'http://localhost:5173/#/compact';
    log.info('Loading compact window URL:', url);
    compactWindow.loadURL(url);
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html');
    log.info('Loading compact window from:', indexPath);
    compactWindow.loadFile(indexPath, { hash: 'compact' });
  }

  // Log when content finishes loading
  compactWindow.webContents.on('did-finish-load', () => {
    log.info('Compact window content loaded successfully');
  });

  compactWindow.webContents.on('crashed', () => {
    log.error('Compact window crashed!');
  });

  // Close compact window when user closes it
  compactWindow.on('closed', () => {
    compactWindow = null;
  });

  // Hide compact window when clicking outside (blur)
  compactWindow.on('blur', () => {
    if (compactWindow && !compactWindow.isDestroyed()) {
      compactWindow.hide();
    }
  });

  // Prevent new window creation
  compactWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle renderer process crashes
  compactWindow.webContents.on('render-process-gone', async (event, details) => {
    log.error('Compact window renderer crashed:', details);
    log.info('Cleaning up VPN connection due to compact window crash');
    try {
      await vpnService.cleanup();
    } catch (error) {
      log.error('VPN cleanup failed after crash:', error);
    }
  });

  // Intercept keyboard shortcuts for reload (F5, Ctrl+R) in compact window
  compactWindow.webContents.on('before-input-event', async (event, input) => {
    const isReload = (input.control && input.key === 'r') || input.key === 'F5';

    if (isReload && input.type === 'keyDown') {
      event.preventDefault();
      log.info('Manual reload detected in compact window - cleaning up VPN');
      try {
        await vpnService.cleanup();
      } catch (error) {
        log.error('VPN cleanup failed during reload:', error);
      }
      compactWindow.reload();
    }
  });

  // Set Content Security Policy
  compactWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // In dev mode allow localhost API; in production restrict to HTTPS only
    const connectSrc = isDev
      ? "connect-src 'self' https: http://localhost:3001 http://localhost:5173;"
      : "connect-src 'self' https:;";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "img-src 'self' data: https:; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          connectSrc +
          " object-src 'none';"
        ]
      }
    });
  });

  log.info('Compact window created');
}

/**
 * Show compact window and hide main window
 */
function showCompactWindow() {
  if (isMac) return;

  if (!compactWindow) {
    createCompactWindow();
  }

  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.hide();
  }

  compactWindow.show();
  compactWindow.focus();
  log.info('Compact window shown');
}

/**
 * Hide compact window and show main window
 */
function hideCompactWindow() {
  if (!compactWindow || compactWindow.isDestroyed()) return;

  compactWindow.hide();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }

  log.info('Compact window hidden');
}

/**
 * Create application menu (macOS)
 */
function createMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  const template = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Set auto-launch on Linux using .desktop files
 */
async function setLinuxAutoLaunch(enabled, mode = 'open') {
  try {
    const os = require('os');
    const autostartDir = path.join(os.homedir(), '.config/autostart');
    const desktopFilePath = path.join(autostartDir, 'wiredog-vpn.desktop');

    if (enabled) {
      // Ensure autostart directory exists
      if (!fs.existsSync(autostartDir)) {
        fs.mkdirSync(autostartDir, { recursive: true });
      }

      // Get the app executable path
      const exePath = app.getPath('exe');
      const args = mode === 'minimize' ? ' --hidden' : '';

      // Create .desktop file content
      const desktopContent = `[Desktop Entry]
Type=Application
Version=1.0
Name=WireDog VPN
Exec=${exePath}${args}
Comment=Secure VPN client for Americans
StartupNotify=true
Terminal=false
Categories=Network;Utility;
`;

      fs.writeFileSync(desktopFilePath, desktopContent, 'utf-8');
      log.info(`Linux auto-launch enabled at ${desktopFilePath}`);
    } else {
      // Remove the .desktop file if it exists
      if (fs.existsSync(desktopFilePath)) {
        fs.unlinkSync(desktopFilePath);
        log.info(`Linux auto-launch disabled, removed ${desktopFilePath}`);
      }
    }
  } catch (error) {
    log.error('Failed to set Linux auto-launch:', error);
    throw error;
  }
}

/**
 * IPC event handlers
 * These handle secure communication from renderer process
 */
function setupIpcHandlers() {
  // Window controls
  ipcMain.handle('app:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('app:maximize', () => {
    if (mainWindow) {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    }
  });

  ipcMain.handle('app:close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  ipcMain.handle('app:get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:get-build-number', () => {
    return getBuildNumber();
  });

  ipcMain.handle('app:get-os-version', async () => {
    const fs = require('fs');
    try {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf-8');
      const match = osRelease.match(/^PRETTY_NAME="?(.+?)"?$/m);
      if (match) return match[1];
    } catch {
      // Fallback if /etc/os-release is not available
    }
    const os = require('os');
    return os.release();
  });

  ipcMain.handle('app:is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
  });

  // Geolocation - fetched from main process to avoid file:// origin issues
  ipcMain.handle('app:get-geolocation', async () => {
    const http = require('http');
    const https = require('https');
    const get = (url) => new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON from ${url}`)); }
        });
      }).on('error', reject);
    });

    try {
      // ip-api.com returns IP + location in one call (no API key needed, 45 req/min)
      const data = await get('http://ip-api.com/json/?fields=query,city,region,regionName,country');
      if (data.city) {
        return { ip: data.query, city: data.city, region: data.region || data.regionName, country: data.country };
      }
    } catch (err) {
      log.warn('Primary geolocation failed:', err.message);
    }

    try {
      // Fallback: ipify + ipapi.co
      const ipData = await get('https://api.ipify.org?format=json');
      const geoData = await get(`https://ipapi.co/${ipData.ip}/json/`);
      return { ip: ipData.ip, city: geoData.city, region: geoData.region_code || geoData.region, country: geoData.country_name };
    } catch (err) {
      log.error('Geolocation fetch failed:', err.message);
      return { ip: 'Redacted', city: 'Redacted', region: '', country: 'US' };
    }
  });

  // System operations
  ipcMain.handle('system:open-external', async (event, url) => {
    try {
      await shell.openExternal(url);
      return true;
    } catch (error) {
      log.error('Failed to open external URL:', error);
      return false;
    }
  });

  // Log directory operations
  ipcMain.handle('logs:open-app-logs', async () => {
    try {
      const logFile = log.transports.file.getFile();
      const logDir = path.dirname(logFile.path);
      const result = await shell.openPath(logDir);
      if (result) {
        log.error('Failed to open app logs directory:', result);
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      log.error('Failed to open app logs directory:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('logs:open-service-logs', async () => {
    try {
      const isDev = !app.isPackaged;
      const logDir = isDev
        ? path.join(__dirname, '..', 'logs')
        : '/var/log/wiredog';
      const result = await shell.openPath(logDir);
      if (result) {
        log.error('Failed to open service logs directory:', result);
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      log.error('Failed to open service logs directory:', error);
      return { success: false, error: error.message };
    }
  });

  // VPN operations - Real implementation
  ipcMain.handle('vpn:check-dependencies', async () => {
    log.info('VPN check dependencies request');
    try {
      return await vpnService.checkDependencies();
    } catch (error) {
      log.error('VPN check dependencies failed:', error);
      return {
        ok: false,
        missing: ['Unknown'],
        instructions: 'Failed to check dependencies. Please restart the application.'
      };
    }
  });

  ipcMain.handle('vpn:connect', async (event, { serverId, settings }) => {
    log.info(`VPN connect request: ${serverId}`);

    // Check if we're in "stay-protected" mode (advanced kill switch active but no VPN)
    let inStayProtectedMode = false;
    try {
      const status = await vpnService.getFullStatus();
      inStayProtectedMode = status.advancedKillSwitchActive;
      if (inStayProtectedMode) {
        log.info('[Pre-connect] Advanced kill switch active — skipping policy check to avoid leak risk');
      }
    } catch (error) {
      log.warn('[Pre-connect] Failed to check status:', error.message);
    }

    // Skip policy check if in stay-protected mode to avoid disabling kill switch
    // Policy check is optional with fail-open policy anyway
    if (!inStayProtectedMode) {
      log.info('[Update] Pre-connect policy check before VPN connection');
      try {
        const policy = await checkUpdatePolicy();
        if (policy) {
          const buildNumber = getBuildNumber();
          if (policy.maintenanceMode) {
            log.warn('[Update] Pre-connect: BLOCKED — maintenance mode active');
            evaluateUpdatePolicy(policy);
            throw new Error('WireDog VPN is currently under maintenance. Please try again later.');
          }
          if (buildNumber < policy.minSupportedVersion || policy.forceUpdate) {
            log.warn(`[Update] Pre-connect: BLOCKED — force update required (build ${buildNumber} < min ${policy.minSupportedVersion})`);
            evaluateUpdatePolicy(policy);
            throw new Error('A required update is available. Please update WireDog VPN before connecting.');
          }
          log.info('[Update] Pre-connect: policy check passed, allowing connection');
        } else {
          log.info('[Update] Pre-connect: no policy returned, allowing connection');
        }
      } catch (error) {
        if (error.message.includes('maintenance') || error.message.includes('required update')) {
          throw error;
        }
        // Network error fetching policy — allow connection to proceed
        log.warn(`[Update] Pre-connect: policy fetch failed (${error.message}), allowing connection (fail-open)`);
      }
    } else {
      log.info('[Update] Skipping policy check in stay-protected mode — using fail-open policy');
    }

    try {
      // Get auth token for API authentication
      const token = settingsStore.get('authToken');

      const result = await vpnService.connect(serverId, settings, token);

      // Save last connected server for auto-connect feature
      settingsStore.set('lastServerId', serverId);

      // Persist session for app restart recovery
      settingsStore.set('lastSession', result);

      return result;
    } catch (error) {
      log.error('VPN connect failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:cancel-connect', () => {
    vpnService.cancelConnect();
    return { success: true };
  });

  ipcMain.handle('vpn:disconnect', async (_, options = {}) => {
    const disableProtection = options?.disableProtection !== false; // default true
    log.info('VPN disconnect request', { disableProtection, options });
    try {
      // Get auth token for API authentication
      const token = settingsStore.get('authToken');

      await vpnService.disconnect(token, { disableProtection });
      // Clear persisted session only when fully disabling protection.
      // When keeping PersistentBlock (disableProtection=false), preserve lastSession
      // so boot auto-reconnect can show full server info (city, stateCode, public IP).
      if (disableProtection) {
        settingsStore.delete('lastSession');
      }
      return { success: true };
    } catch (error) {
      log.error('VPN disconnect failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:get-status', async () => {
    const status = await vpnService.getFullStatus();
    // After reboot, currentSession is lost. The fallback in getFullStatus() builds a
    // minimal session from service status (tunnel IP, server ID only). Upgrade it with
    // the full lastSession from electron-store which has city/state and public IP.
    if (status.status === 'connected') {
      const lastSession = settingsStore.get('lastSession');
      if (lastSession && status.session) {
        status.session = { ...lastSession, assignedIp: status.session.assignedIp };
      }
    }
    return status;
  });

  ipcMain.handle('vpn:get-stats', async () => {
    try {
      return await vpnService.getStats();
    } catch (error) {
      log.error('Failed to get VPN stats:', error);
      return null;
    }
  });

  ipcMain.handle('vpn:split-tunnel-diagnostics', async () => {
    try {
      const sc = require('./ipc/service-client');
      return await sc.getSplitTunnelDiagnostics();
    } catch (error) {
      log.error('Split tunnel diagnostics failed:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('vpn:toggle-killswitch', async (_, { enabled }) => {
    log.info(`VPN toggle kill switch: ${enabled}`);
    try {
      await vpnService.toggleKillSwitch(enabled);
      return { success: true };
    } catch (error) {
      log.error('VPN toggle kill switch failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:emergency-reset', async () => {
    log.info('VPN emergency reset requested');
    try {
      const result = await vpnService.emergencyReset();
      return result;
    } catch (error) {
      log.error('VPN emergency reset failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:enable-advanced-killswitch', async () => {
    log.info('VPN enable advanced kill switch');
    try {
      await vpnService.enableAdvancedKillSwitch();
      return { success: true };
    } catch (error) {
      log.error('VPN enable advanced kill switch failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:disable-advanced-killswitch', async () => {
    log.info('VPN disable advanced kill switch');
    try {
      await vpnService.disableAdvancedKillSwitch();
      return { success: true };
    } catch (error) {
      log.error('VPN disable advanced kill switch failed:', error);
      throw error;
    }
  });

  // Get installed applications by scanning .desktop files
  ipcMain.handle('app:get-installed-apps', async () => {
    const os = require('os');
    const homeDir = os.homedir();
    const searchDirs = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(homeDir, '.local/share/applications'),
      // Snap apps (default Firefox on Ubuntu 22.04+)
      '/var/lib/snapd/desktop/applications',
      // Flatpak apps (system-wide and per-user)
      '/var/lib/flatpak/exports/share/applications',
      path.join(homeDir, '.local/share/flatpak/exports/share/applications'),
    ];

    const apps = [];
    const seenPaths = new Set();

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      let files;
      try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.desktop'));
      } catch (e) {
        continue;
      }

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          if (!content.includes('[Desktop Entry]')) continue;

          const typeMatch = content.match(/^Type=(.+)$/m);
          if (!typeMatch || typeMatch[1].trim() !== 'Application') continue;

          const noDisplayMatch = content.match(/^NoDisplay=(.+)$/m);
          if (noDisplayMatch && noDisplayMatch[1].trim() === 'true') continue;

          const nameMatch = content.match(/^Name=(.+)$/m);
          if (!nameMatch) continue;
          const name = nameMatch[1].trim();

          const execMatch = content.match(/^Exec=(.+)$/m);
          if (!execMatch) continue;

          // Strip field codes (%f, %u, etc.) and env VAR=value prefixes, get first real token
          const execStripped = execMatch[1].trim().replace(/%[fFuUdDnNikvm]/g, '').trim();
          const tokens = execStripped.split(/\s+/);
          // Skip past any leading `env` keyword and `KEY=VALUE` tokens
          let startIdx = 0;
          if (tokens[0] === 'env') startIdx = 1;
          while (startIdx < tokens.length && tokens[startIdx].includes('=')) startIdx++;
          let exePath = tokens[startIdx];
          if (!exePath) continue;

          // Resolve to absolute path if relative
          if (!path.isAbsolute(exePath)) {
            const binDirs = ['/usr/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/sbin', '/snap/bin'];
            for (const binDir of binDirs) {
              const candidate = path.join(binDir, exePath);
              if (fs.existsSync(candidate)) {
                exePath = candidate;
                break;
              }
            }
          }

          const key = exePath.toLowerCase();
          if (seenPaths.has(key)) continue;
          seenPaths.add(key);

          apps.push({ name, exePath });
        } catch (e) {
          // Skip malformed desktop files
        }
      }
    }

    return apps.sort((a, b) => a.name.localeCompare(b.name));
  });

  // Browse for an application executable
  ipcMain.handle('app:browse-for-app', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Application Executable',
      defaultPath: '/usr/bin',
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const exePath = result.filePaths[0];
    const name = path.basename(exePath);
    return { name, exePath };
  });

  // Forward VPN status changes to renderer and update tray
  vpnService.onStatusChange((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vpn:status-changed', status);
    }
    if (compactWindow && !compactWindow.isDestroyed()) {
      compactWindow.webContents.send('vpn:status-changed', status);
    }
    // Update tray menu with new status
    updateTrayMenu();
  });

  // Settings - Persisted in electron-store
  ipcMain.handle('settings:get', () => {
    return settingsStore.store;
  });

  ipcMain.handle('settings:set', (event, newSettings) => {
    try {
      // Merge with existing settings
      const currentSettings = settingsStore.store;
      const merged = { ...currentSettings, ...newSettings };
      settingsStore.store = merged;
      log.info('Settings updated');
      return { success: true, settings: merged };
    } catch (error) {
      log.error('Failed to update settings:', error);
      return { success: false, error: error.message };
    }
  });

  // Auth token management
  ipcMain.handle('auth:set-token', (event, token) => {
    try {
      settingsStore.set('authToken', token);
      log.info('Auth token stored');
      return { success: true };
    } catch (error) {
      log.error('Failed to store auth token:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('auth:get-token', () => {
    return settingsStore.get('authToken');
  });

  ipcMain.handle('auth:clear-token', () => {
    try {
      settingsStore.set('authToken', null);
      log.info('Auth token cleared');
      return { success: true };
    } catch (error) {
      log.error('Failed to clear auth token:', error);
      return { success: false, error: error.message };
    }
  });

  // Compact window operations
  ipcMain.handle('compact:show-main', () => {
    hideCompactWindow();
  });

  ipcMain.handle('compact:exit', () => {
    isQuitting = true;
    app.quit();
  });

  // Auto-launch settings (Linux uses XDG autostart)
  ipcMain.handle('app:set-auto-launch', async (event, { enabled, mode }) => {
    try {
      // Save settings to store
      settingsStore.set('autoStart', enabled);
      settingsStore.set('autoStartMode', mode);

      if (isLinux) {
        // Use Linux-specific .desktop file approach
        await setLinuxAutoLaunch(enabled, mode);
      } else {
        // Use native Electron API for Windows/macOS
        app.setLoginItemSettings({
          openAtLogin: enabled,
          args: mode === 'minimize' ? ['--hidden'] : []
        });
      }

      log.info(`Auto-launch ${enabled ? 'enabled' : 'disabled'} with mode: ${mode}`);
      return { success: true };
    } catch (error) {
      log.error('Failed to set auto-launch:', error);
      return { success: false, error: error.message };
    }
  });

  // Latency measurement
  ipcMain.handle('latency:measure-servers', async (_, servers) => {
    try {
      const latency = require('./latency');
      return await latency.measureAll(servers);
    } catch (error) {
      log.error('Latency measurement failed:', error);
      return {};
    }
  });

  // Safe reload - disconnect VPN first
  ipcMain.handle('app:safe-reload', async () => {
    log.info('Safe reload requested - cleaning up VPN');
    try {
      await vpnService.cleanup();
    } catch (error) {
      log.error('VPN cleanup failed during reload:', error);
    }

    // Reload all windows
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
    if (compactWindow && !compactWindow.isDestroyed()) {
      compactWindow.reload();
    }
  });

  log.info('IPC handlers registered');
}

/**
 * Initialize settings store (must be called after Electron is ready)
 */
async function initializeSettingsStore() {
  try {
    const Store = (await import('electron-store')).default;
    settingsStore = new Store({
      name: 'vpn-settings',
      defaults: {
        protocol: 'wireguard',
        killSwitch: false,
        autoConnect: false,
        splitTunneling: false,
        blockAdsEnabled: true,
        blockMalwareEnabled: true,
        lastServerId: null,
        authToken: null
      }
    });
    try { vpnService.setConfigStore(settingsStore); } catch (err) {
      log.warn('VPN: setConfigStore failed:', err.message);
    }
    // Lets VPNService fetch a fresh token itself for auto-reconnect and pending-disconnect
    // retries, which originate internally rather than from an IPC call carrying a token.
    try { vpnService.setAuthTokenProvider(() => settingsStore.get('authToken')); } catch (err) {
      log.warn('VPN: setAuthTokenProvider failed:', err.message);
    }
    log.info('Settings store initialized');
  } catch (error) {
    log.error('Failed to initialize settings store:', error);
    throw error;
  }
}

// ================================
// Update System
// ================================

function getApiBaseUrl() {
  return process.env.VITE_API_URL
    || (isDev ? 'http://localhost:3001/api' : 'https://api.wiredogvpn.com/api');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

async function checkUpdatePolicy() {
  const url = `${getApiBaseUrl()}/app/config`;
  try {
    // Add a 10 second timeout to prevent hanging when always-on kill switch blocks all traffic
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Policy check timeout')), 10000)
    );

    const config = await Promise.race([fetchJson(url), timeoutPromise]);
    const policy = config.platforms?.['linux-debian-x64'];
    if (!policy) {
      log.info('[Update] No linux-debian-x64 platform policy found in response');
      return null;
    }
    return policy;
  } catch (error) {
    log.error(`[Update] Failed to fetch update policy: ${error.message}`);
    return null;
  }
}

function getBuildNumber() {
  const pkg = require('../package.json');
  return pkg.buildNumber || 0;
}

function sendToAllWindows(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactWindow.webContents.send(channel, data);
  }
}

// Track the last downloaded .deb file path
let lastDownloadedDebPath = null;

/**
 * Download a .deb file from URL to temp directory, reporting progress.
 */
function downloadDebFile(url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('No download URL provided'));
      return;
    }

    const client = url.startsWith('https') ? https : http;

    const handleResponse = (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        const redirectClient = redirectUrl.startsWith('https') ? https : http;
        redirectClient.get(redirectUrl, handleResponse).on('error', reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }

      const total = parseInt(res.headers['content-length'], 10) || 0;
      const fileName = `wiredog-vpn-update-${Date.now()}.deb`;
      const filePath = path.join(app.getPath('temp'), fileName);
      const fileStream = fs.createWriteStream(filePath);

      let transferred = 0;
      let lastProgressReport = 0;

      res.on('data', (chunk) => {
        transferred += chunk.length;
        fileStream.write(chunk);

        // Report progress at most every 200ms
        const now = Date.now();
        if (now - lastProgressReport > 200 || transferred === total) {
          lastProgressReport = now;
          const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
          const bytesPerSecond = transferred; // Approximate
          sendToAllWindows('update:download-progress', {
            percent,
            bytesPerSecond,
            transferred,
            total,
          });
        }
      });

      res.on('end', () => {
        fileStream.end(() => {
          lastDownloadedDebPath = filePath;
          log.info(`[Update] Download complete: ${filePath}`);
          sendToAllWindows('update:downloaded', { filePath });
          resolve(filePath);
        });
      });

      res.on('error', (error) => {
        fileStream.close();
        fs.unlink(filePath, () => {});
        reject(error);
      });
    };

    client.get(url, handleResponse).on('error', reject);
  });
}

async function evaluateUpdatePolicy(policy) {
  const buildNumber = getBuildNumber();

  // 1. Maintenance mode — blocks everything
  if (policy.maintenanceMode) {
    log.warn('[Update] MAINTENANCE MODE active — blocking app usage');
    sendToAllWindows('update:maintenance', {
      message: policy.updateMessage,
    });
    return;
  }

  // 2. Force update — must update before using app
  if (buildNumber < policy.minSupportedVersion || policy.forceUpdate) {
    log.warn('[Update] Force update required');
    sendToAllWindows('update:force-required', {
      message: policy.updateMessage,
      downloadUrl: policy.downloadUrl,
    });
    return;
  }

  // 3. Optional update available
  if (buildNumber < policy.latestVersion) {
    const automaticUpdates = settingsStore ? settingsStore.get('automaticUpdates', true) : true;
    log.info('[Update] Optional update available');

    if (automaticUpdates) {
      // Silent background download
      log.info('[Update] Auto-updates ON — initiating silent background download');
      try {
        await downloadDebFile(policy.downloadUrl);
      } catch (error) {
        log.error(`[Update] Background download failed: ${error.message}`);
      }
    } else {
      log.info('[Update] Auto-updates OFF — notifying user of available update');
      sendToAllWindows('update:available', {
        message: policy.updateMessage,
        downloadUrl: policy.downloadUrl,
        latestVersion: policy.latestVersion,
      });
    }
    return;
  }

  log.info('[Update] App is up to date');
}

/**
 * Setup update policy checking, IPC handlers, and periodic polling.
 * Runs in BOTH dev and production — policy enforcement is always active.
 */
function setupUpdateSystem() {
  // IPC handlers for renderer-initiated actions
  ipcMain.handle('update:check-now', async () => {
    log.info('[Update] Manual update check requested by user');
    const policy = await checkUpdatePolicy();
    if (!policy) {
      log.info('[Update] Manual check result: no policy available, reporting up to date');
      return { upToDate: true };
    }

    const buildNumber = getBuildNumber();
    if (buildNumber < policy.latestVersion || buildNumber < policy.minSupportedVersion || policy.forceUpdate) {
      log.info('[Update] Manual check result: update available');
      await evaluateUpdatePolicy(policy);
      return { upToDate: false };
    }
    log.info('[Update] Manual check result: app is up to date');
    return { upToDate: true };
  });

  ipcMain.handle('update:download-now', async () => {
    log.info('[Update] User-initiated download requested');
    try {
      const policy = await checkUpdatePolicy();
      if (policy?.downloadUrl) {
        await downloadDebFile(policy.downloadUrl);
        log.info('[Update] User-initiated download complete');
      } else {
        throw new Error('No download URL available');
      }
    } catch (error) {
      log.error(`[Update] User-initiated download failed: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('update:install-now', async () => {
    log.info('[Update] User requested install');
    if (lastDownloadedDebPath && fs.existsSync(lastDownloadedDebPath)) {
      return { success: true, debPath: lastDownloadedDebPath };
    } else {
      return { success: false };
    }
  });

  ipcMain.handle('update:restart-app', async () => {
    log.info('[Update] User requested restart to apply update');

    if (!lastDownloadedDebPath || !fs.existsSync(lastDownloadedDebPath)) {
      log.error('[Update] No downloaded .deb file found for auto-install');
      return { success: false, error: 'Update file not found' };
    }

    // Write a flag file so the next launch can detect a successful update
    try {
      const pkg = require('../package.json');
      const flagPath = path.join(app.getPath('userData'), '.update-pending');
      fs.writeFileSync(flagPath, JSON.stringify({ buildNumber: pkg.buildNumber || 0 }));
    } catch (err) {
      log.error(`[Update] Failed to write update flag: ${err.message}`);
    }

    // Step 1: Run pkexec dpkg -i (this shows the password prompt and blocks until done)
    return new Promise((resolve) => {
      log.info(`[Update] Running: pkexec dpkg -i ${lastDownloadedDebPath}`);
      execFile('pkexec', ['dpkg', '-i', lastDownloadedDebPath], (error) => {
        if (error) {
          log.error(`[Update] dpkg install failed: ${error.message}`);
          resolve({ success: false, error: 'Update was cancelled or failed.' });
          return;
        }

        log.info('[Update] dpkg install succeeded, spawning relaunch script and quitting');

        // Step 2: Spawn a detached script that waits for us to exit, then relaunches
        const pid = process.pid;
        const appPath = process.argv[0];
        const relaunchScript = `
          while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done
          sleep 1
          nohup "${appPath}" > /dev/null 2>&1 &
        `;
        const child = spawn('bash', ['-c', relaunchScript], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        // Step 3: Quit gracefully
        isQuitting = true;
        app.quit();
      });
    });
  });

  // Initial policy check — deferred until renderer is ready
  let initialCheckDone = false;
  ipcMain.handle('update:renderer-ready', async () => {
    if (initialCheckDone) {
      log.info('[Update] Renderer ready signal received (already checked, skipping)');
      return;
    }
    initialCheckDone = true;

    // Check if we just completed an update
    try {
      const flagPath = path.join(app.getPath('userData'), '.update-pending');
      if (fs.existsSync(flagPath)) {
        const flag = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
        fs.unlinkSync(flagPath);
        const pkg = require('../package.json');
        const currentBuild = pkg.buildNumber || 0;
        if (currentBuild > (flag.buildNumber || 0)) {
          log.info(`[Update] Update successful: build ${flag.buildNumber} → ${currentBuild}`);
          sendToAllWindows('update:success', { version: pkg.version, buildNumber: currentBuild });
        }
      }
    } catch (err) {
      log.error(`[Update] Failed to check post-update status: ${err.message}`);
    }

    const policy = await checkUpdatePolicy();
    if (policy) evaluateUpdatePolicy(policy);
    else log.info('[Update] Startup check: no policy to evaluate');
  });

  // Periodic policy check every 30 minutes
  setInterval(async () => {
    log.info('[Update] Running periodic update policy check (30-min interval)');
    const policy = await checkUpdatePolicy();
    if (policy) evaluateUpdatePolicy(policy);
    else log.info('[Update] Periodic check: no policy to evaluate');
  }, 30 * 60 * 1000);
}

// App event handlers
app.whenReady().then(async () => {
  log.info('Electron app ready');
  await initializeSettingsStore();
  setupIpcHandlers();

  // Restore last session BEFORE creating window — the renderer calls vpn:get-status
  // on mount, and needs currentSession populated for boot auto-reconnect scenarios.
  const lastSession = settingsStore.get('lastSession');
  if (lastSession) {
    vpnService.restoreSession(lastSession);
  }

  createMainWindow();
  createTray();
  createMenu();

  // Ensure Linux Service is running (attempt to start if not available)
  // Skip in development mode since the service is typically not installed
  if (!isDev) {
    try {
      log.info('Attempting to ensure VPN Service is running...');
      await vpnService.ensureServiceRunning();
      log.info('VPN Service is ready');

      // Crash recovery: if a prior session token is cached but the tunnel is down,
      // tell the backend to decrement the connection counter. Also retries any
      // pending-disconnect ledger entries left over from a previous launch.
      await vpnService.performStartupCleanup();
    } catch (error) {
      log.warn('VPN Service startup:', error.message);
      // Don't block app startup if service fails - user can still connect manually
    }
  }

  // Initialize auto-launch with saved settings
  try {
    const savedAutoStart = settingsStore.get('autoStart', false);
    const savedAutoStartMode = settingsStore.get('autoStartMode', 'open');

    if (isLinux) {
      await setLinuxAutoLaunch(savedAutoStart, savedAutoStartMode);
    } else {
      app.setLoginItemSettings({
        openAtLogin: savedAutoStart,
        args: savedAutoStartMode === 'minimize' ? ['--hidden'] : []
      });
    }

    log.info(`Auto-launch initialized: enabled=${savedAutoStart}, mode=${savedAutoStartMode}`);
  } catch (error) {
    log.warn('Failed to initialize auto-launch:', error.message);
  }

  // Setup update system (runs in both dev and production — policy enforcement is always active)
  setupUpdateSystem();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  log.info('Application quitting - cleaning up VPN');
  try {
    await vpnService.cleanup();
  } catch (error) {
    log.error('VPN cleanup failed:', error);
  }
});

// When a second instance is launched, show and focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

// Security: Prevent navigation to external websites
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    if (parsedUrl.origin !== 'http://localhost:5173' && !navigationUrl.startsWith('file://')) {
      event.preventDefault();
    }
  });
});

log.info('Electron main process started');
