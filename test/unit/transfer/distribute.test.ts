import { describe, expect, it } from 'vitest';
import { CometError } from '../../../src/core/errors.js';
import { renderTemplate } from '../../../src/remote/render.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import { distributeToServer, pullScriptVars } from '../../../src/transfer/distribute.js';
import { openReverseTunnel, TunnelUnavailableError } from '../../../src/transfer/tunnel.js';

const VARS = { remotePort: 40123, registryRef: 'mup-app:v1', targetTag: 'mup-app:v1', baseImage: 'zodern/meteor:latest' };

describe('pull-via-tunnel.sh', () => {
  it('pulls the base image, then the app through the tunnel, retags and drops the tunnel tag', async () => {
    const script = await renderTemplate('comet/pull-via-tunnel.sh', pullScriptVars(VARS));
    const lines = script.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines[0]).toBe('set -e');
    const order = [
      'sudo docker pull zodern/meteor:latest || true',
      'sudo docker pull 127.0.0.1:40123/mup-app:v1',
      'sudo docker tag 127.0.0.1:40123/mup-app:v1 mup-app:v1',
      'sudo docker rmi 127.0.0.1:40123/mup-app:v1',
    ];
    const idx = order.map((l) => lines.indexOf(l));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('rejects references that are not plain image names', () => {
    expect(() => pullScriptVars({ ...VARS, targetTag: 'mup-app:v1; rm -rf /' })).toThrow(CometError);
    expect(() => pullScriptVars({ ...VARS, baseImage: '$(id)' })).toThrow(CometError);
    expect(() => pullScriptVars({ ...VARS, remotePort: 0 })).toThrow(CometError);
  });
});

describe('openReverseTunnel', () => {
  const conn = (err: Error) => ({ name: 'one', host: 'h', forwardIn: async () => { throw err; } }) as unknown as SshConnection;

  it('maps a refused forward to TunnelUnavailableError with the sshd hint', async () => {
    for (const msg of ['Unable to bind to 127.0.0.1:0', 'administratively prohibited']) {
      const p = openReverseTunnel(conn(new Error(msg)), 5000);
      await expect(p).rejects.toBeInstanceOf(TunnelUnavailableError);
      await expect(openReverseTunnel(conn(new Error(msg)), 5000)).rejects.toThrow(/AllowTcpForwarding/);
    }
  });

  it('passes other errors through', async () => {
    await expect(openReverseTunnel(conn(new Error('socket hang up')), 5000)).rejects.not.toBeInstanceOf(TunnelUnavailableError);
  });
});

describe('distributeToServer', () => {
  it('always closes the tunnel, also when the pull fails', async () => {
    let closed = false;
    const conn = {
      name: 'one',
      host: 'h',
      forwardIn: async () => ({ port: 40123, close: async () => void (closed = true) }),
      runScriptOrThrow: async () => {
        throw new CometError('pull failed');
      },
    } as unknown as SshConnection;
    await expect(distributeToServer(conn, { registryPort: 5000, registryRef: 'mup-app:v1', targetTag: 'mup-app:v1', baseImage: 'zodern/meteor' })).rejects.toThrow(
      /pull failed/,
    );
    expect(closed).toBe(true);
  });
});
