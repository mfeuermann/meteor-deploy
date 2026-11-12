/**
 * Zero-downtime switch behind the MUP proxy without load balancing (proxy spec §4.3).
 *
 * MUP's start.sh removes the app container and then starts the new one, so nginx has nothing to
 * route to in between. Behind the proxy the app publishes no host port (`--expose`), so a second
 * container can run beside it: comet-deploy starts `<app>-next` from the same start.sh (minus
 * the removal, under another name), waits for its health check and for nginx (docker-gen) to
 * route to it, then makes nginx route only to `<app>-next` (an upstream file per domain, see
 * zd-finish.sh), and only then stops the old container (10 s for in-flight requests) and renames
 * `<app>-next` to `<app>`. On a failure `<app>-next` is removed and the old container never
 * stopped. Known compromise: nginx sends requests to `<app>-next` from its start, also while it
 * is not healthy yet (docker-gen lists every running container with the app's VIRTUAL_HOST).
 */
import type { NormalizedConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { appDir, containerName, localImageRepo } from '../core/naming.js';
import type { Reporter } from '../output/reporter.js';
import { PROXY_NAME, proxyDomains } from '../proxy/render.js';
import { cometScript, shArg } from '../remote/ops.js';
import type { ExecOptions, SshConnection } from '../ssh/connection.js';
import { appHealthOptions, healthCheck, type HealthResult } from './health-check.js';

/** How an activation replaces the running container. */
export type SwitchMode = { kind: 'zero-downtime' } | { kind: 'restart' };

/** How long nginx gets to route to `<app>-next` after its health check passed. */
export const NGINX_PICKUP_TIMEOUT_MS = 15_000;
const PICKUP_POLL_MS = 500;
const LOG_TAIL_LINES = 100;

/** The `docker.args` as one string, for the checks below. */
const argsText = (c: NormalizedConfig) => ((c.app.docker.args as unknown[] | undefined) ?? []).map(String).join(' ');

/**
 * Why the zero-downtime switch cannot be used for this config (one line), or null when it can.
 * It needs the proxy without active load balancing (load-balanced servers are drained instead,
 * §4.4), and a container that can run twice at once: no published host port, no host network,
 * no fixed `--name`. `o.loadBalancingActive: false` is a load-balanced config whose upstream
 * does not exist on the proxies yet (load balancing is being enabled): nginx still routes to
 * the containers, and the running one does not publish the port yet.
 */
export function zeroDowntimeBlocker(c: NormalizedConfig, o: { loadBalancingActive?: boolean } = {}): string | null {
  if (!c.proxy) return 'the app is not behind the proxy (no "proxy" section)';
  if (c.proxy.loadBalancing && o.loadBalancingActive !== false) return 'proxy.loadBalancing is on: the app publishes a host port, which two containers cannot share';
  if (c.cometDeploy.zeroDowntime === false) return 'cometDeploy.zeroDowntime is false';
  if (c.app.ssl) return 'app.ssl starts its own frontend container, which cannot run twice';
  const args = argsText(c);
  if (/(^|\s)(-p\S*|-P|--publish|--publish-all)(=|\s|$)/.test(args)) return 'docker.args publishes a host port, which two containers cannot share';
  if (/(^|\s)--net(work)?(=|\s+)host(\s|$)/.test(args)) return 'docker.args uses the host network, where two containers cannot listen on one port';
  if (/(^|\s)--name(=|\s|$)/.test(args)) return 'docker.args sets --name, which two containers cannot share';
  if (((c.app.docker.networks as unknown[] | undefined) ?? []).map(String).includes('host')) return 'docker.networks includes the host network';
  return null;
}

const REMOVE_START = '# Remove previous version of the app, if exists';
const REMOVE_END = '>&2 echo "Finished removing docker containers"';
const NAME_RE = /--name=\$APPNAME(?=[\s\\])/g;

/**
 * The script that starts `$APPNAME-next` from the server's `config/start.sh` (MUP 1.5.11's
 * template): without the block that removes the running container, with
 * `--name=$APPNAME-next`, and with every `docker network connect <net> $APPNAME` aimed at
 * `$APPNAME-next`. Everything else (env, volumes, log options, hostname) stays as it is.
 *
 * @throws CometError when start.sh does not have MUP's form (an anchor is missing).
 */
export function nextContainerScript(startSh: string): string {
  const i = startSh.indexOf(REMOVE_START);
  const j = i < 0 ? -1 : startSh.indexOf(REMOVE_END, i);
  const names = startSh.match(NAME_RE)?.length ?? 0;
  if (i < 0 || j < 0 || names !== 1) {
    const missing = i < 0 ? `"${REMOVE_START}"` : j < 0 ? `'${REMOVE_END}'` : `exactly one "--name=$APPNAME" (found ${names})`;
    throw new CometError(`config/start.sh has an unknown form (no ${missing}), so the zero-downtime switch cannot start a second container from it.`, {
      hint: 'Deploy once with "cometDeploy: { zeroDowntime: false }" to write MUP\'s start.sh, or check what changed config/start.sh on the server.',
    });
  }
  let end = j + REMOVE_END.length;
  if (startSh[end] === '\n') end++;
  return (startSh.slice(0, i) + startSh.slice(end))
    .replace(NAME_RE, '--name=$APPNAME-next')
    .replace(/^(\s*sudo docker network connect \S+) \$APPNAME$/gm, '$1 $APPNAME-next');
}

/** The result of `switchContainer`; `logsTail` holds the logs of `<app>-next` when it failed. */
export interface SwitchResult {
  health: HealthResult;
  switched: boolean;
  error?: string;
  logsTail?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether container `name` is running. */
export async function containerRunning(conn: SshConnection, name: string): Promise<boolean> {
  const r = await conn.exec(`sudo docker inspect -f '{{.State.Running}}' ${shArg(name)} 2>/dev/null`);
  return r.stdout.trim() === 'true';
}

/**
 * Waits until the nginx config generated by docker-gen routes to one of `next`'s IPs on `port`
 * (at least one check, then until `timeoutMs`) and returns that `<ip>:<port>`, or null. The IPs
 * come from `.NetworkSettings.Networks`, because Docker 29 no longer fills the deprecated
 * `.NetworkSettings.IPAddress`.
 */
async function waitForNginx(conn: SshConnection, next: string, port: number, timeoutMs: number): Promise<string | null> {
  const ips = (await conn.exec(`sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${shArg(next)}`)).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ips.length === 0) return null;
  const routes = ips.map((ip) => ({ route: `${ip}:${port}`, re: new RegExp(`(^|[^\\d.])${ip.replace(/\./g, '\\.')}:${port}(?!\\d)`, 'm') }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conf = (await conn.exec(`sudo docker exec ${PROXY_NAME} cat /etc/nginx/conf.d/default.conf`)).stdout;
    const found = routes.find((r) => r.re.test(conf));
    if (found) return found.route;
    if (Date.now() >= deadline) return null;
    await sleep(PICKUP_POLL_MS);
  }
}

/**
 * Replaces the app container on one server without a gap (see the module comment). Never
 * throws for a failed switch: the result says what happened, and on failure `<app>-next` is
 * gone again (its logs are in `logsTail`) and the old container still runs, untouched.
 */
export async function switchContainer(
  d: { conn: SshConnection; config: NormalizedConfig; serverName: string; reporter: Reporter },
  out: ExecOptions,
  o: { pickupTimeoutMs?: number } = {},
): Promise<SwitchResult> {
  const { conn, config: c } = d;
  const name = containerName(c);
  const next = `${name}-next`;
  const removeNext = () => conn.exec(`sudo docker rm -f ${shArg(next)} > /dev/null 2>&1 || true`, out);
  const failed = async (health: HealthResult, error: string): Promise<SwitchResult> => {
    const logs = await conn.exec(`sudo docker logs --tail ${LOG_TAIL_LINES} ${shArg(next)} 2>&1`).catch(() => null);
    await removeNext().catch(() => undefined);
    return { health, switched: false, error, logsTail: logs?.stdout };
  };
  let health: HealthResult = { ok: false, reason: 'crashed', seconds: 0 };
  try {
    // A leftover of an earlier run that was interrupted.
    await removeNext();
    const startSh = await conn.exec(`sudo cat ${shArg(`${appDir(c)}/config/start.sh`)}`);
    if (startSh.code !== 0) throw new CometError(`Cannot read ${appDir(c)}/config/start.sh: ${startSh.stderr.trim()}`);
    const script64 = Buffer.from(nextContainerScript(startSh.stdout), 'utf8').toString('base64');
    await conn.runScriptOrThrow(await cometScript('zd-start.sh', { appDir: appDir(c), image: localImageRepo(c), script64 }), 'Starting the new container', out);
    health = await healthCheck(conn, { ...appHealthOptions(c), container: next }, out);
    if (!health.ok) return await failed(health, '');
    const timeoutMs = o.pickupTimeoutMs ?? NGINX_PICKUP_TIMEOUT_MS;
    const route = await waitForNginx(conn, next, Number(c.app.docker.imagePort ?? 3000), timeoutMs);
    if (!route) return await failed(health, `nginx did not route to the new container within ${Math.round(timeoutMs / 1000)}s`);
    const finish = await cometScript('zd-finish.sh', { name, next, proxyName: PROXY_NAME, domains: proxyDomains(c), route });
    await conn.runScriptOrThrow(finish, 'Replacing the old container', out);
    return { health, switched: true };
  } catch (err) {
    return failed(health, (err as Error)?.message ?? String(err));
  }
}
