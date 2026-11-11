/**
 * `status`: one overview row per app server (Docker version, app container state, running
 * version, HTTP status of the health check path, lock holder). templates/comet/status.sh
 * collects all of it in one SSH round trip per server.
 */
import type { CommandContext } from '../../core/context.js';
import { appDir, containerName, localImageRepo } from '../../core/naming.js';
import { describeHolder } from '../../deploy/pipeline.js';
import { cometScript, parseVersions, type LockInfo } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';

/** One row of the `status` table. */
export interface StatusRow {
  /** Server name from the config. */
  server: string;
  /**
   * Docker server version, or `not-installed`, `not-running`, `unknown` (the script printed
   * no version) or `unreachable` (SSH failed).
   */
  docker: string;
  /** The app container; `missing` when there is none. */
  container: 'running' | 'stopped' | 'missing' | 'restarting';
  /**
   * The version tag `:latest` points to; null when `:latest` is not a comet-deploy version
   * (e.g. after `mup deploy`).
   */
  version: string | null;
  /** Who holds the deploy lock; null when the app is not locked. */
  lock: string | null;
  /** HTTP status of the health check path; null when the app does not run or nothing answered. */
  http: number | null;
}

// Docker's `.State.Status` values that are shown as they are; every other state (created,
// exited, paused, dead, …) is shown as `stopped`. status.sh prints `missing` itself.
const CONTAINER_STATES: Record<string, StatusRow['container']> = { running: 'running', restarting: 'restarting', missing: 'missing' };

/**
 * Parses the `key=value` output of templates/comet/status.sh.
 * Lines without `=` and unknown keys are ignored; a key that is missing keeps its default.
 */
export function parseStatus(stdout: string): Omit<StatusRow, 'server'> {
  const row: Omit<StatusRow, 'server'> = { docker: 'unknown', container: 'missing', version: null, lock: null, http: null };
  const images: string[] = [];
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'docker') row.docker = value || 'unknown';
    else if (key === 'container') row.container = CONTAINER_STATES[value] ?? 'stopped';
    else if (key === 'image') images.push(value);
    // curl prints 000 when nothing answered; only a real status code counts.
    else if (key === 'http') row.http = /^[1-9]\d{2}$/.test(value) ? Number(value) : null;
    else if (key === 'lock') {
      let holder: LockInfo | null = null;
      try {
        const v = JSON.parse(value);
        if (v && typeof v === 'object' && typeof v.user === 'string') holder = v as LockInfo;
      } catch {
        // info.json is missing (it is moved into the lock directory right after the mkdir)
        // or unreadable. The lock directory exists, so the lock is still held.
      }
      row.lock = holder ? describeHolder(holder) : 'held (owner unknown)';
    }
  }
  // The running version is the version tag with the same image ID as :latest.
  const v = parseVersions(images.join('\n'));
  row.version = v.versions.find((x) => x.id === v.latestId)?.tag ?? null;
  return row;
}

/** The `status` table: `SERVER  DOCKER  APP  VERSION  HTTP  LOCK`, columns padded to fit. */
export function formatStatusTable(rows: StatusRow[]): string {
  const header = ['SERVER', 'DOCKER', 'APP', 'VERSION', 'HTTP', 'LOCK'];
  const data = rows.map((r) => [r.server, r.docker, r.container, r.version ?? '-', r.http === null ? '-' : String(r.http), r.lock ?? '']);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmt = (cols: string[]) =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [fmt(header), ...data.map(fmt)].join('\n');
}

/**
 * Status of the app on every app server, in one SSH round trip per server.
 * All servers are queried in parallel. A server that cannot be reached gets a row with
 * `docker: 'unreachable'` and a warning; this function does not throw for it.
 */
export async function appStatus(ctx: CommandContext): Promise<StatusRow[]> {
  const c = ctx.config;
  const script = await cometScript('status.sh', {
    container: containerName(c),
    repo: localImageRepo(c),
    lockDir: `${appDir(c)}/config/deploy.lock`,
    // The same port as the health check after an activation (see src/deploy/activate.ts).
    port: Number(c.app.deployCheckPort ?? c.app.docker.imagePort),
    path: c.cometDeploy.healthCheck.path,
  });
  return Promise.all(
    ctx.appServers().map(async (s): Promise<StatusRow> => {
      try {
        // The exit code is not checked: whatever the script printed is parsed.
        const r = await (await ctx.ssh.get(s)).runScript(script);
        return { server: s, ...parseStatus(r.stdout) };
      } catch (err) {
        ctx.reporter.warn(`Could not read the status of "${s}": ${(err as Error).message}`);
        return { server: s, docker: 'unreachable', container: 'missing', version: null, lock: null, http: null };
      }
    }),
  );
}

/**
 * `meteor.status`. MUP's top-level `status` also runs `docker.status`, `mongo.status` and
 * `proxy.status`; comet-deploy covers Docker in the same table.
 */
async function status(ctx: CommandContext): Promise<void> {
  const rows = await ctx.runner.run('meteor.status', () => appStatus(ctx));
  ctx.reporter.info(formatStatusTable(rows));
}

const overview = (y: import('yargs').Argv) => y.option('overview', { type: 'boolean', describe: 'Accepted for MUP compatibility (the output is always an overview)' });

/** `status [--overview]`, under MUP's `default.status` key. */
export const statusCommand: ConfigCommand = {
  command: 'status',
  describe: 'Show Docker, the app container, the running version, HTTP and locks per server',
  builder: overview,
  run: (ctx) => ctx.runner.run('default.status', () => status(ctx)),
};

/** Hidden `meteor status`: the same table, without the `default.status` key. */
export const meteorStatusCommand: ConfigCommand = { command: 'status', describe: false, group: 'meteor', builder: overview, run: status };
