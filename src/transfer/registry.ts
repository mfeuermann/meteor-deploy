/**
 * The `registry` transfer, for configs with MUP's `privateDockerRegistry`: the image is pushed
 * from this computer to the registry and every server pulls it. The registry is only the way
 * the image travels: a server keeps it as `mup-<app>:<version>` like after the tunnel or the
 * stream, and start.sh never pulls (registry design §4.1), so canary, revert and rollback work
 * server by server without the registry.
 */
import type { NormalizedConfig, RegistryConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';

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
