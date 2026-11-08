import type { ExecOptions } from '../ssh/connection.js';
import type { Reporter } from './reporter.js';

/** Streams remote output line by line to `reporter.verboseLine(server, …)`. */
export function verboseOutput(reporter: Reporter, server: string): ExecOptions {
  if (!reporter.verbose) return {};
  const splitter = () => {
    let buf = '';
    return (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        reporter.verboseLine(server, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    };
  };
  return { onStdout: splitter(), onStderr: splitter() };
}
