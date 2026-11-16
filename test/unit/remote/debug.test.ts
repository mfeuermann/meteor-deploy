/**
 * `debugApp` against a fake SSH connection: the start script's answer is configured per test,
 * `forwardOut` and `openExec` return echo streams, and real local TCP connections go to the
 * listener on 127.0.0.1.
 */
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import { createReporter } from '../../../src/output/reporter.js';
import { debugApp } from '../../../src/remote/debug.js';
import { ForwardRefusedError, type SshConnection } from '../../../src/ssh/connection.js';

// One app server "one", app "my.mongo.app".
const fixture = join(import.meta.dirname, '../../fixtures/configs/mongo');
const BRIDGE = 'network=bridge\nip=172.18.0.5\ngateway=172.18.0.1\nid=cid123\n';

interface Fake {
  start?: { code: number; stdout?: string; stderr?: string };
  forwardOut?: (host: string, port: number) => Promise<PassThrough>;
  inspect?: string;
}

async function setup(f: Fake = {}) {
  const log = { scripts: 0, execs: [] as string[], forwards: [] as string[], openExecs: [] as string[] };
  const out: string[] = [];
  const conn = {
    name: 'one',
    runScript: async () => (log.scripts++, { code: 0, stdout: BRIDGE, stderr: '', ...f.start }),
    exec: async (command: string) => (log.execs.push(command), { code: 0, stdout: command.includes('inspect') ? (f.inspect ?? 'cid123 true') : '', stderr: '' }),
    forwardOut: async (host: string, port: number) => (log.forwards.push(`${host}:${port}`), f.forwardOut ? f.forwardOut(host, port) : new PassThrough()),
    openExec: async (command: string) => (log.openExecs.push(command), Object.assign(new PassThrough(), { stderr: new PassThrough(), exitCode: new Promise<number>(() => {}) })),
  } as unknown as SshConnection;
  const ctx = await createContext(
    { config: join(fixture, 'mup.js') },
    {
      cwd: fixture,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => out.push(s) }),
      sshPoolFactory: () => ({ get: async () => conn, closeAll: async () => {} }),
    },
  );
  const ac = new AbortController();
  return { ctx, ac, log, out: () => out.join('') };
}

/** Waits until the debugger prints its address, and returns the local port from it. */
async function localPort(out: () => string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const m = out().match(/ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no address printed:\n${out()}`);
}

/** Connects, writes `ping` and resolves with what comes back. */
function roundTrip(port: number): Promise<{ data: string; socket: import('node:net').Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write('ping'));
    socket.once('data', (d) => resolve({ data: d.toString(), socket }));
    socket.once('error', reject);
  });
}

let blocker: Server | undefined;
afterEach(() => blocker?.close());

describe('debugApp', () => {
  it('checks the local port before it touches the server', async () => {
    blocker = createServer();
    await new Promise<void>((r) => blocker!.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as AddressInfo).port;
    const s = await setup();
    const err = await debugApp(s.ctx, { words: [], port, signal: s.ac.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CometError);
    expect((err as CometError).message).toBe(`Port ${port} is in use on this computer.`);
    expect((err as CometError).hint).toBe(`Use --port <n>, and add localhost:<n> in chrome://inspect → Configure.`);
    expect(s.log.scripts).toBe(0);
  });

  it("prints the spec's instructions with the real port", async () => {
    const s = await setup();
    const done = debugApp(s.ctx, { words: [], port: 0, signal: s.ac.signal });
    const port = await localPort(s.out);
    expect(s.out()).toContain(`Debugger of "my.mongo.app" on "one": ws://127.0.0.1:${port}`);
    expect(s.out()).toContain('1. Open chrome://inspect in Chrome');
    expect(s.out()).toContain('2. Select "Open dedicated DevTools for Node"');
    expect(s.out()).toContain("3. Wait a minute while it connects and loads the app. The app's files appear in the Sources tab.");
    expect(s.out()).toContain('Do not use breakpoints on a production server: they pause the app, which then answers no methods or subscriptions. Use logpoints instead.');
    expect(s.out()).toContain('The debugger stays enabled in the app until it restarts; it is reachable only while this command runs. Press Ctrl+C to stop.');
    s.ac.abort();
    await done;
  });

  it('a connection goes through forwardOut to ip:9228 (bridge), and says it is connected once', async () => {
    const s = await setup();
    const done = debugApp(s.ctx, { words: [], port: 0, signal: s.ac.signal });
    const port = await localPort(s.out);
    const a = await roundTrip(port);
    const b = await roundTrip(port);
    expect([a.data, b.data]).toEqual(['ping', 'ping']);
    expect(s.log.forwards).toEqual(['172.18.0.5:9228', '172.18.0.5:9228']);
    expect(s.out().match(/Debugger connected\./g)).toHaveLength(1);
    a.socket.destroy();
    b.socket.destroy();
    s.ac.abort();
    await done;
  });

  it('host network: a connection goes to 127.0.0.1:9229 on the server', async () => {
    const s = await setup({ start: { code: 0, stdout: 'network=host\nid=cid123\n' } });
    const done = debugApp(s.ctx, { words: [], port: 0, signal: s.ac.signal });
    const r = await roundTrip(await localPort(s.out));
    expect(s.log.forwards).toEqual(['127.0.0.1:9229']);
    r.socket.destroy();
    s.ac.abort();
    await done;
  });

  it('switches to docker exec once forwarding is refused, and says so once', async () => {
    const s = await setup({ forwardOut: async () => Promise.reject(new ForwardRefusedError('[one] The SSH server does not allow TCP forwarding (x).')) });
    const done = debugApp(s.ctx, { words: [], port: 0, signal: s.ac.signal });
    const port = await localPort(s.out);
    const a = await roundTrip(port);
    const b = await roundTrip(port);
    expect([a.data, b.data]).toEqual(['ping', 'ping']);
    expect(s.log.openExecs).toEqual([
      'sudo docker exec -i my.mongo.app-debug socat STDIO TCP:127.0.0.1:9229',
      'sudo docker exec -i my.mongo.app-debug socat STDIO TCP:127.0.0.1:9229',
    ]);
    expect(s.log.forwards).toHaveLength(1);
    expect(s.out().match(/SSH TCP forwarding is off on "one": the debugger connection goes through docker exec, which is slower to connect\./g)).toHaveLength(1);
    a.socket.destroy();
    b.socket.destroy();
    s.ac.abort();
    await done;
  });

  it('removes the helper when aborted with an open connection', async () => {
    const s = await setup();
    const done = debugApp(s.ctx, { words: [], port: 0, signal: s.ac.signal });
    const port = await localPort(s.out);
    const open = await roundTrip(port);
    s.ac.abort();
    await done;
    expect(s.log.execs).toContain("sudo docker rm -f my.mongo.app-debug");
    expect(open.socket.destroyed || (await new Promise((r) => open.socket.once('close', () => r(true))))).toBe(true);
    await expect(roundTrip(port)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('removes the helper after a failed start', async () => {
    const s = await setup({ start: { code: 12, stderr: 'pull access denied for alpine/socat' } });
    const err = await debugApp(s.ctx, { words: [], port: 0, signal: s.ac.signal }).catch((e: unknown) => e);
    expect((err as CometError).message).toBe('Cannot start the debugger helper on "one": pull access denied for alpine/socat');
    expect((err as CometError).hint).toMatch(/rate limit/);
    expect(s.log.execs).toContain('sudo docker rm -f my.mongo.app-debug');
  });

  it('reports a replaced container', async () => {
    const s = await setup({ forwardOut: async () => Promise.reject(new CometError('[one] Cannot connect to 172.18.0.5:9228 from the server: connect failed')), inspect: 'cid999 true' });
    const done = debugApp(s.ctx, { words: [], port: 0, signal: s.ac.signal });
    const port = await localPort(s.out);
    connect(port, '127.0.0.1').on('error', () => {});
    await expect(done).rejects.toThrow('The app container on "one" was replaced or stopped; run "comet-deploy meteor debug" again.');
    expect(s.log.execs).toContain('sudo docker rm -f my.mongo.app-debug');
  });

  it('maps the exit codes of the start script', async () => {
    const stopped = await setup({ start: { code: 10 } });
    const e10 = (await debugApp(stopped.ctx, { words: [], port: 0, signal: stopped.ac.signal }).catch((e: unknown) => e)) as CometError;
    expect(e10.message).toBe('The app container "my.mongo.app" does not run on "one".');
    expect(e10.hint).toBe('Start it with "comet-deploy start".');
    const noNode = await setup({ start: { code: 11, stderr: 'no node process in the container\n' } });
    const e11 = (await debugApp(noNode.ctx, { words: [], port: 0, signal: noNode.ac.signal }).catch((e: unknown) => e)) as CometError;
    expect(e11.message).toBe('Cannot enable the debugger of the app on "one": no node process in the container');
  });

  it('an unknown server name is an error', async () => {
    const s = await setup();
    await expect(debugApp(s.ctx, { words: ['two'], port: 0, signal: s.ac.signal })).rejects.toThrow('Unknown server "two". Servers: one');
  });
});
