import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger';
import configWriter from './config-writer';

const INTERFACE_NAME = 'wg0';
const HANDSHAKE_TIMEOUT = 30000; // 30 seconds
const HANDSHAKE_CHECK_INTERVAL = 1000; // 1 second
const INTERFACE_READY_TIMEOUT = 5000; // 5 seconds for awg-go to create the TUN device

// Bundled binary locations differ between environments:
//   Production:  /opt/WireDogVPN/resources/service/index.js  → ../bin
//   Development: service/dist/index.js                       → ../../resources/bin
const BUNDLED_BIN_PROD = path.join(__dirname, '..', 'bin');
const BUNDLED_BIN_DEV  = path.join(__dirname, '..', '..', 'resources', 'bin');

// AWG CLI tool (configuration utility, equivalent to `wg`)
const AWG_SEARCH_PATHS = [
  path.join(BUNDLED_BIN_PROD, 'awg'),
  path.join(BUNDLED_BIN_DEV,  'awg'),
  '/usr/bin/awg',
  '/usr/sbin/awg',
  '/bin/awg',
  '/sbin/awg',
  '/usr/local/bin/awg',
  '/usr/local/sbin/awg',
];

// AWG userspace daemon (equivalent to wireguard-go; creates the TUN interface)
const AWG_GO_SEARCH_PATHS = [
  path.join(BUNDLED_BIN_PROD, 'awg-go'),
  path.join(BUNDLED_BIN_DEV,  'awg-go'),
  '/usr/bin/awg-go',
  '/usr/sbin/awg-go',
  '/usr/local/bin/awg-go',
];

/**
 * AmneziaWG Manager - Handles tunnel operations using the bundled awg + awg-go binaries.
 *
 * awg-go is the userspace AWG daemon (no kernel module required). It creates a TUN
 * interface and speaks the AWG protocol. The awg CLI tool configures it exactly like
 * wg configures a standard WireGuard interface.
 */
class WireGuardManager {
  private connected: boolean = false;
  private assignedIp: string | null = null;
  private wgPath: string | null = null;       // awg CLI binary
  private awgGoPath: string | null = null;    // awg-go daemon binary
  private awgGoProcess: ChildProcess | null = null;
  private originalResolvConf: string | null = null;

  constructor() {
    this.wgPath = this.findBinary('awg', AWG_SEARCH_PATHS);
    this.awgGoPath = this.findBinary('awg-go', AWG_GO_SEARCH_PATHS);
  }

  /**
   * Locate a binary: check bundled path first, then PATH, then static locations.
   */
  private findBinary(name: string, staticPaths: string[]): string | null {
    // Check bundled location first (first entry in staticPaths is always the bundled one)
    const bundled = staticPaths[0];
    if (fs.existsSync(bundled)) {
      logger.info(`AWG: Found bundled ${name} at ${bundled}`);
      return bundled;
    }

    // Check PATH
    try {
      const result = execSync(`which ${name}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (result) {
        logger.info(`AWG: Found ${name} in PATH at ${result}`);
        return result;
      }
    } catch {
      // Not in PATH, fall through to static locations
    }

    // Check remaining static locations
    for (const p of staticPaths.slice(1)) {
      if (fs.existsSync(p)) {
        logger.info(`AWG: Found ${name} at ${p}`);
        return p;
      }
    }

    logger.warn(`AWG: ${name} binary not found`);
    return null;
  }

  /**
   * Verify all dependencies are available
   */
  verifyDependencies(): { ok: boolean; missing: string[]; instructions: string } {
    const missing: string[] = [];

    if (!this.wgPath) {
      this.wgPath = this.findBinary('awg', AWG_SEARCH_PATHS);
      if (!this.wgPath) missing.push('awg (bundled AWG CLI tool)');
    }

    if (!this.awgGoPath) {
      this.awgGoPath = this.findBinary('awg-go', AWG_GO_SEARCH_PATHS);
      if (!this.awgGoPath) missing.push('awg-go (bundled AWG userspace daemon)');
    }

    try {
      execSync('which ip', { stdio: 'pipe' });
    } catch {
      missing.push('iproute2 (ip command)');
    }

    if (missing.length > 0) {
      const instructions =
        'The following bundled components are missing from the installation:\n\n' +
        missing.join('\n') +
        '\n\nTry reinstalling WireDog VPN. If the problem persists, contact support.';
      return { ok: false, missing, instructions };
    }

    return { ok: true, missing: [], instructions: '' };
  }

  /**
   * Detect Linux distribution (used for fallback instructions only)
   */
  private detectDistro(): string {
    try {
      if (fs.existsSync('/etc/os-release')) {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf-8').toLowerCase();
        if (osRelease.includes('ubuntu')) return 'ubuntu';
        if (osRelease.includes('debian')) return 'debian';
        if (osRelease.includes('fedora')) return 'fedora';
        if (osRelease.includes('arch')) return 'arch';
        if (osRelease.includes('opensuse') || osRelease.includes('suse')) return 'opensuse';
      }
    } catch {}
    return 'unknown';
  }

  /**
   * Connect to VPN using bundled awg-go (userspace) + awg (configuration tool).
   * No kernel module required.
   */
  async connect(config: any): Promise<string> {
    logger.info('AWG: Starting connection...');

    const deps = this.verifyDependencies();
    if (!deps.ok) {
      const error = new Error(
        `Missing required components: ${deps.missing.join(', ')}\n\n${deps.instructions}`
      );
      (error as any).code = 'MISSING_DEPENDENCIES';
      throw error;
    }

    try {
      // 1. Parse config
      const parsedConfig = this.parseConfig(config);
      this.assignedIp = parsedConfig.addresses[0];

      // 2. Clean up any existing interface / stale awg-go process
      await this.cleanupInterface();

      // 3. Start awg-go userspace daemon — it creates the TUN device
      logger.info(`AWG: Starting awg-go daemon for ${INTERFACE_NAME}...`);
      await this.startAwgGo();

      // 4. Configure the interface: AWG obfuscation params + private key
      logger.info('AWG: Configuring interface...');
      const tempKeyFile = this.writeTempKey(parsedConfig.privateKey);
      try {
        let ifaceCmd = `${this.wgPath} set ${INTERFACE_NAME}`;
        if (parsedConfig.awg) {
          const a = parsedConfig.awg;
          ifaceCmd += ` jc ${a.Jc} jmin ${a.Jmin} jmax ${a.Jmax}`;
          ifaceCmd += ` s1 ${a.S1} s2 ${a.S2}`;
          ifaceCmd += ` h1 ${a.H1} h2 ${a.H2} h3 ${a.H3} h4 ${a.H4}`;
        }
        ifaceCmd += ` private-key ${tempKeyFile}`;
        execSync(ifaceCmd, { stdio: 'pipe' });
      } finally {
        try { fs.unlinkSync(tempKeyFile); } catch {}
      }

      // 5. Add peer
      logger.info('AWG: Adding peer...');
      let peerCmd = `${this.wgPath} set ${INTERFACE_NAME} peer ${parsedConfig.serverPublicKey}`;
      peerCmd += ` endpoint ${parsedConfig.endpoint}`;
      peerCmd += ` allowed-ips ${parsedConfig.allowedIPs.join(',')}`;
      if (parsedConfig.persistentKeepalive) {
        peerCmd += ` persistent-keepalive ${parsedConfig.persistentKeepalive}`;
      }
      execSync(peerCmd, { stdio: 'pipe' });

      // 6. Assign IP addresses
      logger.info('AWG: Assigning IP addresses...');
      for (const addr of parsedConfig.addresses) {
        const family = addr.includes(':') ? '-6' : '-4';
        execSync(`ip ${family} addr add ${addr} dev ${INTERFACE_NAME}`, { stdio: 'pipe' });
      }

      // 7. Bring up interface
      logger.info('AWG: Bringing up interface...');
      execSync(`ip link set ${INTERFACE_NAME} up`, { stdio: 'pipe' });

      // 8. Configure routing
      logger.info('AWG: Configuring routes...');
      await this.configureRouting(parsedConfig);

      // 9. Configure DNS
      if (parsedConfig.dns.length > 0) {
        logger.info('AWG: Configuring DNS...');
        await this.configureDns(parsedConfig.dns);
      }

      // 10. Wait for handshake
      logger.info('AWG: Waiting for handshake...');
      await this.waitForHandshake();

      this.connected = true;
      logger.info('AWG: Connected successfully');
      return parsedConfig.addresses.join(', ');

    } catch (error: any) {
      logger.error('AWG: Connection failed:', error);
      await this.disconnect();
      throw error;
    }
  }

  /**
   * Spawn the awg-go userspace daemon and wait until it has created the TUN interface.
   */
  private async startAwgGo(): Promise<void> {
    // awg-go writes its UAPI socket to /var/run/amneziawg/wg0.sock.
    // This directory is on tmpfs and disappears on reboot; create it defensively
    // (the systemd RuntimeDirectory also creates it, but this guards against a
    // mis-packaged or manually-run service that skips the unit file).
    for (const socketDir of ['/var/run/amneziawg', '/var/run/wireguard']) {
      try {
        fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
      } catch (e: any) {
        if (e.code !== 'EEXIST') {
          logger.warn(`AWG: Could not create socket directory ${socketDir}: ${e.message}`);
        }
      }
    }

    let awgClosed = false;
    let awgExitCode: number | null = null;
    let awgOutput = ''; // combined stdout + stderr for error reporting

    this.awgGoProcess = spawn(this.awgGoPath!, [INTERFACE_NAME], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // awg-go needs WG_PROCESS_FOREGROUND to not self-daemonize on some builds
      env: { ...process.env, WG_PROCESS_FOREGROUND: '1' }
    });

    this.awgGoProcess.stdout?.on('data', (d) => {
      const line = d.toString().trim();
      awgOutput += line + '\n';
      logger.debug(`awg-go: ${line}`);
    });
    this.awgGoProcess.stderr?.on('data', (d) => {
      const line = d.toString().trim();
      awgOutput += line + '\n';
      logger.debug(`awg-go: ${line}`);
    });

    this.awgGoProcess.on('exit', (code, signal) => {
      awgExitCode = code;
      if (this.connected) {
        logger.warn(`AWG: awg-go exited unexpectedly (code=${code}, signal=${signal})`);
        this.connected = false;
      }
      this.awgGoProcess = null;
    });

    // Use 'close' (fires after all stdio streams are flushed) rather than 'exit'
    // so that awgStderr is fully populated before we read it.
    this.awgGoProcess.on('close', () => {
      awgClosed = true;
    });

    // Wait until the TUN device appears (awg-go creates it asynchronously).
    // Fail fast once the process has fully closed without creating the interface.
    const deadline = Date.now() + INTERFACE_READY_TIMEOUT;
    while (Date.now() < deadline) {
      if (this.interfaceExists()) return;
      if (awgClosed) {
        const detail = awgOutput.trim() ? `\nOutput: ${awgOutput.trim()}` : '';
        throw new Error(`awg-go exited with code ${awgExitCode} before creating interface ${INTERFACE_NAME}${detail}`);
      }
      await this.sleep(100);
    }
    throw new Error(`awg-go did not create interface ${INTERFACE_NAME} within ${INTERFACE_READY_TIMEOUT}ms`);
  }

  /**
   * Parse and normalize config from API (supports both WireGuard and AWG fields)
   */
  private parseConfig(config: any): {
    privateKey: string;
    addresses: string[];
    dns: string[];
    serverPublicKey: string;
    endpoint: string;
    allowedIPs: string[];
    persistentKeepalive: number;
    awg?: {
      Jc: number; Jmin: number; Jmax: number;
      S1: number; S2: number;
      H1: number; H2: number; H3: number; H4: number;
    };
  } {
    const privateKey = config.PrivateKey || config.privateKey;
    const addressStr = config.Address || config.address;
    const dnsStr = config.DNS || config.dns || '';
    const serverPublicKey = config.ServerPublicKey || config.serverPublicKey || config.peer?.publicKey;
    const endpoint = config.Endpoint || config.endpoint || config.peer?.endpoint;
    const allowedIPsStr = config.AllowedIPs || config.allowedIPs || config.peer?.allowedIPs || '0.0.0.0/0, ::/0';
    const persistentKeepalive = config.PersistentKeepalive || config.persistentKeepalive || config.peer?.persistentKeepalive || 25;

    const addresses = addressStr.split(',').map((s: string) => s.trim()).filter((s: string) => s);
    const dns = dnsStr ? dnsStr.split(',').map((s: string) => s.trim()).filter((s: string) => s) : [];
    const allowedIPs = allowedIPsStr.split(',').map((s: string) => s.trim()).filter((s: string) => s);

    const awgRaw = config.awg || config.Awg;
    const awg = awgRaw
      ? {
          Jc: awgRaw.Jc, Jmin: awgRaw.Jmin, Jmax: awgRaw.Jmax,
          S1: awgRaw.S1, S2: awgRaw.S2,
          H1: awgRaw.H1, H2: awgRaw.H2, H3: awgRaw.H3, H4: awgRaw.H4
        }
      : undefined;

    return { privateKey, addresses, dns, serverPublicKey, endpoint, allowedIPs, persistentKeepalive, awg };
  }

  /**
   * Write private key to a temp file with secure permissions
   */
  private writeTempKey(privateKey: string): string {
    const tempFile = path.join(os.tmpdir(), `awg-key-${process.pid}`);
    fs.writeFileSync(tempFile, privateKey, { mode: 0o600 });
    return tempFile;
  }

  /**
   * Clean up any existing interface and kill any stale awg-go process
   */
  private async cleanupInterface(): Promise<void> {
    // Kill tracked process
    if (this.awgGoProcess && !this.awgGoProcess.killed) {
      this.awgGoProcess.kill('SIGTERM');
      this.awgGoProcess = null;
    }

    // Kill any orphaned awg-go process from a previous session
    try {
      execSync(`pkill -f "awg-go ${INTERFACE_NAME}"`, { stdio: 'pipe' });
      await this.sleep(300);
    } catch {
      // No orphan, that's fine
    }

    if (this.interfaceExists()) {
      logger.info(`AWG: Cleaning up existing ${INTERFACE_NAME} interface...`);
      try { execSync(`ip link set ${INTERFACE_NAME} down`, { stdio: 'pipe' }); } catch {}
      try { execSync(`ip link delete dev ${INTERFACE_NAME}`, { stdio: 'pipe' }); } catch {}
    }
  }

  /**
   * Configure routing for VPN
   */
  private async configureRouting(config: { allowedIPs: string[]; endpoint: string }): Promise<void> {
    const endpointHost = config.endpoint.split(':')[0];
    let endpointIp = endpointHost;

    if (!/^\d+\.\d+\.\d+\.\d+$/.test(endpointHost) && !endpointHost.includes(':')) {
      try {
        const result = execSync(`getent hosts ${endpointHost} | awk '{print $1}' | head -1`, {
          encoding: 'utf-8', stdio: 'pipe'
        }).trim();
        if (result) endpointIp = result;
      } catch {
        logger.warn(`AWG: Could not resolve ${endpointHost}, using as-is`);
      }
    }

    const routeAllIPv4 = config.allowedIPs.some(ip => ip === '0.0.0.0/0');
    const routeAllIPv6 = config.allowedIPs.some(ip => ip === '::/0');

    if (routeAllIPv4 || routeAllIPv6) {
      try {
        const defaultGw = execSync("ip route show default | awk '{print $3}'", {
          encoding: 'utf-8', stdio: 'pipe'
        }).trim().split('\n')[0];

        const defaultDev = execSync("ip route show default | awk '{print $5}'", {
          encoding: 'utf-8', stdio: 'pipe'
        }).trim().split('\n')[0];

        if (defaultGw && defaultDev) {
          logger.debug('AWG: Adding exclusion route for VPN server');
          try {
            execSync(`ip route add ${endpointIp}/32 via ${defaultGw} dev ${defaultDev}`, { stdio: 'pipe' });
          } catch (e: any) {
            if (!e.message?.includes('File exists')) {
              logger.warn('AWG: Could not add server exclusion route:', e.message);
            }
          }
        }
      } catch (e) {
        logger.warn('AWG: Could not get default gateway:', e);
      }

      if (routeAllIPv4) {
        try {
          execSync(`ip route add 0.0.0.0/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' });
          execSync(`ip route add 128.0.0.0/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' });
        } catch (e: any) {
          logger.warn('AWG: Could not add IPv4 routes:', e.message);
        }
      }

      if (routeAllIPv6) {
        try {
          execSync(`ip -6 route add ::/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' });
          execSync(`ip -6 route add 8000::/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' });
        } catch (e: any) {
          logger.debug('AWG: Could not add IPv6 routes:', e.message);
        }
      }
    } else {
      for (const ip of config.allowedIPs) {
        const family = ip.includes(':') ? '-6' : '-4';
        try {
          execSync(`ip ${family} route add ${ip} dev ${INTERFACE_NAME}`, { stdio: 'pipe' });
        } catch (e: any) {
          if (!e.message?.includes('File exists')) {
            logger.warn(`AWG: Could not add route for ${ip}:`, e.message);
          }
        }
      }
    }
  }

  /**
   * Configure DNS servers
   */
  private async configureDns(dnsServers: string[]): Promise<void> {
    if (await this.configureDnsSystemdResolved(dnsServers)) return;
    await this.configureDnsResolvConf(dnsServers);
  }

  private async configureDnsSystemdResolved(dnsServers: string[]): Promise<boolean> {
    try {
      execSync('which resolvectl', { stdio: 'pipe' });
      const dnsArgs = dnsServers.join(' ');
      execSync(`resolvectl dns ${INTERFACE_NAME} ${dnsArgs}`, { stdio: 'pipe' });
      execSync(`resolvectl domain ${INTERFACE_NAME} "~."`, { stdio: 'pipe' });
      logger.info('AWG: DNS configured via systemd-resolved');
      return true;
    } catch {
      return false;
    }
  }

  private async configureDnsResolvConf(dnsServers: string[]): Promise<void> {
    const resolvConfPath = '/etc/resolv.conf';
    try {
      if (fs.existsSync(resolvConfPath)) {
        this.originalResolvConf = fs.readFileSync(resolvConfPath, 'utf-8');
      }
      const newResolvConf = dnsServers
        .filter(dns => !dns.includes(':'))
        .map(dns => `nameserver ${dns}`)
        .join('\n') + '\n';
      fs.writeFileSync(resolvConfPath, newResolvConf);
      logger.info('AWG: DNS configured via /etc/resolv.conf');
    } catch (e: any) {
      logger.warn('AWG: Could not configure DNS:', e.message);
    }
  }

  private async restoreDns(): Promise<void> {
    try {
      execSync('which resolvectl', { stdio: 'pipe' });
      execSync(`resolvectl revert ${INTERFACE_NAME}`, { stdio: 'pipe' });
      logger.info('AWG: DNS reverted via systemd-resolved');
      return;
    } catch {}

    if (this.originalResolvConf) {
      try {
        fs.writeFileSync('/etc/resolv.conf', this.originalResolvConf);
        this.originalResolvConf = null;
        logger.info('AWG: DNS restored from backup');
      } catch (e: any) {
        logger.warn('AWG: Could not restore DNS:', e.message);
      }
    }
  }

  private async removeRoutes(): Promise<void> {
    try { execSync(`ip route del 0.0.0.0/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' }); } catch {}
    try { execSync(`ip route del 128.0.0.0/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' }); } catch {}
    try { execSync(`ip -6 route del ::/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' }); } catch {}
    try { execSync(`ip -6 route del 8000::/1 dev ${INTERFACE_NAME}`, { stdio: 'pipe' }); } catch {}
  }

  /**
   * Disconnect from VPN — tears down routes, DNS, interface, and the awg-go daemon.
   */
  async disconnect(): Promise<void> {
    logger.info('AWG: Disconnecting...');

    try {
      await this.restoreDns();
      await this.removeRoutes();

      if (this.interfaceExists()) {
        try { execSync(`ip link set ${INTERFACE_NAME} down`, { stdio: 'pipe' }); } catch {}
        try { execSync(`ip link delete dev ${INTERFACE_NAME}`, { stdio: 'pipe' }); } catch {}
        logger.info(`AWG: ${INTERFACE_NAME} removed`);
      }

      // Terminate the awg-go daemon (also cleans up /var/run/wireguard/wg0.sock)
      if (this.awgGoProcess && !this.awgGoProcess.killed) {
        this.awgGoProcess.kill('SIGTERM');
        this.awgGoProcess = null;
      }
    } catch (error: any) {
      logger.warn('AWG: Error during disconnect:', error.message);
    }

    try { await configWriter.removeConfig(); } catch {}

    this.connected = false;
    this.assignedIp = null;
    logger.info('AWG: Disconnected');
  }

  async isConnected(): Promise<boolean> {
    if (!this.connected) return false;
    return this.interfaceExists();
  }

  async getStats(): Promise<{ bytesIn: number; bytesOut: number }> {
    if (!this.wgPath) return { bytesIn: 0, bytesOut: 0 };

    try {
      const output = execSync(`${this.wgPath} show ${INTERFACE_NAME} transfer`, {
        encoding: 'utf-8', stdio: 'pipe'
      });

      let totalIn = 0, totalOut = 0;
      for (const line of output.trim().split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          totalIn  += parseInt(parts[1], 10) || 0;
          totalOut += parseInt(parts[2], 10) || 0;
        }
      }
      return { bytesIn: totalIn, bytesOut: totalOut };
    } catch {
      return { bytesIn: 0, bytesOut: 0 };
    }
  }

  private interfaceExists(): boolean {
    try {
      execSync(`ip link show ${INTERFACE_NAME}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private async waitForHandshake(): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < HANDSHAKE_TIMEOUT) {
      if (await this.checkHandshake()) {
        logger.info('AWG: Handshake completed');
        return;
      }
      await this.sleep(HANDSHAKE_CHECK_INTERVAL);
    }
    throw new Error('Handshake timeout - could not establish connection with VPN server');
  }

  private async checkHandshake(): Promise<boolean> {
    if (!this.wgPath) return false;
    try {
      const output = execSync(`${this.wgPath} show ${INTERFACE_NAME} latest-handshakes`, {
        encoding: 'utf-8', stdio: 'pipe'
      });
      for (const line of output.trim().split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 2 && parseInt(parts[1], 10) > 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getAssignedIp(): string | null {
    return this.assignedIp;
  }
}

export default new WireGuardManager();
