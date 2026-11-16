/**
 * `meteor debug` (commands design §4.3): the Node inspector of the running app on
 * `127.0.0.1:<port>` of this computer, for Chrome DevTools.
 *
 * On the server, templates/comet/debug-start.sh sends SIGUSR1 to the app's node process (the
 * inspector then listens on 127.0.0.1:9229 inside the container) and starts a socat helper
 * `<app>-debug` in the app's network namespace. Nothing is published on the server: each local
 * connection reaches the helper through an SSH `direct-tcpip` forward to the container's IP,
 * or, when the server does not allow TCP forwarding, through `docker exec -i <helper> socat
 * STDIO …` on an exec channel. The helper is removed when the command ends.
 *
 * MUP published the inspector on port 9227 of every interface of the server and listened on
 * 0.0.0.0:9229 locally; the inspector runs any code it is sent, so neither is done here.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { containerName } from '../core/naming.js';
import { pickServer } from '../cli/pick-server.js';
import { ForwardRefusedError, type SshConnection } from '../ssh/connection.js';
import { cometScript, shArg } from './ops.js';

/** Pinned, like every helper image; amd64 and arm64. */
export const DEBUG_IMAGE = 'alpine/socat:1.8.1.1';
/** Where the helper listens inside the app's network namespace. */
export const DEBUG_PORT_IN_APP = 9228;
/** Node's inspector port (SIGUSR1 always opens this one, on loopback). */
const INSPECTOR_PORT = 9229;
/** The port chrome://inspect looks at by default. */
const CHROME_DEFAULT_PORT = 9229;

export interface DebugOptions {
  /** Words after `meteor debug` (the server name). */
  words: string[];
  /** Local port on 127.0.0.1; 0 picks a free one (tests). */
  port: number;
  /** Aborted by Ctrl+C: the command then cleans up and ends normally. */
  signal: AbortSignal;
}

/** Where a forwarded connection goes on the server, from the output of debug-start.sh. */
interface Target {
  host: string;
  port: number;
  /**
   * `<Id> <StartedAt>` of the app container when the inspector was enabled. The start time
   * changes when Docker restarts the same container (a crash with a restart policy), which
   * starts the app without the inspector.
   */
  instance: string;
}

/** Parses the key=value lines of debug-start.sh. */
function parseTarget(stdout: string): Target {
  const kv = new Map(stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const instance = `${kv.get('id') ?? ''} ${kv.get('started') ?? ''}`;
  if (kv.get('network') === 'host') return { host: '127.0.0.1', port: INSPECTOR_PORT, instance };
  const ip = kv.get('ip');
  if (!ip) throw new CometError(`Unexpected output of the debugger setup: ${stdout.trim()}`);
  return { host: ip, port: DEBUG_PORT_IN_APP, instance };
}

/** Listens on 127.0.0.1:`port`; a port in use is a CometError with the spec's hint. */
function listenLocal(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new CometError(`Port ${port} is in use on this computer.`, { hint: 'Use --port <n>, and add localhost:<n> in chrome://inspect → Configure.' }));
      } else {
        reject(new CometError(`Cannot listen on 127.0.0.1:${port}: ${err.message}`, { cause: err }));
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** The CometError for a non-zero exit of debug-start.sh. */
function startError(code: number, stderr: string, container: string, server: string): CometError {
  const reason = stderr.trim();
  if (code === 10) return new CometError(`The app container "${container}" does not run on "${server}".`, { hint: 'Start it with "comet-deploy start".' });
  if (code === 11) return new CometError(`Cannot enable the debugger of the app on "${server}": ${reason}`);
  if (code === 12) {
    return new CometError(`Cannot start the debugger helper on "${server}": ${reason}`, {
      hint: `If the pull of ${DEBUG_IMAGE} failed, see "Docker Hub rate limits" in the troubleshooting guide.`,
    });
  }
  return new CometError(`The debugger setup failed on "${server}" (exit code ${code}): ${reason}`);
}

function instructions(app: string, server: string, port: number): string {
  const lines = [
    `Debugger of "${app}" on "${server}": ws://127.0.0.1:${port}`,
    '',
    'To debug:',
    '1. Open chrome://inspect in Chrome',
    '2. Select "Open dedicated DevTools for Node"',
    "3. Wait a minute while it connects and loads the app. The app's files appear in the Sources tab.",
  ];
  if (port !== CHROME_DEFAULT_PORT) lines.push(`   Port ${port} is not one that chrome://inspect looks at by default: add localhost:${port} under Configure.`);
  lines.push(
    '',
    'Do not use breakpoints on a production server: they pause the app, which then answers no methods or subscriptions. Use logpoints instead.',
    'The debugger stays enabled in the app until it restarts; it is reachable only while this command runs. Press Ctrl+C to stop.',
  );
  return lines.join('\n');
}

/**
 * Serves local connections until `signal` aborts (resolves) or the app container is gone
 * (rejects). Each connection gets its own forward, or exec channel once forwarding was refused.
 */
function serve(ctx: CommandContext, o: { listener: Server; conn: SshConnection; server: string; container: string; helper: string; target: Target; signal: AbortSignal }): Promise<void> {
  const { reporter } = ctx;
  const sockets = new Set<Socket>();
  let viaExec = false;
  let connected = false;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      o.signal.removeEventListener('abort', onAbort);
      for (const s of sockets) s.destroy();
      o.listener.close();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => finish();
    if (o.signal.aborted) return finish();
    o.signal.addEventListener('abort', onAbort);

    /** The app container still runs as the one the inspector was enabled in, not restarted. */
    const appStillThere = async (): Promise<boolean> => {
      const r = await o.conn.exec(`sudo docker inspect -f '{{.Id}} {{.State.Running}} {{.State.StartedAt}}' ${shArg(o.container)}`);
      const [id, running, started] = r.stdout.trim().split(' ');
      return r.code === 0 && running === 'true' && `${id} ${started}` === o.target.instance;
    };
    const failed = async (socket: Socket) => {
      socket.destroy();
      if (settled) return;
      const there = await appStillThere().catch(() => false);
      if (!there) finish(new CometError(`The app container on "${o.server}" was replaced or stopped; run "comet-deploy meteor debug" again.`));
    };
    const execChannel = () => o.conn.openExec(`sudo docker exec -i ${shArg(o.helper)} socat STDIO TCP:127.0.0.1:${INSPECTOR_PORT}`);

    const open = async (socket: Socket): Promise<Duplex | null> => {
      if (!viaExec) {
        try {
          return await o.conn.forwardOut(o.target.host, o.target.port);
        } catch (err) {
          if (!(err instanceof ForwardRefusedError)) return null;
          if (!viaExec) {
            viaExec = true;
            reporter.warn(`SSH TCP forwarding is off on "${o.server}": the debugger connection goes through docker exec, which is slower to connect.`);
          }
        }
      }
      const ch = await execChannel().catch(() => null);
      if (ch) {
        void ch.exitCode.then((code) => {
          if (code !== 0) void failed(socket);
        });
      }
      return ch;
    };

    o.listener.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      if (!connected) {
        connected = true;
        reporter.info('Debugger connected.');
      }
      void open(socket).then((remote) => {
        if (!remote) return void failed(socket);
        if (settled || socket.destroyed) return void remote.destroy();
        remote.on('error', () => socket.destroy());
        remote.on('close', () => socket.destroy());
        socket.on('close', () => remote.destroy());
        socket.pipe(remote);
        remote.pipe(socket);
      });
    });
  });
}

/**
 * `meteor debug [server]`: picks the app server (commands design §4.1), listens on
 * 127.0.0.1:`port` (before touching the server, so a port in use changes nothing), enables the
 * inspector and starts the helper, then serves connections until `signal` aborts. The helper
 * is removed in every case once the setup script has run.
 *
 * @throws CometError for a port in use, a stopped app, a failed setup, or an app container that
 *   was replaced while debugging
 */
export async function debugApp(ctx: CommandContext, o: DebugOptions): Promise<void> {
  await ctx.runner.run('meteor.debug', async () => {
    const c = ctx.config;
    const { server } = pickServer({ words: o.words, candidates: ctx.appServers(), usage: 'comet-deploy meteor debug <server>', wordsMayBeCommand: false });
    const listener = await listenLocal(o.port);
    const container = containerName(c);
    const helper = `${container}-debug`;
    let conn: SshConnection | undefined;
    try {
      conn = await ctx.ssh.get(server);
      const script = await cometScript('debug-start.sh', { container, helper, image: DEBUG_IMAGE, listenPort: DEBUG_PORT_IN_APP });
      const r = await conn.runScript(script);
      if (r.code !== 0) throw startError(r.code, r.stderr, container, server);
      const target = parseTarget(r.stdout);
      const port = (listener.address() as { port: number }).port;
      ctx.reporter.info(instructions(c.app.name, server, port));
      await serve(ctx, { listener, conn, server, container, helper, target, signal: o.signal });
    } finally {
      listener.close();
      if (conn) {
        const rm = await conn.exec(`sudo docker rm -f ${shArg(helper)}`).catch((e: unknown) => ({ code: 1, stdout: '', stderr: (e as Error).message }));
        if (rm.code !== 0) ctx.reporter.warn(`Could not remove the debugger helper "${helper}" on "${server}": ${rm.stderr.trim()}`);
      }
    }
  });
}
