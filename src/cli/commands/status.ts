/**
 * `status`: one overview row per app server (Docker version, app container state, running
 * version, HTTP status of the health check path, lock holder), then, without `--overview`, the
 * full report of src/output/status-report.ts (commands design §4.4). templates/comet/status.sh
 * collects all of it in one SSH round trip per server.
 */
import type { CommandContext } from '../../core/context.js';
import { appDir, containerName, localImageRepo } from '../../core/naming.js';
import { describeHolder } from '../../deploy/pipeline.js';
import { showMongoStatus } from '../../mongo/status.js';
import { containerWarnings, dockerVersionWarning, formatStatusReport } from '../../output/status-report.js';
import { formatTable } from '../../output/table.js';
import { formatProxyStatus, proxyStatus } from '../../proxy/setup.js';
import { checkUrlsFromHere } from '../../remote/http-check.js';
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
  /** The facts of the full report; missing for a server that could not be reached. */
  details?: ServerDetails;
  /** Why the server could not be reached (`docker: 'unreachable'`). */
  error?: string;
}

/** What the full `status` report shows beyond the table (status.sh's detail keys). */
export interface ServerDetails {
  /** `PRETTY_NAME` of /etc/os-release, else `uname -s`. */
  os: string | null;
  /** `uname -m`. */
  arch: string | null;
  /** Docker's data directory (`DockerRootDir`). */
  dockerRoot: string | null;
  /** Free space in `dockerRoot`, in KiB (`df -Pk`). */
  dockerFreeKb: number | null;
  /** `.State.StartedAt` of the app container, as Docker prints it. */
  startedAt: string | null;
  restarts: number | null;
  network: 'host' | 'bridge' | null;
  /** Published ports, `<HostIp>:<HostPort> -> <port>/<proto>`. */
  ports: string[];
  /** Names of the container's env variables, in the container's order; never values. */
  envNames: string[];
  /** The version tag `:previous` points to, if it is a comet-deploy version. */
  previousVersion: string | null;
  /** The URL status.sh checked on the server. */
  httpUrl: string | null;
  /** `:latest` exists but is no comet-deploy version (MUP deployed it). */
  foreignVersion: boolean;
}

/** A variable name; anything else on an `envname=` line is dropped. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/**
 * Parses the detail keys of templates/comet/status.sh for the full report; the keys of
 * parseStatus are read again only for the versions. Unknown keys are ignored.
 */
export function parseStatusDetails(stdout: string): ServerDetails {
  const d: ServerDetails = {
    os: null,
    arch: null,
    dockerRoot: null,
    dockerFreeKb: null,
    startedAt: null,
    restarts: null,
    network: null,
    ports: [],
    envNames: [],
    previousVersion: null,
    httpUrl: null,
    foreignVersion: false,
  };
  const images: string[] = [];
  const int = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'os') d.os = value || null;
    else if (key === 'arch') d.arch = value || null;
    else if (key === 'dockerroot') d.dockerRoot = value || null;
    else if (key === 'dockerfree') d.dockerFreeKb = int(value);
    else if (key === 'started') d.startedAt = value || null;
    else if (key === 'restarts') d.restarts = int(value);
    else if (key === 'network') d.network = value === 'host' || value === 'bridge' ? value : null;
    else if (key === 'port' && value) d.ports.push(value);
    else if (key === 'envname' && ENV_NAME_RE.test(value)) d.envNames.push(value);
    else if (key === 'httpurl') d.httpUrl = value || null;
    else if (key === 'image') images.push(value);
  }
  const v = parseVersions(images.join('\n'));
  d.previousVersion = v.versions.find((x) => x.id === v.previousId)?.tag ?? null;
  d.foreignVersion = v.latestId !== null && !v.versions.some((x) => x.id === v.latestId);
  return d;
}

/** The `status` table: `SERVER  DOCKER  APP  VERSION  HTTP  LOCK`, columns padded to fit. */
export function formatStatusTable(rows: StatusRow[]): string {
  const header = ['SERVER', 'DOCKER', 'APP', 'VERSION', 'HTTP', 'LOCK'];
  const data = rows.map((r) => [r.server, r.docker, r.container, r.version ?? '-', r.http === null ? '-' : String(r.http), r.lock ?? '']);
  return formatTable(header, data);
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
        return { server: s, ...parseStatus(r.stdout), details: parseStatusDetails(r.stdout) };
      } catch (err) {
        ctx.reporter.warn(`Could not read the status of "${s}": ${(err as Error).message}`);
        return { server: s, docker: 'unreachable', container: 'missing', version: null, lock: null, http: null, error: (err as Error).message };
      }
    }),
  );
}

/**
 * The URL `status` checks from this computer for a server: its effective ROOT_URL (the
 * server's own env first) with the health check path; null without a ROOT_URL.
 */
export function localCheckUrl(c: CommandContext['config'], server: string): string | null {
  const root = c.app.servers[server]?.env?.ROOT_URL ?? c.app.env.ROOT_URL;
  if (root === undefined || root === null || root === '') return null;
  const path = c.cometDeploy.healthCheck.path;
  return String(root).replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * `meteor.status`: the table, and without `overview` the Docker version warning, the full
 * report and the container warnings. The checks from this computer run while the servers
 * answer. MUP's top-level `status` also runs `docker.status`, `mongo.status` and
 * `proxy.status`; comet-deploy covers Docker in the same table.
 */
async function status(ctx: CommandContext, overviewOnly: boolean): Promise<void> {
  await ctx.runner.run('meteor.status', async () => {
    const c = ctx.config;
    const servers = ctx.appServers();
    const urls = servers.map((s) => localCheckUrl(c, s)).filter((u): u is string => u !== null);
    const fromHere = overviewOnly ? null : checkUrlsFromHere(urls, ctx.checkUrl);
    const rows = await appStatus(ctx);
    ctx.reporter.info(formatStatusTable(rows));
    if (!fromHere) return;
    const versions = dockerVersionWarning(rows);
    if (versions) ctx.reporter.warn(versions);
    const report = formatStatusReport(rows, {
      hostOf: (s) => String(c.servers[s]?.host ?? s),
      localUrlOf: (s) => localCheckUrl(c, s),
      fromHere: await fromHere,
      behindProxy: !!c.proxy,
      now: new Date(),
    });
    ctx.reporter.info(`\n${report}`);
    for (const w of containerWarnings(rows)) ctx.reporter.warn(w);
  });
}

export const overview = (y: import('yargs').Argv) =>
  y.option('overview', { type: 'boolean', describe: 'Shorter output: the tables without the full report, one line for MongoDB' });

/** `proxy.status`: the shared proxy's status block (also MUP's `post.default.status`). */
export async function showProxyStatus(ctx: CommandContext): Promise<void> {
  const rows = await ctx.runner.run('proxy.status', () => proxyStatus(ctx));
  ctx.reporter.info(formatProxyStatus(rows));
}

/** `status [--overview]`, under MUP's `default.status` key. */
export const statusCommand: ConfigCommand = {
  command: 'status',
  describe: 'Show the servers, the app container, its version, ports, env names, HTTP and locks',
  builder: overview,
  run: (ctx, argv) =>
    ctx.runner.run('default.status', async () => {
      // MUP's `post.default.status` runs `docker.status` first. comet-deploy shows Docker in the
      // app table, so the step is empty and only keeps the place of its hooks.
      await ctx.runner.run('docker.status', async () => {});
      await status(ctx, argv.overview === true);
      if (ctx.config.mongo) await showMongoStatus(ctx, argv.overview === true);
      if (ctx.config.proxy) await showProxyStatus(ctx);
    }),
};

/** `meteor status`: the same table and report, without the `default.status` key. */
export const meteorStatusCommand: ConfigCommand = {
  command: 'status',
  describe: 'Show the app status on the servers',
  group: 'meteor',
  builder: overview,
  run: (ctx, argv) => status(ctx, argv.overview === true),
};
