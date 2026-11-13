/**
 * The `registry` transfer, for configs with MUP's `privateDockerRegistry`: the image is pushed
 * from this computer to the registry and every server pulls it. The registry is only the way
 * the image travels: a server keeps it as `mup-<app>:<version>` like after the tunnel or the
 * stream, and start.sh never pulls (registry design §4.1), so canary, revert and rollback work
 * server by server without the registry.
 */
import type { NormalizedConfig, RegistryConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { run as runLocal } from '../local/exec.js';
import { lineSplitter } from '../output/lines.js';
import { shq } from '../remote/ops.js';
import { formatFailureOutput, type SshConnection } from '../ssh/connection.js';
import { serverHasImage } from './stream.js';

/** Whether the config sends the image through `privateDockerRegistry` (validation keeps `transfer` in line). */
export function usesRegistry(c: NormalizedConfig): boolean {
  return !!c.privateDockerRegistry;
}

/**
 * The registry for MUP's docker-setup.sh (`setup`, `docker setup`), which runs `docker login`
 * on the servers: only with both credentials. Without them MUP's template would log in with
 * empty values and fail under `set -e`; the servers then log in by themselves (spec §4.1).
 */
export function setupRegistry(c: NormalizedConfig): RegistryConfig | undefined {
  const reg = c.privateDockerRegistry;
  return reg?.username && reg.password ? reg : undefined;
}

/** The image repository in the registry: `<imagePrefix>/mup-<lowercase app name>`, as in MUP. */
export function registryRepo(c: NormalizedConfig): string {
  return `${c.privateDockerRegistry?.imagePrefix}/mup-${c.app.name.toLowerCase()}`;
}

const DOCKER_HUB = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/**
 * The registry `privateDockerRegistry.host` names, as Docker writes it in an image name:
 * lowercased, without scheme and path (`https://index.docker.io/v1/` → `docker.io`).
 */
export function registryOfHost(host: string): string {
  const h = host
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  return DOCKER_HUB.has(h) ? 'docker.io' : h;
}

/**
 * The registry an image name starting with `prefix` is pushed to, by Docker's rule: the first
 * part when it contains `.` or `:` or is `localhost`, otherwise Docker Hub.
 */
export function registryOfPrefix(prefix: string): string {
  const first = prefix.split('/')[0].toLowerCase();
  const isHost = first.includes('.') || first.includes(':') || first === 'localhost';
  return isHost && !DOCKER_HUB.has(first) ? first : 'docker.io';
}

/**
 * Refuses a registry config that would push somewhere else than the registry in `host`: a
 * missing `imagePrefix` (the image would go to Docker Hub as `mup-<app>`) or a prefix of
 * another registry. The image holds the app's bundle, so a wrong target could publish it.
 * Only the commands that push call this; nothing to check without a registry.
 *
 * @throws CometError
 */
export function assertRegistryPushable(c: NormalizedConfig): void {
  const reg = c.privateDockerRegistry;
  if (!reg) return;
  const prefix = reg.imagePrefix;
  if (!prefix) {
    throw new CometError('privateDockerRegistry.imagePrefix is required: it is where comet-deploy pushes the image, for example "registry.example.com/myteam".');
  }
  const target = registryOfPrefix(prefix);
  const expected = registryOfHost(reg.host);
  if (target !== expected) {
    throw new CometError(
      `privateDockerRegistry.imagePrefix "${prefix}" would push to ${target}, not to the registry "${expected}" in privateDockerRegistry.host. ` +
        `Start it with the registry host, for example "${expected}/${prefix}".`,
    );
  }
}

/** Whether docker's output says the registry refused the credentials (or got none). */
export function isAuthError(output: string): boolean {
  return /denied|unauthorized|authentication required|no basic auth credentials/i.test(output);
}

const hasCredentials = (reg: RegistryConfig) => !!(reg.username && reg.password);

/** `text` with the registry password replaced, so no error ever shows it (docker may echo it). */
function withoutPassword(text: string, reg: RegistryConfig): string {
  return reg.password ? text.split(reg.password).join('***') : text;
}

/**
 * Logs the local Docker in to the registry with the config's credentials, the password on
 * stdin (never in the arguments). Docker keeps the login (`~/.docker/config.json` or the
 * system's credential store), replacing an earlier login to the same host. Without both
 * credentials nothing runs: the local Docker uses the login it has (e.g. from CI).
 *
 * @returns Whether it logged in.
 * @throws CometError `Logging in to the registry "<host>" failed: <stderr>`.
 */
export async function registryLogin(reg: RegistryConfig, o: { run?: typeof runLocal } = {}): Promise<boolean> {
  if (!hasCredentials(reg)) return false;
  const r = await (o.run ?? runLocal)('docker', ['login', '--username', reg.username!, '--password-stdin', reg.host], { input: reg.password });
  if (r.code !== 0) {
    throw new CometError(`Logging in to the registry "${reg.host}" failed: ${withoutPassword(r.stderr.trim() || r.stdout.trim(), reg)}`, {
      hint: 'Check privateDockerRegistry.username and password. Nothing was built or pushed, and no server was changed.',
    });
  }
  return true;
}

/**
 * Pushes the local image `localTag` to the registry as `ref`: `docker tag`, `docker push`, and
 * the helper tag `ref` is removed again in every case (only the tag; the image keeps its local
 * version tag), so no local tag outlives the push.
 *
 * @param o.onLine Each line of `docker push` (for `--verbose`).
 * @throws CometError `Pushing <ref> to the registry failed: <stderr>`, with a hint for refused
 *   credentials or an unreachable registry.
 */
export async function pushImage(o: {
  localTag: string;
  ref: string;
  reg: RegistryConfig;
  run?: typeof runLocal;
  onLine?: (line: string) => void;
}): Promise<{ durationMs: number }> {
  const run = o.run ?? runLocal;
  const start = Date.now();
  const failed = (output: string) => {
    const why = withoutPassword(output.trim(), o.reg);
    const hint = isAuthError(output)
      ? `Check that the registry account may push to "${o.reg.imagePrefix}".${hasCredentials(o.reg) ? '' : ` Or log in first with "docker login ${o.reg.host}".`}`
      : `Check that this computer can reach the registry "${o.reg.host}".`;
    return new CometError(`Pushing ${o.ref} to the registry failed: ${why}`, { hint: `${hint} No server was changed.` });
  };
  const tag = await run('docker', ['tag', o.localTag, o.ref]);
  if (tag.code !== 0) throw failed(tag.stderr || tag.stdout);
  try {
    const push = await run('docker', ['push', o.ref], { onLine: (l) => o.onLine?.(l) });
    if (push.code !== 0) throw failed(push.stderr || push.stdout);
  } finally {
    await run('docker', ['rmi', o.ref]);
  }
  return { durationMs: Date.now() - start };
}

/**
 * Pulls `ref` from the registry on the server and keeps it as `targetTag` only: `docker pull`,
 * `docker tag` to the target, the pulled tag removed, then a check that the target exists. The
 * server needs a login to the registry (`docker setup`) unless the registry allows anonymous
 * pulls. The running app is not touched.
 *
 * @param o.onStatus Each non-empty output line of `docker pull` (for `--verbose`).
 * @throws CometError `[<server>] Pulling <ref> failed …`, with the login hint on refused credentials.
 */
export async function pullFromRegistry(
  conn: SshConnection,
  o: { ref: string; targetTag: string; reg: RegistryConfig; onStatus?: (line: string) => void },
): Promise<{ durationMs: number }> {
  const start = Date.now();
  const failed = (why: string) => new CometError(`[${conn.name}] Pulling ${o.ref} failed${why}`);
  const lines = o.onStatus
    ? lineSplitter((l) => {
        const line = l.trim();
        if (line) o.onStatus!(line);
      })
    : undefined;
  const pull = await conn.exec(`sudo docker pull ${shq(o.ref)}`, { onStdout: lines?.push, onClose: lines?.flush });
  if (pull.code !== 0) {
    const output = `${pull.stdout}\n${pull.stderr}`;
    const login = hasCredentials(o.reg)
      ? 'The server is not logged in to the registry: run "comet-deploy docker setup", which runs docker login on the servers.'
      : `The server is not logged in to the registry: run "sudo docker login ${o.reg.host}" on the server, or set privateDockerRegistry.username and password and run "comet-deploy docker setup".`;
    throw failed(` (exit code ${pull.code}):\n${withoutPassword(formatFailureOutput(pull), o.reg)}${isAuthError(output) ? `\n${login}` : ''}`);
  }
  const tag = await conn.exec(`sudo docker tag ${shq(o.ref)} ${shq(o.targetTag)} && sudo docker rmi ${shq(o.ref)}`);
  if (tag.code !== 0) throw failed(`: tagging ${o.targetTag} failed (exit code ${tag.code}):\n${formatFailureOutput(tag)}`);
  if (!(await serverHasImage(conn, o.targetTag))) throw failed(`: ${o.targetTag} is missing on the server after docker pull.`);
  return { durationMs: Date.now() - start };
}
