import pc from 'picocolors';
import { maskSecrets } from './secrets.js';

export type ServerStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'reverted';

export interface SummaryRow {
  server: string;
  version?: string;
  result: ServerStatus;
  durationMs?: number;
  note?: string;
}

export interface Reporter {
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;
  server(server: string, step: string, status: ServerStatus, detail?: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  verboseLine(server: string | null, line: string): void;
  summary(rows: SummaryRow[]): void;
  phaseTimings(): Array<{ name: string; durationMs: number }>;
  addSecrets(values: string[]): void;
  /** Masks registered secrets in text printed outside the reporter (e.g. top-level errors). */
  mask(text: string): string;
  readonly verbose: boolean;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

const SYMBOL: Record<ServerStatus, string> = {
  pending: '…',
  running: '→',
  ok: '✓',
  failed: '✗',
  skipped: '-',
  reverted: '↺',
};

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
