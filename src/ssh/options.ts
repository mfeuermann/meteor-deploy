/**
 * Maps a `servers.<name>` entry of the MUP config to ssh2 connect options, the way MUP does
 * through nodemiral, so a config that connects with MUP connects here too.
 */
import { readFileSync } from 'node:fs';
import type { ConnectConfig } from 'ssh2';
import { resolveUserPath } from '../config/load.js';
import type { ServerConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';

/**
 * ssh2 connect options for a server, like MUP/nodemiral: defaults, then the whole
 * `servers.*.opts` object merged in; auth `pem` > `password` > ssh agent.
 *
 * `pem` is a path to a private key, resolved against the current directory as MUP does (with
 * `~` expanded and the config directory as a fallback), and read as the key content. Encrypted
 * keys need the agent (MUP has no passphrase option either). `o.readFile` replaces the file read
 * in tests.
 *
 * @throws CometError for a `.pub` key, an unreadable key file, or when no authentication method
 *   is available.
 */
export function buildConnectOptions(
  server: ServerConfig,
  o: { cwd: string; basePath: string; env: NodeJS.ProcessEnv; readFile?: (p: string) => string; name?: string },
): ConnectConfig {
  const label = o.name ? `"${o.name}" (${server.host})` : `"${server.host}"`;
  // MUP's keepalive values (a keepalive every 28 s; after 12 unanswered ones, about 5.6 minutes,
  // the connection counts as dead) and nodemiral's 60 s handshake timeout. MUP's schema allows
  // only `opts.port`, but nodemiral merges the whole object, so any ssh2 option in `opts`
  // overrides these defaults.
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
