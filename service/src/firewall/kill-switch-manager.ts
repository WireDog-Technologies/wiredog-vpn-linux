import logger from '../utils/logger';
import iptables from './iptables-manager';

// Chain names
const CHAIN_OUTPUT = 'WIREDOG_OUTPUT';
const CHAIN_INPUT = 'WIREDOG_INPUT';
const CHAIN_DNS = 'WIREDOG_DNS';
const CHAIN_IPV6 = 'WIREDOG_IPV6';

// Interface name
const VPN_INTERFACE = 'wg0';

// Kill switch states
type KillSwitchState = 'disabled' | 'bootstrap' | 'connected';

/**
 * Kill Switch Manager
 * Manages iptables rules for blocking traffic outside VPN
 */
class KillSwitchManager {
  private state: KillSwitchState = 'disabled';
  private serverIp: string | null = null;
  private serverPort: number | null = null;

  /**
   * Get current state
   */
  getState(): KillSwitchState {
    return this.state;
  }

  /**
   * Enable kill switch in bootstrap mode
   * Allows VPN server traffic, LAN, and DNS during connection
   */
  async enableBootstrap(serverIp: string, serverPort: number): Promise<void> {
    logger.info('Kill switch: Enabling bootstrap mode');

    this.serverIp = serverIp;
    this.serverPort = serverPort;

    // Clean up any existing rules first
    await this.cleanup();

    // Create chains
    this.createChains();

    // Add jump rules from OUTPUT/INPUT to our chains
    iptables.addJump('OUTPUT', CHAIN_OUTPUT, 1, false);
    iptables.addJump('INPUT', CHAIN_INPUT, 1, false);

    // IPv6: Add jump to our chain
    iptables.addJump('OUTPUT', CHAIN_IPV6, 1, true);
    iptables.addJump('INPUT', CHAIN_IPV6, 1, true);

    // Add bootstrap rules
    this.addBootstrapRules(serverIp, serverPort);

    // Add IPv6 blocking rules
    this.addIPv6BlockingRules();

    this.state = 'bootstrap';
    logger.info('Kill switch: Bootstrap mode enabled');
  }

  /**
   * Transition to connected mode
   * Adds rules to allow traffic through VPN interface
   */
  async enableConnected(): Promise<void> {
    if (this.state !== 'bootstrap') {
      logger.warn('Kill switch: Cannot enable connected mode - not in bootstrap state');
      return;
    }

    logger.info('Kill switch: Transitioning to connected mode');

    // Insert VPN interface rules at top of our chains
    iptables.insertRule(CHAIN_OUTPUT, `-o ${VPN_INTERFACE} -j ACCEPT`, 1, false);
    iptables.insertRule(CHAIN_INPUT, `-i ${VPN_INTERFACE} -j ACCEPT`, 1, false);

    // Add DNS leak protection - only allow DNS on VPN interface
    this.addDnsLeakProtection();

    // Allow IPv6 on VPN interface if available
    iptables.insertRule(CHAIN_IPV6, `-o ${VPN_INTERFACE} -j ACCEPT`, 1, true);
    iptables.insertRule(CHAIN_IPV6, `-i ${VPN_INTERFACE} -j ACCEPT`, 1, true);

    this.state = 'connected';
    logger.info('Kill switch: Connected mode enabled');
  }

  /**
   * Disable kill switch and clean up all rules
   */
  async disable(): Promise<void> {
    logger.info('Kill switch: Disabling...');

    await this.cleanup();

    this.state = 'disabled';
    this.serverIp = null;
    this.serverPort = null;

    logger.info('Kill switch: Disabled');
  }

  /**
   * Create custom chains
   */
  private createChains(): void {
    // IPv4 chains
    iptables.createChain(CHAIN_OUTPUT, false);
    iptables.createChain(CHAIN_INPUT, false);
    iptables.createChain(CHAIN_DNS, false);

    // IPv6 chain
    iptables.createChain(CHAIN_IPV6, true);
  }

  /**
   * Add bootstrap rules (before VPN is connected)
   */
  private addBootstrapRules(serverIp: string, serverPort: number): void {
    // OUTPUT rules (order matters - first match wins after jump)

    // 1. Allow loopback
    iptables.appendRule(CHAIN_OUTPUT, '-o lo -j ACCEPT', false);

    // 2. Allow VPN server
    iptables.appendRule(CHAIN_OUTPUT, `-d ${serverIp} -p udp --dport ${serverPort} -j ACCEPT`, false);

    // 3. Allow LAN traffic (RFC 1918 private ranges)
    iptables.appendRule(CHAIN_OUTPUT, '-d 10.0.0.0/8 -j ACCEPT', false);
    iptables.appendRule(CHAIN_OUTPUT, '-d 172.16.0.0/12 -j ACCEPT', false);
    iptables.appendRule(CHAIN_OUTPUT, '-d 192.168.0.0/16 -j ACCEPT', false);
    iptables.appendRule(CHAIN_OUTPUT, '-d 169.254.0.0/16 -j ACCEPT', false);  // Link-local

    // 4. Allow DHCP
    iptables.appendRule(CHAIN_OUTPUT, '-p udp --dport 67:68 -j ACCEPT', false);

    // 5. Allow DNS (temporary during bootstrap, replaced by VPN-only DNS when connected)
    iptables.appendRule(CHAIN_OUTPUT, '-p udp --dport 53 -j ACCEPT', false);
    iptables.appendRule(CHAIN_OUTPUT, '-p tcp --dport 53 -j ACCEPT', false);

    // 6. Drop everything else
    iptables.appendRule(CHAIN_OUTPUT, '-j DROP', false);

    // INPUT rules (for return traffic)

    // 1. Allow loopback
    iptables.appendRule(CHAIN_INPUT, '-i lo -j ACCEPT', false);

    // 2. Allow established/related connections
    iptables.appendRule(CHAIN_INPUT, '-m state --state ESTABLISHED,RELATED -j ACCEPT', false);

    // 3. Allow from VPN server
    iptables.appendRule(CHAIN_INPUT, `-s ${serverIp} -p udp --sport ${serverPort} -j ACCEPT`, false);

    // 4. Allow LAN traffic
    iptables.appendRule(CHAIN_INPUT, '-s 10.0.0.0/8 -j ACCEPT', false);
    iptables.appendRule(CHAIN_INPUT, '-s 172.16.0.0/12 -j ACCEPT', false);
    iptables.appendRule(CHAIN_INPUT, '-s 192.168.0.0/16 -j ACCEPT', false);
    iptables.appendRule(CHAIN_INPUT, '-s 169.254.0.0/16 -j ACCEPT', false);

    // 5. Allow DHCP
    iptables.appendRule(CHAIN_INPUT, '-p udp --sport 67:68 -j ACCEPT', false);

    // 6. Drop everything else
    iptables.appendRule(CHAIN_INPUT, '-j DROP', false);

    logger.debug('Bootstrap rules added');
  }

  /**
   * Add DNS leak protection rules
   * Only allows DNS queries through VPN interface
   */
  private addDnsLeakProtection(): void {
    // Create DNS chain rules
    iptables.flushChain(CHAIN_DNS, false);

    // Allow DNS on VPN interface
    iptables.appendRule(CHAIN_DNS, `-o ${VPN_INTERFACE} -j ACCEPT`, false);

    // Allow DNS to localhost (for local resolver if configured)
    iptables.appendRule(CHAIN_DNS, '-d 127.0.0.0/8 -j ACCEPT', false);

    // Block all other DNS
    iptables.appendRule(CHAIN_DNS, '-j DROP', false);

    // Insert jump to DNS chain for DNS traffic in OUTPUT
    // Remove the permissive DNS rules added during bootstrap
    iptables.deleteRule(CHAIN_OUTPUT, '-p udp --dport 53 -j ACCEPT', false);
    iptables.deleteRule(CHAIN_OUTPUT, '-p tcp --dport 53 -j ACCEPT', false);

    // Add jump to DNS chain (after VPN interface rule but before DROP)
    iptables.insertRule(CHAIN_OUTPUT, `-p udp --dport 53 -j ${CHAIN_DNS}`, 2, false);
    iptables.insertRule(CHAIN_OUTPUT, `-p tcp --dport 53 -j ${CHAIN_DNS}`, 3, false);

    logger.debug('DNS leak protection rules added');
  }

  /**
   * Add IPv6 blocking rules
   */
  private addIPv6BlockingRules(): void {
    // Allow loopback
    iptables.appendRule(CHAIN_IPV6, '-o lo -j ACCEPT', true);
    iptables.appendRule(CHAIN_IPV6, '-i lo -j ACCEPT', true);

    // Allow link-local (needed for IPv6 neighbor discovery)
    iptables.appendRule(CHAIN_IPV6, '-d fe80::/10 -j ACCEPT', true);
    iptables.appendRule(CHAIN_IPV6, '-s fe80::/10 -j ACCEPT', true);

    // Drop everything else (will be modified when connected if VPN has IPv6)
    iptables.appendRule(CHAIN_IPV6, '-j DROP', true);

    logger.debug('IPv6 blocking rules added');
  }

  /**
   * Clean up all firewall rules
   */
  private async cleanup(): Promise<void> {
    logger.debug('Cleaning up firewall rules...');

    // Remove jumps from built-in chains
    iptables.removeJump('OUTPUT', CHAIN_OUTPUT, false);
    iptables.removeJump('INPUT', CHAIN_INPUT, false);
    iptables.removeJump('OUTPUT', CHAIN_IPV6, true);
    iptables.removeJump('INPUT', CHAIN_IPV6, true);

    // Flush and delete our chains (IPv4)
    iptables.flushChain(CHAIN_OUTPUT, false);
    iptables.flushChain(CHAIN_INPUT, false);
    iptables.flushChain(CHAIN_DNS, false);
    iptables.deleteChain(CHAIN_OUTPUT, false);
    iptables.deleteChain(CHAIN_INPUT, false);
    iptables.deleteChain(CHAIN_DNS, false);

    // Flush and delete IPv6 chain
    iptables.flushChain(CHAIN_IPV6, true);
    iptables.deleteChain(CHAIN_IPV6, true);

    logger.debug('Firewall rules cleaned up');
  }

  /**
   * Debug: Print current rules
   */
  debugPrint(): void {
    logger.info('=== IPv4 OUTPUT chain ===');
    logger.info(iptables.listChain(CHAIN_OUTPUT, false));
    logger.info('=== IPv4 INPUT chain ===');
    logger.info(iptables.listChain(CHAIN_INPUT, false));
    logger.info('=== IPv4 DNS chain ===');
    logger.info(iptables.listChain(CHAIN_DNS, false));
    logger.info('=== IPv6 chain ===');
    logger.info(iptables.listChain(CHAIN_IPV6, true));
  }
}

export default new KillSwitchManager();
