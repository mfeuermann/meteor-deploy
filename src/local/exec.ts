/**
 * Runs local commands (docker, meteor, git) as child processes. No shell is involved, so
 * arguments never need quoting, and a command's failure is reported as an exit code instead of
 * an exception.
 */
import { spawn } from 'node:child_process';

export interface RunResult {
  /** Exit code; 127 when the command could not be started, 128 when a signal killed it. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Environment of the command; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Inherit stdio (output is shown, not captured). */
  inherit?: boolean;
  /** Written to stdin. stdin is closed either way, so a command that reads it never waits. */
  input?: string;
  /**
   * Called once per output line, without the line break (`\r\n` included), and once more for an
   * unterminated last line when the command exits.
   */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Runs a local command without a shell and resolves with its exit code and output; it never
 * rejects. A command that cannot be started (not found, not executable) resolves with code 127,
 * as in a shell, with the spawn error appended to `stderr`.
 */
export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // A failed spawn can emit both 'error' and 'close'; the first one decides.
    let settled = false;
    const done = (r: RunResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      stdio: o.inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });
    const lineSplitter = (stream: 'stdout' | 'stderr') => {
      let buf = '';
      return {
        push(chunk: string) {
          if (!o.onLine) return;
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            o.onLine(buf.slice(0, nl).replace(/\r$/, ''), stream);
            buf = buf.slice(nl + 1);
          }
        },
        flush() {
          if (o.onLine && buf) o.onLine(buf, stream);
          buf = '';
        },
      };
    };
    const outLines = lineSplitter('stdout');
    const errLines = lineSplitter('stderr');
    // setEncoding decodes across chunk boundaries, so a multi-byte character is never split.
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      outLines.push(d);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      errLines.push(d);
    });
    if (child.stdin) {
      // EPIPE when the command exits without reading stdin; its exit code tells what happened.
      child.stdin.on('error', () => {});
      child.stdin.end(o.input ?? '');
    }
    child.on('error', (err) => done({ code: 127, stdout, stderr: stderr + err.message }));
    // 'close' (not 'exit') fires after the output streams ended, so all output is collected.
    child.on('close', (code, signal) => {
      outLines.flush();
      errLines.flush();
      done({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}
