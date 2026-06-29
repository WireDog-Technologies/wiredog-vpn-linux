import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const WIREGUARD_CONFIG_DIR = '/etc/wireguard';
const INTERFACE_NAME = 'wg0';

/**
 * Write WireGuard configuration file
 */
export async function writeConfig(config: any): Promise<string> {
  const configPath = path.join(WIREGUARD_CONFIG_DIR, `${INTERFACE_NAME}.conf`);

  // Normalize config keys (handle both camelCase and PascalCase from API)
  const privateKey = config.PrivateKey || config.privateKey;
  const address = config.Address || config.address;
  const dns = config.DNS || config.dns || '1.1.1.1';
  const serverPublicKey = config.ServerPublicKey || config.serverPublicKey;
  const endpoint = config.Endpoint || config.endpoint;
  const allowedIPs = config.AllowedIPs || config.allowedIPs || '0.0.0.0/0, ::/0';
  const persistentKeepalive = config.PersistentKeepalive || config.persistentKeepalive || 25;

  // AWG obfuscation parameters go in the [Interface] section
  const awg = config.awg || config.Awg;
  const awgLines = awg
    ? `Jc = ${awg.Jc}\nJmin = ${awg.Jmin}\nJmax = ${awg.Jmax}\nS1 = ${awg.S1}\nS2 = ${awg.S2}\nH1 = ${awg.H1}\nH2 = ${awg.H2}\nH3 = ${awg.H3}\nH4 = ${awg.H4}\n`
    : '';

  // Build AWG config content
  const configContent = `[Interface]
PrivateKey = ${privateKey}
Address = ${address}
DNS = ${dns}
${awgLines}
[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${endpoint}
AllowedIPs = ${allowedIPs}
PersistentKeepalive = ${persistentKeepalive}
`;

  logger.info(`Writing WireGuard config to ${configPath}`);
  logger.debug(`Config content:\n${configContent.replace(privateKey, '[REDACTED]')}`);

  // Ensure config directory exists
  if (!fs.existsSync(WIREGUARD_CONFIG_DIR)) {
    fs.mkdirSync(WIREGUARD_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  // Write config file with secure permissions (600)
  fs.writeFileSync(configPath, configContent, { mode: 0o600 });

  logger.info('WireGuard config written successfully');
  return address;
}

/**
 * Remove WireGuard configuration file
 */
export async function removeConfig(): Promise<void> {
  const configPath = path.join(WIREGUARD_CONFIG_DIR, `${INTERFACE_NAME}.conf`);

  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
    logger.info(`Removed WireGuard config: ${configPath}`);
  }
}

/**
 * Check if WireGuard config exists
 */
export function configExists(): boolean {
  const configPath = path.join(WIREGUARD_CONFIG_DIR, `${INTERFACE_NAME}.conf`);
  return fs.existsSync(configPath);
}

export default {
  writeConfig,
  removeConfig,
  configExists,
  INTERFACE_NAME
};
