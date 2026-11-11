import type { Duplex } from 'node:stream';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { ServerConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { buildConnectOptions } from './options.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  stdin?: string | NodeJS.ReadableStream;
}

/** Same as MUP: errors show the last 4200 characters of each stream. */
const OUTPUT_TAIL = 4200;

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

export class SshConnection {
  private sftpPromise?: Promise<SFTPWrapper>;
  private readonly forwards = new Map<number, (stream: Duplex) => void>();
  private closed = false;
  private dropped = false;

  private constructor(
    readonly name: string,
    readonly host: string,
    private readonly client: Client,
  ) {
    client.on('tcp connection', (info, accept, reject) => {
      const handler = this.forwards.get(info.destPort);
      if (handler) handler(accept());
      else reject();
    });
    // ssh2 emits these before it closes the open channels, so a command cut off by the drop sees `dropped`.
    const drop = () => void (this.dropped = true);
    client.on('end', drop);
    client.on('close', drop);
    client.on('error', drop);
  }

  /** False once the connection was closed or dropped (the server went away, the network failed…). */
  get isAlive(): boolean {
    return !this.closed && !this.dropped;
  }

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

  static connect(name: string, server: ServerConfig, o: { cwd: string; basePath: string }): Promise<SshConnection> {
    const options = buildConnectOptions(server, { ...o, env: process.env, name });
    return new Promise((resolve, reject) => {
      const client = new Client();
      let ready = false;
      client.once('ready', () => {
        ready = true;
        resolve(new SshConnection(name, server.host, client));
      });
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

  exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.call('cannot run a command', () => this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) return reject(this.dropped ? this.closedError('cannot run a command', err) : new CometError(`[${this.name}] Cannot run a command: ${err.message}`, { cause: err }));
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => {
          const s = d.toString('utf8');
          stdout += s;
          o.onStdout?.(s);
        });
        stream.stderr.on('data', (d: Buffer) => {
          const s = d.toString('utf8');
          stderr += s;
          o.onStderr?.(s);
        });
        stream.on('close', (code: number | null, signal?: string) => {
          // No exit status and the connection is gone: the command was cut off, it did not fail.
          if (code === null && !signal && this.dropped) return reject(this.closedError('a command was interrupted'));
          resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
        });
        if (typeof o.stdin === 'string') stream.end(o.stdin);
        else if (o.stdin) o.stdin.pipe(stream);
        else stream.end();
      }), reject);
    });
  }

  /** Runs a bash script fed on stdin (no quoting issues, no remote temp file). */
  runScript(script: string, o: ExecOptions = {}): Promise<ExecResult> {
    return this.exec('bash -s', { ...o, stdin: script });
  }

  async runScriptOrThrow(script: string, what: string, o: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.runScript(script, o);
    if (r.code !== 0) {
      throw new CometError(`[${this.name}] ${what} failed (exit code ${r.code}):\n${formatFailureOutput(r)}`);
    }
    return r;
  }

  private sftp(): Promise<SFTPWrapper> {
    this.sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => {
      this.call('cannot open SFTP', () => this.client.sftp((err, sftp) => (err ? reject(this.dropped ? this.closedError('cannot open SFTP', err) : new CometError(`[${this.name}] SFTP failed: ${err.message}`, { cause: err })) : resolve(sftp))), reject);
    });
    // A failed SFTP session is not cached: the next call tries again.
    this.sftpPromise.catch(() => (this.sftpPromise = undefined));
    return this.sftpPromise;
  }

  async writeFile(remotePath: string, content: string, mode?: number): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, content, mode === undefined ? {} : { mode }, (err) =>
        err ? reject(new CometError(`[${this.name}] Cannot write ${remotePath}: ${err.message}`, { cause: err })) : resolve(),
      );
    });
  }

  async putFile(localPath: string, remotePath: string, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, { step: onProgress ? (sent, _chunk, total) => onProgress(sent, total) : undefined }, (err) =>
        err ? reject(new CometError(`[${this.name}] Cannot upload ${localPath} to ${remotePath}: ${err.message}`, { cause: err })) : resolve(),
      );
    });
  }

  /**
   * Reverse port forward: connections to 127.0.0.1:<port> on the server are
   * handed to `onConnection`. `remotePort = 0` lets the server pick a port.
   */
  forwardIn(remotePort: number, onConnection: (stream: Duplex) => void): Promise<{ port: number; close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
      this.call('cannot open a reverse tunnel', () => this.client.forwardIn('127.0.0.1', remotePort, (err, bound) => {
        if (err) return reject(new CometError(`[${this.name}] Cannot open a reverse tunnel on port ${remotePort}: ${err.message}`, { cause: err }));
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
