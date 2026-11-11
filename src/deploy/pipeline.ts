/**
 * Orchestrates every command that changes the app on the servers: `deploy` (plus the hidden
 * `meteor build` / `meteor push`, which stop early), `reconfig`, `restart` and `rollback`, and the
 * plain `start`, `stop` and `meteor envconfig`.
 *
 * `deployPipeline` runs these phases, in this order:
 *
 *  1. Checks: unsupported config sections, the version name, preflight (locally Docker, buildx and
 *     meteor; on every server in parallel SSH, sudo, Docker, architecture, disk space, reverse port
 *     forwarding and the deploy lock), the settings and one render of every server's env.list.
 *     Every problem is reported here, before anything is built or changed.
 *  2. Build: once per target platform, locally, or reused from the build cache.
 *     `meteor build` stops here.
 *  3. Lock: the deploy lock on every server. Everything before this step only reads from the
 *     servers; everything after it runs in a `try` whose `finally` releases the locks.
 *  4. Distribute: push to the local registry, then every server pulls the missing layers through
 *     an SSH reverse tunnel. The running app is not touched yet. `meteor push` stops here.
 *  5. Activate: server by server according to the strategy (canary, rolling or parallel); see
 *     `activateServer` for snapshot → retag → write config → start → health check → revert.
 *  6. History: one entry per server that was activated.
 *  7. Prune: old version tags and dangling images, on the servers that ended healthy.
 *  8. Unlock (`finally`): release the locks and this deploy's lease on the local registry.
 *  9. Summary: the per-server table, the log tails of failed servers and a warning when the
 *     servers ended on different versions.
 *
 * `reconfig`, `restart` and `rollback` share the lock → strategy → history → unlock part
 * (`lockedRollout`). Every step runs inside `ctx.runner.run()` under MUP's command key and in MUP's
 * nesting, so a hook configured for any of them is refused instead of silently skipped.
 */
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
import {
  acquireLock,
  appendHistory,
  listVersions,
  pruneImages,
  pruneVersions,
  readHistory,
  readLock,
  releaseLock,
  type HistoryEntry,
  type LockInfo,
} from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
import { distributeToServer } from '../transfer/distribute.js';
import { ensureLocalRegistry, pushToLocalRegistry, stopLocalRegistry } from '../transfer/local-registry.js';
import { activateServer, startServer, type ActivationResult } from './activate.js';
import { deployerName, makeHistoryEntry, versionOutcomes } from './history.js';
import { runPreflight } from './preflight.js';
import { chooseRollbackTarget, type RollbackTarget } from './rollback.js';
import { runStrategy } from './strategy.js';

/**
 * Everything the pipelines call that touches Docker, SSH, the servers or git. The defaults are
 * the real implementations (`DEFAULT_DEPS`); tests replace single functions.
 */
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
  pruneImages: typeof pruneImages;
  readHistory: typeof readHistory;
  readGitInfo: typeof readGitInfo;
  /**
   * Aborted by the CLI on the first Ctrl+C / SIGTERM: the running step finishes, no further
   * server is started, the locks are released and the command exits with code 130.
   */
  signal?: AbortSignal;
}

/** Result of `deployPipeline` and `rollbackPipeline`. */
export interface DeployOutcome {
  /**
   * Deploy: the version of the image (comma-separated when the platforms came from different
   * builds). Rollback: the `--to` version, else the target all servers share, else `previous`.
   */
  version: string;
  /** One result per server the strategy reached. */
  results: ActivationResult[];
  /** Servers the strategy did not reach because an earlier server failed or the run was aborted. */
  skipped: string[];
  /** True when every selected server ended healthy (always true when `stopAfter` ended the run). */
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
  pruneImages,
  readHistory,
  readGitInfo,
};

/**
 * Refuses the config sections this release cannot run yet (`proxy`, `mongo`,
 * `privateDockerRegistry`, the `registry` / `stream` transfers) with a `CometError`. Called before
 * anything else, so such a config fails up front instead of halfway through a deploy.
 */
export function assertPhase1Supported(ctx: CommandContext): void {
  const c = ctx.config;
  const phase2 = (what: string) => new CometError(`${what} is not supported yet (planned for phase 2 of comet-deploy).`);
  if (c.proxy) throw phase2('The "proxy" section');
  if (c.mongo) throw phase2('The "mongo" section');
  if (c.privateDockerRegistry) throw phase2('"privateDockerRegistry"');
  if (c.cometDeploy.transfer === 'registry' || c.cometDeploy.transfer === 'stream') throw phase2(`cometDeploy.transfer "${c.cometDeploy.transfer}"`);
}

/**
 * Renders the env.list of every server once and discards it, so a config Docker could not read
 * (e.g. METEOR_SETTINGS over 64 KiB) fails before the build and before any server is locked or
 * changed. Throws `CometError`.
 */
async function checkEnvLists(ctx: CommandContext, servers: string[], settings: unknown): Promise<void> {
  for (const s of servers) await renderEnvList(ctx.config, settings, s, { cwd: ctx.cwd, basePath: ctx.basePath });
}

/**
 * The lock holder record stored in the server's `deploy.lock`: who runs `command`, from which
 * machine and process, and since when. Shown to anyone who finds the lock taken.
 */
export function lockInfo(command: string): LockInfo {
  return { user: deployerName(), machine: hostname(), pid: process.pid, startedAt: new Date().toISOString(), command, tool: TOOL_ID };
}

/**
 * Throws the abort `CometError` (exit code 130) once `signal` is aborted. Called between steps,
 * never inside one, so the step that was running when the user pressed Ctrl+C finishes first.
 */
function aborted(signal?: AbortSignal, what = 'Deploy'): void {
  if (signal?.aborted) throw new CometError(`${what} aborted`, { exitCode: 130, hint: 'Servers that were not reached kept their previous state.' });
}

/** The history result of an activation status; `revert-failed` counts as `failed`. */
const historyResult = (s: ActivationResult['status']): HistoryEntry['result'] => (s === 'healthy' ? 'success' : s === 'reverted' ? 'reverted' : 'failed');

/** How many history entries are read to learn which versions ran on a server. */
const HISTORY_WINDOW = 1000;

/**
 * The version outcomes of one server from its deploy history, or null when the history says
 * nothing about versions (empty, unreadable, or only reconfig/restart entries): then nothing
 * is filtered by it.
 */
async function serverVersionOutcomes(d: Pick<PipelineDeps, 'readHistory'>, conn: SshConnection, appName: string) {
  const entries = await d.readHistory(conn, appName, HISTORY_WINDOW).catch(() => []);
  const o = versionOutcomes(entries);
  return o.succeeded.size || o.failedOnly.size ? o : null;
}

/** The lock holder for messages (also used by `status` and `unlock`). */
export function describeHolder(h: LockInfo | undefined | null): string {
  return h ? `${h.user}@${h.machine} ("${h.command}" since ${h.startedAt})` : 'an unknown process';
}

/**
 * `--force-unlock`: releases the existing locks before acquiring, with a warning that names each
 * holder so it is clear whose deploy may still be running.
 */
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

/**
 * Takes the deploy lock on every server in parallel, all or nothing: when any server is locked by
 * someone else or cannot be reached, the locks taken so far are released again and a `CometError`
 * lists every problem. Returns the servers that were locked (none when `cometDeploy.lock` is off);
 * that list is what the caller passes to `releaseServers`.
 */
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
    // The "wait for the other deploy" hint only fits a lock that someone holds; a server error
    // brings its own hint (e.g. "run setup first"), each one given once.
    const held = results.some((x) => x.status === 'fulfilled' && !x.value.r.ok);
    const hints = new Set(results.flatMap((x) => (x.status === 'rejected' && x.reason instanceof CometError && x.reason.hint ? [x.reason.hint] : [])));
    if (held) hints.add('Wait for the other deploy to finish. If none is running, release the lock with "comet-deploy unlock" (or add --force-unlock).');
    throw new CometError(`Cannot lock the servers:\n${problems.map((p) => `  - ${p}`).join('\n')}`, {
      hint: hints.size ? [...hints].join('\n') : undefined,
    });
  }
  return locked;
}

/**
 * Releases the deploy lock on `servers`. It runs in `finally` blocks, so it never throws: a server
 * whose lock cannot be released only gets a warning with the command that releases it by hand.
 */
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

/**
 * Prints the per-server summary table, the last log lines of every server that did not end
 * healthy and, when some servers ended healthy while others did not (or were skipped), a warning:
 * a partial rollout must never pass for a success. `o.mixed` words that warning for commands other
 * than deploy.
 */
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

/** Summary-table status of each activation status. */
const ROW_STATUS: Record<ActivationResult['status'], ServerStatus> = { healthy: 'ok', reverted: 'reverted', 'revert-failed': 'failed', failed: 'failed' };

/**
 * Summary-table rows: one per result (with the error as the note unless it is healthy), then one
 * per skipped server with `skipNote`. `versionOf` fills the version column (null leaves it empty).
 */
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
 * `deploy`: preflight → build once → lock → push to the local registry → distribute through
 * tunnels → activate by strategy → history → prune → unlock → summary (the module header
 * describes each phase). `stopAfter: 'build'` / `'push'` implement the hidden `meteor build` /
 * `meteor push`.
 *
 * Servers that fail their health check do not make it throw: they are in the returned outcome
 * (`ok: false`). It throws `CometError` for problems found before activation (preflight, build,
 * lock, distribution) and when aborted.
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
  // `startedAt` names the version (UTC timestamp + git sha) and is also the `startedAt` of every
  // history entry of this run, which is how `history` joins the entries of different servers.
  const startedAt = new Date();
  const appPath = resolveAppPath(c, ctx.basePath);
  const git = await d.readGitInfo(appPath);
  const version = makeVersion(startedAt, git ? { sha: git.sha, dirty: git.dirty } : undefined);
  const strategy = o.strategy ?? c.cometDeploy.strategy;

  // The MUP command keys this run enters: `meteor build` is only `meteor.build` and
  // `meteor push` stops after `meteor.prepareBundle`, as in MUP. All of them are checked for
  // hooks now, so a hook on a late step never fails the deploy after the build and the upload.
  const keys =
    o.stopAfter === 'build'
      ? ['meteor.build']
      : ['meteor.push', 'meteor.build', 'meteor.prepareBundle', ...(o.stopAfter === 'push' ? [] : ['meteor.deploy', 'default.reconfig', 'meteor.envconfig', 'meteor.start'])];
  run.refuseHooks(keys);
  const step = <T>(key: string, fn: () => Promise<T>): Promise<T> => (keys.includes(key) ? run.run(key, fn) : fn());

  return step('meteor.deploy', async () => {
    // A held lock only matters when this run will take one: `meteor build` never locks, and
    // `--force-unlock` releases the lock anyway.
    const pre = await r.phase('Preflight', () => d.preflight(ctx, servers, {
        needsBuild: true,
        checkLocks: c.cometDeploy.lock && o.stopAfter !== 'build' && !o.forceUnlock,
        distributes: o.stopAfter !== 'build',
      }));
    // Loaded before the build, as MUP's deploy does first: a missing or invalid settings file
    // fails now, and its values are registered as secrets before any later output is printed.
    const settings = ctx.getSettings();
    await checkEnvLists(ctx, servers, settings);
    let built: BuiltImage[] = [];
    let results: ActivationResult[] = [];
    let skipped: string[] = [];

    // In MUP `meteor.push` is build + upload + `meteor.prepareBundle`. Here the lock sits between
    // the build and the distribution, so `meteor.push` wraps only the build and
    // `meteor.prepareBundle` is entered after the lock; the keys still run in MUP's order.
    await step('meteor.push', async () => {
      built = await step('meteor.build', () =>
        r.phase('Build', () => d.buildApp(ctx, { platforms: pre.platforms, version, cachedBuild: o.cachedBuild, forceBuild: o.forceBuild })),
      );
    });
    // A build-cache hit reuses the image of an earlier build, which keeps that build's version
    // tag, so the version reported and deployed is the image's, not the one generated above.
    // Platforms reused from different builds can differ, hence the join.
    const deployedVersion = [...new Set(built.map((b) => b.version))].join(', ') || version;
    if (o.stopAfter === 'build') return { version: deployedVersion, results, skipped, ok: true };
    aborted(d.signal);

    // Each server gets the image built for its platform (detected by preflight).
    const imageFor = (s: string): BuiltImage => {
      const b = built.find((x) => x.platform === pre.platformByServer[s]);
      if (!b) throw new CometError(`No image was built for ${pre.platformByServer[s]} (server "${s}").`);
      return b;
    };
    // The tag the server keeps the image under: `mup-<app>:<version>`, next to MUP's
    // `:latest` / `:previous`, so it stays available for `rollback`.
    const targetTag = (s: string) => `${localImageRepo(c)}:${imageFor(s).version}`;

    // Everything above only reads from the servers. The lock is taken only now because the build
    // does not touch them and can take minutes, which would block every other deploy, rollback or
    // restart for that long; preflight has already reported a held lock before the build.
    // `lockServers` cleans up after itself when it fails, so it stays outside the `try`.
    const locked = await r.phase('Lock', () => lockServers(ctx, servers, 'deploy', d, { force: o.forceUnlock }));
    // Tells the `finally` whether this deploy holds a lease on the shared local registry.
    let registryStarted = false;
    try {
      // Inside the `try`, so an abort that arrived while locking still releases the locks.
      aborted(d.signal);
      await step('meteor.prepareBundle', () =>
        r.phase('Distribute', async () => {
          const { port } = await d.ensureLocalRegistry();
          registryStarted = true;
          // One push per platform. The registry keeps its layers between deploys, so only
          // changed layers are uploaded.
          const refs = new Map<string, string>();
          for (const b of built) refs.set(b.platform, await d.pushToLocalRegistry(b.localTag, port, (l) => r.verboseLine(null, l)));
          aborted(d.signal);
          // Distribution only adds an image next to the running app. A failure on any server
          // fails the whole deploy here, before activation, so no server has been changed.
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
      if (o.stopAfter === 'push') return { version: deployedVersion, results, skipped, ok: true };

      // MUP's deploy continues with `default.reconfig` → `meteor.envconfig` → `meteor.start`.
      // One activation per server does all three, but the keys are entered in the same nesting
      // so that hooks on them are refused.
      ({ results, skipped } = await step('default.reconfig', () =>
        step('meteor.envconfig', () =>
          step('meteor.start', () =>
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

      // History before pruning: pruning reads it to find the versions that never ran healthy.
      // Skipped servers were not touched and get no entry.
      await writeHistory(ctx, d, { action: 'deploy', results, startedAt, servers, git, versionOf: (s) => imageFor(s).version });
      // Pruning runs only where the new version is healthy; a server that failed or was reverted
      // keeps all its images for a manual rollback. Versions that never ran healthy on a server
      // do not use up one of its `keepVersions` slots. Removing version tags can leave untagged
      // images behind, which `pruneImages` removes. Pruning is housekeeping: errors only warn.
      await Promise.all(
        results
          .filter((res) => res.status === 'healthy')
          .map(async (res) => {
            try {
              const conn = await ctx.ssh.get(res.server);
              const failed = (await serverVersionOutcomes(d, conn, c.app.name))?.failedOnly ?? new Set<string>();
              const removed = await d.pruneVersions(conn, localImageRepo(c), c.cometDeploy.keepVersions, { failed });
              if (removed.length) r.verboseLine(res.server, `removed old versions: ${removed.join(', ')}`);
              await d.pruneImages(conn);
            } catch (err) {
              r.warn(`Could not remove old versions on "${res.server}": ${(err as Error).message}`);
            }
          }),
      );
    } finally {
      // Runs on success, on any error and on abort (including the `meteor push` return above).
      // Neither call throws. `stopLocalRegistry` drops this deploy's lease and stops the
      // container only when no other deploy on this machine still holds one.
      await releaseServers(ctx, locked, d);
      if (registryStarted) await d.stopLocalRegistry().catch(() => {});
    }

    // The summary is printed even after an abort; the abort error (exit code 130) follows it.
    reportOutcome(ctx, summaryRows(results, skipped, (s) => imageFor(s).version), results, skipped, deployedVersion);
    aborted(d.signal);
    const ok = skipped.length === 0 && results.every((x) => x.status === 'healthy');
    return { version: deployedVersion, results, skipped, ok };
  });
}

/** Result of `reconfig` and `restart`: `DeployOutcome` without a version. */
export interface LifecycleOutcome {
  results: ActivationResult[];
  skipped: string[];
  ok: boolean;
}

/**
 * Appends one history entry to every server the strategy reached, failed and reverted ones
 * included. Nothing here fails the command: git info is optional (`o.git` when the caller
 * read it already, null for no git) and a failed write only warns.
 */
async function writeHistory(
  ctx: CommandContext,
  d: Pick<PipelineDeps, 'appendHistory' | 'readGitInfo'>,
  o: {
    action: HistoryEntry['action'];
    results: ActivationResult[];
    startedAt: Date;
    servers: string[];
    versionOf?: (s: string) => string | null;
    git?: Awaited<ReturnType<PipelineDeps['readGitInfo']>>;
  },
): Promise<void> {
  const git = o.git !== undefined ? o.git : await d.readGitInfo(resolveAppPath(ctx.config, ctx.basePath)).catch(() => null);
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

/**
 * The common part of `reconfig`, `restart` and `rollback`: lock → `fn` on each server by strategy
 * → history → unlock. The locks are released even when something throws. `fn` handles one server;
 * if it throws, `runStrategy` records a failed result instead. Printing the summary is left to
 * the caller, which knows how to word it.
 */
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
 * The image does not change.
 */
export async function reconfigPipeline(ctx: CommandContext, o: { strategy?: CometOptions['strategy']; forceUnlock?: boolean }, deps: Partial<PipelineDeps> = {}): Promise<LifecycleOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  assertPhase1Supported(ctx);
  return ctx.runner.run('default.reconfig', () =>
    ctx.runner.run('meteor.envconfig', () =>
      ctx.runner.run('meteor.start', async () => {
        // Before the lock, as in deploy: a settings file or env.list that cannot be used fails
        // while no server is locked yet.
        const settings = ctx.getSettings();
        await checkEnvLists(ctx, ctx.appServers(), settings);
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
 * MUP restarts server after server; here the strategy decides, and the deploy
 * lock keeps a restart from running into a deploy.
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

/**
 * `stop` (MUP `meteor.stop`): `meteor-stop.sh` on all app servers in parallel, without lock or
 * strategy, as in MUP. Throws one `CometError` that lists every server that failed.
 */
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

/**
 * `start` (MUP `meteor.start`): `meteor-start.sh` + health check on all app servers in parallel,
 * without lock or strategy, as in MUP. Never throws: a server that cannot be reached becomes a
 * failed result, and the caller turns failed results into the exit code.
 */
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

/**
 * Hidden `meteor envconfig`: writes start.sh/env.list on all app servers without restarting, as
 * MUP's does. No lock, no snapshot: the new files take effect on the next start.
 */
export async function envconfigAll(ctx: CommandContext): Promise<void> {
  assertPhase1Supported(ctx);
  await ctx.runner.run('meteor.envconfig', async () => {
    const settings = ctx.getSettings();
    const servers = ctx.appServers();
    // Render everything first, so one bad server does not leave the others half-written.
    const files = await Promise.all(
      servers.map(async (s) => ({
        s,
        startSh: await renderStartSh(ctx.config, s),
        envList: await renderEnvList(ctx.config, settings, s, { cwd: ctx.cwd, basePath: ctx.basePath }),
      })),
    );
    for (const f of files) {
      const conn = await ctx.ssh.get(f.s);
      await conn.writeFile(`${appDir(ctx.config)}/config/start.sh`, f.startSh);
      // env.list carries the settings and other secrets: readable by its owner only.
      await conn.writeFile(`${appDir(ctx.config)}/config/env.list`, f.envList, 0o600);
      ctx.reporter.server(f.s, 'envconfig', 'ok');
    }
  });
}

/**
 * `rollback [--to <version>]`: lock → per server by strategy: pick the target
 * from the versions kept on that server → retag → start.sh → health check →
 * history → unlock. Nothing is built or transferred. Only the image changes;
 * the current config stays, because an old env.list could bring back secrets
 * that were rotated since. A config is changed with `reconfig`.
 */
export async function rollbackPipeline(
  ctx: CommandContext,
  o: { to?: string; strategy?: CometOptions['strategy']; forceUnlock?: boolean },
  deps: Partial<PipelineDeps> = {},
): Promise<DeployOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  assertPhase1Supported(ctx);
  // The target chosen on each server, for the summary table and the history entries.
  const targets = new Map<string, RollbackTarget>();
  // A server's target version tag; null for `:previous` (an image without a version tag, e.g.
  // one deployed by MUP) and when there is no target.
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
        // The history is only needed for the automatic choice, which skips versions that never
        // ran healthy on this server; an explicit `--to` is taken as given.
        const [versions, outcomes] = await Promise.all([
          d.listVersions(conn, localImageRepo(ctx.config)),
          o.to ? Promise.resolve(null) : serverVersionOutcomes(d, conn, ctx.config.app.name),
        ]);
        const target = chooseRollbackTarget(versions, o.to, outcomes?.succeeded);
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
    // One version is reported when every server rolled back to the same target; servers that
    // went back to different versions are listed per server in the summary.
    const labels = [...new Set(outcome.results.map((r) => label(r.server)).filter((x): x is string => !!x))];
    return { version: o.to ?? (labels.length === 1 ? labels[0] : 'the versions listed above'), ...outcome };
  });
}
