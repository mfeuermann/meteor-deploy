/**
 * The load-balancing upstream file `/opt/mup-nginx-proxy/upstream/<app>` (MUP's `upstream.sh`)
 * and the controller that takes servers out of it while they restart (proxy spec §4.4).
 *
 * comet-deploy's only addition to the file is the nginx `down` flag on a server line
 * (`server 10.0.0.1:4000 down;`): it keeps `ip_hash` mapping the other clients to the same
 * servers. Without down marks the file is byte-identical to the one MUP writes.
 */
import type { NormalizedConfig } from '../config/types.js';
import { loadBalancingHosts, upstreamPort } from './render.js';

/** One `server <host>:<port>[ down];` line. */
export interface UpstreamEntry {
  host: string;
  port: number;
  down: boolean;
}

/** How long a drained server keeps serving its in-flight requests before it is restarted. */
export const DRAIN_WAIT_MS = 5000;

/** The entries MUP writes: every app server, up, on the app's port, in `app.servers` order. */
export function desiredEntries(c: NormalizedConfig): UpstreamEntry[] {
  const port = upstreamPort(c);
  return loadBalancingHosts(c).map((host) => ({ host, port, down: false }));
}

/**
 * The file content for `entries`. It reproduces the body of MUP's heredoc as ejs renders it,
 * blank lines included: the newline after each `<% … %>` tag stays in the output.
 */
export function formatUpstream(c: NormalizedConfig, entries: UpstreamEntry[]): string {
  const sticky = c.proxy?.stickySessions !== false;
  const servers = entries.map((e) => `\nserver ${e.host}:${e.port}${e.down ? ' down' : ''};\n`).join('');
  return `${sticky ? '\nip_hash;\n' : ''}\n${servers}\n`;
}

/** The server lines of an upstream file (blank lines, `ip_hash;` and anything else are skipped). */
export function parseUpstream(content: string): UpstreamEntry[] {
  const out: UpstreamEntry[] = [];
  for (const line of content.split('\n')) {
    const m = /^\s*server\s+(\S+):(\d+)(\s+down)?\s*;\s*$/.exec(line);
    if (m) out.push({ host: m[1], port: Number(m[2]), down: !!m[3] });
  }
  return out;
}

/**
 * Writes the upstream file on every proxy server and reloads nginx there. Resolves with the
 * proxies where that failed; never rejects for a single proxy.
 */
export type UpstreamApply = (content: string) => Promise<{ failed: Array<{ proxy: string; error: string }> }>;

/**
 * Keeps the upstream file of one app consistent while its servers restart one by one.
 *
 * - An entry belongs to the server with the same host (`privateIp`, else `host`); its port may
 *   differ (a `PORT` change takes effect per server, when that server is healthy again).
 * - Entries whose host no server of the config has (a removed server, a changed address) are
 *   dropped at the first write, unless that would leave no entry up; then they stay until
 *   `finalize`.
 * - A server without an entry (new server, new address) is added by `healthy`, at its place in
 *   `app.servers` order.
 * - Writes are serialized, so the drains of a parallel batch never overwrite each other.
 */
export class UpstreamController {
  private entries: UpstreamEntry[];
  private last: string;
  private readonly hostOf: Map<string, string>;
  private readonly order: string[];
  private readonly failed: Array<{ proxy: string; error: string }> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waitMs: number;

  constructor(
    private readonly c: NormalizedConfig,
    current: UpstreamEntry[],
    private readonly apply: UpstreamApply,
    o: { waitMs?: number } = {},
  ) {
    this.entries = current.map((e) => ({ ...e }));
    this.last = formatUpstream(c, this.entries);
    this.order = Object.keys(c.app.servers ?? {});
    const hosts = loadBalancingHosts(c);
    this.hostOf = new Map(this.order.map((s, i) => [s, hosts[i]]));
    this.waitMs = o.waitMs ?? DRAIN_WAIT_MS;
  }

  /** Runs `fn` after every earlier operation has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ownerOf(e: UpstreamEntry): string | undefined {
    return this.order.find((s) => this.hostOf.get(s) === e.host);
  }

  private entryOf(server: string): UpstreamEntry | undefined {
    return this.entries.find((e) => e.host === this.hostOf.get(server));
  }

  /** Drops stale entries when at least one entry that stays is up. */
  private pruneStale(): void {
    const kept = this.entries.filter((e) => this.ownerOf(e) !== undefined);
    if (kept.some((e) => !e.down)) this.entries = kept;
  }

  private async write(): Promise<void> {
    const content = formatUpstream(this.c, this.entries);
    if (content === this.last) return;
    const r = await this.apply(content);
    this.failed.push(...r.failed);
    this.last = content;
  }

  /**
   * Marks `server` down on every proxy and waits `waitMs` for its in-flight requests. Returns
   * false without changing anything when it has no entry or when no other entry would stay up.
   */
  drain(server: string): Promise<boolean> {
    return this.serial(async () => {
      this.pruneStale();
      const e = this.entryOf(server);
      if (!e) return false;
      if (e.down) return true;
      if (!this.entries.some((x) => x !== e && !x.down)) return false;
      e.down = true;
      await this.write();
      if (this.waitMs > 0) await new Promise((r) => setTimeout(r, this.waitMs));
      return true;
    });
  }

  /** `server` passed its health check: its entry becomes `host:port` of the config, up. */
  healthy(server: string): Promise<void> {
    return this.serial(async () => {
      this.pruneStale();
      const host = this.hostOf.get(server);
      if (host === undefined) return;
      const next: UpstreamEntry = { host, port: upstreamPort(this.c), down: false };
      const i = this.entries.findIndex((e) => e.host === host);
      if (i >= 0) {
        this.entries[i] = next;
      } else {
        const rank = this.order.indexOf(server);
        const at = this.entries.findIndex((e) => {
          const owner = this.ownerOf(e);
          return owner === undefined || this.order.indexOf(owner) > rank;
        });
        this.entries.splice(at < 0 ? this.entries.length : at, 0, next);
      }
      await this.write();
    });
  }

  /** The final form: `desiredEntries`, with `down` kept for the servers in `keepDown`. */
  finalize(keepDown: ReadonlySet<string>): Promise<void> {
    return this.serial(async () => {
      this.entries = desiredEntries(this.c).map((e, i) => ({ ...e, down: keepDown.has(this.order[i]) }));
      await this.write();
    });
  }

  /** Servers whose entry is down right now. */
  downServers(): string[] {
    return this.order.filter((s) => this.entryOf(s)?.down);
  }

  /** Proxies where a write failed, for the summary. */
  failures(): Array<{ proxy: string; error: string }> {
    return [...this.failed];
  }
}
