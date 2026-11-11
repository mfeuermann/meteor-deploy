/**
 * Switches one server to a new image and/or config and proves it works: snapshot the config,
 * retag the image, write start.sh/env.list, start the container, health check, and on failure
 * put back exactly what was changed. The pipelines call `activateServer` once per server through
 * the strategy; `startServer` is the no-change variant for `start` and `restart`.
 */
import type { NormalizedConfig } from '../config/types.js';
import { appDir, containerName, localImageRepo } from '../core/naming.js';
import { verboseOutput } from '../output/lines.js';
import type { Reporter } from '../output/reporter.js';
import { renderEnvList, renderMeteorStart, renderStartSh } from '../remote/app-files.js';
import { restoreConfigSnapshot, retagActivate, retagRestore, retagSwap, shArg, snapshotConfig, type ImageTags } from '../remote/ops.js';
import type { ExecOptions, SshConnection } from '../ssh/connection.js';
import { healthCheck, type HealthResult } from './health-check.js';

/** What happened on one server. */
export interface ActivationResult {
  server: string;
  /**
   * - `healthy`: the new image/config runs and passed the health check.
   * - `reverted`: it failed, and the previous image/config was restored and is healthy again.
   * - `revert-failed`: it failed, and restoring did not work or the restored app is not healthy.
   * - `failed`: it failed with nothing to revert (the server was not changed, or there was no
   *   previous state), or a plain start/restart failed.
   */
  status: 'healthy' | 'reverted' | 'revert-failed' | 'failed';
  durationMs: number;
  /** Why it was not healthy (absent when healthy). */
  error?: string;
  /** The container's last log lines, collected right after the failure (before any revert). */
  logsTail?: string;
  /** The health check of the new version, when one ran. */
  health?: HealthResult;
}

/** What an activation needs: the server's connection plus everything to render its files. */
export interface ActivateDeps {
  conn: SshConnection;
  config: NormalizedConfig;
  /** The loaded settings.json; unused for a rollback, which keeps the config on the server. */
  settings: unknown;
  serverName: string;
  /** Base directories for resolving per-server settings files when env.list is rendered. */
  cwd: string;
  basePath: string;
  reporter: Reporter;
}

/** MUP's default `deployCheckWaitTime`. */
const DEFAULT_WAIT_SEC = 60;
/** Log lines shown for a server that failed. */
const LOG_TAIL_LINES = 100;

/** One-line health check outcome for the progress output. */
function describeHealth(h: HealthResult): string {
  if (h.ok) return `HTTP ${h.status} after ${h.seconds}s`;
  const last = h.lastStatus ? `, last HTTP ${h.lastStatus}` : '';
  if (h.reason === 'crashed') return `the container stopped or is restarting (${h.seconds}s${last})`;
  if (h.reason === 'no-ip') return `the container got no IP address (${h.seconds}s)`;
  return `no healthy answer within ${h.seconds}s${last}`;
}

/**
 * Health check parameters from the config. As in MUP's deploy check, the port is
 * `deployCheckPort`, else the container port, and the timeout is `deployCheckWaitTime`.
 */
function healthOptions(config: NormalizedConfig) {
  const app = config.app;
  return {
    container: containerName(config),
    port: Number(app.deployCheckPort ?? app.docker.imagePort),
    path: config.cometDeploy.healthCheck.path,
    maxStatus: config.cometDeploy.healthCheck.maxStatus,
    timeoutSec: Number(app.deployCheckWaitTime ?? DEFAULT_WAIT_SEC),
  };
}

/**
 * MUP's `meteor-start.sh` (which recreates the container with config/start.sh as it is on the
 * server, from `:latest`) + health check. Throws when the start script fails; a failed health
 * check is returned, not thrown.
 */
async function startAndCheck(d: Pick<ActivateDeps, 'conn' | 'config'>, out: ExecOptions): Promise<HealthResult> {
  await d.conn.runScriptOrThrow(await renderMeteorStart(d.config), 'Starting the app', out);
  return healthCheck(d.conn, healthOptions(d.config), out);
}

/**
 * The container's last log lines (stderr included), or undefined when they cannot be read. Best
 * effort: it only adds detail to a failure report and must not replace the original error.
 */
async function containerLogsTail(d: Pick<ActivateDeps, 'conn' | 'config'>): Promise<string | undefined> {
  const logs = await d.conn.exec(`sudo docker logs --tail ${LOG_TAIL_LINES} ${shArg(containerName(d.config))} 2>&1`).catch(() => null);
  return logs?.stdout;
}

/**
 * Starts the app from the files already on the server and checks its health
 * (`start`, `restart`). No revert: nothing was changed. Never throws; every
 * failure becomes a `failed` result, with the container's last log lines when
 * they can be read. `o.step` labels the progress line (default `start`).
 */
export async function startServer(d: Omit<ActivateDeps, 'settings' | 'cwd' | 'basePath'>, o: { step?: string } = {}): Promise<ActivationResult> {
  const started = Date.now();
  const { serverName: server, reporter: r } = d;
  const done = (x: Omit<ActivationResult, 'server' | 'durationMs'>): ActivationResult => ({ server, durationMs: Date.now() - started, ...x });
  let failure: { error: string; health?: HealthResult };
  try {
    r.server(server, o.step ?? 'start', 'running');
    const health = await startAndCheck(d, verboseOutput(r, server));
    if (health.ok) {
      r.server(server, 'health', 'ok', describeHealth(health));
      return done({ status: 'healthy', health });
    }
    failure = { error: `Health check failed: ${describeHealth(health)}`, health };
  } catch (err) {
    failure = { error: (err as Error)?.message ?? String(err) };
  }
  r.server(server, 'health', 'failed', failure.error);
  return done({ status: 'failed', ...failure, logsTail: await containerLogsTail(d) });
}

/**
 * Undoes an activation: restores the config snapshot taken by it (when
 * `restoreConfig`) and re-tags :latest / :previous to the images they named
 * before it (`tags`), then restarts the app. False when there is nothing to undo.
 * Throws when a remote step fails; it does not check the health of the result.
 */
export async function revertServer(d: ActivateDeps, o: { tags: ImageTags | null; restoreConfig: boolean }): Promise<boolean> {
  const restoredConfig = o.restoreConfig ? await restoreConfigSnapshot(d.conn, d.config.app.name) : false;
  let restoredImage = false;
  // An empty `latestId` means the server had no :latest before (first deploy), so there is no
  // image to go back to.
  if (o.tags?.latestId) {
    await retagRestore(d.conn, localImageRepo(d.config), o.tags);
    restoredImage = true;
  }
  if (!restoredConfig && !restoredImage) return false;
  // start.sh directly, like MUP's own deploy-check revert: tags and files are already back in
  // place, so none of meteor-start.sh's image/bundle housekeeping is wanted here.
  const r = await d.conn.exec(`sudo bash ${shArg(`${appDir(d.config)}/config/start.sh`)}`, verboseOutput(d.reporter, d.serverName));
  if (r.code !== 0) throw new Error(`start.sh exited with ${r.code}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return true;
}

/**
 * Activation on one server: snapshot the config, retag, write start.sh/env.list,
 * start, health check; on failure collect the logs and revert. The app restarts
 * in place (a short downtime per server, as with MUP; no zero-downtime switch).
 *
 * The mode decides what changes:
 * - `deploy`: image (`version`) and config.
 * - `reconfig` (`version: null`): only the config; a failure restores the config.
 * - `rollback`: only the image: to `version`, or with `version: null` to
 *   :previous (swapped, so the current image stays tagged). A failed rollback
 *   returns to the image that ran and never touches the config.
 *
 * A revert counts as `reverted` only when the restored app passes a health check
 * too. Never throws: every outcome is an `ActivationResult`.
 */
export async function activateServer(d: ActivateDeps, o: { version: string | null; mode: 'deploy' | 'reconfig' | 'rollback' }): Promise<ActivationResult> {
  const started = Date.now();
  const { conn, config, serverName: server, reporter: r } = d;
  const app = config.app;
  const out = verboseOutput(r, server);
  const done = (x: Omit<ActivationResult, 'server' | 'durationMs'>): ActivationResult => ({ server, durationMs: Date.now() - started, ...x });

  let failure: { error: string; health?: HealthResult };
  // What this activation changed, so a failure undoes exactly that (and no more).
  let snapshotTaken = false;
  let tagsBefore: ImageTags | null = null;
  let touched = false;
  try {
    r.server(server, o.mode === 'rollback' ? `rollback to ${o.version ?? ':previous'}` : 'activate', 'running');
    // Render first, before the snapshot and the retag: rendering can fail (an env.list line
    // Docker could not read, an unreadable per-server settings file), and such a failure must
    // leave the server exactly as it was, with nothing to revert (`touched` stays false).
    const files =
      o.mode === 'rollback'
        ? null
        : { startSh: await renderStartSh(config, server), envList: await renderEnvList(config, d.settings, server, { cwd: d.cwd, basePath: d.basePath }) };
    // The snapshot (config/.prev) is what a failed deploy or reconfig restores. `snapshotTaken`
    // is false when the server has no start.sh yet; the config is then not restored on failure.
    if (o.mode !== 'rollback') snapshotTaken = await snapshotConfig(conn, app.name);
    if (o.mode === 'rollback' && !o.version) {
      tagsBefore = await retagSwap(conn, localImageRepo(config));
      if (!tagsBefore) throw new Error('There is no :previous image on this server');
      touched = true;
    } else if (o.mode !== 'reconfig' && o.version) {
      // retag.sh changes :latest last, so a failure inside it leaves the running image as it was.
      tagsBefore = await retagActivate(conn, localImageRepo(config), o.version);
      touched = true;
    }
    if (files) {
      // Set before writing: a failure between the two writes leaves a half-new config.
      touched = true;
      await conn.writeFile(`${appDir(config)}/config/start.sh`, files.startSh);
      // env.list carries the settings and other secrets: readable by its owner only.
      await conn.writeFile(`${appDir(config)}/config/env.list`, files.envList, 0o600);
    }
    // Starting recreates the container, so from here on any failure needs a revert.
    touched = true;
    const health = await startAndCheck(d, out);
    if (health.ok) {
      r.server(server, 'health', 'ok', describeHealth(health));
      return done({ status: 'healthy', health });
    }
    failure = { error: `Health check failed: ${describeHealth(health)}`, health };
  } catch (err) {
    failure = { error: (err as Error)?.message ?? String(err) };
  }

  // Failed before the first change: nothing to revert, and the app keeps running untouched.
  if (!touched) {
    r.server(server, o.mode === 'rollback' ? 'rollback' : 'activate', 'failed', failure.error);
    return done({ status: 'failed', error: `${failure.error} (the server was not changed)`, health: failure.health });
  }
  r.server(server, 'health', 'failed', failure.error);
  // The logs of the failed container, read before the revert replaces it.
  const logsTail = await containerLogsTail(d);
  try {
    // A rollback never took a snapshot, so only its image is restored.
    const reverted = await revertServer(d, { tags: tagsBefore, restoreConfig: snapshotTaken });
    if (!reverted) return done({ status: 'failed', error: `${failure.error} (nothing to revert to)`, logsTail, health: failure.health });
    const what = o.mode === 'reconfig' ? 'previous config' : 'previous version';
    // The promise is that the old version keeps running, so the revert only counts as
    // `reverted` when the restored app answers the health check again.
    const restored = await healthCheck(conn, healthOptions(config), out);
    if (!restored.ok) {
      const error = `${failure.error}; the restored version is not healthy either: ${describeHealth(restored)}`;
      r.server(server, 'revert', 'failed', `${what} restored, but ${describeHealth(restored)}`);
      return done({ status: 'revert-failed', error, logsTail, health: failure.health });
    }
    r.server(server, 'revert', 'reverted', `${what} restored, ${describeHealth(restored)}`);
    return done({ status: 'reverted', error: failure.error, logsTail, health: failure.health });
  } catch (err) {
    r.server(server, 'revert', 'failed', (err as Error).message);
    return done({ status: 'revert-failed', error: `${failure.error}; revert failed: ${(err as Error).message}`, logsTail, health: failure.health });
  }
}
