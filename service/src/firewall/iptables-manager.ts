import { execSync } from 'child_process';
import logger from '../utils/logger';

/**
 * Low-level iptables wrapper
 * Provides methods for managing iptables and ip6tables rules
 */
class IptablesManager {
  /**
   * Execute iptables command
   */
  private exec(command: string, silent: boolean = false): void {
    try {
      execSync(command, { stdio: silent ? 'pipe' : 'inherit' });
    } catch (error: any) {
      if (!silent) {
        throw error;
      }
    }
  }

  /**
   * Check if chain exists in iptables
   */
  chainExists(chain: string, ipv6: boolean = false): boolean {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    try {
      execSync(`${cmd} -L ${chain} -n`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new chain
   */
  createChain(chain: string, ipv6: boolean = false): void {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    if (!this.chainExists(chain, ipv6)) {
      this.exec(`${cmd} -N ${chain}`);
      logger.debug(`Created chain: ${chain} (IPv${ipv6 ? '6' : '4'})`);
    }
  }

  /**
   * Flush chain (remove all rules)
   */
  flushChain(chain: string, ipv6: boolean = false): void {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    if (this.chainExists(chain, ipv6)) {
      this.exec(`${cmd} -F ${chain}`);
      logger.debug(`Flushed chain: ${chain} (IPv${ipv6 ? '6' : '4'})`);
    }
  }

  /**
   * Delete chain (must be empty and not referenced)
   */
  deleteChain(chain: string, ipv6: boolean = false): void {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    if (this.chainExists(chain, ipv6)) {
      this.exec(`${cmd} -X ${chain}`, true);
      logger.debug(`Deleted chain: ${chain} (IPv${ipv6 ? '6' : '4'})`);
    }
  }

  /**
   * Insert rule at position (1-indexed)
   */
  insertRule(chain: string, rule: string, position: number = 1, ipv6: boolean = false): void {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    this.exec(`${cmd} -I ${chain} ${position} ${rule}`);
    logger.debug(`Inserted rule at position ${position} in ${chain}: ${rule} (IPv${ipv6 ? '6' : '4'})`);
  }

  /**
   * Append rule to end of chain
   */
  appendRule(chain: string, rule: string, ipv6: boolean = false): void {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    this.exec(`${cmd} -A ${chain} ${rule}`);
    logger.debug(`Appended rule to ${chain}: ${rule} (IPv${ipv6 ? '6' : '4'})`);
  }

  /**
   * Delete rule from chain
   */
  deleteRule(chain: string, rule: string, ipv6: boolean = false): void {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    this.exec(`${cmd} -D ${chain} ${rule}`, true);
    logger.debug(`Deleted rule from ${chain}: ${rule} (IPv${ipv6 ? '6' : '4'})`);
  }

  /**
   * Check if rule exists in chain
   */
  ruleExists(chain: string, rule: string, ipv6: boolean = false): boolean {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    try {
      execSync(`${cmd} -C ${chain} ${rule}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add jump to custom chain from built-in chain
   */
  addJump(fromChain: string, toChain: string, position: number = 1, ipv6: boolean = false): void {
    const rule = `-j ${toChain}`;
    if (!this.ruleExists(fromChain, rule, ipv6)) {
      this.insertRule(fromChain, rule, position, ipv6);
    }
  }

  /**
   * Remove jump to custom chain from built-in chain
   */
  removeJump(fromChain: string, toChain: string, ipv6: boolean = false): void {
    const rule = `-j ${toChain}`;
    this.deleteRule(fromChain, rule, ipv6);
  }

  /**
   * List rules in chain (for debugging)
   */
  listChain(chain: string, ipv6: boolean = false): string {
    const cmd = ipv6 ? 'ip6tables' : 'iptables';
    try {
      return execSync(`${cmd} -L ${chain} -n -v`, { encoding: 'utf-8' });
    } catch {
      return '';
    }
  }

  /**
   * Save current rules (useful for debugging)
   */
  saveRules(ipv6: boolean = false): string {
    const cmd = ipv6 ? 'ip6tables-save' : 'iptables-save';
    try {
      return execSync(cmd, { encoding: 'utf-8' });
    } catch {
      return '';
    }
  }
}

export default new IptablesManager();
