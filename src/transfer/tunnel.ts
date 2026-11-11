/**
 * SSH reverse tunnel from a server to the local registry. The server's Docker pulls from
 * `127.0.0.1:<port>` on the server, and each of its connections is carried over the existing SSH
 * connection to the registry on this machine, so the server needs no route to us. Also the
 * preflight probe that detects `AllowTcpForwarding no` before the build.
 */
import { connect } from 'node:net';
import { CometError } from '../core/errors.js';
import type { SshConnection } from '../ssh/connection.js';

/** The server refuses reverse port forwarding; `reason` is what the SSH server answered. */
export class TunnelUnavailableError extends CometError {
  /** The refusal without the `[server]` prefix, for the preflight report. */
  reason = '';
}

/**
 * Error messages that mean sshd refused the forward. OpenSSH answers a refused `tcpip-forward`
 * request with a bare failure, which ssh2 reports as "Unable to bind to <addr>:<port>"; the other
 * patterns catch more explicit refusals.
 */
const REFUSED_RE = /administratively prohibited|unable to bind|remote port forwarding|forwarding.*(denied|disabled)/i;

/**
 * Reverse tunnel: connections to 127.0.0.1:<remotePort> on the server reach
 * 127.0.0.1:<localPort> here (the local registry).
 *
 * The remote port is 0, so sshd picks a free one and parallel deploys or other tunnels never
 * clash. Every forwarded connection (`docker pull` downloads several layers at once) gets its
 * own TCP connection to the local port; an error on either side destroys both. `close()` stops
 * the forward.
 *
 * @throws TunnelUnavailableError when sshd refuses reverse forwarding; other errors (for example
 *   a dropped connection) are rethrown unchanged.
 */
export async function openReverseTunnel(conn: SshConnection, localPort: number): Promise<{ remotePort: number; close(): Promise<void> }> {
  try {
    const fwd = await conn.forwardIn(0, (stream) => {
      const socket = connect(localPort, '127.0.0.1');
      const destroyBoth = () => {
        socket.destroy();
        stream.destroy();
      };
      socket.on('error', destroyBoth);
      stream.on('error', destroyBoth);
      stream.pipe(socket).pipe(stream);
    });
    return { remotePort: fwd.port, close: fwd.close };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (REFUSED_RE.test(msg)) {
      const e = new TunnelUnavailableError(`[${conn.name}] The SSH server does not allow reverse port forwarding (${msg}). Set "AllowTcpForwarding yes" in its sshd_config.`, {
        hint: 'Edit /etc/ssh/sshd_config on the server and reload sshd. A transfer without a tunnel is planned for phase 2.',
        cause: err,
      });
      e.reason = msg.replace(/^\[[^\]]*\]\s*/, '');
      throw e;
    }
    throw err;
  }
}

/**
 * Checks that the server allows reverse port forwarding by opening and closing
 * a tunnel. Returns the server's refusal, or null when forwarding works.
 * Preflight runs this so `AllowTcpForwarding no` is reported before the build
 * instead of after it. The local port (1) is never dialed, because nothing
 * connects to the probe tunnel before it closes.
 */
export async function probeForwarding(conn: SshConnection): Promise<string | null> {
  try {
    const t = await openReverseTunnel(conn, 1);
    await t.close().catch(() => {});
    return null;
  } catch (err) {
    if (err instanceof TunnelUnavailableError) return err.reason || err.message;
    throw err;
  }
}
