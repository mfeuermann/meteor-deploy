import { hostname } from 'node:os';
import { buildApp, type BuiltImage } from '../build/index.js';
import { makeVersion, readGitInfo } from '../build/version.js';
import { resolveAppPath } from '../config/normalize.js';
import type { CometOptions } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { appDir, localImageRepo } from '../core/naming.js';
import { TOOL_ID } from '../core/version.js';
import { verboseOutput } from '../output/lines.js';
import { formatDuration, type ServerStatus, type SummaryRow } from '../output/reporter.js';
import { renderEnvList, renderMeteorStop, renderStartSh } from '../remote/app-files.js';
import { acquireLock, appendHistory, listVersions, pruneVersions, readLock, releaseLock, type HistoryEntry, type LockInfo } from '../remote/ops.js';
import { distributeToServer } from '../transfer/distribute.js';
import { ensureLocalRegistry, pushToLocalRegistry, stopLocalRegistry } from '../transfer/local-registry.js';
import { activateServer, startServer, type ActivationResult } from './activate.js';
import { deployerName, makeHistoryEntry } from './history.js';
import { runPreflight } from './preflight.js';
import { chooseRollbackTarget, type RollbackTarget } from './rollback.js';
import { runStrategy } from './strategy.js';

export interface PipelineDeps {
  startServer: typeof startServer;
  preflight: typeof runPreflight;
  buildApp: typeof buildApp;
  ensureLocalRegistry: typeof ensureLocalRegistry;
  pushToLocalRegistry: typeof pushToLocalRegistry;
  stopLocalRegistry: typeof stopLocalRegistry;
  distributeToServer: typeof distributeToServer;
  activateServer: typeof activateServer;
  acquireLock: typeof acquireLock;
  releaseLock: typeof releaseLock;
  readLock: typeof readLock;
  listVersions: typeof listVersions;
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
  startServer,
  preflight: runPreflight,
  buildApp,
  ensureLocalRegistry,
  pushToLocalRegistry,
  stopLocalRegistry,
  distributeToServer,
  activateServer,
  acquireLock,
  releaseLock,
  readLock,
  listVersions,
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

function aborted(signal?: AbortSignal, what = 'Deploy'): void {
  if (signal?.aborted) throw new CometError(`${what} aborted`, { exitCode: 130, hint: 'Servers that were not reached kept their previous state.' });
}

const historyResult = (s: ActivationResult['status']): HistoryEntry['result'] => (s === 'healthy' ? 'success' : s === 'reverted' ? 'reverted' : 'failed');

export function describeHolder(h: LockInfo | undefined | null): string {
  return h ? `${h.user}@${h.machine} ("${h.command}" since ${h.startedAt})` : 'an unknown process';
}

/** `--force-unlock`: releases existing locks (naming the holder) before acquiring. */
async function forceUnlock(ctx: CommandContext, servers: string[], d: Pick<PipelineDeps, 'readLock' | 'releaseLock'>): Promise<void> {
  await Promise.all(
    servers.map(async (s) => {
      const conn = await ctx.ssh.get(s);
      const holder = await d.readLock(conn, ctx.config.app.name);
      if (!holder) return;
      ctx.reporter.warn(`Releasing the deploy lock on "${s}" held by ${describeHolder(holder)} (--force-unlock)`);
      await d.releaseLock(conn, ctx.config.app.name);
    }),
  );
}

/** Locks all servers; on any failure releases what was acquired. Returns the locked servers. */
export async function lockServers(
  ctx: CommandContext,
  servers: string[],
  command: string,
  d: Pick<PipelineDeps, 'acquireLock' | 'releaseLock' | 'readLock'>,
  o: { force?: boolean } = {},
): Promise<string[]> {
  if (!ctx.config.cometDeploy.lock) return [];
  if (o.force) await forceUnlock(ctx, servers, d);
  const info = lockInfo(command);
  const results = await Promise.allSettled(servers.map(async (s) => ({ s, r: await d.acquireLock(await ctx.ssh.get(s), ctx.config.app.name, info) })));
  const locked = results.flatMap((x) => (x.status === 'fulfilled' && x.value.r.ok ? [x.value.s] : []));
  const problems = results.flatMap((x, i) => {
    if (x.status === 'rejected') return [`Server "${servers[i]}": ${(x.reason as Error)?.message ?? x.reason}`];
    if (!x.value.r.ok) {
      return [`Server "${servers[i]}" is locked by ${describeHolder(x.value.r.holder)}`];
    }
    return [];
  });
  if (problems.length) {
    await releaseServers(ctx, locked, d);
    throw new CometError(`Cannot lock the servers:\n${problems.map((p) => `  - ${p}`).join('\n')}`, {
      hint: 'Wait for the other deploy to finish. If none is running, release the lock with "comet-deploy unlock" (or add --force-unlock).',
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
export function reportOutcome(
  ctx: CommandContext,
  rows: SummaryRow[],
  results: ActivationResult[],
  skipped: string[],
  version: string | null,
  o: { mixed?: (healthy: string[], others: string[]) => string } = {},
): void {
  ctx.reporter.summary(rows);
  const healthy = results.filter((r) => r.status === 'healthy').map((r) => r.server);
  const notHealthy = results.filter((r) => r.status !== 'healthy');
  for (const r of notHealthy) {
    if (r.logsTail) ctx.reporter.info(`\nLast log lines on "${r.server}":\n${r.logsTail.trimEnd()}`);
  }
  if (healthy.length > 0 && (notHealthy.length > 0 || skipped.length > 0)) {
    const others = [...notHealthy.map((r) => r.server), ...skipped];
    ctx.reporter.warn(
      o.mixed
        ? o.mixed(healthy, others)
        : `MIXED VERSIONS: ${healthy.join(', ')} run ${version ?? 'the new version'}; ${others.join(', ')} do not. ` +
            `Fix the problem and deploy again, or run "comet-deploy rollback --servers ${healthy.join(',')}" to return those servers to the previous version.`,
    );
  }
}

const ROW_STATUS: Record<ActivationResult['status'], ServerStatus> = { healthy: 'ok', reverted: 'reverted', 'revert-failed': 'failed', failed: 'failed' };

export function summaryRows(
  results: ActivationResult[],
  skipped: string[],
  versionOf: (s: string) => string | null,
  skipNote = 'not deployed (an earlier server failed)',
): SummaryRow[] {
  return [
    ...results.map((r) => ({
      server: r.server,
      version: versionOf(r.server) ?? undefined,
      result: ROW_STATUS[r.status],
      durationMs: r.durationMs,
      note: r.status === 'healthy' ? undefined : r.error,
    })),
    ...skipped.map((s): SummaryRow => ({ server: s, result: 'skipped', note: skipNote })),
  ];
}

/**
 * The deploy pipeline (spec §5): preflight → build once → lock → push to the
 * local registry → distribute through tunnels → activate by strategy →
 * history → prune → unlock.
 */
export async function deployPipeline(
  ctx: CommandContext,
  o: { cachedBuild: boolean; forceBuild: boolean; strategy?: CometOptions['strategy']; stopAfter?: 'build' | 'push'; forceUnlock?: boolean },
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
    const pre = await r.phase('Preflight', () => d.preflight(ctx, servers, { needsBuild: true, checkLocks: c.cometDeploy.lock && o.stopAfter !== 'build' && !o.forceUnlock }));
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

    const locked = await r.phase('Lock', () => lockServers(ctx, servers, 'deploy', d, { force: o.forceUnlock }));
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
              runStrategy(
                servers,
                strategy,
                async (s) =>
                  d.activateServer(
                    { conn: await ctx.ssh.get(s), config: c, settings, serverName: s, cwd: ctx.cwd, basePath: ctx.basePath, reporter: r },
                    { version: imageFor(s).version, mode: 'deploy' },
                  ),
                d.signal,
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
    aborted(d.signal);
    const ok = skipped.length === 0 && results.every((x) => x.status === 'healthy');
    return { version, results, skipped, ok };
  });
}

export interface LifecycleOutcome {
  results: ActivationResult[];
  skipped: string[];
  ok: boolean;
}

/** Appends one history entry per server that was touched; failures only warn. */
async function writeHistory(
  ctx: CommandContext,
  d: Pick<PipelineDeps, 'appendHistory' | 'readGitInfo'>,
  o: { action: HistoryEntry['action']; results: ActivationResult[]; startedAt: Date; servers: string[]; versionOf?: (s: string) => string | null },
): Promise<void> {
  const git = await d.readGitInfo(resolveAppPath(ctx.config, ctx.basePath)).catch(() => null);
  const durationMs = Date.now() - o.startedAt.getTime();
  await Promise.all(
    o.results.map(async (res) => {
      try {
        const entry = makeHistoryEntry({ action: o.action, version: o.versionOf?.(res.server) ?? null, result: historyResult(res.status), startedAt: o.startedAt, durationMs, git, servers: o.servers });
        await d.appendHistory(await ctx.ssh.get(res.server), ctx.config.app.name, entry);
      } catch (err) {
        ctx.reporter.warn(`Could not write the deploy history on "${res.server}": ${(err as Error).message}`);
      }
    }),
  );
}

/** Lock → `fn` by strategy → history → unlock (locks are released even when `fn` throws). */
async function lockedRollout(
  ctx: CommandContext,
  o: { action: 'reconfig' | 'restart' | 'rollback'; strategy?: CometOptions['strategy']; phase: string; forceUnlock?: boolean; versionOf?: (s: string) => string | null },
  d: PipelineDeps,
  fn: (s: string) => Promise<ActivationResult>,
): Promise<LifecycleOutcome> {
  const servers = ctx.appServers();
  if (servers.length === 0) throw new CometError('No app servers selected.');
  const startedAt = new Date();
  const locked = await ctx.reporter.phase('Lock', () => lockServers(ctx, servers, o.action, d, { force: o.forceUnlock }));
  let results: ActivationResult[] = [];
  let skipped: string[] = [];
  try {
    ({ results, skipped } = await ctx.reporter.phase(o.phase, () => runStrategy(servers, o.strategy ?? ctx.config.cometDeploy.strategy, fn, d.signal)));
    await writeHistory(ctx, d, { action: o.action, results, startedAt, servers, versionOf: o.versionOf });
  } finally {
    await releaseServers(ctx, locked, d);
  }
  const ok = skipped.length === 0 && results.every((x) => x.status === 'healthy');
  return { results, skipped, ok };
}

/**
 * `reconfig` (MUP `default.reconfig` → `meteor.envconfig` → `meteor.start`):
 * writes start.sh/env.list from the current config and settings, restarts the
 * app by strategy with a health check, and restores the previous config on failure.
 */
export async function reconfigPipeline(ctx: CommandContext, o: { strategy?: CometOptions['strategy']; forceUnlock?: boolean }, deps: Partial<PipelineDeps> = {}): Promise<LifecycleOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  assertPhase1Supported(ctx);
  return ctx.runner.run('default.reconfig', () =>
    ctx.runner.run('meteor.envconfig', () =>
      ctx.runner.run('meteor.start', async () => {
        const settings = ctx.getSettings();
        const outcome = await lockedRollout(ctx, { action: 'reconfig', strategy: o.strategy, phase: 'Reconfigure', forceUnlock: o.forceUnlock }, d, async (s) =>
          d.activateServer(
            { conn: await ctx.ssh.get(s), config: ctx.config, settings, serverName: s, cwd: ctx.cwd, basePath: ctx.basePath, reporter: ctx.reporter },
            { version: null, mode: 'reconfig' },
          ),
        );
        reportOutcome(ctx, summaryRows(outcome.results, outcome.skipped, () => null, 'not reconfigured (an earlier server failed)'), outcome.results, outcome.skipped, null, {
          mixed: (healthy, others) =>
            `MIXED CONFIGURATION: ${healthy.join(', ')} run the new configuration; ${others.join(', ')} kept the previous one. Fix the problem and run "comet-deploy reconfig" again.`,
        });
        aborted(d.signal, 'Reconfig');
        return outcome;
      }),
    ),
  );
}

/**
 * `restart` (MUP `meteor.restart`): stop + start + health check per server by
 * strategy. Nothing changes on the server, so there is nothing to revert.
 */
export async function restartPipeline(ctx: CommandContext, o: { strategy?: CometOptions['strategy']; forceUnlock?: boolean }, deps: Partial<PipelineDeps> = {}): Promise<LifecycleOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  return ctx.runner.run('meteor.restart', async () => {
    const stopScript = await renderMeteorStop(ctx.config);
    const outcome = await lockedRollout(ctx, { action: 'restart', strategy: o.strategy, phase: 'Restart', forceUnlock: o.forceUnlock }, d, async (s) => {
      const conn = await ctx.ssh.get(s);
      ctx.reporter.server(s, 'stop', 'running');
      await conn.runScriptOrThrow(stopScript, 'Stopping the app', verboseOutput(ctx.reporter, s));
      return d.startServer({ conn, config: ctx.config, serverName: s, reporter: ctx.reporter });
    });
    reportOutcome(ctx, summaryRows(outcome.results, outcome.skipped, () => null, 'not restarted (an earlier server failed)'), outcome.results, outcome.skipped, null, {
      mixed: (healthy, others) => `${healthy.join(', ')} restarted; ${others.join(', ')} did not. Check the logs with "comet-deploy logs".`,
    });
    aborted(d.signal, 'Restart');
    return outcome;
  });
}

/** `stop` (MUP `meteor.stop`): `meteor-stop.sh` on all app servers in parallel. */
export async function stopAll(ctx: CommandContext): Promise<void> {
  const servers = ctx.appServers();
  const script = await renderMeteorStop(ctx.config);
  const res = await Promise.allSettled(
    servers.map(async (s) => {
      ctx.reporter.server(s, 'stop', 'running');
      await (await ctx.ssh.get(s)).runScriptOrThrow(script, 'Stopping the app', verboseOutput(ctx.reporter, s));
      ctx.reporter.server(s, 'stop', 'ok');
    }),
  );
  const failed = res.flatMap((x, i) => (x.status === 'rejected' ? [`${servers[i]}: ${(x.reason as Error)?.message ?? x.reason}`] : []));
  for (const f of failed) ctx.reporter.error(f);
  if (failed.length) throw new CometError(`Stopping the app failed on ${failed.length} server(s):\n${failed.map((f) => `  - ${f}`).join('\n')}`);
}

/** `start` (MUP `meteor.start`): `meteor-start.sh` + health check on all app servers in parallel. */
export async function startAll(ctx: CommandContext, deps: Partial<Pick<PipelineDeps, 'startServer'>> = {}): Promise<ActivationResult[]> {
  const start = deps.startServer ?? startServer;
  const results = await Promise.all(
    ctx.appServers().map(async (s) => {
      const t = Date.now();
      try {
        return await start({ conn: await ctx.ssh.get(s), config: ctx.config, serverName: s, reporter: ctx.reporter });
      } catch (err) {
        return { server: s, status: 'failed', durationMs: Date.now() - t, error: (err as Error)?.message ?? String(err) } satisfies ActivationResult;
      }
    }),
  );
  reportOutcome(ctx, summaryRows(results, [], () => null), results, [], null, {
    mixed: (healthy, others) => `${healthy.join(', ')} started; ${others.join(', ')} did not. Check the logs with "comet-deploy logs".`,
  });
  return results;
}

/** Hidden `meteor envconfig`: writes start.sh/env.list on all app servers without restarting. */
export async function envconfigAll(ctx: CommandContext): Promise<void> {
  assertPhase1Supported(ctx);
  await ctx.runner.run('meteor.envconfig', async () => {
    const settings = ctx.getSettings();
    for (const s of ctx.appServers()) {
      const conn = await ctx.ssh.get(s);
      await conn.writeFile(`${appDir(ctx.config)}/config/start.sh`, await renderStartSh(ctx.config, s));
      await conn.writeFile(`${appDir(ctx.config)}/config/env.list`, await renderEnvList(ctx.config, settings, s, { cwd: ctx.cwd, basePath: ctx.basePath }), 0o600);
      ctx.reporter.server(s, 'envconfig', 'ok');
    }
  });
}

/**
 * `rollback [--to <version>]` (spec §11): lock → per server by strategy: pick
 * the target from the kept versions → retag → start.sh → health check →
 * history → unlock. Only the image changes; the current config stays.
 */
export async function rollbackPipeline(
  ctx: CommandContext,
  o: { to?: string; strategy?: CometOptions['strategy']; forceUnlock?: boolean },
  deps: Partial<PipelineDeps> = {},
): Promise<DeployOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  assertPhase1Supported(ctx);
  const targets = new Map<string, RollbackTarget>();
  const tagOf = (s: string): string | null => {
    const t = targets.get(s);
    return t?.kind === 'version' ? t.tag : null;
  };
  return ctx.runner.run('default.rollback', async () => {
    const outcome = await lockedRollout(
      ctx,
      { action: 'rollback', strategy: o.strategy, phase: 'Rollback', forceUnlock: o.forceUnlock, versionOf: tagOf },
      d,
      async (s) => {
        const started = Date.now();
        const conn = await ctx.ssh.get(s);
        const target = chooseRollbackTarget(await d.listVersions(conn, localImageRepo(ctx.config)), o.to);
        targets.set(s, target);
        if (target.kind === 'none') {
          ctx.reporter.server(s, 'rollback', 'failed', target.reason);
          return { server: s, status: 'failed', durationMs: Date.now() - started, error: target.reason };
        }
        return d.activateServer(
          { conn, config: ctx.config, settings: null, serverName: s, cwd: ctx.cwd, basePath: ctx.basePath, reporter: ctx.reporter },
          { version: tagOf(s), mode: 'rollback' },
        );
      },
    );
    const label = (s: string) => {
      const t = targets.get(s);
      return t?.kind === 'version' ? t.tag : t?.kind === 'previous' ? ':previous' : null;
    };
    reportOutcome(ctx, summaryRows(outcome.results, outcome.skipped, label, 'not rolled back (an earlier server failed)'), outcome.results, outcome.skipped, null, {
      mixed: (healthy, others) =>
        `MIXED VERSIONS: ${healthy.join(', ')} were rolled back; ${others.join(', ')} were not. ` +
        `Fix the problem and run "comet-deploy rollback --servers ${others.join(',')}"${o.to ? ` --to ${o.to}` : ''}.`,
    });
    aborted(d.signal, 'Rollback');
    const labels = [...new Set(outcome.results.map((r) => label(r.server)).filter((x): x is string => !!x))];
    return { version: o.to ?? (labels.length === 1 ? labels[0] : 'previous'), ...outcome };
  });
}
