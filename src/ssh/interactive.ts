/**
 * An interactive command or shell on a server with the local terminal attached (`mongo shell`,
 * `ssh`). In a terminal the session gets a pseudo-terminal of the window's
 * size and follows resizes, and the local terminal is in raw mode, so keys such as Ctrl+C go to
 * the remote program. Piped input (a script, a test) gets plain pipes instead.
 */
import type { SshConnection } from './connection.js';

/** The local streams; `process` by default. */
export interface LocalTerminal {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): unknown; pause?(): unknown };
  stdout: NodeJS.WritableStream & { rows?: number; columns?: number; on(event: 'resize', fn: () => void): unknown; off(event: 'resize', fn: () => void): unknown };
  stderr: NodeJS.WritableStream;
}

const processTerminal = (): LocalTerminal => ({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });

/**
 * Runs `command(tty)` on `conn` with the local terminal attached and returns its exit status;
 * `command: null` opens the SSH user's login shell instead (`conn.shell`). `tty` says whether a
 * pseudo-terminal is used, so the command can ask for one itself (e.g. `docker exec -it`
 * against `-i`). Raw mode and the resize listener are always undone, also
 * when the session fails.
 */
export async function runInteractive(conn: SshConnection, command: ((tty: boolean) => string) | null, term: LocalTerminal = processTerminal()): Promise<number> {
  const tty = term.stdin.isTTY === true && typeof term.stdin.setRawMode === 'function';
  const size = () => ({ rows: term.stdout.rows ?? 24, cols: term.stdout.columns ?? 80 });
  let onResize: (() => void) | undefined;
  try {
    if (tty) term.stdin.setRawMode!(true);
    const o = {
      pty: tty ? { ...size(), term: process.env.TERM || 'xterm' } : undefined,
      stdin: term.stdin,
      stdout: term.stdout,
      stderr: term.stderr,
      onChannel: (resize) => {
        if (!tty) return;
        onResize = () => resize(size().rows, size().cols);
        term.stdout.on('resize', onResize);
      },
    };
    return await (command === null ? conn.shell(o) : conn.interactive(command(tty), o));
  } finally {
    if (onResize) term.stdout.off('resize', onResize);
    if (tty) term.stdin.setRawMode!(false);
    // process.stdin keeps the process alive while it flows.
    term.stdin.pause?.();
  }
}
