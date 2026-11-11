/**
 * `--verbose` support: turns the chunked stdout/stderr of a remote command into whole lines
 * for the reporter, the way MUP streams remote output in verbose mode.
 */
import type { ExecOptions } from '../ssh/connection.js';
import type { Reporter } from './reporter.js';

/**
 * Turns a chunked stream into whole lines. SSH data chunks do not follow line boundaries, so
 * text is buffered until its newline arrives; `flush` emits a last line that has none.
 */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

/**
 * Exec callbacks that stream remote output line by line to `reporter.verboseLine(server, …)`,
 * or no callbacks at all when the reporter is not verbose. Pass the result to
 * `SshConnection.exec`.
 */
export function verboseOutput(reporter: Reporter, server: string): ExecOptions {
  if (!reporter.verbose) return {};
  // One splitter per stream, so stdout and stderr are never glued into one line.
  const out = lineSplitter((l) => reporter.verboseLine(server, l));
  const err = lineSplitter((l) => reporter.verboseLine(server, l));
  return {
    onStdout: out.push,
    onStderr: err.push,
    onClose: () => {
      out.flush();
      err.flush();
    },
  };
}
