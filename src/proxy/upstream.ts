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
 * Writes the upstream file on the given proxy servers and reloads nginx there. Resolves with the
 * proxies where that failed; never rejects for a single proxy.
 */
export type UpstreamApply = (content: string, proxies: string[]) => Promise<{ failed: Array<{ proxy: string; error: string }> }>;

/** A proxy whose upstream file is not known to have the final content after `finalize`. */
export interface UpstreamFailure {
  proxy: string;
  /** The last error of a write to it. */
  error: string;
  /** The servers that may still be marked down there (in its last known or an attempted content). */
  down: string[];
}

/**
 * Keeps the upstream file of one app consistent while its servers restart one by one.
 *
 * - An entry belongs to the server with the same host (`privateIp`, else `host`). It changes to
 *   the config's host and port only when that server applied the config (a deploy or reconfig
 *   that ended healthy, `healthy(s, { applied: true })`): until then the server runs its previous
 *   `start.sh`, and its entry stays as it is, whatever the config says now.
 * - With `applyConfig` (deploy, reconfig): entries whose host no server of the config has (a
 *   removed server, a changed address) are dropped at the first write, unless that would leave no
 *   entry up; a server without an entry (new server, new address) is added once it applied the
 *   config, at its place in `app.servers` order. Without it (restart, rollback, which run the
 *   server's own `start.sh`) only the `down` marks change.
 * - Every proxy keeps its own last known content. A write goes only to the proxies whose file
 *   differs; a failed write makes that proxy's content unknown, so the next write (at the latest
 *   `finalize`) tries it again.
 * - The starting entries are the first proxy's, with a server counted as down when it is down on
 *   any proxy.
 * - Writes are serialized, so the drains of a parallel batch never overwrite each other.
 */
export class UpstreamController {
  private entries: UpstreamEntry[];
  /** Last known content per proxy; undefined after a failed write (unknown). */
  private readonly last = new Map<string, string | null | undefined>();
  private readonly proxies: string[];
  private readonly hostOf: Map<string, string>;
  private readonly order: string[];
  private readonly applyConfig: boolean;
  /** Servers whose entry has the config's host and port because they applied the config. */
  private readonly applied = new Set<string>();
  /** Per proxy with an unknown content: the last error and the servers down in what it may hold. */
  private readonly unsynced = new Map<string, { error: string; down: Set<string> }>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waitMs: number;

  constructor(
    private readonly c: NormalizedConfig,
    files: ReadonlyMap<string, string | null>,
    private readonly apply: UpstreamApply,
    o: { waitMs?: number; applyConfig?: boolean } = {},
  ) {
    this.proxies = [...files.keys()];
    for (const [p, content] of files) this.last.set(p, content);
    this.order = Object.keys(c.app.servers ?? {});
    const hosts = loadBalancingHosts(c);
    this.hostOf = new Map(this.order.map((s, i) => [s, hosts[i]]));
    this.waitMs = o.waitMs ?? DRAIN_WAIT_MS;
    this.applyConfig = o.applyConfig ?? true;
    const parsed = [...files.values()].map((content) => parseUpstream(content ?? ''));
    const downHosts = new Set(parsed.flat().filter((e) => e.down).map((e) => e.host));
    this.entries = (parsed[0] ?? []).map((e) => ({ ...e, down: e.down || downHosts.has(e.host) }));
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

  /** The config's entry for `server` (up). */
  private configEntry(server: string): UpstreamEntry {
    return { host: this.hostOf.get(server)!, port: upstreamPort(this.c), down: false };
  }

  /** Drops stale entries (deploy, reconfig) when at least one entry that stays is up; true when it dropped any. */
  private pruneStale(): boolean {
    if (!this.applyConfig) return false;
    const kept = this.entries.filter((e) => this.ownerOf(e) !== undefined);
    if (kept.length === this.entries.length || !kept.some((e) => !e.down)) return false;
    this.entries = kept;
    return true;
  }

  /** The servers marked down in `content`. */
  private downIn(content: string | null | undefined): string[] {
    return parseUpstream(content ?? '')
      .filter((e) => e.down)
      .flatMap((e) => this.ownerOf(e) ?? []);
  }

  private async write(): Promise<void> {
    const content = formatUpstream(this.c, this.entries);
    const targets = this.proxies.filter((p) => this.last.get(p) !== content);
    if (targets.length === 0) return;
    const r = await this.apply(content, targets);
    const failed = new Map(r.failed.map((f) => [f.proxy, f.error]));
    for (const p of targets) {
      const error = failed.get(p);
      if (error === undefined) {
        this.last.set(p, content);
        this.unsynced.delete(p);
        continue;
      }
      const u = this.unsynced.get(p) ?? { error, down: new Set(this.downIn(this.last.get(p))) };
      u.error = error;
      for (const s of this.downIn(content)) u.down.add(s);
      this.unsynced.set(p, u);
      this.last.set(p, undefined);
    }
  }

  /**
   * Marks `server` down on every proxy and waits `waitMs` for its in-flight requests. A server
   * whose address changed has no entry: dropping its old (stale) entry drains it. Returns false
   * without changing anything when there is nothing to drain or no other entry would stay up.
   */
  drain(server: string): Promise<boolean> {
    return this.serial(async () => {
      const pruned = this.pruneStale();
      const e = this.entryOf(server);
      if (!e && !pruned) return false;
      if (e?.down) return true;
      if (e) {
        if (!this.entries.some((x) => x !== e && !x.down)) return false;
        e.down = true;
      }
      await this.write();
      if (this.waitMs > 0) await new Promise((r) => setTimeout(r, this.waitMs));
      return true;
    });
  }

  /**
   * `server` passed its health check. `applied`: it runs the config now (deploy, reconfig), so
   * its entry becomes the config's host and port; otherwise (a revert, restart, rollback) its
   * entry only loses the `down` mark.
   */
  healthy(server: string, o: { applied: boolean }): Promise<void> {
    return this.serial(async () => {
      this.pruneStale();
      const host = this.hostOf.get(server);
      if (host === undefined) return;
      const i = this.entries.findIndex((e) => e.host === host);
      if (o.applied && this.applyConfig) {
        this.applied.add(server);
        if (i >= 0) {
          this.entries[i] = this.configEntry(server);
        } else {
          const rank = this.order.indexOf(server);
          const at = this.entries.findIndex((e) => {
            const owner = this.ownerOf(e);
            return owner === undefined || this.order.indexOf(owner) > rank;
          });
          this.entries.splice(at < 0 ? this.entries.length : at, 0, this.configEntry(server));
        }
      } else if (i >= 0) {
        this.entries[i] = { ...this.entries[i], down: false };
      }
      await this.write();
    });
  }

  /**
   * The final form, written to every proxy whose file differs (failed proxies are tried again).
   * With `applyConfig`: the servers in `app.servers` order, each with the config's entry when it
   * applied the config and its current entry otherwise, stale entries dropped (unless no entry
   * would stay up). When every server applied the config, this is MUP's file. `down` is kept for
   * the servers in `keepDown`.
   */
  finalize(keepDown: ReadonlySet<string>): Promise<void> {
    return this.serial(async () => {
      if (this.applyConfig) {
        const next = this.order.flatMap((s) => {
          const e = this.applied.has(s) ? this.configEntry(s) : this.entryOf(s);
          return e ? [{ ...e, down: keepDown.has(s) }] : [];
        });
        const stale = this.entries.filter((e) => this.ownerOf(e) === undefined);
        this.entries = next.some((e) => !e.down) ? next : [...next, ...stale];
      } else {
        this.entries = this.entries.map((e) => {
          const owner = this.ownerOf(e);
          return owner === undefined ? e : { ...e, down: keepDown.has(owner) };
        });
      }
      await this.write();
    });
  }

  /** Servers whose entry is down right now. */
  downServers(): string[] {
    return this.order.filter((s) => this.entryOf(s)?.down);
  }

  /** App servers that have no entry (a new server or a new address that did not deploy). */
  missingServers(): string[] {
    return this.order.filter((s) => !this.entryOf(s));
  }

  /** Proxies whose file is not known to be up to date, for the summary. */
  failures(): UpstreamFailure[] {
    return [...this.unsynced].map(([proxy, u]) => ({ proxy, error: u.error, down: this.order.filter((s) => u.down.has(s)) }));
  }
}
