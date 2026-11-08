import type { NormalizedConfig } from '../config/types.js';
import { appDir, containerName, localImageRepo } from '../core/naming.js';
import { verboseOutput } from '../output/lines.js';
import type { Reporter } from '../output/reporter.js';
import { renderEnvList, renderMeteorStart, renderStartSh } from '../remote/app-files.js';
import { restoreConfigSnapshot, retagActivate, retagRevert, shArg, snapshotConfig } from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
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

/** Restores the config snapshot (and :previous when `revertImage`) and restarts the app. */
export async function revertServer(d: ActivateDeps, o: { revertImage: boolean }): Promise<boolean> {
  const name = d.config.app.name;
  const restoredConfig = await restoreConfigSnapshot(d.conn, name);
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
 */
export async function activateServer(d: ActivateDeps, o: { version: string | null; mode: 'deploy' | 'reconfig' | 'rollback' }): Promise<ActivationResult> {
  const started = Date.now();
  const { conn, config, serverName: server, reporter: r } = d;
  const app = config.app;
  const out = verboseOutput(r, server);
  const done = (x: Omit<ActivationResult, 'server' | 'durationMs'>): ActivationResult => ({ server, durationMs: Date.now() - started, ...x });

  let failure: { error: string; health?: HealthResult };
  try {
    r.server(server, o.mode === 'rollback' ? `rollback to ${o.version}` : 'activate', 'running');
    if (o.mode !== 'rollback') await snapshotConfig(conn, app.name);
    if (o.mode !== 'reconfig' && o.version) await retagActivate(conn, localImageRepo(config), o.version);
    if (o.mode !== 'rollback') {
      await conn.writeFile(`${appDir(config)}/config/start.sh`, await renderStartSh(config, server));
      await conn.writeFile(`${appDir(config)}/config/env.list`, await renderEnvList(config, d.settings, server, { cwd: d.cwd, basePath: d.basePath }), 0o600);
    }
    await conn.runScriptOrThrow(await renderMeteorStart(config), 'Starting the app', out);
    const health = await healthCheck(
      conn,
      {
        container: containerName(config),
        port: Number(app.deployCheckPort ?? app.docker.imagePort),
        path: config.cometDeploy.healthCheck.path,
        maxStatus: config.cometDeploy.healthCheck.maxStatus,
        timeoutSec: Number(app.deployCheckWaitTime ?? DEFAULT_WAIT_SEC),
      },
      out,
    );
    if (health.ok) {
      r.server(server, 'health', 'ok', describeHealth(health));
      return done({ status: 'healthy', health });
    }
    failure = { error: `Health check failed: ${describeHealth(health)}`, health };
  } catch (err) {
    failure = { error: (err as Error)?.message ?? String(err) };
  }

  r.server(server, 'health', 'failed', failure.error);
  const logs = await conn.exec(`sudo docker logs --tail ${LOG_TAIL_LINES} ${shArg(containerName(config))} 2>&1`).catch(() => null);
  const logsTail = logs?.stdout;
  try {
    const reverted = await revertServer(d, { revertImage: o.mode !== 'reconfig' });
    if (!reverted) return done({ status: 'failed', error: `${failure.error} (nothing to revert to)`, logsTail, health: failure.health });
    r.server(server, 'revert', 'reverted', o.mode === 'reconfig' ? 'previous config restored' : 'previous version restored');
    return done({ status: 'reverted', error: failure.error, logsTail, health: failure.health });
  } catch (err) {
    r.server(server, 'revert', 'failed', (err as Error).message);
    return done({ status: 'revert-failed', error: `${failure.error}; revert failed: ${(err as Error).message}`, logsTail, health: failure.health });
  }
}
