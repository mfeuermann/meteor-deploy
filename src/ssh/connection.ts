/**
 * One SSH connection to a server, built on ssh2: remote commands (scripts are fed to `bash -s`
 * on stdin), SFTP writes and reverse port forwards for the registry tunnel. It turns ssh2's
 * failure modes (a synchronous "Not connected" throw, a channel that closes without an exit
 * status when the connection drops) into CometErrors with a clear message.
 */
import type { Duplex } from 'node:stream';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { ServerConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { buildConnectOptions } from './options.js';

export interface ExecResult {
  /** Exit status; 128 when a signal ended the command, 1 when the server sent no status. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Called with each decoded chunk as it arrives (not split into lines). */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * Written to the command's stdin, which is then closed (a stream is piped). Without it stdin is
   * closed at once, so a command that reads it does not wait.
   */
  stdin?: string | NodeJS.ReadableStream;
  /** Called once when the command has ended, after the last output chunk (to flush partial lines). */
  onClose?: () => void;
  /**
   * `false`: the output only goes to the callbacks and the result's `stdout`/`stderr` stay
   * empty, so an endless stream such as `docker logs -f` does not grow in memory.
   */
  collect?: boolean;
}

/** Same as MUP: errors show the last 4200 characters of each stream. */
const OUTPUT_TAIL = 4200;

/** The block MUP prints for a failed remote command: the tails of stderr and stdout. */
export function formatFailureOutput(r: ExecResult): string {
  const tail = (s: string) => s.substring(s.length - OUTPUT_TAIL).trimEnd();
  return [
    '------------------------------------STDERR------------------------------------',
    tail(r.stderr),
    '------------------------------------STDOUT------------------------------------',
    tail(r.stdout),
    '------------------------------------------------------------------------------',
  ].join('\n');
}

/**
 * An open, authenticated SSH connection to one server (create it with `SshConnection.connect`).
 * After the connection drops, every method fails with a CometError instead of hanging or throwing
 * a raw ssh2 error, and `isAlive` turns false so `SshPool` opens a new one.
 */
export class SshConnection {
  /** The SFTP session, opened on first use and shared by all file operations. */
  private sftpPromise?: Promise<SFTPWrapper>;
  /** Reverse forward handlers by the port bound on the server. */
  private readonly forwards = new Map<number, (stream: Duplex) => void>();
  /** `close()` was called. */
  private closed = false;
  /** ssh2 reported that the connection ended, closed or failed. */
  private dropped = false;
  /**
   * Rejects of the SFTP requests waiting for an answer. ssh2 never answers a request sent after
   * the connection died, so the drop rejects them instead of leaving the deploy hanging.
   */
  private readonly pendingFileOps = new Set<(err: CometError) => void>();

  private constructor(
    readonly name: string,
    readonly host: string,
    private readonly client: Client,
  ) {
    // ssh2 emits 'tcp connection' for each connection the server accepts on a port forwarded with
    // `forwardIn`; `info.destPort` is the bound port (ssh2 corrects servers that report 0). One
    // listener serves all forwards; a connection to a port without a handler is rejected.
    client.on('tcp connection', (info, accept, reject) => {
      const handler = this.forwards.get(info.destPort);
      if (handler) handler(accept());
      else reject();
    });
    // ssh2 emits these before it closes the open channels, so a command cut off by the drop sees `dropped`.
    const drop = () => {
      this.dropped = true;
      this.sftpPromise = undefined;
      for (const fail of this.pendingFileOps) fail(this.closedError('a file transfer was interrupted'));
      this.pendingFileOps.clear();
    };
    client.on('end', drop);
    client.on('close', drop);
    client.on('error', drop);
  }

  /** False once the connection was closed or dropped (the server went away, the network failed…). */
  get isAlive(): boolean {
    return !this.closed && !this.dropped;
  }

  /** The error for an operation that failed because the connection is gone. */
  private closedError(what: string, cause?: unknown): CometError {
    return new CometError(`[${this.name}] The SSH connection to ${this.host} closed: ${what}`, {
      hint: 'Check the network and the server, then run the command again.',
      cause,
    });
  }

  /**
   * Calls an ssh2 method that throws synchronously ("Not connected") when the
   * socket is gone, turning that into a CometError instead of a stack trace.
   */
  private call(what: string, fn: () => void, reject: (err: unknown) => void): void {
    if (!this.isAlive) return reject(this.closedError(what));
    try {
      fn();
    } catch (err) {
      reject(this.closedError(what, err));
    }
  }

  /**
   * Opens and authenticates a connection to `server` (options from `buildConnectOptions`).
   * Rejects with a CometError when the authentication settings are invalid (before any
   * connection attempt) or when the connection or the authentication fails.
   */
  static async connect(name: string, server: ServerConfig, o: { cwd: string; basePath: string }): Promise<SshConnection> {
    const options = buildConnectOptions(server, { ...o, env: process.env, name });
    return new Promise((resolve, reject) => {
      const client = new Client();
      let ready = false;
      client.once('ready', () => {
        ready = true;
        resolve(new SshConnection(name, server.host, client));
      });
      // This listener stays for the life of the client: an 'error' event without a listener
      // would crash the process. After 'ready' the connection's own `drop` listener handles it.
      client.on('error', (err) => {
        if (!ready) {
          reject(
            new CometError(`Cannot connect to server "${name}" (${server.host}:${options.port}): ${err.message}`, {
              hint: 'Check host, port, username and the SSH key/password in the config.',
              cause: err,
            }),
          );
        }
      });
      client.connect(options);
    });
  }

  /**
   * Runs `command` on the server (through the SSH user's shell, like `ssh host command`) and
   * resolves with its exit status and output; a non-zero exit is not an error here. Rejects with
   * a CometError when no channel can be opened or the connection drops before the command exits.
   */
  exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.call('cannot run a command', () => this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) return reject(this.dropped ? this.closedError('cannot run a command', err) : new CometError(`[${this.name}] Cannot run a command: ${err.message}`, { cause: err }));
        let stdout = '';
        let stderr = '';
        // The streams' decoders keep a multi-byte character that is split across two chunks
        // together; Buffer#toString per chunk would garble it.
        stream.setEncoding('utf8');
        stream.stderr.setEncoding('utf8');
        const collect = o.collect !== false;
        stream.on('data', (s: string) => {
          if (collect) stdout += s;
          o.onStdout?.(s);
        });
        stream.stderr.on('data', (s: string) => {
          if (collect) stderr += s;
          o.onStderr?.(s);
        });
        // Like a child process, ssh2 passes the exit status (or signal) to the channel's 'close';
        // the code is null when the server sent no exit status.
        stream.on('close', (code: number | null, signal?: string) => {
          o.onClose?.();
          // No exit status and the connection is gone: the command was cut off, it did not fail.
          if (code === null && !signal && this.dropped) return reject(this.closedError('a command was interrupted'));
          resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
        });
        // Ending stdin sends EOF, which `bash -s` needs to finish reading its script.
        if (typeof o.stdin === 'string') stream.end(o.stdin);
        else if (o.stdin) o.stdin.pipe(stream);
        else stream.end();
      }), reject);
    });
  }

  /**
   * Runs a bash script fed on stdin (no quoting issues, no remote temp file). The script is not
   * part of the command line, so it also never shows up in the server's process list.
   */
  runScript(script: string, o: ExecOptions = {}): Promise<ExecResult> {
    return this.exec('bash -s', { ...o, stdin: script });
  }

  /**
   * Like `runScript`, but a non-zero exit throws a CometError
   * `[<server>] <what> failed (exit code N)` followed by MUP's output block.
   */
  async runScriptOrThrow(script: string, what: string, o: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.runScript(script, o);
    if (r.code !== 0) {
      throw new CometError(`[${this.name}] ${what} failed (exit code ${r.code}):\n${formatFailureOutput(r)}`);
    }
    return r;
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpPromise) return this.sftpPromise;
    const opening = new Promise<SFTPWrapper>((resolve, reject) => {
      this.call('cannot open SFTP', () => this.client.sftp((err, sftp) => {
        if (err) return reject(this.dropped ? this.closedError('cannot open SFTP', err) : new CometError(`[${this.name}] SFTP failed: ${err.message}`, { cause: err }));
        // A session the server closed is not reused: the next call opens a new one.
        sftp.on('close', () => {
          if (this.sftpPromise === opening) this.sftpPromise = undefined;
        });
        resolve(sftp);
      }), reject);
    });
    this.sftpPromise = opening;
    // A failed SFTP session is not cached: the next call tries again.
    opening.catch(() => {
      if (this.sftpPromise === opening) this.sftpPromise = undefined;
    });
    return opening;
  }

  /**
   * Sends one SFTP request and waits for its answer. Rejects with the connection's closed error
   * when the connection is already gone or drops before the answer (ssh2 would never call back),
   * and with `failed(err)` when the server reports an error.
   */
  private async sftpRequest(what: string, send: (sftp: SFTPWrapper, done: (err?: Error | null) => void) => void, failed: (err: Error) => CometError): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      if (!this.isAlive) return reject(this.closedError(what));
      this.pendingFileOps.add(reject);
      const settle = (err?: Error | null) => {
        this.pendingFileOps.delete(reject);
        if (!err) resolve();
        else reject(this.dropped ? this.closedError(what, err) : failed(err));
      };
      try {
        send(sftp, settle);
      } catch (err) {
        settle(err as Error);
      }
    });
  }

  /**
   * Writes `content` to `remotePath` over SFTP, as the SSH user (no sudo), replacing the file,
   * and sets its permissions to `mode` when given.
   *
   * @throws CometError when the file cannot be written.
   */
  async writeFile(remotePath: string, content: string, mode?: number): Promise<void> {
    const what = `cannot write ${remotePath}`;
    const failed = (err: Error) => new CometError(`[${this.name}] Cannot write ${remotePath}: ${err.message}`, { cause: err });
    await this.sftpRequest(what, (sftp, done) => sftp.writeFile(remotePath, content, mode === undefined ? {} : { mode }, done), failed);
    if (mode === undefined) return;
    // OpenSSH's SFTP server applies the open request's mode only when it creates the file, so
    // an existing env.list written by MUP with 0644 would keep exposing its secrets.
    await this.sftpRequest(what, (sftp, done) => sftp.chmod(remotePath, mode, done), failed);
  }

  /**
   * Uploads a local file over SFTP with ssh2's `fastPut` (several chunks in flight at once).
   * `onProgress` receives the bytes sent so far and the total size.
   *
   * @throws CometError when the upload fails.
   */
  async putFile(localPath: string, remotePath: string, onProgress?: (sent: number, total: number) => void): Promise<void> {
    await this.sftpRequest(
      `cannot upload ${localPath}`,
      (sftp, done) => sftp.fastPut(localPath, remotePath, { step: onProgress ? (sent, _chunk, total) => onProgress(sent, total) : undefined }, done),
      (err) => new CometError(`[${this.name}] Cannot upload ${localPath} to ${remotePath}: ${err.message}`, { cause: err }),
    );
  }

  /**
   * Reverse port forward: connections to 127.0.0.1:<port> on the server are
   * handed to `onConnection`. `remotePort = 0` lets the server pick a port.
   *
   * The forward binds on the server's loopback only, so it is not reachable from the network.
   * `close()` asks the server to stop listening; connections that are already open stay open.
   * Rejects with a CometError when the server refuses the forward.
   */
  forwardIn(remotePort: number, onConnection: (stream: Duplex) => void): Promise<{ port: number; close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
      this.call('cannot open a reverse tunnel', () => this.client.forwardIn('127.0.0.1', remotePort, (err, bound) => {
        if (err) return reject(new CometError(`[${this.name}] Cannot open a reverse tunnel on port ${remotePort}: ${err.message}`, { cause: err }));
        // ssh2 passes the port the server bound, which is the one it picked when we asked for 0.
        const port = bound || remotePort;
        this.forwards.set(port, onConnection);
        resolve({
          port,
          close: () =>
            new Promise<void>((res) => {
              this.forwards.delete(port);
              if (!this.isAlive) return res();
              try {
                this.client.unforwardIn('127.0.0.1', port, () => res());
              } catch {
                res(); // the connection went away meanwhile: nothing left to unforward
              }
            }),
        });
      }), reject);
    });
  }

  /**
   * Ends the connection and waits until ssh2 reports it closed. Calling it again, or after the
   * connection dropped, resolves at once: ssh2 may already have emitted 'close', and waiting for
   * it again would never finish.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const wasDropped = this.dropped;
    this.closed = true;
    if (wasDropped) return Promise.resolve();
    return new Promise((resolve) => {
      this.client.once('close', () => resolve());
      this.client.end();
    });
  }
}
