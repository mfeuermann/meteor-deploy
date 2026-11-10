import type { NormalizedConfig } from '../config/types.js';
import { appDir, containerName, localImageRepo } from '../core/naming.js';
import { verboseOutput } from '../output/lines.js';
import type { Reporter } from '../output/reporter.js';
import { renderEnvList, renderMeteorStart, renderStartSh } from '../remote/app-files.js';
import { restoreConfigSnapshot, retagActivate, retagRevert, retagSwap, shArg, snapshotConfig } from '../remote/ops.js';
import type { ExecOptions, SshConnection } from '../ssh/connection.js';
import { healthCheck, type HealthResult } from './health-check.js';

export interface ActivationResult {
  server: string;
  status: 'healthy' | 'reverted' | 'revert-failed' | 'failed';
  durationMs: number;
  error?: string;
  logsTail?: string;
  health?: HealthResult;
}

export interface ActivateDeps {
  conn: SshConnection;
  config: NormalizedConfig;
  settings: unknown;
  serverName: string;
  cwd: string;
  basePath: string;
  reporter: Reporter;
}

const DEFAULT_WAIT_SEC = 60;
const LOG_TAIL_LINES = 100;

function describeHealth(h: HealthResult): string {
  if (h.ok) return `HTTP ${h.status} after ${h.seconds}s`;
  const last = h.lastStatus ? `, last HTTP ${h.lastStatus}` : '';
  if (h.reason === 'crashed') return `the container stopped or is restarting (${h.seconds}s${last})`;
  if (h.reason === 'no-ip') return `the container got no IP address (${h.seconds}s)`;
  return `no healthy answer within ${h.seconds}s${last}`;
}

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

/** `meteor-start.sh` (runs config/start.sh as it is on the server) + health check. */
async function startAndCheck(d: Pick<ActivateDeps, 'conn' | 'config'>, out: ExecOptions): Promise<HealthResult> {
  await d.conn.runScriptOrThrow(await renderMeteorStart(d.config), 'Starting the app', out);
  return healthCheck(d.conn, healthOptions(d.config), out);
}

async function containerLogsTail(d: Pick<ActivateDeps, 'conn' | 'config'>): Promise<string | undefined> {
  const logs = await d.conn.exec(`sudo docker logs --tail ${LOG_TAIL_LINES} ${shArg(containerName(d.config))} 2>&1`).catch(() => null);
  return logs?.stdout;
}

/**
 * Starts the app from the files already on the server and checks its health
 * (`start`, `restart`). No revert: nothing was changed.
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
 * Restores the config snapshot (unless `restoreConfig` is false) and :previous
 * (when `revertImage`), then restarts the app.
 */
export async function revertServer(d: ActivateDeps, o: { revertImage: boolean; restoreConfig?: boolean }): Promise<boolean> {
  const name = d.config.app.name;
  const restoredConfig = o.restoreConfig === false ? false : await restoreConfigSnapshot(d.conn, name);
  const restoredImage = o.revertImage ? await retagRevert(d.conn, localImageRepo(d.config)) : false;
  if (!restoredConfig && !restoredImage) return false;
  const r = await d.conn.exec(`sudo bash ${shArg(`${appDir(d.config)}/config/start.sh`)}`, verboseOutput(d.reporter, d.serverName));
  if (r.code !== 0) throw new Error(`start.sh exited with ${r.code}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return true;
}

/**
 * Activation on one server (spec §10.2, without zero downtime): snapshot the
 * config, retag, write start.sh/env.list, start, health check; on failure show
 * the logs and revert.
 *
 * `rollback` changes only the image (spec §11): to `version`, or with
 * `version: null` to :previous (swapped, so the current image stays tagged).
 * A failed rollback returns to the image that ran and never touches the config.
 */
export async function activateServer(d: ActivateDeps, o: { version: string | null; mode: 'deploy' | 'reconfig' | 'rollback' }): Promise<ActivationResult> {
  const started = Date.now();
  const { conn, config, serverName: server, reporter: r } = d;
  const app = config.app;
  const out = verboseOutput(r, server);
  const done = (x: Omit<ActivationResult, 'server' | 'durationMs'>): ActivationResult => ({ server, durationMs: Date.now() - started, ...x });

  let failure: { error: string; health?: HealthResult };
  try {
    r.server(server, o.mode === 'rollback' ? `rollback to ${o.version ?? ':previous'}` : 'activate', 'running');
    if (o.mode !== 'rollback') await snapshotConfig(conn, app.name);
    if (o.mode === 'rollback' && !o.version) {
      if (!(await retagSwap(conn, localImageRepo(config)))) throw new Error('There is no :previous image on this server');
    } else if (o.mode !== 'reconfig' && o.version) {
      await retagActivate(conn, localImageRepo(config), o.version);
    }
    if (o.mode !== 'rollback') {
      await conn.writeFile(`${appDir(config)}/config/start.sh`, await renderStartSh(config, server));
      await conn.writeFile(`${appDir(config)}/config/env.list`, await renderEnvList(config, d.settings, server, { cwd: d.cwd, basePath: d.basePath }), 0o600);
    }
    const health = await startAndCheck(d, out);
    if (health.ok) {
      r.server(server, 'health', 'ok', describeHealth(health));
      return done({ status: 'healthy', health });
    }
    failure = { error: `Health check failed: ${describeHealth(health)}`, health };
  } catch (err) {
    failure = { error: (err as Error)?.message ?? String(err) };
  }

  r.server(server, 'health', 'failed', failure.error);
  const logsTail = await containerLogsTail(d);
  try {
    const reverted = await revertServer(d, { revertImage: o.mode !== 'reconfig', restoreConfig: o.mode !== 'rollback' });
    if (!reverted) return done({ status: 'failed', error: `${failure.error} (nothing to revert to)`, logsTail, health: failure.health });
    r.server(server, 'revert', 'reverted', o.mode === 'reconfig' ? 'previous config restored' : 'previous version restored');
    return done({ status: 'reverted', error: failure.error, logsTail, health: failure.health });
  } catch (err) {
    r.server(server, 'revert', 'failed', (err as Error).message);
    return done({ status: 'revert-failed', error: `${failure.error}; revert failed: ${(err as Error).message}`, logsTail, health: failure.health });
  }
}
