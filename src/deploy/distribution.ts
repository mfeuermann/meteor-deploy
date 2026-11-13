/**
 * The Distribute phase of a deploy: every server gets the image of its platform under the
 * version tag, either through the reverse tunnel to the local registry (only the missing layers
 * travel), on servers whose sshd refuses forwarding as a whole archive over SSH (`stream`), or,
 * with `privateDockerRegistry`, pushed to that registry and pulled by every server.
 * Nothing of the running app changes here; a failure on any server fails the deploy before
 * activation.
 */
import type { BuiltImage } from '../build/index.js';
import type { Platform } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { formatDuration } from '../output/reporter.js';
import type { SshConnection } from '../ssh/connection.js';
import type { distributeToServer } from '../transfer/distribute.js';
import type { ensureLocalRegistry, pushToLocalRegistry } from '../transfer/local-registry.js';
import { formatBytes, type ImageStore, type localImageStore, type removeArchive, type saveImageArchive, type serverHasImage, type StreamArchive, type streamToServer } from '../transfer/stream.js';
import { registryOfHost, registryRef, usesRegistry, type pullFromRegistry, type pushImage } from '../transfer/registry.js';
import { TunnelUnavailableError } from '../transfer/tunnel.js';
import { streamWarning } from './preflight.js';

/** The functions the phase calls (the real ones are in `PipelineDeps`). */
export interface DistributionDeps {
  ensureLocalRegistry: typeof ensureLocalRegistry;
  pushToLocalRegistry: typeof pushToLocalRegistry;
  distributeToServer: typeof distributeToServer;
  localImageStore: typeof localImageStore;
  saveImageArchive: typeof saveImageArchive;
  removeArchive: typeof removeArchive;
  serverHasImage: typeof serverHasImage;
  streamToServer: typeof streamToServer;
  pushImage: typeof pushImage;
  pullFromRegistry: typeof pullFromRegistry;
}

/** What `distributeImages` gets from the pipeline. */
interface DistributionInput {
  servers: string[];
  streamServers: string[];
  built: BuiltImage[];
  imageFor: (server: string) => BuiltImage;
  targetTag: (server: string) => string;
  checkAbort: () => void;
  onRegistryStarted: () => void;
}

/** Fails the phase when any server failed, listing all of them; marks each failed server. */
function throwIfFailed(ctx: CommandContext, servers: string[], dist: PromiseSettledResult<unknown>[]): void {
  const failed = dist.flatMap((x, i) => (x.status === 'rejected' ? [{ s: servers[i], e: x.reason as Error }] : []));
  for (const f of failed) ctx.reporter.server(f.s, 'distribute', 'failed', f.e?.message);
  if (failed.length) {
    throw new CometError(`Image distribution failed:\n${failed.map((f) => `  - ${f.s}: ${f.e?.message ?? f.e}`).join('\n')}`, {
      hint: 'No server was changed.',
    });
  }
}

/**
 * The registry path: the servers that already have the version are found first, then one push
 * per platform still needed (nothing is pushed when every server has it), `checkAbort`, and
 * the pulls on all servers in parallel. No local registry, no archives.
 */
async function distributeViaRegistry(ctx: CommandContext, d: DistributionDeps, o: DistributionInput): Promise<void> {
  const c = ctx.config;
  const r = ctx.reporter;
  const reg = c.privateDockerRegistry!;
  const present = new Set<string>();
  await Promise.all(
    o.servers.map(async (s) => {
      // A server that cannot be reached now fails below, in the distribution.
      const conn = await ctx.ssh.get(s).catch(() => null);
      if (conn && (await d.serverHasImage(conn, o.targetTag(s)).catch(() => false))) present.add(s);
    }),
  );
  const refs = new Map<Platform, string>();
  for (const b of new Set(o.servers.filter((s) => !present.has(s)).map((s) => o.imageFor(s)))) {
    const ref = registryRef(c, b);
    const res = await d.pushImage({ localTag: b.localTag, ref, reg, onLine: (l) => r.verboseLine(null, l) });
    r.info(`registry: pushed ${ref} in ${formatDuration(res.durationMs)}`);
    refs.set(b.platform, ref);
  }
  o.checkAbort();
  const host = registryOfHost(reg.host);
  const dist = await Promise.allSettled(
    o.servers.map(async (s) => {
      if (present.has(s)) return r.server(s, 'distribute', 'ok', '(already on the server)');
      r.server(s, 'distribute', 'running');
      const conn = await ctx.ssh.get(s);
      const res = await d.pullFromRegistry(conn, { ref: refs.get(o.imageFor(s).platform)!, targetTag: o.targetTag(s), reg, onStatus: (l) => r.verboseLine(s, l) });
      r.server(s, 'distribute', 'ok', `${formatDuration(res.durationMs)} (from ${host})`);
    }),
  );
  throwIfFailed(ctx, o.servers, dist);
}

/**
 * Distributes the built images to `servers`. The `streamServers` (from preflight) get the
 * archive; the others the tunnel, and with `transfer: 'auto'` a tunnel that sshd refuses only
 * now switches that server to the archive too, with the preflight warning.
 *
 * Order: the stream servers that already have the version are found first, so when all of them
 * have it nothing is saved; then one archive per platform still needed is saved, then the local
 * registry is started and pushed to (only when a tunnel server exists), then `checkAbort`, and
 * only then does anything go to the servers, all in parallel. Every archive is removed at the
 * end, whatever happened.
 *
 * With `privateDockerRegistry` every server gets the image through the registry instead (see
 * `distributeViaRegistry`).
 *
 * @param o.checkAbort Throws the abort error once the run was aborted.
 * @param o.onRegistryStarted Called once the local registry runs, so the caller stops it.
 * @throws CometError from `saveImageArchive` (before any server got anything) or
 *   `Image distribution failed:` listing every server that failed.
 */
export async function distributeImages(ctx: CommandContext, d: DistributionDeps, o: DistributionInput): Promise<void> {
  if (usesRegistry(ctx.config)) return distributeViaRegistry(ctx, d, o);
  const c = ctx.config;
  const r = ctx.reporter;
  const streamed = new Set(o.streamServers.filter((s) => o.servers.includes(s)));
  const tunnelServers = o.servers.filter((s) => !streamed.has(s));
  // One archive per platform, made on first need: up front for the stream servers, or later for
  // a server whose tunnel was refused at distribution.
  const archives = new Map<Platform, Promise<StreamArchive>>();
  let store: Promise<ImageStore> | undefined;
  const archiveFor = (b: BuiltImage): Promise<StreamArchive> => {
    let p = archives.get(b.platform);
    if (!p) {
      p = (async () => {
        store ??= d.localImageStore();
        const a = await d.saveImageArchive({ localTag: b.localTag, platform: b.platform, app: c.app.name, store: await store });
        r.info(`stream: ${b.localTag} (${b.platform}), ${formatBytes(a.bytes)} compressed`);
        return a;
      })();
      archives.set(b.platform, p);
    }
    return p;
  };
  // A failed check counts as "missing": the load then reports the real problem.
  const hasVersion = (conn: SshConnection, s: string) => d.serverHasImage(conn, o.targetTag(s)).catch(() => false);
  const alreadyThere = (s: string) => r.server(s, 'distribute', 'ok', '(already on the server)');

  try {
    const present = new Set<string>();
    await Promise.all(
      [...streamed].map(async (s) => {
        // A server that cannot be reached now fails below, in the distribution.
        const conn = await ctx.ssh.get(s).catch(() => null);
        if (conn && (await hasVersion(conn, s))) present.add(s);
      }),
    );
    const needed = [...new Set([...streamed].filter((s) => !present.has(s)).map((s) => o.imageFor(s)))];
    await Promise.all(needed.map(archiveFor));

    let port = 0;
    const refs = new Map<string, string>();
    if (tunnelServers.length) {
      ({ port } = await d.ensureLocalRegistry());
      o.onRegistryStarted();
      // One push per platform a tunnel server needs. The registry keeps its layers between
      // deploys, so only changed layers are uploaded.
      for (const b of new Set(tunnelServers.map((s) => o.imageFor(s)))) refs.set(b.platform, await d.pushToLocalRegistry(b.localTag, port, (l) => r.verboseLine(null, l)));
    }
    o.checkAbort();

    const viaStream = async (s: string, conn: SshConnection) => {
      const a = await archiveFor(o.imageFor(s));
      const res = await d.streamToServer(conn, { archive: a, targetTag: o.targetTag(s), onStatus: (l) => r.verboseLine(s, l) });
      r.server(s, 'distribute', 'ok', `${formatDuration(res.durationMs)} (whole image, ${formatBytes(a.bytes)})`);
    };
    const dist = await Promise.allSettled(
      o.servers.map(async (s) => {
        if (present.has(s)) return alreadyThere(s);
        r.server(s, 'distribute', 'running');
        const conn = await ctx.ssh.get(s);
        if (streamed.has(s)) return viaStream(s, conn);
        try {
          const res = await d.distributeToServer(conn, {
            registryPort: port,
            registryRef: refs.get(o.imageFor(s).platform)!,
            targetTag: o.targetTag(s),
            baseImage: c.app.docker.image!,
            onStatus: (l) => r.verboseLine(s, l),
          });
          r.server(s, 'distribute', 'ok', formatDuration(res.durationMs));
        } catch (e) {
          if (c.cometDeploy.transfer !== 'auto' || !(e instanceof TunnelUnavailableError)) throw e;
          r.warn(streamWarning(s, e.reason || e.message));
          if (await hasVersion(conn, s)) return alreadyThere(s);
          await viaStream(s, conn);
        }
      }),
    );
    throwIfFailed(ctx, o.servers, dist);
  } finally {
    // Waits for a save that is still running (another platform's save failed first).
    for (const p of archives.values()) {
      const a = await p.catch(() => null);
      if (a) d.removeArchive(a);
    }
  }
}
