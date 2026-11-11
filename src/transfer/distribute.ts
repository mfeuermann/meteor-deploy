/**
 * Distribution of a built image to one server: open a reverse tunnel to the local registry, then
 * run `pull-via-tunnel.sh` on the server, so its Docker pulls only the layers it does not have
 * yet. The running app is not touched; activation happens later.
 */
import { CometError } from '../core/errors.js';
import { lineSplitter } from '../output/lines.js';
import { cometScript } from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
import { openReverseTunnel } from './tunnel.js';

/**
 * Template variables for `pull-via-tunnel.sh`. The references are shell-quoted
 * by the template (`q()`), so any valid Docker reference works, including
 * registries with a port (`registry.example.com:5000/org/image:tag`); Docker
 * itself rejects invalid ones.
 *
 * `tunnelRef` points at the tunnel on the server's loopback. Docker allows plain HTTP for a
 * registry on 127.0.0.0/8, so the server needs no `insecure-registries` setting.
 *
 * @throws CometError for a port outside 1–65535 or an empty reference.
 */
export function pullScriptVars(o: { remotePort: number; registryRef: string; targetTag: string; baseImage: string }): Record<string, string> {
  if (!Number.isInteger(o.remotePort) || o.remotePort <= 0 || o.remotePort > 65535) throw new CometError(`Invalid tunnel port ${o.remotePort}.`);
  for (const [what, v] of [['registry reference', o.registryRef], ['image tag', o.targetTag], ['base image', o.baseImage]]) {
    if (!v.trim()) throw new CometError(`The ${what} is empty.`);
  }
  return { tunnelRef: `127.0.0.1:${o.remotePort}/${o.registryRef}`, targetTag: o.targetTag, baseImage: o.baseImage };
}

/**
 * Pulls the image from the local registry through a reverse tunnel; only missing layers travel.
 * Runs `pull-via-tunnel.sh` with sudo on the server: it pulls the base image from its own
 * registry first (so its layers usually do not go through the tunnel; a failure is ignored),
 * pulls `registryRef` through the tunnel, tags it `targetTag` and removes the tunnel tag. The
 * tunnel is closed in every case.
 *
 * @param o.registryPort Port of the local registry on 127.0.0.1.
 * @param o.registryRef Image reference inside the registry, without host (`mup-<app>:<tag>`).
 * @param o.onStatus Receives each non-empty stdout line of the script (`docker pull` progress).
 * @throws TunnelUnavailableError when sshd refuses reverse forwarding; CometError when the
 *   pull fails or the connection drops.
 */
export async function distributeToServer(
  conn: SshConnection,
  o: { registryPort: number; registryRef: string; targetTag: string; baseImage: string; onStatus?: (s: string) => void },
): Promise<{ durationMs: number }> {
  const start = Date.now();
  const tunnel = await openReverseTunnel(conn, o.registryPort);
  try {
    const script = await cometScript('pull-via-tunnel.sh', pullScriptVars({ ...o, remotePort: tunnel.remotePort }));
    const onStatus = o.onStatus;
    const lines = onStatus
      ? lineSplitter((l) => {
          const line = l.trim();
          if (line) onStatus(line);
        })
      : undefined;
    await conn.runScriptOrThrow(script, `Pulling ${o.targetTag}`, { onStdout: lines?.push, onClose: lines?.flush });
  } finally {
    await tunnel.close().catch(() => {});
  }
  return { durationMs: Date.now() - start };
}
