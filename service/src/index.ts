import logger from './utils/logger';
import unixSocketServer from './ipc/unix-socket-server';
import { handleMessage } from './ipc/json-rpc-handler';
import wireguardManager from './tunnel/wireguard-manager';
import { SERVICE_VERSION } from './version';

const SERVICE_NAME = 'WireDog VPN Service';

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // 1. Tear down WireGuard tunnel only — intentional disconnects go through
    //    handleDisconnect() which also disables the kill switch. Here we leave
    //    the iptables rules in place so kill-switch protection persists if the
    //    service dies unexpectedly (e.g. crash or SIGTERM from the OS).
    logger.info('Disconnecting VPN...');
    await wireguardManager.disconnect();
  } catch (err) {
    logger.warn('VPN disconnect failed:', err);
  }

  try {
    // 2. Stop IPC server
    logger.info('Stopping IPC server...');
    await unixSocketServer.stop();
  } catch (err) {
    logger.warn('IPC server stop failed:', err);
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('='.repeat(50));
  logger.info(`${SERVICE_NAME} v${SERVICE_VERSION}`);
  logger.info('='.repeat(50));
  logger.info(`Environment: ${process.env.NODE_ENV || 'production'}`);
  logger.info(`Process ID: ${process.pid}`);
  logger.info(`User ID: ${process.getuid?.() || 'N/A'}`);

  // Register signal handlers for graceful shutdown
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  });

  try {
    // 1. Set up message handler
    unixSocketServer.setMessageHandler(handleMessage);

    // 2. Start IPC server
    logger.info('Starting IPC server...');
    await unixSocketServer.start();

    logger.info(`${SERVICE_NAME} is ready and listening`);
    logger.info('='.repeat(50));

  } catch (err) {
    logger.error('Failed to start service:', err);
    process.exit(1);
  }
}

// Start the service
main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
