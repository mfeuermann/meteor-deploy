import { CometError } from '../core/errors.js';
import { cometScript } from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
import { openReverseTunnel } from './tunnel.js';

/**
 * Template variables for `pull-via-tunnel.sh`. The references are shell-quoted
 * by the template (`q()`), so any valid Docker reference works, including
 * registries with a port (`registry.example.com:5000/org/image:tag`); Docker
 * itself rejects invalid ones.
 */
export function pullScriptVars(o: { remotePort: number; registryRef: string; targetTag: string; baseImage: string }): Record<string, string> {
  if (!Number.isInteger(o.remotePort) || o.remotePort <= 0 || o.remotePort > 65535) throw new CometError(`Invalid tunnel port ${o.remotePort}.`);
  for (const [what, v] of [['registry reference', o.registryRef], ['image tag', o.targetTag], ['base image', o.baseImage]]) {
    if (!v.trim()) throw new CometError(`The ${what} is empty.`);
  }
  return { tunnelRef: `127.0.0.1:${o.remotePort}/${o.registryRef}`, targetTag: o.targetTag, baseImage: o.baseImage };
}

/** Pulls the image from the local registry through a reverse tunnel; only missing layers travel. */
export async function distributeToServer(
  conn: SshConnection,
  o: { registryPort: number; registryRef: string; targetTag: string; baseImage: string; onStatus?: (s: string) => void },
): Promise<{ durationMs: number }> {
  const start = Date.now();
  const tunnel = await openReverseTunnel(conn, o.registryPort);
  try {
    const script = await cometScript('pull-via-tunnel.sh', pullScriptVars({ ...o, remotePort: tunnel.remotePort }));
    let buf = '';
    await conn.runScriptOrThrow(script, `Pulling ${o.targetTag}`, {
      onStdout: (chunk) => {
        if (!o.onStatus) return;
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) o.onStatus(line);
        }
      },
    });
  } finally {
    await tunnel.close().catch(() => {});
  }
  return { durationMs: Date.now() - start };
}
