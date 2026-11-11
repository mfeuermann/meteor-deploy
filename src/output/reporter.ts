/**
 * Console output for all commands: phases with durations, per-server step lines, warnings and
 * errors, `--verbose` remote output and the summary table. Every line goes through secret
 * masking, so values registered with `addSecrets` never reach the terminal or a CI log.
 */
import pc from 'picocolors';
import { maskSecrets } from './secrets.js';

/**
 * State of one server in a step or in the summary. `reverted`: the new version failed and the
 * server was switched back to the version it ran before.
 */
export type ServerStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'reverted';

/** One row of the summary table printed at the end of a rollout. */
export interface SummaryRow {
  server: string;
  version?: string;
  result: ServerStatus;
  durationMs?: number;
  /** Free text, e.g. the reason a server failed. */
  note?: string;
}

/** The output sink commands write to. Created by `createReporter`; tests pass their own. */
export interface Reporter {
  /**
   * Runs `fn` between a `==> name` and a `<== name (duration)` line and records the duration.
   * When `fn` throws, prints `<== name failed (duration)` and rethrows.
   */
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Prints `[server] step <symbol> detail`. */
  server(server: string, step: string, status: ServerStatus, detail?: string): void;
  info(msg: string): void;
  /** Prints `Warning: <msg>`. */
  warn(msg: string): void;
  /** Prints `Error: <msg>`. */
  error(msg: string): void;
  /** Prints one line of command output in verbose mode only. `server` null: local, no prefix. */
  verboseLine(server: string | null, line: string): void;
  summary(rows: SummaryRow[]): void;
  /** Durations of the phases run so far, in order (failed phases included). */
  phaseTimings(): Array<{ name: string; durationMs: number }>;
  /** Registers values to mask in every later line (see collectSecrets). Duplicates are ignored. */
  addSecrets(values: string[]): void;
  /** Masks registered secrets in text printed outside the reporter (e.g. top-level errors). */
  mask(text: string): string;
  readonly verbose: boolean;
}

/** `12.3s` below a minute, `4m05s` from one minute on. */
export function formatDuration(ms: number): string {
  // 59.95 s would print as "60.0s"; from there on whole seconds, rounded before the split so
  // that 119.6 s becomes 2m00s rather than 1m60s.
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

const SYMBOL: Record<ServerStatus, string> = {
  pending: '…',
  running: '→',
  ok: '✓',
  failed: '✗',
  skipped: '-',
  reverted: '↺',
};

/**
 * Creates the standard reporter. `tty` only decides whether lines are colored: output is
 * always plain appended lines, so it reads the same in a terminal and in a CI log. `write`
 * defaults to stdout and `now` to `Date.now`; tests replace both.
 */
export function createReporter(opts: {
  verbose: boolean;
  tty: boolean;
  write?: (s: string) => void;
  now?: () => number;
}): Reporter {
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const now = opts.now ?? (() => Date.now());
  const secrets: string[] = [];
  const timings: Array<{ name: string; durationMs: number }> = [];
  const color = opts.tty ? pc : pc.createColors(false);

  const out = (line: string) => write(maskSecrets(line, secrets) + '\n');

  const statusColor = (s: ServerStatus, text: string) => {
    if (s === 'ok') return color.green(text);
    if (s === 'failed') return color.red(text);
    if (s === 'reverted') return color.yellow(text);
    if (s === 'skipped') return color.dim(text);
    return text;
  };

  return {
    verbose: opts.verbose,
    async phase(name, fn) {
      const start = now();
      out(color.bold(`==> ${name}`));
      try {
        const result = await fn();
        const d = now() - start;
        timings.push({ name, durationMs: d });
        out(color.bold(`<== ${name} (${formatDuration(d)})`));
        return result;
      } catch (err) {
        const d = now() - start;
        timings.push({ name, durationMs: d });
        out(color.red(`<== ${name} failed (${formatDuration(d)})`));
        throw err;
      }
    },
    server(server, step, status, detail) {
      const parts = [`[${server}]`, step, statusColor(status, SYMBOL[status])];
      if (detail) parts.push(detail);
      out(parts.join(' '));
    },
    info(msg) {
      out(msg);
    },
    warn(msg) {
      out(color.yellow(`Warning: ${msg}`));
    },
    error(msg) {
      out(color.red(`Error: ${msg}`));
    },
    verboseLine(server, line) {
      if (!opts.verbose) return;
      out(color.dim(server ? `[${server}] ${line}` : line));
    },
    summary(rows) {
      const header = ['SERVER', 'VERSION', 'RESULT', 'TIME', 'NOTE'];
      const data = rows.map((r) => [
        r.server,
        r.version ?? '-',
        r.result,
        r.durationMs === undefined ? '-' : formatDuration(r.durationMs),
        r.note ?? '',
      ]);
      // Widths come from the plain text; the header is colored only after padding, so the
      // escape codes do not shift the columns.
      const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
      const fmt = (cols: string[]) =>
        cols
          .map((c, i) => c.padEnd(widths[i]))
          .join('  ')
          .trimEnd();
      out('');
      out(color.bold(fmt(header)));
      for (const d of data) out(fmt(d));
    },
    phaseTimings() {
      return [...timings];
    },
    addSecrets(values) {
      for (const v of values) if (!secrets.includes(v)) secrets.push(v);
    },
    mask(text) {
      return maskSecrets(text, secrets);
    },
  };
}
