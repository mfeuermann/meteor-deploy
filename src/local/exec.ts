import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Inherit stdio (output is shown, not captured). */
  inherit?: boolean;
  input?: string;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

/** Runs a local command without a shell. A missing command resolves with code 127. */
export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
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
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      outLines.push(d);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      errLines.push(d);
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(o.input ?? '');
    }
    child.on('error', (err) => done({ code: 127, stdout, stderr: stderr + err.message }));
    child.on('close', (code, signal) => {
      outLines.flush();
      errLines.flush();
      done({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}
