import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const BYPASS_TABLE_ID = 200;
const VPN_TABLE_ID = 100;
const EXCLUDE_MARK = '0x00100001';
const INCLUDE_MARK = '0x00200001';

// cgroup v1 (net_cls) paths
const CGROUP_V1_BASE = '/sys/fs/cgroup/net_cls';
const CGROUP_V1_PATH = '/sys/fs/cgroup/net_cls/wiredog_bypass';
const CGROUP_V1_CLASSID = '0x00100001';

// cgroup v2 paths (unified hierarchy)
const CGROUP_V2_ROOT = '/sys/fs/cgroup';
const CGROUP_V2_PATH = '/sys/fs/cgroup/wiredog_bypass';
const CGROUP_V2_NAME = 'wiredog_bypass'; // must match CGROUP_V2_PATH basename

// nftables table used for cgroup v2 marking
const NFT_TABLE = 'wiredog_split';

// iptables chain used for cgroup v1 marking
const IPTABLES_MANGLE_CHAIN = 'WIREDOG_MANGLE';
const KS_OUTPUT_CHAIN = 'WIREDOG_OUTPUT';

const VPN_INTERFACE = 'wg0';
const PROCESS_SCAN_INTERVAL_MS = 2000;

export interface SplitTunnelApp {
  name: string;
  exePath: string;
}

export interface SplitTunnelingConfig {
  enabled: boolean;
  mode: 'include' | 'exclude';
  apps: SplitTunnelApp[];
  ips: string[];
}

function runSilent(cmd: string): void {
  try { execSync(cmd, { stdio: 'pipe' }); } catch {}
}

function tryRun(cmd: string): string {
  try { return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim(); } catch { return ''; }
}

class SplitTunnelManager {
  private active = false;
  private config: SplitTunnelingConfig | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  /** 0 = unavailable, 1 = cgroup v1 net_cls, 2 = cgroup v2 unified */
  private cgroupVersion: 0 | 1 | 2 = 0;
  private assignedPids = new Set<number>();

  // ─── Public API ──────────────────────────────────────────────────────────

  async enable(config: SplitTunnelingConfig): Promise<void> {
    if (!config.enabled) return;
    if (config.apps.length === 0 && config.ips.length === 0) return;

    logger.info(`Split tunnel: Enabling ${config.mode} mode — ${config.apps.length} apps, ${config.ips.length} IPs`);
    this.config = config;

    await this.cleanup();

    if (config.apps.length > 0) {
      this.cgroupVersion = this.setupCgroup();
    }

    if (config.mode === 'exclude') {
      this.setupExcludeMode(config);
    } else {
      this.setupIncludeMode(config);
    }

    if (config.ips.length > 0) {
      this.applyIpRoutes(config);
    }

    this.active = true;

    if (config.apps.length > 0 && this.cgroupVersion > 0) {
      this.startProcessScanner();
    }
  }

  async disable(): Promise<void> {
    if (!this.active && this.cgroupVersion === 0) return;
    logger.info('Split tunnel: Disabling');
    await this.cleanup();
    this.active = false;
    logger.info('Split tunnel: Disabled');
  }

  // ─── Cgroup detection and setup ──────────────────────────────────────────

  private setupCgroup(): 0 | 1 | 2 {
    // Try cgroup v1 (net_cls) first
    if (this.setupCgroupV1()) return 1;
    // Fall back to cgroup v2 (unified hierarchy)
    if (this.setupCgroupV2()) return 2;
    logger.warn('Split tunnel: No cgroup support found — app-based traffic marking unavailable');
    return 0;
  }

  private setupCgroupV1(): boolean {
    try {
      if (!fs.existsSync(CGROUP_V1_BASE)) {
        // Attempt to mount net_cls cgroup v1 controller
        execSync('mount -t cgroup -o net_cls net_cls /sys/fs/cgroup/net_cls', { stdio: 'pipe' });
      }
      if (!fs.existsSync(CGROUP_V1_PATH)) {
        fs.mkdirSync(CGROUP_V1_PATH, { recursive: true });
      }
      fs.writeFileSync(`${CGROUP_V1_PATH}/net_cls.classid`, CGROUP_V1_CLASSID);
      logger.info(`Split tunnel: Using cgroup v1 at ${CGROUP_V1_PATH} (classid ${CGROUP_V1_CLASSID})`);
      return true;
    } catch {
      return false;
    }
  }

  private setupCgroupV2(): boolean {
    try {
      // Verify this is indeed a cgroup v2 unified hierarchy
      if (!fs.existsSync(`${CGROUP_V2_ROOT}/cgroup.controllers`)) {
        return false;
      }
      if (!fs.existsSync(CGROUP_V2_PATH)) {
        fs.mkdirSync(CGROUP_V2_PATH, { recursive: true });
      }
      logger.info(`Split tunnel: Using cgroup v2 at ${CGROUP_V2_PATH}`);
      return true;
    } catch (err: any) {
      logger.warn('Split tunnel: cgroup v2 setup failed:', err.message);
      return false;
    }
  }

  // ─── Exclude mode ────────────────────────────────────────────────────────
  // All traffic uses VPN by default; listed apps bypass it.

  private setupExcludeMode(config: SplitTunnelingConfig): void {
    const { gw, dev } = this.getOriginalGateway();
    if (!gw || !dev) {
      logger.warn('Split tunnel: Cannot determine original gateway — exclude routing skipped');
      return;
    }

    // Table 200: default route via original (non-VPN) gateway
    runSilent(`ip route add default via ${gw} dev ${dev} table ${BYPASS_TABLE_ID}`);
    // Policy rule: fwmark → table 200
    runSilent(`ip rule add fwmark ${EXCLUDE_MARK} priority 90 table ${BYPASS_TABLE_ID}`);

    if (config.apps.length > 0 && this.cgroupVersion > 0) {
      this.setupMarkingRules(EXCLUDE_MARK);
      this.addKillSwitchBypassRule(EXCLUDE_MARK);
    }

    logger.info(`Split tunnel: Exclude mode routing configured (gateway ${gw} dev ${dev})`);
  }

  // ─── Include mode ────────────────────────────────────────────────────────
  // Remove VPN default routes; only listed apps use VPN.

  private setupIncludeMode(config: SplitTunnelingConfig): void {
    // Remove WireGuard's /1 routes so normal traffic falls back to the original default
    runSilent(`ip route del 0.0.0.0/1 dev ${VPN_INTERFACE}`);
    runSilent(`ip route del 128.0.0.0/1 dev ${VPN_INTERFACE}`);
    runSilent(`ip -6 route del ::/1 dev ${VPN_INTERFACE}`);
    runSilent(`ip -6 route del 8000::/1 dev ${VPN_INTERFACE}`);

    // Table 100: default through VPN interface
    runSilent(`ip route add default dev ${VPN_INTERFACE} table ${VPN_TABLE_ID}`);
    // Policy rule: fwmark → table 100 (VPN)
    runSilent(`ip rule add fwmark ${INCLUDE_MARK} priority 90 table ${VPN_TABLE_ID}`);

    if (config.apps.length > 0 && this.cgroupVersion > 0) {
      this.setupMarkingRules(INCLUDE_MARK);
    }

    logger.info('Split tunnel: Include mode routing configured');
  }

  // ─── Packet marking ──────────────────────────────────────────────────────

  private setupMarkingRules(mark: string): void {
    if (this.cgroupVersion === 1) {
      this.setupMarkingV1(mark);
    } else if (this.cgroupVersion === 2) {
      this.setupMarkingV2(mark);
    }
  }

  /** iptables mangle: mark packets from the net_cls cgroup */
  private setupMarkingV1(mark: string): void {
    runSilent(`iptables -t mangle -N ${IPTABLES_MANGLE_CHAIN}`);
    runSilent(`iptables -t mangle -I OUTPUT 1 -j ${IPTABLES_MANGLE_CHAIN}`);
    runSilent(`iptables -t mangle -A ${IPTABLES_MANGLE_CHAIN} -m cgroup --cgroup ${CGROUP_V1_CLASSID} -j MARK --set-mark ${mark}`);
    logger.info('Split tunnel: iptables mangle marking rules (v1) configured');
  }

  /**
   * nftables: mark packets from the cgroup v2 slice.
   * Uses `socket cgroupv2 level 1 "wiredog_bypass"` — matched by the socket's
   * cgroup path at depth 1 (directly under /sys/fs/cgroup/).
   */
  private setupMarkingV2(mark: string): void {
    // Create a dedicated nftables table so teardown is a single `nft delete table`
    runSilent(`nft add table ip ${NFT_TABLE}`);
    runSilent(`nft add chain ip ${NFT_TABLE} output '{ type route hook output priority mangle; }'`);
    runSilent(`nft add rule ip ${NFT_TABLE} output socket cgroupv2 level 1 "${CGROUP_V2_NAME}" mark set ${mark}`);

    // IPv6
    runSilent(`nft add table ip6 ${NFT_TABLE}`);
    runSilent(`nft add chain ip6 ${NFT_TABLE} output '{ type route hook output priority mangle; }'`);
    runSilent(`nft add rule ip6 ${NFT_TABLE} output socket cgroupv2 level 1 "${CGROUP_V2_NAME}" mark set ${mark}`);

    logger.info('Split tunnel: nftables marking rules (v2) configured');
  }

  private teardownMarkingRules(): void {
    // v1: iptables mangle
    runSilent(`iptables -t mangle -D OUTPUT -j ${IPTABLES_MANGLE_CHAIN}`);
    runSilent(`iptables -t mangle -F ${IPTABLES_MANGLE_CHAIN}`);
    runSilent(`iptables -t mangle -X ${IPTABLES_MANGLE_CHAIN}`);

    // v2: nftables (delete entire table — removes all chains/rules at once)
    runSilent(`nft delete table ip ${NFT_TABLE}`);
    runSilent(`nft delete table ip6 ${NFT_TABLE}`);
  }

  // ─── Kill switch integration ──────────────────────────────────────────────

  private addKillSwitchBypassRule(mark: string): void {
    // Insert only when WIREDOG_OUTPUT chain exists (kill switch active)
    try {
      execSync(`iptables -L ${KS_OUTPUT_CHAIN} -n`, { stdio: 'pipe' });
      runSilent(`iptables -I ${KS_OUTPUT_CHAIN} 1 -m mark --mark ${mark} -j ACCEPT`);
      logger.info('Split tunnel: Kill switch bypass rule added');
    } catch {
      // Kill switch not active — rule not needed
    }
  }

  private removeKillSwitchBypassRules(): void {
    runSilent(`iptables -D ${KS_OUTPUT_CHAIN} -m mark --mark ${EXCLUDE_MARK} -j ACCEPT`);
    runSilent(`iptables -D ${KS_OUTPUT_CHAIN} -m mark --mark ${INCLUDE_MARK} -j ACCEPT`);
  }

  // ─── IP-based routes ──────────────────────────────────────────────────────

  private applyIpRoutes(config: SplitTunnelingConfig): void {
    const { gw, dev } = this.getOriginalGateway();

    for (const ip of config.ips) {
      const fam = ip.includes(':') ? '-6' : '-4';
      if (config.mode === 'exclude') {
        if (gw && dev) runSilent(`ip ${fam} route add ${ip} via ${gw} dev ${dev}`);
      } else {
        runSilent(`ip ${fam} route add ${ip} dev ${VPN_INTERFACE}`);
      }
    }
  }

  private removeIpRoutes(config: SplitTunnelingConfig): void {
    for (const ip of config.ips) {
      const fam = ip.includes(':') ? '-6' : '-4';
      runSilent(`ip ${fam} route del ${ip}`);
    }
  }

  // ─── Process scanner ──────────────────────────────────────────────────────

  private get cgroupProcsPath(): string {
    return this.cgroupVersion === 1
      ? `${CGROUP_V1_PATH}/cgroup.procs`
      : `${CGROUP_V2_PATH}/cgroup.procs`;
  }

  private startProcessScanner(): void {
    this.stopProcessScanner();

    // Log resolved paths once at startup so we can verify the resolver output
    for (const app of (this.config?.apps ?? [])) {
      const resolved = this.resolveToRealBinaries(app.exePath);
      logger.info(`Split tunnel: Configured "${app.exePath}" resolves to: ${[...resolved].join(', ')}`);
    }

    logger.info('Split tunnel: Process scanner started');
    this.scanAndAssignProcesses();
    this.scanTimer = setInterval(() => this.scanAndAssignProcesses(), PROCESS_SCAN_INTERVAL_MS);
  }

  private stopProcessScanner(): void {
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
  }

  /**
   * Resolves a configured exe path to all real binary paths it might represent.
   *
   * Example chain for Google Chrome:
   *   /usr/bin/google-chrome-stable  (symlink)
   *   → /opt/google/chrome/google-chrome  (bash wrapper script)
   *   → exec -a "$0" "$HERE/chrome"
   *   → /opt/google/chrome/chrome  (actual ELF binary shown in /proc/<pid>/exe)
   */
  private resolveToRealBinaries(configuredPath: string): Set<string> {
    const candidates = new Set<string>([configuredPath]);

    try {
      // Step 1: follow symlinks
      const resolved = fs.realpathSync(configuredPath);
      candidates.add(resolved);

      // Step 2: if it's a shell script, parse it for the real binary
      const content = fs.readFileSync(resolved, 'utf-8');
      if (!content.startsWith('#!')) return candidates;

      const scriptDir = path.dirname(resolved);

      // Pattern: $HERE/binary or ${HERE}/binary
      // Covers: exec -a "$0" "$HERE/chrome", exec "$HERE/app", exec ${HERE}/bin, etc.
      for (const m of content.matchAll(/\$\{?HERE\}?\/([^\s"'$\\]+)/g)) {
        const bin = path.join(scriptDir, m[1]);
        candidates.add(bin);
        try { candidates.add(fs.realpathSync(bin)); } catch {}
      }

      // Pattern: exec /absolute/path (direct exec of a full path, no $HERE variable)
      for (const m of content.matchAll(/\bexec\b[^#\n]*?(\/(?:usr|opt|bin|sbin|home|app|snap)[^\s"'$\\]*)/g)) {
        candidates.add(m[1]);
        try { candidates.add(fs.realpathSync(m[1])); } catch {}
      }

      // Fallback: scan for ELF binaries in the same directory as the script.
      // This catches cases where the script name and the real binary name differ
      // (e.g. google-chrome wrapper script → chrome ELF binary in same dir).
      try {
        for (const entry of fs.readdirSync(scriptDir)) {
          const fullPath = path.join(scriptDir, entry);
          try {
            const fd = fs.openSync(fullPath, 'r');
            const buf = Buffer.alloc(4);
            fs.readSync(fd, buf, 0, 4, 0);
            fs.closeSync(fd);
            // ELF magic bytes: \x7fELF
            if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
              candidates.add(fullPath);
            }
          } catch {}
        }
      } catch {}
    } catch {}

    return candidates;
  }

  private scanAndAssignProcesses(): void {
    if (!this.config || this.cgroupVersion === 0) return;

    // Pre-resolve all configured exe paths once per scan (they rarely change)
    const resolvedSets = this.config.apps.map(a => ({
      original: a.exePath,
      binaries: this.resolveToRealBinaries(a.exePath),
    }));

    try {
      const entries = fs.readdirSync('/proc');
      const livePids = new Set<number>();

      for (const entry of entries) {
        const pid = parseInt(entry, 10);
        if (isNaN(pid)) continue;
        livePids.add(pid);
        if (this.assignedPids.has(pid)) continue;

        try {
          const exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');

          let matched = false;
          let matchedBy = '';

          for (const { original, binaries } of resolvedSets) {
            // Strategy 1: exact resolved binary match
            if (binaries.has(exe)) { matched = true; matchedBy = `resolved(${original})`; break; }

            // Strategy 2: the configured path itself matches a child process argv[0]
            // (catches cases where the wrapper script path appears in cmdline)
            try {
              const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0')[0];
              if (binaries.has(argv0)) { matched = true; matchedBy = `argv0(${original})`; break; }
            } catch {}
          }

          if (matched) {
            logger.info(`Split tunnel: Matched PID ${pid} (${exe}) via ${matchedBy} — writing to cgroup`);
            try {
              fs.writeFileSync(this.cgroupProcsPath, String(pid));
              this.assignedPids.add(pid);
              logger.info(`Split tunnel: PID ${pid} → cgroup assigned OK`);
            } catch (e: any) {
              logger.warn(`Split tunnel: Could not assign PID ${pid} to cgroup: ${e.message}`);
            }
          }
        } catch { /* unreadable /proc entry or process exited */ }
      }

      for (const pid of this.assignedPids) {
        if (!livePids.has(pid)) this.assignedPids.delete(pid);
      }
    } catch (err: any) {
      logger.warn('Split tunnel: Process scan failed:', err.message);
    }
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────

  getDiagnostics(): object {
    const v1Exists = fs.existsSync(CGROUP_V1_PATH);
    const v2Exists = fs.existsSync(CGROUP_V2_PATH);
    const cgroupPath = this.cgroupVersion === 1 ? CGROUP_V1_PATH : CGROUP_V2_PATH;
    const cgroupExists = this.cgroupVersion === 1 ? v1Exists : v2Exists;

    let cgroupPids: number[] = [];
    if (cgroupExists) {
      const raw = tryRun(`cat ${cgroupPath}/cgroup.procs`);
      cgroupPids = raw ? raw.split('\n').map(Number).filter(Boolean) : [];
    }

    // Map each configured app to matching running processes using full resolver
    const appMatches: Array<{
      configuredPath: string;
      resolvedBinaries: string[];
      runningPids: Array<{ pid: number; exePath: string; argv0: string; matched: string }>;
    }> = [];

    for (const app of (this.config?.apps ?? [])) {
      const cfgPath = app.exePath;
      const resolved = this.resolveToRealBinaries(cfgPath);
      const hits: Array<{ pid: number; exePath: string; argv0: string; matched: string }> = [];

      try {
        for (const entry of fs.readdirSync('/proc')) {
          const pid = parseInt(entry, 10);
          if (isNaN(pid)) continue;
          try {
            const exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
            const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0')[0];

            let how = '';
            if (resolved.has(exe)) how = 'resolved-exe';
            else if (resolved.has(argv0)) how = 'resolved-argv0';

            if (how) hits.push({ pid, exePath: exe, argv0, matched: how });
          } catch {}
        }
      } catch {}

      appMatches.push({ configuredPath: cfgPath, resolvedBinaries: [...resolved], runningPids: hits });
    }

    return {
      active: this.active,
      cgroupVersion: this.cgroupVersion,
      config: this.config ? { mode: this.config.mode, apps: this.config.apps, ipCount: this.config.ips.length } : null,
      cgroup: {
        v1Available: v1Exists,
        v2Available: v2Exists,
        activePath: cgroupExists ? cgroupPath : null,
        assignedPids: cgroupPids,
        trackedCount: this.assignedPids.size,
      },
      appMatches,
      network: {
        iptablesMangle: tryRun(`iptables -t mangle -L ${IPTABLES_MANGLE_CHAIN} -n -v 2>/dev/null`),
        nftRules: tryRun(`nft list table ip ${NFT_TABLE} 2>/dev/null`),
        ipRules: tryRun('ip rule list'),
        bypassTable: tryRun(`ip route list table ${BYPASS_TABLE_ID} 2>/dev/null`),
        defaultRoute: tryRun('ip route show default'),
      },
    };
  }

  // ─── Gateway helper ──────────────────────────────────────────────────────

  private getOriginalGateway(): { gw: string; dev: string } {
    // Parse:  default via 192.168.1.1 dev eth0 ...
    const line = tryRun('ip route show default');
    const gwMatch = line.match(/via\s+(\S+)/);
    const devMatch = line.match(/dev\s+(\S+)/);
    const gw = gwMatch?.[1] ?? '';
    const dev = devMatch?.[1] ?? '';
    if (gw && dev) logger.info(`Split tunnel: Original gateway ${gw} dev ${dev}`);
    return { gw, dev };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  private async cleanup(): Promise<void> {
    this.stopProcessScanner();
    this.assignedPids.clear();

    this.teardownMarkingRules();
    this.removeKillSwitchBypassRules();

    runSilent(`ip rule del fwmark ${EXCLUDE_MARK} table ${BYPASS_TABLE_ID}`);
    runSilent(`ip rule del fwmark ${INCLUDE_MARK} table ${VPN_TABLE_ID}`);
    runSilent(`ip route flush table ${BYPASS_TABLE_ID}`);
    runSilent(`ip route flush table ${VPN_TABLE_ID}`);

    const cfg = this.config;
    if (cfg && cfg.ips.length > 0) this.removeIpRoutes(cfg);

    // Remove cgroup and migrate processes back to root cgroup
    this.cleanupCgroup(CGROUP_V1_PATH, CGROUP_V1_BASE);
    this.cleanupCgroup(CGROUP_V2_PATH, CGROUP_V2_ROOT);

    this.cgroupVersion = 0;
    this.config = null;
  }

  private cleanupCgroup(cgroupPath: string, parentPath: string): void {
    if (!fs.existsSync(cgroupPath)) return;
    try {
      const raw = fs.readFileSync(`${cgroupPath}/cgroup.procs`, 'utf-8').trim();
      for (const pid of raw.split('\n').filter(Boolean)) {
        try { fs.writeFileSync(`${parentPath}/cgroup.procs`, pid); } catch {}
      }
      fs.rmdirSync(cgroupPath);
    } catch {}
  }
}

export default new SplitTunnelManager();
