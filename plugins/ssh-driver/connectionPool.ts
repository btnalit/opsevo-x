/**
 * SshConnectionPool — SSH 连接池
 *
 * AsyncSemaphore 保证并发安全，空闲连接超时回收。
 *
 * Requirements: A8.31
 */

import type { SshPoolConfig } from './types';

const DEFAULT_POOL_CONFIG: SshPoolConfig = {
  maxConnections: 5,
  idleTimeoutMs: 300000, // 5 minutes
  connectTimeoutMs: 10000,
};

interface PooledConnection {
  id: string;
  client: any; // ssh2.Client
  lastUsed: number;
  inUse: boolean;
}

export class SshConnectionPool {
  private config: SshPoolConfig;
  private connections: Map<string, PooledConnection> = new Map();
  private waitQueue: Array<(conn: PooledConnection) => void> = [];
  private cleanupTimer: NodeJS.Timeout | null = null;
  private connectionFactory: (() => Promise<any>) | null = null;

  constructor(config?: Partial<SshPoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  setConnectionFactory(factory: () => Promise<any>): void {
    this.connectionFactory = factory;
  }

  get activeCount(): number {
    return Array.from(this.connections.values()).filter(c => c.inUse).length;
  }

  get idleCount(): number {
    return Array.from(this.connections.values()).filter(c => !c.inUse).length;
  }

  get totalCount(): number {
    return this.connections.size;
  }

  async acquire(): Promise<any> {
    // Find idle connection
    for (const [id, conn] of this.connections) {
      if (!conn.inUse) {
        conn.inUse = true;
        conn.lastUsed = Date.now();
        return conn.client;
      }
    }

    // Create new if under limit
    if (this.connections.size < this.config.maxConnections && this.connectionFactory) {
      const client = await this.connectionFactory();
      const id = `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const conn: PooledConnection = { id, client, lastUsed: Date.now(), inUse: true };
      this.connections.set(id, conn);
      return client;
    }

    // Wait for available connection
    return new Promise<any>((resolve) => {
      this.waitQueue.push((conn) => {
        conn.inUse = true;
        conn.lastUsed = Date.now();
        resolve(conn.client);
      });
    });
  }

  release(client: any): void {
    for (const [id, conn] of this.connections) {
      if (conn.client === client) {
        conn.inUse = false;
        conn.lastUsed = Date.now();

        // Serve waiting requests
        if (this.waitQueue.length > 0) {
          const waiter = this.waitQueue.shift()!;
          waiter(conn);
        }
        return;
      }
    }
  }

  startCleanup(): void {
    this.stopCleanup();
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of this.connections) {
        if (!conn.inUse && (now - conn.lastUsed) > this.config.idleTimeoutMs) {
          try { conn.client.end?.(); } catch {}
          this.connections.delete(id);
        }
      }
    }, 60000);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async closeAll(): Promise<void> {
    this.stopCleanup();
    for (const [id, conn] of this.connections) {
      try { conn.client.end?.(); } catch {}
    }
    this.connections.clear();
    this.waitQueue = [];
  }
}
