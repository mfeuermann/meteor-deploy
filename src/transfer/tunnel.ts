import { connect } from 'node:net';
import { CometError } from '../core/errors.js';
import type { SshConnection } from '../ssh/connection.js';

export class TunnelUnavailableError extends CometError {}

const REFUSED_RE = /administratively prohibited|unable to bind|remote port forwarding|forwarding.*(denied|disabled)/i;

/**
 * Reverse tunnel: connections to 127.0.0.1:<remotePort> on the server reach
 * 127.0.0.1:<localPort> here (the local registry).
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
      throw new TunnelUnavailableError(`[${conn.name}] The SSH server does not allow reverse port forwarding (${msg}). Set "AllowTcpForwarding yes" in its sshd_config.`, {
        hint: 'Edit /etc/ssh/sshd_config on the server and reload sshd. A transfer without a tunnel is planned for phase 2.',
        cause: err,
      });
    }
    throw err;
  }
}
