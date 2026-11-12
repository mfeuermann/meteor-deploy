/**
 * `mongo status`: MUP 1.5.11's "Mongo Status" block (container state, restarts, start time,
 * version, connections, storage engine) plus the featureCompatibilityVersion, which the next
 * MongoDB upgrade needs (mongo design §4.5). One SSH round trip (templates/comet/mongo-status.sh).
 */
import type { CommandContext } from '../core/context.js';
import { cometScript } from '../remote/ops.js';
import { mongoServers } from './render.js';

export interface MongoStatus {
  server: string;
  host: string;
  /** The `mongodb` container; `missing` when there is none or the server was unreachable. */
  state: 'running' | 'restarting' | 'stopped' | 'missing';
  restartCount: number | null;
  /** Docker's `Created` time of the container. */
  createdAt: string | null;
  version: string | null;
  connections: number | null;
  storageEngine: string | null;
  fcv: string | null;
  /** Why the status could not be read (SSH failed). */
  error?: string;
}

/** Decodes a base64 JSON value; null when it is empty or not JSON. */
function json(b64: string | undefined): Record<string, any> | null {
  if (!b64) return null;
  try {
    const v = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parses the output of mongo-status.sh; anything missing or unreadable is null. */
export function parseMongoStatus(server: string, host: string, stdout: string): MongoStatus {
  const kv = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const inspect = json(kv.get('inspect'));
  const ss = json(kv.get('server_status'));
  const st = inspect?.State ?? {};
  return {
    server,
    host,
    state: !inspect ? 'missing' : st.Restarting === true ? 'restarting' : st.Running === true ? 'running' : 'stopped',
    restartCount: num(inspect?.RestartCount),
    createdAt: str(inspect?.Created),
    version: str(ss?.version),
    connections: num(ss?.connections?.current),
    storageEngine: str(ss?.storageEngine?.name),
    fcv: str(kv.get('fcv')),
  };
}

/** The block `status` and `mongo status` print. `overview` keeps only the state line. */
export function formatMongoStatus(s: MongoStatus, overview: boolean): string {
  const lines = ['', '=> MongoDB status'];
  if (s.error) {
    lines.push(` - Could not read the status of server ${s.host}: ${s.error}`);
  } else if (s.state === 'missing' || s.state === 'stopped') {
    lines.push(` - Stopped on server ${s.host}`);
  } else {
    lines.push(` - ${s.state} on server ${s.host}`);
    if (!overview) {
      const known: Array<[unknown, string]> = [
        [s.restartCount, `Restarted ${s.restartCount} times`],
        [s.createdAt, `Running since ${s.createdAt}`],
        [s.version, `Version ${s.version}`],
        [s.connections, `Connections: ${s.connections}`],
        [s.storageEngine, `Storage Engine: ${s.storageEngine}`],
        [s.fcv, `Feature compatibility: ${s.fcv}`],
      ];
      for (const [value, line] of known) if (value !== null) lines.push(` - ${line}`);
    }
  }
  return lines.join('\n');
}

/**
 * `mongo.status` (also MUP's `post.default.status`): the status of MongoDB on the first mongo
 * server, as in MUP. Nothing is printed without a mongo section or when `--servers` leaves
 * that server out. An unreachable server is printed, not thrown.
 */
export async function showMongoStatus(ctx: CommandContext, overview = false): Promise<void> {
  await ctx.runner.run('mongo.status', async () => {
    const c = ctx.config;
    if (!c.mongo) return;
    const first = Object.keys(c.mongo.servers ?? {})[0];
    if (!first || !mongoServers(c, ctx.serverFilter).includes(first)) return;
    const host = String(c.servers[first]?.host ?? first);
    let s: MongoStatus;
    try {
      // The exit code is not checked: whatever the script printed is parsed.
      const r = await (await ctx.ssh.get(first)).runScript(await cometScript('mongo-status.sh', {}));
      s = parseMongoStatus(first, host, r.stdout);
    } catch (err) {
      s = { ...parseMongoStatus(first, host, ''), error: (err as Error).message };
    }
    ctx.reporter.info(formatMongoStatus(s, overview));
  });
}
