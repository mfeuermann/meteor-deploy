import type { ServerConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { SshConnection } from './connection.js';

/** One lazily opened SSH connection per server. */
export class SshPool {
  private readonly connections = new Map<string, Promise<SshConnection>>();

  constructor(
    private readonly servers: Record<string, ServerConfig>,
    private readonly o: { cwd: string; basePath: string },
  ) {}

  get(name: string): Promise<SshConnection> {
    const existing = this.connections.get(name);
    if (existing) return existing;
    const server = this.servers[name];
    if (!server) return Promise.reject(new CometError(`Server "${name}" is not defined in "servers"`));
    const p = SshConnection.connect(name, server, this.o);
    this.connections.set(name, p);
    // A failed connection may be retried later.
    p.catch(() => this.connections.delete(name));
    return p;
  }

  async closeAll(): Promise<void> {
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => {})));
  }
}
