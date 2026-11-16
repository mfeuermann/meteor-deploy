import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { ForwardRefusedError, SshConnection } from '../../../src/ssh/connection.js';
import { hostKey } from '../../helpers/ssh.js';

const { Server } = ssh2;

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

/**
 * An in-process SSH server for the session APIs: a shell that prints `hi` and exits 3, an exec
 * that echoes stdin and exits 0, and direct-tcpip channels that echo their data, or are refused
 * by policy when `refuseTcpip` is set.
 */
async function startSessionServer(o: { refuseTcpip?: boolean } = {}) {
  const seen: { tcpip: { destIP: string; destPort: number }[]; ptys: number; execs: string[] } = { tcpip: [], ptys: 0, execs: [] };
  const srv = new Server({ hostKeys: [hostKey()] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => {
          seen.ptys++;
          acceptPty?.();
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('hi');
          stream.exit(3);
          stream.end();
        });
        session.on('exec', (acceptExec, _reject, info) => {
          seen.execs.push(info.command);
          const stream = acceptExec();
          stream.on('data', (d: Buffer) => stream.write(d));
          stream.on('end', () => {
            stream.exit(0);
            stream.end();
          });
        });
      });
      // Without a 'tcpip' listener ssh2 refuses the channel with ADMINISTRATIVELY_PROHIBITED,
      // the answer of sshd with `AllowTcpForwarding no` (ssh2's own reject() says CONNECT_FAILED).
      if (!o.refuseTcpip) {
        client.on('tcpip', (accept, _reject, info) => {
          seen.tcpip.push({ destIP: info.destIP, destPort: info.destPort });
          const stream = accept();
          stream.on('data', (d: Buffer) => stream.write(d));
        });
      }
    });
    client.on('error', () => {});
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { port, seen, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

describe('SshConnection sessions: shell, forwardOut, openExec', () => {
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  let conn: SshConnection | undefined;
  afterEach(async () => {
    await conn?.close();
    await server?.close();
  });
  const connect = async (o: { refuseTcpip?: boolean } = {}) => {
    server = await startSessionServer(o);
    conn = await SshConnection.connect('one', { host: '127.0.0.1', username: 'u', password: 'p', opts: { port: server.port } }, { cwd: process.cwd(), basePath: process.cwd() });
    return conn;
  };
  const sink = () => {
    const chunks: Buffer[] = [];
    const w = new PassThrough();
    w.on('data', (c: Buffer) => chunks.push(c));
    return { w, text: () => Buffer.concat(chunks).toString() };
  };

  it('shell() opens a shell channel and resolves with its exit status', async () => {
    const c = await connect();
    const out = sink();
    const stdin = new PassThrough();
    const code = await c.shell({ stdin, stdout: out.w, stderr: new PassThrough(), pty: { rows: 24, cols: 80, term: 'xterm' } });
    expect(code).toBe(3);
    expect(out.text()).toBe('hi');
    expect(server!.seen.ptys).toBe(1);
  });

  it('forwardOut() returns a stream to the target', async () => {
    const c = await connect();
    const s = await c.forwardOut('172.18.0.5', 9228);
    const echoed = new Promise<string>((resolve) => s.once('data', (d: Buffer) => resolve(d.toString())));
    s.write('ping');
    expect(await echoed).toBe('ping');
    expect(server!.seen.tcpip).toEqual([{ destIP: '172.18.0.5', destPort: 9228 }]);
    s.destroy();
  });

  it('forwardOut() rejects with ForwardRefusedError when the server refuses', async () => {
    const c = await connect({ refuseTcpip: true });
    const err = await c.forwardOut('127.0.0.1', 9229).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForwardRefusedError);
    expect((err as Error).message).toMatch(/^\[one\] /);
  });

  it('openExec() exposes stdin/stdout and the exit code', async () => {
    const c = await connect();
    const ch = await c.openExec('sudo docker exec -i x socat STDIO TCP:127.0.0.1:9229');
    const out = sink();
    ch.pipe(out.w);
    ch.end('abc');
    expect(await ch.exitCode).toBe(0);
    expect(out.text()).toBe('abc');
    expect(server!.seen.execs).toEqual(['sudo docker exec -i x socat STDIO TCP:127.0.0.1:9229']);
  });
});
