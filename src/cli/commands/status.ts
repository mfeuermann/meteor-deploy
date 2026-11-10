import type { CommandContext } from '../../core/context.js';
import { appDir, containerName, localImageRepo } from '../../core/naming.js';
import { describeHolder } from '../../deploy/pipeline.js';
import { cometScript, parseVersions, type LockInfo } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';

export interface StatusRow {
  server: string;
  docker: string;
  container: 'running' | 'stopped' | 'missing' | 'restarting';
  version: string | null;
  lock: string | null;
  http: number | null;
}

const CONTAINER_STATES: Record<string, StatusRow['container']> = { running: 'running', restarting: 'restarting', missing: 'missing' };

/** Parses the `key=value` output of templates/comet/status.sh. */
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
    else if (key === 'http') row.http = /^[1-9]\d{2}$/.test(value) ? Number(value) : null;
    else if (key === 'lock') {
      let holder: LockInfo | null = null;
      try {
        const v = JSON.parse(value);
        if (v && typeof v === 'object' && typeof v.user === 'string') holder = v as LockInfo;
      } catch {
        // unreadable info.json: still locked
      }
      row.lock = holder ? describeHolder(holder) : 'held (owner unknown)';
    }
  }
  const v = parseVersions(images.join('\n'));
  row.version = v.versions.find((x) => x.id === v.latestId)?.tag ?? null;
  return row;
}

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

/** Status of the app on every app server, in one SSH round trip per server. */
export async function appStatus(ctx: CommandContext): Promise<StatusRow[]> {
  const c = ctx.config;
  const script = await cometScript('status.sh', {
    container: containerName(c),
    repo: localImageRepo(c),
    lockDir: `${appDir(c)}/config/deploy.lock`,
    port: Number(c.app.deployCheckPort ?? c.app.docker.imagePort),
    path: c.cometDeploy.healthCheck.path,
  });
  return Promise.all(
    ctx.appServers().map(async (s): Promise<StatusRow> => {
      try {
        const r = await (await ctx.ssh.get(s)).runScript(script);
        return { server: s, ...parseStatus(r.stdout) };
      } catch (err) {
        ctx.reporter.warn(`Could not read the status of "${s}": ${(err as Error).message}`);
        return { server: s, docker: 'unreachable', container: 'missing', version: null, lock: null, http: null };
      }
    }),
  );
}

async function status(ctx: CommandContext): Promise<void> {
  const rows = await ctx.runner.run('meteor.status', () => appStatus(ctx));
  ctx.reporter.info(formatStatusTable(rows));
}

const overview = (y: import('yargs').Argv) => y.option('overview', { type: 'boolean', describe: 'Accepted for MUP compatibility (the output is always an overview)' });

export const statusCommand: ConfigCommand = {
  command: 'status',
  describe: 'Show Docker, the app container, the running version, HTTP and locks per server',
  builder: overview,
  run: (ctx) => ctx.runner.run('default.status', () => status(ctx)),
};

export const meteorStatusCommand: ConfigCommand = { command: 'status', describe: false, group: 'meteor', builder: overview, run: status };
