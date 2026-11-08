import { CometError } from '../core/errors.js';
import { renderTemplate } from '../remote/render.js';
import type { SshConnection } from '../ssh/connection.js';
import { openReverseTunnel } from './tunnel.js';

/** Plain image references only (they are rendered into the script unquoted). */
const IMAGE_REF_RE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$/i;

function checkRef(what: string, v: string): string {
  if (!IMAGE_REF_RE.test(v)) throw new CometError(`Invalid ${what} "${v}".`);
  return v;
}

export function pullScriptVars(o: { remotePort: number; registryRef: string; targetTag: string; baseImage: string }): Record<string, string> {
  if (!Number.isInteger(o.remotePort) || o.remotePort <= 0 || o.remotePort > 65535) throw new CometError(`Invalid tunnel port ${o.remotePort}.`);
  return {
    remotePort: String(o.remotePort),
    registryRef: checkRef('registry reference', o.registryRef),
    targetTag: checkRef('image tag', o.targetTag),
    baseImage: checkRef('base image', o.baseImage),
  };
}

/** Pulls the image from the local registry through a reverse tunnel; only missing layers travel. */
export async function distributeToServer(
  conn: SshConnection,
  o: { registryPort: number; registryRef: string; targetTag: string; baseImage: string; onStatus?: (s: string) => void },
): Promise<{ durationMs: number }> {
  const start = Date.now();
  const tunnel = await openReverseTunnel(conn, o.registryPort);
  try {
    const script = await renderTemplate('comet/pull-via-tunnel.sh', pullScriptVars({ ...o, remotePort: tunnel.remotePort }));
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
