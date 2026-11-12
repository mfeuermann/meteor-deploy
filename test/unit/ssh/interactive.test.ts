import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { SshConnection } from '../../../src/ssh/connection.js';
import { runInteractive, type LocalTerminal } from '../../../src/ssh/interactive.js';
import { hostKey } from '../../helpers/ssh.js';

/**
 * An in-process SSH server that runs two commands: `echo-stdin` sends stdin back and exits 3
 * at EOF; `wait-resize` exits 0 after the first window change. It records pty and window
 * change requests.
 */
async function startServer() {
  const seen = { pty: null as null | { rows: number; cols: number; term: string }, resize: null as null | { rows: number; cols: number } };
  const srv = new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('error', () => {});
    client.on('ready', () =>
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let finish: (() => void) | undefined;
        session.on('pty', (accept, _reject, info) => {
          seen.pty = { rows: info.rows, cols: info.cols, term: info.term };
          accept?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          seen.resize = { rows: info.rows, cols: info.cols };
          accept?.();
          finish?.();
        });
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          if (info.command === 'echo-stdin') {
            stream.on('data', (d: Buffer) => stream.write(d));
            stream.on('end', () => {
              stream.exit(3);
              stream.end();
            });
          } else {
            finish = () => {
              stream.exit(0);
              stream.end();
            };
          }
        });
      }),
    );
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { port: (srv.address() as AddressInfo).port, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

describe('SshConnection.interactive', () => {
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

  it('interactive pipes stdin and returns the exit code', async () => {
    const c = await connect();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (d) => (out += d));
    const done = c.interactive('echo-stdin', { stdin, stdout, stderr: new PassThrough() });
    stdin.end('hello\n');
    expect(await done).toBe(3);
    expect(out).toBe('hello\n');
  });

  it('interactive with pty asks for a pseudo-terminal of that size and passes a resize on', async () => {
    const c = await connect();
    const code = await c.interactive('wait-resize', {
      pty: { rows: 40, cols: 120, term: 'xterm-256color' },
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onChannel: (resize) => setTimeout(() => resize(50, 132), 20),
    });
    expect(code).toBe(0);
    expect(server!.seen.pty).toEqual({ rows: 40, cols: 120, term: 'xterm-256color' });
    expect(server!.seen.resize).toEqual({ rows: 50, cols: 132 });
  });
});

/** A local terminal whose stdin says it is (or is not) a TTY and records raw mode changes. */
function terminal(isTTY: boolean) {
  const raw: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), { isTTY, setRawMode: (b: boolean) => raw.push(b) });
  const stdout = Object.assign(new EventEmitter(), { rows: 30, columns: 100, write: () => true });
  return { term: { stdin, stdout, stderr: stdout } as unknown as LocalTerminal, raw, stdout };
}

describe('runInteractive', () => {
  it('uses no pty when stdin is not a terminal', async () => {
    const t = terminal(false);
    let got: { command: string; pty: unknown } | undefined;
    const conn = { interactive: async (command: string, o: { pty?: unknown }) => ((got = { command, pty: o.pty }), 0) } as unknown as SshConnection;
    expect(await runInteractive(conn, (tty) => `cmd tty=${tty}`, t.term)).toBe(0);
    expect(got).toEqual({ command: 'cmd tty=false', pty: undefined });
    expect(t.raw).toEqual([]);
  });

  it('uses a pty of the terminal size when stdin is a terminal', async () => {
    const t = terminal(true);
    let pty: unknown;
    const conn = { interactive: async (_c: string, o: { pty?: unknown }) => ((pty = o.pty), 0) } as unknown as SshConnection;
    await runInteractive(conn, () => 'cmd', t.term);
    expect(pty).toMatchObject({ rows: 30, cols: 100 });
    expect(t.raw).toEqual([true, false]);
  });

  it('restores the terminal when the command fails', async () => {
    const t = terminal(true);
    const conn = {
      interactive: async (_c: string, o: { onChannel?: (resize: (r: number, c: number) => void) => void }) => {
        o.onChannel?.(() => {});
        throw new Error('connection lost');
      },
    } as unknown as SshConnection;
    await expect(runInteractive(conn, () => 'cmd', t.term)).rejects.toThrow('connection lost');
    expect(t.raw).toEqual([true, false]);
    expect(t.stdout.listenerCount('resize')).toBe(0);
  });
});
