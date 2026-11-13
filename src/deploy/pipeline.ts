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
 *  2. Build: once per target platform, locally, or reused from the build cache. With a private
 *     registry the local Docker logs in to it first. `meteor build` stops here.
 *  3. Lock: the deploy lock on every server (with load balancing on every app server, see
 *     `lockTargets`). Everything before this step only reads from the servers; everything after
 *     it runs in a `try` whose `finally` releases the locks.
 *  4. Distribute (src/deploy/distribution.ts): push to the local registry, then every server
 *     pulls the missing layers through an SSH reverse tunnel; a server without SSH forwarding
 *     gets the whole image over SSH; with `privateDockerRegistry` the image is pushed there and
 *     every server pulls it. The running app is not touched yet. `meteor push` stops here.
 *  5. Activate: server by server according to the strategy (canary, rolling or parallel); see
 *     `activateServer` for snapshot → retag → write config → start → health check → revert.
 *     Behind the reverse proxy a `ProxyRollout` (src/proxy/rollout.ts) wraps this phase: it
 *     syncs the app's proxy files first, drains load-balanced servers while they restart or
 *     replaces the container without downtime, and finishes the proxy before the unlock.
 *  6. History: one entry per server that was activated.
 *  7. Prune: old version tags and dangling images, on the servers that ended healthy.
 *  8. Unlock (`finally`): release the locks and this deploy's lease on the local registry.
 *  9. Summary: the per-server table, the log tails of failed servers and a warning when the
 *     servers ended on different versions. With a private registry, `:latest` there is then
 *     moved to the new version for MUP (`updateRegistryLatest`).
 *
 * `reconfig`, `restart` and `rollback` share the proxy rollout → lock → strategy → history →
 * unlock part (`lockedRollout`). Every step runs inside `ctx.runner.run()` under MUP's command key and in MUP's
 * nesting, so the config's hooks run at the same points as in MUP (hooks design §4.3).
 */
import { hostname } from 'node:os';
import { buildApp, type BuiltImage } from '../build/index.js';
import { makeVersion, readGitInfo } from '../build/version.js';
import { resolveAppPath } from '../config/normalize.js';
import type { CometOptions } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { appDir, containerName, localImageRepo } from '../core/naming.js';
import { TOOL_ID } from '../core/version.js';
import { verboseOutput } from '../output/lines.js';
import type { ServerStatus, SummaryRow } from '../output/reporter.js';
import { renderEnvList, renderMeteorStop, renderStartSh } from '../remote/app-files.js';
import {
  acquireLock,
  adoptMupRegistryImage,
  appendHistory,
  listVersions,
  pruneImages,
  pruneVersions,
  readHistory,
  readLock,
  releaseLock,
  SetupMissingError,
  startShPullsRegistry,
  type HistoryEntry,
  type LockInfo,
} from '../remote/ops.js';
import { createProxyRollout, lockTargets, rolloutProxies } from '../proxy/rollout.js';
import type { SshConnection } from '../ssh/connection.js';
import { distributeToServer } from '../transfer/distribute.js';
import { ensureLocalRegistry, pushToLocalRegistry, stopLocalRegistry } from '../transfer/local-registry.js';
import { assertRegistryPushable, pullFromRegistry, pushImage, registryLogin, registryRepo, usesRegistry } from '../transfer/registry.js';
import { localImageStore, removeArchive, saveImageArchive, serverHasImage, streamToServer } from '../transfer/stream.js';
import { activateServer, startServer, type ActivationResult } from './activate.js';
import { distributeImages } from './distribution.js';
import { deployerName, makeHistoryEntry, versionOutcomes } from './history.js';
import { runPreflight } from './preflight.js';
import { assertMongoRunning } from '../mongo/check.js';
import { chooseRollbackTarget, type RollbackTarget } from './rollback.js';
import { runStrategy } from './strategy.js';
import type { SwitchMode } from './zero-downtime.js';

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
  /** The `stream` transfer (servers without SSH forwarding get the whole image as an archive). */
  localImageStore: typeof localImageStore;
  saveImageArchive: typeof saveImageArchive;
  removeArchive: typeof removeArchive;
  serverHasImage: typeof serverHasImage;
  streamToServer: typeof streamToServer;
  /** The `registry` transfer (`privateDockerRegistry`): local login, push, pull on the servers. */
  registryLogin: typeof registryLogin;
  pushImage: typeof pushImage;
  pullFromRegistry: typeof pullFromRegistry;
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
  /** The proxy part of the rollouts (null without a `proxy` section). */
  createProxyRollout: typeof createProxyRollout;
  /** Refuses to go on when the app is linked to a `mongodb` container that does not run. */
  checkMongo: typeof assertMongoRunning;
  /** Whether MUP with a private registry wrote the server's start.sh (rollback refuses such a server). */
  startShPullsRegistry: typeof startShPullsRegistry;
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
  localImageStore,
  saveImageArchive,
  removeArchive,
  serverHasImage,
  streamToServer,
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
  createProxyRollout,
  checkMongo: assertMongoRunning,
  startShPullsRegistry,
  registryLogin,
  pushImage,
  pullFromRegistry,
};

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
 * that list is what the caller passes to `releaseServers`. With `skipNotSetUp`, a server whose
 * app config directory is missing (`SetupMissingError`) is left out instead of failing the lock.
 */
export async function lockServers(
  ctx: CommandContext,
  servers: string[],
  command: string,
  d: Pick<PipelineDeps, 'acquireLock' | 'releaseLock' | 'readLock'>,
  o: { force?: boolean; skipNotSetUp?: boolean } = {},
): Promise<string[]> {
  if (!ctx.config.cometDeploy.lock) return [];
  if (o.force) await forceUnlock(ctx, servers, d);
  const info = lockInfo(command);
  // One server at a time, in the same order for every command, stopping at a lock someone holds:
  // of two commands that want the same servers, the one that locks the first of them gets them
  // all. Locking in parallel could give each command one server, and both would fail.
  const order = [...servers].sort();
  const results: Array<PromiseSettledResult<{ s: string; r: Awaited<ReturnType<PipelineDeps['acquireLock']>> }>> = [];
  for (const s of order) {
    try {
      const r = await d.acquireLock(await ctx.ssh.get(s), ctx.config.app.name, info);
      results.push({ status: 'fulfilled', value: { s, r } });
      if (!r.ok) break;
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  const acquired = new Set(results.flatMap((x) => (x.status === 'fulfilled' && x.value.r.ok ? [x.value.s] : [])));
  const locked = servers.filter((s) => acquired.has(s));
  // A server without the app's config directory has no deploy running on it: nothing to lock.
  const skipped = (x: PromiseSettledResult<unknown>) => !!o.skipNotSetUp && x.status === 'rejected' && x.reason instanceof SetupMissingError;
  const problems = results.flatMap((x, i) => {
    if (skipped(x)) return [];
    if (x.status === 'rejected') return [`Server "${order[i]}": ${(x.reason as Error)?.message ?? x.reason}`];
    if (!x.value.r.ok) {
      return [`Server "${order[i]}" is locked by ${describeHolder(x.value.r.holder)}`];
    }
    return [];
  });
  if (problems.length) {
    await releaseServers(ctx, locked, d);
    // The "wait for the other deploy" hint only fits a lock that someone holds; a server error
    // brings its own hint (e.g. "run setup first"), each one given once.
    const held = results.some((x) => x.status === 'fulfilled' && !x.value.r.ok);
    const hints = new Set(results.flatMap((x) => (x.status === 'rejected' && !skipped(x) && x.reason instanceof CometError && x.reason.hint ? [x.reason.hint] : [])));
    if (held) hints.add('Wait for the other deploy to finish. If none is running, release the lock with "comet-deploy unlock" (or add --force-unlock).');
    throw new CometError(`Cannot lock the servers:\n${problems.map((p) => `  - ${p}`).join('\n')}`, {
      hint: hints.size ? [...hints].join('\n') : undefined,
    });
  }
  for (const s of locked) heldLocks(ctx).add(s);
  return locked;
}

/** The servers whose deploy lock this command holds right now (see `holdsLock`). */
const HELD = new WeakMap<CommandContext, Set<string>>();
const heldLocks = (ctx: CommandContext): Set<string> => {
  let set = HELD.get(ctx);
  if (!set) HELD.set(ctx, (set = new Set()));
  return set;
};

/**
 * Whether this command holds a deploy lock now: between `lockServers` and `releaseServers`
 * (also inside `withAppLock`). A hook that runs then cannot start another locking command.
 */
export function holdsLock(ctx: CommandContext): boolean {
  return (HELD.get(ctx)?.size ?? 0) > 0;
}

/**
 * Releases the deploy lock on `servers`. It runs in `finally` blocks, so it never throws: a server
 * whose lock cannot be released only gets a warning with the command that releases it by hand.
 */
export async function releaseServers(ctx: CommandContext, servers: string[], d: Pick<PipelineDeps, 'releaseLock'>): Promise<void> {
  for (const s of servers) heldLocks(ctx).delete(s);
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
 * `deploy`: preflight → build once → lock → distribute → activate by strategy → history →
 * prune → unlock → summary (the module header describes each phase). `stopAfter: 'build'` / `'push'` implement the hidden `meteor build` /
 * `meteor push`.
 *
 * Servers that fail their health check do not make it throw: they are in the returned outcome
 * (`ok: false`). It throws `CometError` for problems found before activation (preflight, build,
 * lock, distribution) and when aborted.
 */
export async function deployPipeline(
  ctx: CommandContext,
  o: {
    cachedBuild: boolean;
    forceBuild: boolean;
    cacheFrom?: string[];
    cacheTo?: string[];
    strategy?: CometOptions['strategy'];
    stopAfter?: 'build' | 'push';
    forceUnlock?: boolean;
  },
  deps: Partial<PipelineDeps> = {},
): Promise<DeployOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  const r = ctx.reporter;
  const c = ctx.config;
  const run = ctx.runner;
  // First of all: a registry config that would push somewhere else fails before any work
  // (`meteor build` pushes nothing).
  if (o.stopAfter !== 'build') assertRegistryPushable(c);

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
  // `meteor push` stops after `meteor.prepareBundle`, as in MUP.
  const keys =
    o.stopAfter === 'build'
      ? ['meteor.build']
      : ['meteor.push', 'meteor.build', 'meteor.prepareBundle', ...(o.stopAfter === 'push' ? [] : ['meteor.deploy', 'default.reconfig', 'meteor.envconfig', 'meteor.start'])];
  const step = <T>(key: string, fn: () => Promise<T>, so?: { failed?: (r: T) => boolean }): Promise<T> => (keys.includes(key) ? run.run(key, fn, so) : fn());
  // `meteor.push` spans the build and the distribution, with the lock in between, so it is
  // entered and left by hand.
  const pushing = keys.includes('meteor.push');

  return step('meteor.deploy', async () => {
    // Only a full deploy goes through the proxy; `meteor build` / `meteor push` do not touch the app.
    const proxied = !!c.proxy && !o.stopAfter;
    // A held lock only matters when this run will take one: `meteor build` never locks, and
    // `--force-unlock` releases the lock anyway.
    const pre = await r.phase('Preflight', () =>
      d.preflight(ctx, servers, {
        needsBuild: true,
        checkLocks: c.cometDeploy.lock && o.stopAfter !== 'build' && !o.forceUnlock,
        distributes: o.stopAfter !== 'build',
        ...(proxied ? { proxyServers: rolloutProxies(ctx) } : {}),
        // `meteor build` and `meteor push` do not start the app, so MongoDB does not matter.
        mongo: !!c.mongo && !o.stopAfter,
      }),
    );
    // Loaded before the build, as MUP's deploy does first: a missing or invalid settings file
    // fails now, and its values are registered as secrets before any later output is printed.
    const settings = ctx.getSettings();
    await checkEnvLists(ctx, servers, settings);
    // Before the build too: a proxy file the config names that cannot be read fails now.
    const rollout = proxied ? await d.createProxyRollout(ctx, { action: 'deploy', strategy }) : null;
    let proxyWarnings: string[] = [];
    let built: BuiltImage[] = [];
    let results: ActivationResult[] = [];
    let skipped: string[] = [];

    // In MUP `meteor.push` is build + upload + `meteor.prepareBundle`. Here the lock sits between
    // the build and the distribution (`meteor.prepareBundle`); `meteor.push` still starts before
    // the build and ends after the distribution, so its hooks run where MUP runs them.
    if (pushing) await run.enter('meteor.push');
    // Before the build, so wrong credentials fail now and not after minutes of building.
    if (usesRegistry(c) && pushing && (await d.registryLogin(c.privateDockerRegistry!))) r.info(`registry: logged in to ${c.privateDockerRegistry!.host}`);
    built = await step('meteor.build', () =>
      r.phase('Build', () =>
        d.buildApp(ctx, { platforms: pre.platforms, version, cachedBuild: o.cachedBuild, forceBuild: o.forceBuild, cacheFrom: o.cacheFrom, cacheTo: o.cacheTo }),
      ),
    );
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
    const locked = await r.phase('Lock', () => lockServers(ctx, rollout ? lockTargets(ctx) : servers, 'deploy', d, { force: o.forceUnlock }));
    // Tells the `finally` whether this deploy holds a lease on the shared local registry.
    let registryStarted = false;
    // Set once the activation ran, so a hook that fails after it still gets the summary.
    let activationRan = false;
    let failure: unknown;
    try {
      // Inside the `try`, so an abort that arrived while locking still releases the locks.
      aborted(d.signal);
      // Distribution only adds an image next to the running app (tunnel or stream per server).
      await step('meteor.prepareBundle', () =>
        r.phase('Distribute', () =>
          distributeImages(ctx, d, {
            servers,
            streamServers: pre.streamServers,
            built,
            imageFor,
            targetTag,
            checkAbort: () => aborted(d.signal),
            onRegistryStarted: () => (registryStarted = true),
          }),
        ),
      );
      if (pushing) await run.leave('meteor.push');
      aborted(d.signal);
      if (o.stopAfter === 'push') return { version: deployedVersion, results, skipped, ok: true };

      // The app's proxy files are brought in line before the first server switches to the new
      // version; nothing of the running app is changed by that.
      if (rollout) await rollout.prepare();
      // MUP's deploy continues with `default.reconfig` › `meteor.envconfig` → `meteor.start`.
      // One activation per server writes the config and starts the app, so that a canary and a
      // revert work server by server; `meteor.envconfig` is therefore an empty step right before
      // it (hooks design §4.3).
      ({ results, skipped } = await step('default.reconfig', async () => {
        await step('meteor.envconfig', async () => {});
        return step(
          'meteor.start',
          async () => {
            // Read now, not before the build: a hook may have changed the settings or the config.
            const settingsNow = ctx.getSettings();
            const activated = await r.phase('Activate', async () =>
              runStrategy(
                servers,
                strategy,
                async (s) => {
                  const activate = async (mode?: SwitchMode) =>
                    d.activateServer(
                      { conn: await ctx.ssh.get(s), config: ctx.config, settings: settingsNow, serverName: s, cwd: ctx.cwd, basePath: ctx.basePath, reporter: r },
                      { version: imageFor(s).version, mode: 'deploy', switch: mode },
                    );
                  return rollout ? rollout.activate(s, activate) : activate();
                },
                d.signal,
              ),
            );
            // History right after the activation, before the post hooks: a failing post hook
            // must not lose the record of a version the servers already run. Before pruning too:
            // pruning reads it to find the versions that never ran healthy. Skipped servers were
            // not touched and get no entry.
            await writeHistory(ctx, d, { action: 'deploy', results: activated.results, startedAt, servers, git, versionOf: (s) => imageFor(s).version });
            ({ results, skipped } = activated);
            activationRan = true;
            return activated;
          },
          { failed: activationFailed },
        );
      }));

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
    } catch (e) {
      failure = e;
    } finally {
      // Runs on success, on any error and on abort (including the `meteor push` return above).
      // None of these calls throws. The proxy is finished while the locks are still held, so no
      // other deploy rewrites the upstream in between. `stopLocalRegistry` drops this deploy's
      // lease and stops the container only when no other deploy on this machine still holds one.
      if (rollout) proxyWarnings = await rollout.finish(results);
      await releaseServers(ctx, locked, d);
      if (registryStarted) await d.stopLocalRegistry().catch(() => {});
    }

    // An error before the activation changed no server: no summary. After it (a failing post
    // hook of meteor.start or default.reconfig) the summary says what the servers run now.
    if (failure !== undefined && !activationRan) throw failure;
    // The summary is printed even after an abort; the abort error (exit code 130) follows it.
    reportOutcome(ctx, summaryRows(results, skipped, (s) => imageFor(s).version), results, skipped, deployedVersion);
    for (const w of proxyWarnings) r.warn(w);
    if (failure !== undefined) throw failure;
    aborted(d.signal);
    const ok = skipped.length === 0 && results.every((x) => x.status === 'healthy');
    if (usesRegistry(c) && !o.stopAfter) await updateRegistryLatest(ctx, d, { ok, servers, built });
    return { version: deployedVersion, results, skipped, ok };
  });
}

/**
 * Points `<imagePrefix>/mup-<app>:latest` in the registry at the version a deploy has just
 * activated, for MUP: its start.sh (`mup reconfig`, `mup deploy`) pulls that tag, comet-deploy
 * never reads it (registry design §4.6). Only after a deploy that ended healthy on every app
 * server with one platform; otherwise an info line says why not. A failed push only warns.
 */
async function updateRegistryLatest(ctx: CommandContext, d: PipelineDeps, o: { ok: boolean; servers: string[]; built: BuiltImage[] }): Promise<void> {
  const c = ctx.config;
  const r = ctx.reporter;
  const ref = `${registryRepo(c)}:latest`;
  const notAll = Object.keys(c.app.servers ?? {}).some((s) => !o.servers.includes(s));
  const why = !o.ok
    ? 'the deploy did not succeed on every server'
    : notAll
      ? 'the deploy did not include every app server'
      : o.built.length !== 1
        ? 'the servers run images for several platforms'
        : null;
  if (why) {
    r.info(`registry: ${ref} not updated (${why}).`);
    return;
  }
  try {
    await d.pushImage({ localTag: o.built[0].localTag, ref, reg: c.privateDockerRegistry!, onLine: (l) => r.verboseLine(null, l) });
    r.info(`registry: ${ref} points to this version now (for MUP).`);
  } catch (e) {
    r.warn(`${(e as Error).message} The deploy itself succeeded; only MUP reads this tag ("mup reconfig" would run the previous version).`);
  }
}

/** For the runner: a rollout whose outcome is not ok failed, so its post hooks do not run. */
const notOk = (o: { ok: boolean }) => !o.ok;

/** The activation of a deploy failed when a server is not healthy or was skipped. */
const activationFailed = (a: { results: ActivationResult[]; skipped: string[] }) => a.skipped.length > 0 || a.results.some((x) => x.status !== 'healthy');

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
 * Runs one server's change through the proxy rollout (drain, switch mode) when there is one, else
 * directly with no switch mode.
 */
type ThroughProxy = (run: (mode?: SwitchMode) => Promise<ActivationResult>) => Promise<ActivationResult>;

/**
 * The common part of `reconfig`, `restart` and `rollback`: proxy rollout → lock → `fn` on each
 * server by strategy → history → proxy finish → unlock. The locks are released even when
 * something throws. `fn` handles one server and passes the part that changes the app through
 * `through`; if it throws, `runStrategy` records a failed result instead. Printing the summary
 * (and the proxy warnings after it) is left to the caller, which knows how to word it.
 */
async function lockedRollout(
  ctx: CommandContext,
  o: { action: 'reconfig' | 'restart' | 'rollback'; strategy?: CometOptions['strategy']; phase: string; forceUnlock?: boolean; versionOf?: (s: string) => string | null },
  d: PipelineDeps,
  fn: (s: string, through: ThroughProxy) => Promise<ActivationResult>,
): Promise<LifecycleOutcome & { proxyWarnings: string[] }> {
  const servers = ctx.appServers();
  if (servers.length === 0) throw new CometError('No app servers selected.');
  const strategy = o.strategy ?? ctx.config.cometDeploy.strategy;
  // Before the lock: a proxy file that cannot be read, a proxy or a MongoDB that does not run
  // fails now.
  await d.checkMongo(ctx, servers);
  const rollout = await d.createProxyRollout(ctx, { action: o.action, strategy });
  const startedAt = new Date();
  const locked = await ctx.reporter.phase('Lock', () => lockServers(ctx, rollout ? lockTargets(ctx) : servers, o.action, d, { force: o.forceUnlock }));
  let results: ActivationResult[] = [];
  let skipped: string[] = [];
  let proxyWarnings: string[] = [];
  try {
    if (rollout) await rollout.prepare();
    const through = (s: string): ThroughProxy => (run) => (rollout ? rollout.activate(s, run) : run());
    ({ results, skipped } = await ctx.reporter.phase(o.phase, () => runStrategy(servers, strategy, (s) => fn(s, through(s)), d.signal)));
    await writeHistory(ctx, d, { action: o.action, results, startedAt, servers, versionOf: o.versionOf });
  } finally {
    if (rollout) proxyWarnings = await rollout.finish(results);
    await releaseServers(ctx, locked, d);
  }
  const ok = skipped.length === 0 && results.every((x) => x.status === 'healthy');
  return { results, skipped, ok, proxyWarnings };
}

/**
 * `reconfig` (MUP `default.reconfig` → `meteor.envconfig` → `meteor.start`):
 * writes start.sh/env.list from the current config and settings, restarts the
 * app by strategy with a health check, and restores the previous config on failure.
 * The image does not change.
 */
export async function reconfigPipeline(ctx: CommandContext, o: { strategy?: CometOptions['strategy']; forceUnlock?: boolean }, deps: Partial<PipelineDeps> = {}): Promise<LifecycleOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  // MUP: `default.reconfig` › `meteor.envconfig` → `meteor.start`. The activation writes the
  // config on each server, so `meteor.envconfig` is an empty step before it (hooks design §4.3).
  return ctx.runner.run('default.reconfig', async () => {
    await ctx.runner.run('meteor.envconfig', async () => {});
    return ctx.runner.run(
      'meteor.start',
      async () => {
        // Before the lock, as in deploy: a settings file or env.list that cannot be used fails
        // while no server is locked yet.
        const settings = ctx.getSettings();
        await checkEnvLists(ctx, ctx.appServers(), settings);
        const { proxyWarnings, ...outcome } = await lockedRollout(
          ctx,
          { action: 'reconfig', strategy: o.strategy, phase: 'Reconfigure', forceUnlock: o.forceUnlock },
          d,
          async (s, through) =>
            through(async (mode) =>
              d.activateServer(
                { conn: await ctx.ssh.get(s), config: ctx.config, settings, serverName: s, cwd: ctx.cwd, basePath: ctx.basePath, reporter: ctx.reporter },
                { version: null, mode: 'reconfig', switch: mode },
              ),
            ),
        );
        reportOutcome(ctx, summaryRows(outcome.results, outcome.skipped, () => null, 'not reconfigured (an earlier server failed)'), outcome.results, outcome.skipped, null, {
          mixed: (healthy, others) =>
            `MIXED CONFIGURATION: ${healthy.join(', ')} run the new configuration; ${others.join(', ')} kept the previous one. Fix the problem and run "comet-deploy reconfig" again.`,
        });
        for (const w of proxyWarnings) ctx.reporter.warn(w);
        aborted(d.signal, 'Reconfig');
        return outcome;
      },
      { failed: notOk },
    );
  });
}

/**
 * `restart` (MUP `meteor.restart`): stop + start + health check per server by
 * strategy. Nothing changes on the server, so there is nothing to revert.
 * MUP restarts server after server; here the strategy decides, and the deploy
 * lock keeps a restart from running into a deploy. With the zero-downtime switch the app is
 * not stopped first: a new container replaces it once it is healthy and routed to.
 */
export async function restartPipeline(ctx: CommandContext, o: { strategy?: CometOptions['strategy']; forceUnlock?: boolean }, deps: Partial<PipelineDeps> = {}): Promise<LifecycleOutcome> {
  const d: PipelineDeps = { ...DEFAULT_DEPS, ...deps };
  return ctx.runner.run('meteor.restart', async () => {
    const stopScript = await renderMeteorStop(ctx.config);
    const { proxyWarnings, ...outcome } = await lockedRollout(
      ctx,
      { action: 'restart', strategy: o.strategy, phase: 'Restart', forceUnlock: o.forceUnlock },
      d,
      async (s, through) =>
        through(async (mode) => {
          const conn = await ctx.ssh.get(s);
          const deps = { conn, config: ctx.config, serverName: s, reporter: ctx.reporter };
          if (mode?.kind === 'zero-downtime') return d.startServer(deps, { switch: mode });
          ctx.reporter.server(s, 'stop', 'running');
          await conn.runScriptOrThrow(stopScript, 'Stopping the app', verboseOutput(ctx.reporter, s));
          return d.startServer(deps);
        }),
    );
    reportOutcome(ctx, summaryRows(outcome.results, outcome.skipped, () => null, 'not restarted (an earlier server failed)'), outcome.results, outcome.skipped, null, {
      mixed: (healthy, others) => `${healthy.join(', ')} restarted; ${others.join(', ')} did not. Check the logs with "comet-deploy logs".`,
    });
    for (const w of proxyWarnings) ctx.reporter.warn(w);
    aborted(d.signal, 'Restart');
    return outcome;
  }, { failed: notOk });
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
 * without lock or strategy, as in MUP. Throws only when the app is linked to a MongoDB that does
 * not run (nothing is started then); otherwise a server that cannot be reached becomes a failed
 * result, and the caller turns failed results into the exit code.
 */
export async function startAll(ctx: CommandContext, deps: Partial<Pick<PipelineDeps, 'startServer' | 'checkMongo'>> = {}): Promise<ActivationResult[]> {
  const start = deps.startServer ?? startServer;
  const servers = ctx.appServers();
  await (deps.checkMongo ?? assertMongoRunning)(ctx, servers);
  const results = await Promise.all(
    servers.map(async (s) => {
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
 * MUP's does. No lock, no snapshot: the new files take effect on the next start. A server where
 * MUP's registry start.sh is gets taken over first, as in an activation (registry design §4.5):
 * otherwise the next start would run an older `mup-<app>:latest` than the app runs now.
 */
export async function envconfigAll(ctx: CommandContext): Promise<void> {
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
      if (await adoptMupRegistryImage(conn, { appName: ctx.config.app.name, container: containerName(ctx.config), repo: localImageRepo(ctx.config) })) {
        ctx.reporter.verboseLine(f.s, 'took over the image MUP runs as :latest');
      }
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
  // The target chosen on each server, for the summary table and the history entries.
  const targets = new Map<string, RollbackTarget>();
  // A server's target version tag; null for `:previous` (an image without a version tag, e.g.
  // one deployed by MUP) and when there is no target.
  const tagOf = (s: string): string | null => {
    const t = targets.get(s);
    return t?.kind === 'version' ? t.tag : null;
  };
  return ctx.runner.run('default.rollback', async () => {
    const { proxyWarnings, ...outcome } = await lockedRollout(
      ctx,
      { action: 'rollback', strategy: o.strategy, phase: 'Rollback', forceUnlock: o.forceUnlock, versionOf: tagOf },
      d,
      async (s, through) => {
        const started = Date.now();
        const conn = await ctx.ssh.get(s);
        // MUP's registry start.sh would pull :latest from the registry and run that, whatever the
        // rollback tagged: refused like a server without a target (registry design §4.5).
        if (await d.startShPullsRegistry(conn, ctx.config.app.name)) {
          const error =
            `Server "${s}" was last deployed by MUP with privateDockerRegistry: its start.sh pulls :latest from the registry, so a rollback would not change the version. ` +
            'Run "comet-deploy reconfig" first, then the rollback.';
          ctx.reporter.server(s, 'rollback', 'failed', error);
          return { server: s, status: 'failed', durationMs: Date.now() - started, error };
        }
        // The history is only needed for the automatic choice, which skips versions that never
        // ran healthy on this server; an explicit `--to` is taken as given.
        const [versions, outcomes] = await Promise.all([
          d.listVersions(conn, localImageRepo(ctx.config)),
          o.to ? Promise.resolve(null) : serverVersionOutcomes(d, conn, ctx.config.app.name),
        ]);
        const target = chooseRollbackTarget(versions, o.to, outcomes?.succeeded);
        targets.set(s, target);
        // Decided before `through`: a server without a target is not drained, it keeps running.
        if (target.kind === 'none') {
          ctx.reporter.server(s, 'rollback', 'failed', target.reason);
          return { server: s, status: 'failed', durationMs: Date.now() - started, error: target.reason };
        }
        return through((mode) =>
          d.activateServer(
            { conn, config: ctx.config, settings: null, serverName: s, cwd: ctx.cwd, basePath: ctx.basePath, reporter: ctx.reporter },
            { version: tagOf(s), mode: 'rollback', switch: mode },
          ),
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
    for (const w of proxyWarnings) ctx.reporter.warn(w);
    aborted(d.signal, 'Rollback');
    // One version is reported when every server rolled back to the same target; servers that
    // went back to different versions are listed per server in the summary.
    const labels = [...new Set(outcome.results.map((r) => label(r.server)).filter((x): x is string => !!x))];
    return { version: o.to ?? (labels.length === 1 ? labels[0] : 'the versions listed above'), ...outcome };
  }, { failed: notOk });
}
