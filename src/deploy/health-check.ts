import { CometError } from '../core/errors.js';
import { shq } from '../remote/ops.js';
import { renderTemplate } from '../remote/render.js';
import type { ExecOptions, SshConnection } from '../ssh/connection.js';

export type HealthResult =
  | { ok: true; status: number; seconds: number }
  | { ok: false; reason: 'timeout' | 'crashed' | 'no-ip'; lastStatus?: number; seconds: number };

const RESULT_RE = /^COMET_HEALTH (ok (\d+) (\d+)|fail (timeout|crashed|no-ip) (\d+|-) (\d+))\s*$/;

export function parseHealthResult(stdout: string): HealthResult {
  const lines = stdout.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = RESULT_RE.exec(lines[i].trim());
    if (!m) continue;
    if (m[2]) return { ok: true, status: Number(m[2]), seconds: Number(m[3]) };
    const r: HealthResult = { ok: false, reason: m[4] as 'timeout' | 'crashed' | 'no-ip', seconds: Number(m[6]) };
    if (m[5] !== '-') r.lastStatus = Number(m[5]);
    return r;
  }
  throw new CometError(`The health check printed no result:\n${stdout.slice(-2000)}`);
}

export interface HealthCheckOptions {
  container: string;
  port: number;
  path: string;
  maxStatus: number;
  timeoutSec: number;
}

const isInt = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

export async function healthCheckScript(o: HealthCheckOptions): Promise<string> {
  if (!isInt(o.port, 1, 65535)) throw new CometError(`Invalid health check port ${o.port}.`);
  if (!isInt(o.maxStatus, 100, 599)) throw new CometError(`Invalid healthCheck.maxStatus ${o.maxStatus}.`);
  if (!isInt(o.timeoutSec, 1, 86400)) throw new CometError(`Invalid deployCheckWaitTime ${o.timeoutSec}.`);
  if (!o.path.startsWith('/')) throw new CometError(`healthCheck.path must start with "/" (got "${o.path}").`);
  return renderTemplate('comet/health-check.sh', { q: shq, ...o });
}

export async function healthCheck(conn: SshConnection, o: HealthCheckOptions, exec: ExecOptions = {}): Promise<HealthResult> {
  const r = await conn.runScript(await healthCheckScript(o), exec);
  return parseHealthResult(r.stdout);
}
