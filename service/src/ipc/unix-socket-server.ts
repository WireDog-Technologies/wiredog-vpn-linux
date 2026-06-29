import net from 'net';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

export type MessageHandler = (message: any) => Promise<any>;

/**
 * Unix Socket Server for IPC with Electron app
 * Uses JSON-RPC 2.0 protocol
 */
export class UnixSocketServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private clients: Set<net.Socket> = new Set();
  private messageHandler: MessageHandler | null = null;

  constructor() {
    // Socket path based on environment
    this.socketPath = process.env.NODE_ENV === 'development'
      ? '/tmp/wiredog-dev.sock'
      : '/var/run/wiredog/wiredog.sock';
  }

  /**
   * Set the message handler for incoming requests
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Start the Unix socket server
   */
  async start(): Promise<void> {
    // Ensure socket directory exists
    const socketDir = path.dirname(this.socketPath);
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
    }

    // Remove existing socket file if it exists
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
      logger.info(`Removed existing socket file: ${this.socketPath}`);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        logger.error('Server error:', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, 0o666);
        logger.info(`Unix socket server listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server and clean up
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Unix socket server stopped');
          // Clean up socket file
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * Handle new client connection
   */
  private handleConnection(socket: net.Socket): void {
    logger.info('Client connected');
    this.clients.add(socket);

    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString('utf-8');

      // Process complete lines (messages are newline-delimited)
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          await this.handleMessage(socket, line.trim());
        }
      }
    });

    socket.on('close', () => {
      logger.info('Client disconnected');
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      logger.error('Client socket error:', err);
      this.clients.delete(socket);
    });
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(socket: net.Socket, json: string): Promise<void> {
    // Log method name only — never log full payload (may contain WireGuard keys or tokens)
    try { logger.debug(`Received method: ${JSON.parse(json)?.method ?? 'unknown'}`); } catch {}

    try {
      const message = JSON.parse(json);

      // Validate JSON-RPC 2.0 format
      if (message.jsonrpc !== '2.0') {
        this.sendError(socket, message.id, -32600, 'Invalid Request');
        return;
      }

      // Handle request
      if (message.method && message.id) {
        try {
          if (!this.messageHandler) {
            throw new Error('No message handler configured');
          }

          const result = await this.messageHandler(message);
          this.sendResponse(socket, message.id, result);
        } catch (err: any) {
          logger.error(`Error handling method ${message.method}:`, err);
          this.sendError(socket, message.id, -32603, err.message);
        }
      }
    } catch (err) {
      logger.error('Failed to parse message:', err);
      this.sendError(socket, null, -32700, 'Parse error');
    }
  }

  /**
   * Send successful response
   */
  private sendResponse(socket: net.Socket, id: string, result: any): void {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id,
      result
    });
    socket.write(response + '\n');
    logger.debug('Sent response');
  }

  /**
   * Send error response
   */
  private sendError(socket: net.Socket, id: string | null, code: number, message: string): void {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message }
    });
    socket.write(response + '\n');
    logger.debug('Sent error response');
  }

  /**
   * Broadcast notification to all connected clients
   */
  broadcast(method: string, params: any): void {
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    });

    for (const client of this.clients) {
      client.write(notification + '\n');
    }
    logger.debug(`Broadcast: ${method}`);
  }
}

export default new UnixSocketServer();
