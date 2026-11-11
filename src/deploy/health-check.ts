/**
 * The health check after a start: `health-check.sh` runs on the server and polls the container
 * over HTTP until it answers with an allowed status, crashes or runs out of time (MUP's deploy
 * check, plus a status limit and crash detection). Its last output line is the machine-readable
 * result parsed here.
 */
import { CometError } from '../core/errors.js';
import { shq } from '../remote/ops.js';
import { renderTemplate } from '../remote/render.js';
import type { ExecOptions, SshConnection } from '../ssh/connection.js';

/**
 * Outcome of one health check. `seconds` is how long it took. On failure, `reason` is
 * `timeout` (no allowed answer in time), `crashed` (the container exited, is restarting or is
 * gone) or `no-ip` (the container never got an IP address); `lastStatus` is the last HTTP status
 * seen, if any.
 */
export type HealthResult =
  | { ok: true; status: number; seconds: number }
  | { ok: false; reason: 'timeout' | 'crashed' | 'no-ip'; lastStatus?: number; seconds: number };

/**
 * The result line: `COMET_HEALTH ok <status> <seconds>` or
 * `COMET_HEALTH fail <reason> <lastStatus|-> <seconds>`.
 */
const RESULT_RE = /^COMET_HEALTH (ok (\d+) (\d+)|fail (timeout|crashed|no-ip) (\d+|-) (\d+))\s*$/;

/**
 * Parses the script's output. The last result line wins: the script may print other lines first
 * (e.g. the container state). Throws `CometError` when there is none, i.e. the script died
 * before it could report.
 */
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
  /** Container name. Its IP is looked up on every attempt (localhost with host networking). */
  container: string;
  /** Port inside the container. */
  port: number;
  /** URL path, starting with "/". */
  path: string;
  /** Highest HTTP status that counts as healthy. */
  maxStatus: number;
  /** How long to wait for a healthy answer. */
  timeoutSec: number;
}

const isInt = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

/**
 * Renders `health-check.sh`. The numbers are inserted into the script unquoted, so they are
 * validated here and anything else is refused with a `CometError` (it would otherwise reach the
 * shell). The path is shell-quoted, but must start with "/" to form a URL after the port.
 */
export async function healthCheckScript(o: HealthCheckOptions): Promise<string> {
  if (!isInt(o.port, 1, 65535)) throw new CometError(`Invalid health check port ${o.port}.`);
  if (!isInt(o.maxStatus, 100, 599)) throw new CometError(`Invalid healthCheck.maxStatus ${o.maxStatus}.`);
  if (!isInt(o.timeoutSec, 1, 86400)) throw new CometError(`Invalid deployCheckWaitTime ${o.timeoutSec}.`);
  if (!o.path.startsWith('/')) throw new CometError(`healthCheck.path must start with "/" (got "${o.path}").`);
  return renderTemplate('comet/health-check.sh', { q: shq, ...o });
}

/**
 * Runs the health check on the server and returns its result. An unhealthy app is a result, not
 * an error; it throws only when the script cannot run or reports nothing. The exit code is not
 * checked, because the script exits 0 after printing its result.
 */
export async function healthCheck(conn: SshConnection, o: HealthCheckOptions, exec: ExecOptions = {}): Promise<HealthResult> {
  const r = await conn.runScript(await healthCheckScript(o), exec);
  return parseHealthResult(r.stdout);
}
