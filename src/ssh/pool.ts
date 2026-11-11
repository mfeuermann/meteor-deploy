import type { ServerConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { SshConnection } from './connection.js';

type Connect = (name: string, server: ServerConfig, o: { cwd: string; basePath: string }) => Promise<SshConnection>;

interface Entry {
  promise: Promise<SshConnection>;
  /** Set once the connection is open, so `get` can see whether it is still alive. */
  conn?: SshConnection;
}

/**
 * One lazily opened SSH connection per server, shared by every step of a
 * command. A connection that was dropped (or failed to open) is replaced by a
 * new one on the next `get`, so e.g. the lock release at the end of a deploy
 * still works after a short network outage.
 */
export class SshPool {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly servers: Record<string, ServerConfig>,
    private readonly o: { cwd: string; basePath: string },
    private readonly connect: Connect = SshConnection.connect,
  ) {}

  get(name: string): Promise<SshConnection> {
    const existing = this.entries.get(name);
    // A pending connection is shared; an open one only while it is alive.
    if (existing && (!existing.conn || existing.conn.isAlive)) return existing.promise;
    existing?.conn?.close().catch(() => {});
    const server = this.servers[name];
    if (!server) return Promise.reject(new CometError(`Server "${name}" is not defined in "servers"`));
    const entry: Entry = { promise: this.connect(name, server, this.o) };
    this.entries.set(name, entry);
    entry.promise.then(
      (c) => void (entry.conn = c),
      // A failed connection may be retried later.
      () => this.entries.get(name) === entry && this.entries.delete(name),
    );
    return entry.promise;
  }

  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.promise.then((c) => c.close()).catch(() => {})));
  }
}
