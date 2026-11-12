import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { SshConnection } from '../../../src/ssh/connection.js';

const { Server, utils } = ssh2;

/**
 * An ed25519 host key that ssh2 can read. ssh2's generateKeyPairSync now and then returns a key
 * its own parser rejects ("Malformed OpenSSH private key", about one in a hundred, with any
 * Node version), so such a key is replaced by a new one.
 */
function hostKey(): string {
  for (let i = 0; i < 20; i++) {
    const key = utils.generateKeyPairSync('ed25519').private;
    if (!(utils.parseKey(key) instanceof Error)) return key;
  }
  throw new Error('ssh2 could not generate a readable ed25519 host key in 20 attempts');
}

/**
 * An in-process SSH server on loopback that accepts any password and opens SFTP sessions but
 * never answers a file request, so a request stays in flight until the connection drops.
 */
async function startServer() {
  const sockets: { destroy(): void }[] = [];
  const stats = { sftpSessions: 0 };
  const srv = new Server({ hostKeys: [hostKey()] }, (client) => {
    sockets.push((client as unknown as { _sock: { destroy(): void } })._sock);
    client.on('authentication', (ctx) => ctx.accept());
    // A listener without a reply keeps ssh2 from answering OPEN with "Operation unsupported".
    client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acceptSftp) => {
      stats.sftpSessions++;
      acceptSftp().on('OPEN', () => {});
    })));
    client.on('error', () => {});
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    stats,
    /** Cuts every connection, as a network failure would. */
    drop: () => sockets.forEach((s) => s.destroy()),
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe('SshConnection file operations when the connection drops', () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let conn: SshConnection | undefined;
  afterEach(async () => {
    await conn?.close();
    await server?.close();
  });

  const connect = async () => {
    server = await startServer();
    conn = await SshConnection.connect('one', { host: '127.0.0.1', username: 'u', password: 'p', opts: { port: server.port } }, { cwd: process.cwd(), basePath: process.cwd() });
    return conn;
  };
  const dropped = (c: SshConnection) => new Promise<void>((resolve) => {
    const t = setInterval(() => !c.isAlive && (clearInterval(t), resolve()), 10);
  });

  it('rejects a write that is in flight when the connection drops', async () => {
    const c = await connect();
    const write = c.writeFile('/tmp/x', 'secret', 0o600);
    await new Promise((r) => setTimeout(r, 100));
    server!.drop();
    await expect(write).rejects.toThrow(/\[one\] The SSH connection to 127\.0\.0\.1 closed/);
  });

  it('shares one SFTP session between file operations', async () => {
    const c = await connect();
    void c.writeFile('/tmp/a', 'x').catch(() => {});
    void c.writeFile('/tmp/b', 'x').catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    void c.writeFile('/tmp/c', 'x').catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    expect(server!.stats.sftpSessions).toBe(1);
  });

  it('rejects a write started after the connection dropped instead of hanging', async () => {
    const c = await connect();
    // Opens and caches the SFTP session; the request itself is never answered.
    void c.writeFile('/tmp/x', 'secret', 0o600).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    server!.drop();
    await dropped(c);
    await expect(c.writeFile('/tmp/y', 'secret', 0o600)).rejects.toThrow(/closed/);
    await expect(c.putFile(__filename, '/tmp/z')).rejects.toThrow(/closed/);
  }, 3000);
});
