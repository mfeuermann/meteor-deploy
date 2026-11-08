import { hostname } from 'node:os';
import { buildApp, type BuiltImage } from '../build/index.js';
import { makeVersion, readGitInfo } from '../build/version.js';
import { resolveAppPath } from '../config/normalize.js';
import type { CometOptions } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { localImageRepo } from '../core/naming.js';
import { TOOL_ID } from '../core/version.js';
import { formatDuration, type ServerStatus, type SummaryRow } from '../output/reporter.js';
import { acquireLock, appendHistory, pruneVersions, releaseLock, type HistoryEntry, type LockInfo } from '../remote/ops.js';
import { distributeToServer } from '../transfer/distribute.js';
import { ensureLocalRegistry, pushToLocalRegistry, stopLocalRegistry } from '../transfer/local-registry.js';
import { activateServer, type ActivationResult } from './activate.js';
import { deployerName, makeHistoryEntry } from './history.js';
import { runPreflight } from './preflight.js';
import { runStrategy } from './strategy.js';

export interface PipelineDeps {
  preflight: typeof runPreflight;
  buildApp: typeof buildApp;
  ensureLocalRegistry: typeof ensureLocalRegistry;
  pushToLocalRegistry: typeof pushToLocalRegistry;
  stopLocalRegistry: typeof stopLocalRegistry;
  distributeToServer: typeof distributeToServer;
  activateServer: typeof activateServer;
  acquireLock: typeof acquireLock;
  releaseLock: typeof releaseLock;
  appendHistory: typeof appendHistory;
  pruneVersions: typeof pruneVersions;
  readGitInfo: typeof readGitInfo;
  signal?: AbortSignal;
}

export interface DeployOutcome {
  version: string;
  results: ActivationResult[];
  skipped: string[];
  ok: boolean;
}

const DEFAULT_DEPS: PipelineDeps = {
  preflight: runPreflight,
  buildApp,
  ensureLocalRegistry,
  pushToLocalRegistry,
  stopLocalRegistry,
  distributeToServer,
  activateServer,
  acquireLock,
  releaseLock,
  appendHistory,
  pruneVersions,
  readGitInfo,
};

/** Config parts whose runtime is not in phase 1. */
export function assertPhase1Supported(ctx: CommandContext): void {
  const c = ctx.config;
  const phase2 = (what: string) => new CometError(`${what} is not supported yet (planned for phase 2 of comet-deploy).`);
  if (c.proxy) throw phase2('The "proxy" section');
  if (c.mongo) throw phase2('The "mongo" section');
  if (c.privateDockerRegistry) throw phase2('"privateDockerRegistry"');
  if (c.cometDeploy.transfer === 'registry' || c.cometDeploy.transfer === 'stream') throw phase2(`cometDeploy.transfer "${c.cometDeploy.transfer}"`);
}

export function lockInfo(command: string): LockInfo {
  return { user: deployerName(), machine: hostname(), pid: process.pid, startedAt: new Date().toISOString(), command, tool: TOOL_ID };
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CometError('Deploy aborted', { exitCode: 130 });
}

const historyResult = (s: ActivationResult['status']): HistoryEntry['result'] => (s === 'healthy' ? 'success' : s === 'reverted' ? 'reverted' : 'failed');

/** Locks all servers; on any failure releases what was acquired. Returns the locked servers. */
export async function lockServers(ctx: CommandContext, servers: string[], command: string, d: Pick<PipelineDeps, 'acquireLock' | 'releaseLock'>): Promise<string[]> {
  if (!ctx.config.cometDeploy.lock) return [];
  const info = lockInfo(command);
  const results = await Promise.allSettled(servers.map(async (s) => ({ s, r: await d.acquireLock(await ctx.ssh.get(s), ctx.config.app.name, info) })));
  const locked = results.flatMap((x) => (x.status === 'fulfilled' && x.value.r.ok ? [x.value.s] : []));
  const problems = results.flatMap((x, i) => {
    if (x.status === 'rejected') return [`Server "${servers[i]}": ${(x.reason as Error)?.message ?? x.reason}`];
    if (!x.value.r.ok) {
      const h = x.value.r.holder;
      return [`Server "${servers[i]}" is locked by ${h ? `${h.user}@${h.machine} ("${h.command}" since ${h.startedAt})` : 'an unknown process'}`];
    }
    return [];
  });
  if (problems.length) {
    await releaseServers(ctx, locked, d);
    throw new CometError(`Cannot lock the servers:\n${problems.map((p) => `  - ${p}`).join('\n')}`, {
      hint: 'Wait for the other deploy to finish. If none is running, release the lock with "comet-deploy unlock".',
    });
  }
  return locked;
}

export async function releaseServers(ctx: CommandContext, servers: string[], d: Pick<PipelineDeps, 'releaseLock'>): Promise<void> {
  await Promise.all(
    servers.map(async (s) => {
      try {
        await d.releaseLock(await ctx.ssh.get(s), ctx.config.app.name);
      } catch (err) {
        ctx.reporter.warn(`Could not release the deploy lock on "${s}": ${(err as Error).message}. Run "comet-deploy unlock --servers ${s}".`);
      }
    }),
  );
}

/** Prints the per-server table and, when servers differ, the mixed-versions warning. */
export function reportOutcome(ctx: CommandContext, rows: SummaryRow[], results: ActivationResult[], skipped: string[], version: string | null): void {
  ctx.reporter.summary(rows);
  const healthy = results.filter((r) => r.status === 'healthy').map((r) => r.server);
  const notHealthy = results.filter((r) => r.status !== 'healthy');
  for (const r of notHealthy) {
    if (r.logsTail) ctx.reporter.info(`\nLast log lines on "${r.server}":\n${r.logsTail.trimEnd()}`);
  }
  if (healthy.length > 0 && (notHealthy.length > 0 || skipped.length > 0)) {
    ctx.reporter.warn(
      `MIXED VERSIONS: ${healthy.join(', ')} run ${version ?? 'the new version'}; ` +
        `${[...notHealthy.map((r) => r.server), ...skipped].join(', ')} do not. ` +
        'Fix the problem and deploy again, or run "comet-deploy rollback" to return all servers to the previous version.',
    );
  }
}

const ROW_STATUS: Record<ActivationResult['status'], ServerStatus> = { healthy: 'ok', reverted: 'reverted', 'revert-failed': 'failed', failed: 'failed' };

export function summaryRows(results: ActivationResult[], skipped: string[], versionOf: (s: string) => string | null): SummaryRow[] {
  return [
    ...results.map((r) => ({
      server: r.server,
      version: versionOf(r.server) ?? undefined,
      result: ROW_STATUS[r.status],
      durationMs: r.durationMs,
      note: r.status === 'healthy' ? undefined : r.error,
    })),
    ...skipped.map((s): SummaryRow => ({ server: s, result: 'skipped', note: 'not deployed (an earlier server failed)' })),
  ];
}

/**
 * The deploy pipeline (spec §5): preflight → build once → lock → push to the
 * local registry → distribute through tunnels → activate by strategy →
 * history → prune → unlock.
 */
export async function deployPipeline(
  ctx: CommandContext,
  o: { cachedBuild: boolean; forceBuild: boolean; strategy?: CometOptions['strategy']; stopAfter?: 'build' | 'push' },
  deps: Partial<PipelineDeps> = {},
): Promise<DeployOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  const r = ctx.reporter;
  const c = ctx.config;
  const run = ctx.runner;
  assertPhase1Supported(ctx);

  const servers = ctx.appServers();
  if (servers.length === 0) throw new CometError('No app servers selected.');
  const startedAt = new Date();
  const appPath = resolveAppPath(c, ctx.basePath);
  const git = await d.readGitInfo(appPath);
  const version = makeVersion(startedAt, git ? { sha: git.sha, dirty: git.dirty } : undefined);
  const strategy = o.strategy ?? c.cometDeploy.strategy;

  return run.run('meteor.deploy', async () => {
    const pre = await r.phase('Preflight', () => d.preflight(ctx, servers, { needsBuild: true, checkLocks: c.cometDeploy.lock && o.stopAfter !== 'build' }));
    const settings = ctx.getSettings();
    let built: BuiltImage[] = [];
    let results: ActivationResult[] = [];
    let skipped: string[] = [];

    await run.run('meteor.push', async () => {
      built = await run.run('meteor.build', () =>
        r.phase('Build', () => d.buildApp(ctx, { platforms: pre.platforms, version, cachedBuild: o.cachedBuild, forceBuild: o.forceBuild })),
      );
    });
    if (o.stopAfter === 'build') return { version, results, skipped, ok: true };
    aborted(d.signal);

    const imageFor = (s: string): BuiltImage => {
      const b = built.find((x) => x.platform === pre.platformByServer[s]);
      if (!b) throw new CometError(`No image was built for ${pre.platformByServer[s]} (server "${s}").`);
      return b;
    };
    const targetTag = (s: string) => `${localImageRepo(c)}:${imageFor(s).version}`;

    const locked = await r.phase('Lock', () => lockServers(ctx, servers, 'deploy', d));
    let registryStarted = false;
    try {
      aborted(d.signal);
      await run.run('meteor.prepareBundle', () =>
        r.phase('Distribute', async () => {
          const { port } = await d.ensureLocalRegistry();
          registryStarted = true;
          const refs = new Map<string, string>();
          for (const b of built) refs.set(b.platform, await d.pushToLocalRegistry(b.localTag, port, (l) => r.verboseLine(null, l)));
          aborted(d.signal);
          const dist = await Promise.allSettled(
            servers.map(async (s) => {
              r.server(s, 'distribute', 'running');
              const res = await d.distributeToServer(await ctx.ssh.get(s), {
                registryPort: port,
                registryRef: refs.get(imageFor(s).platform)!,
                targetTag: targetTag(s),
                baseImage: c.app.docker.image!,
                onStatus: (l) => r.verboseLine(s, l),
              });
              r.server(s, 'distribute', 'ok', formatDuration(res.durationMs));
            }),
          );
          const failed = dist.flatMap((x, i) => (x.status === 'rejected' ? [{ s: servers[i], e: x.reason as Error }] : []));
          for (const f of failed) r.server(f.s, 'distribute', 'failed', f.e?.message);
          if (failed.length) {
            throw new CometError(`Image distribution failed:\n${failed.map((f) => `  - ${f.s}: ${f.e?.message ?? f.e}`).join('\n')}`, {
              hint: 'No server was changed.',
            });
          }
        }),
      );
      aborted(d.signal);
      if (o.stopAfter === 'push') return { version, results, skipped, ok: true };

      ({ results, skipped } = await run.run('default.reconfig', () =>
        run.run('meteor.envconfig', () =>
          run.run('meteor.start', () =>
            r.phase('Activate', async () =>
              runStrategy(servers, strategy, async (s) =>
                d.activateServer(
                  { conn: await ctx.ssh.get(s), config: c, settings, serverName: s, cwd: ctx.cwd, basePath: ctx.basePath, reporter: r },
                  { version: imageFor(s).version, mode: 'deploy' },
                ),
              ),
            ),
          ),
        ),
      ));

      const durationMs = Date.now() - startedAt.getTime();
      await Promise.all(
        results.map(async (res) => {
          try {
            const entry = makeHistoryEntry({ action: 'deploy', version: imageFor(res.server).version, result: historyResult(res.status), startedAt, durationMs, git, servers });
            await d.appendHistory(await ctx.ssh.get(res.server), c.app.name, entry);
          } catch (err) {
            r.warn(`Could not write the deploy history on "${res.server}": ${(err as Error).message}`);
          }
        }),
      );
      await Promise.all(
        results
          .filter((res) => res.status === 'healthy')
          .map(async (res) => {
            try {
              const removed = await d.pruneVersions(await ctx.ssh.get(res.server), localImageRepo(c), c.cometDeploy.keepVersions);
              if (removed.length) r.verboseLine(res.server, `removed old versions: ${removed.join(', ')}`);
            } catch (err) {
              r.warn(`Could not remove old versions on "${res.server}": ${(err as Error).message}`);
            }
          }),
      );
    } finally {
      await releaseServers(ctx, locked, d);
      if (registryStarted) await d.stopLocalRegistry().catch(() => {});
    }

    reportOutcome(ctx, summaryRows(results, skipped, (s) => imageFor(s).version), results, skipped, version);
    const ok = skipped.length === 0 && results.every((x) => x.status === 'healthy');
    return { version, results, skipped, ok };
  });
}
