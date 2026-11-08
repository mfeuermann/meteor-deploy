import { readFileSync } from 'node:fs';
import type { ConnectConfig } from 'ssh2';
import { resolveUserPath } from '../config/load.js';
import type { ServerConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';

/**
 * ssh2 connect options for a server, like MUP/nodemiral: defaults, then the whole
 * `servers.*.opts` object merged in; auth `pem` > `password` > ssh agent.
 */
export function buildConnectOptions(
  server: ServerConfig,
  o: { cwd: string; basePath: string; env: NodeJS.ProcessEnv; readFile?: (p: string) => string; name?: string },
): ConnectConfig {
  const label = o.name ? `"${o.name}" (${server.host})` : `"${server.host}"`;
  const options: ConnectConfig = {
    host: server.host,
    port: 22,
    username: server.username,
    readyTimeout: 60000,
    keepaliveInterval: 28000,
    keepaliveCountMax: 12,
    ...(server.opts ?? {}),
  };
  if (server.pem) {
    if (server.pem.endsWith('.pub')) {
      throw new CometError(`servers.${o.name ?? server.host}.pem must be a private key, not a ".pub" public key.`);
    }
    const path = resolveUserPath(server.pem, { cwd: o.cwd, basePath: o.basePath, base: 'cwd' });
    try {
      options.privateKey = (o.readFile ?? ((p) => readFileSync(p, 'utf8')))(path);
    } catch (err) {
      throw new CometError(`Cannot read the SSH key for server ${label} at ${path}: ${(err as Error).message}`);
    }
  } else if (server.password) {
    options.password = server.password;
  } else if (o.env.SSH_AUTH_SOCK) {
    options.agent = o.env.SSH_AUTH_SOCK;
  } else {
    throw new CometError(`No SSH authentication for server ${label}.`, {
      hint: 'Set "pem" or "password" for the server, or start an ssh agent (SSH_AUTH_SOCK).',
    });
  }
  return options;
}
