/**
 * The SSH connections of one command: at most one per server, opened on first use and shared by
 * every step (preflight, lock, distribution, activation, unlock).
 */
import type { ServerConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { SshConnection } from './connection.js';

/** Opens a connection (`SshConnection.connect`; tests pass a fake). */
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

  /**
   * The connection to server `name`. Callers that ask while it is still being opened share the
   * same attempt. Rejects with a CometError when `name` is not in `servers` or the connection
   * cannot be opened; the next call then tries again.
   */
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
      // A failed connection may be retried later. Only remove this attempt's entry, not a newer
      // one that replaced it meanwhile.
      () => this.entries.get(name) === entry && this.entries.delete(name),
    );
    return entry.promise;
  }

  /**
   * Closes every connection, including ones still being opened (closed once they are open).
   * Errors are ignored: this runs at the end of a command, often after a failure.
   */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.promise.then((c) => c.close()).catch(() => {})));
  }
}
