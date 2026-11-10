import type { CommandContext } from '../../core/context.js';
import { mergeHistory, type MergedHistoryEntry } from '../../deploy/history.js';
import { formatDuration } from '../../output/reporter.js';
import { readHistory, type HistoryEntry } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';

const HEADER = ['TIME', 'ACTION', 'VERSION', 'RESULT', 'DURATION', 'BY', 'COMMIT', 'SERVERS'];

function formatTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '-';
  // sv-SE renders as "YYYY-MM-DD HH:MM:SS"
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

/** One result, or the results per server when they differ ("success: one+two, reverted: three"). */
function formatResult(e: MergedHistoryEntry): string {
  const groups = new Map<HistoryEntry['result'], string[]>();
  for (const [server, result] of Object.entries(e.resultBy ?? {})) groups.set(result, [...(groups.get(result) ?? []), server]);
  if (groups.size <= 1) return e.result;
  return [...groups].map(([result, servers]) => `${result}: ${servers.join('+')}`).join(', ');
}

function formatCommit(e: HistoryEntry): string {
  if (!e.git?.commit) return '-';
  return [e.git.commit.slice(0, 7), e.git.branch, e.git.dirty ? 'dirty' : ''].filter(Boolean).join(' ');
}

/** The `history` table: `TIME  ACTION  VERSION  RESULT  DURATION  BY  COMMIT  SERVERS`. */
export function formatHistoryTable(rows: MergedHistoryEntry[], o: { timeZone?: string } = {}): string {
  if (rows.length === 0) return 'No deploy history on the selected servers.';
  const data = rows.map((e) => [
    formatTime(e.startedAt, o.timeZone),
    e.action,
    e.version ?? '-',
    formatResult(e),
    typeof e.durationMs === 'number' ? formatDuration(e.durationMs) : '-',
    `${e.user ?? '?'}@${e.machine ?? '?'}`,
    formatCommit(e),
    e.reportedBy.join(', '),
  ]);
  const widths = HEADER.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmt = (cols: string[]) =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [fmt(HEADER), ...data.map(fmt)].join('\n');
}

async function history(ctx: CommandContext, argv: Record<string, unknown>): Promise<void> {
  const limit = Math.max(1, Math.floor(Number(argv.limit ?? 20)) || 20);
  const servers = ctx.appServers();
  const perServer: Record<string, HistoryEntry[]> = {};
  await Promise.all(
    servers.map(async (s) => {
      try {
        perServer[s] = await readHistory(await ctx.ssh.get(s), ctx.config.app.name, limit);
      } catch (err) {
        ctx.reporter.warn(`Could not read the history on "${s}": ${(err as Error).message}`);
      }
    }),
  );
  ctx.reporter.info(formatHistoryTable(mergeHistory(perServer, limit)));
}

export const historyCommand: ConfigCommand = {
  command: 'history',
  describe: 'Show the deploy history (who deployed what and when)',
  builder: (y) => y.option('limit', { type: 'number', default: 20, describe: 'Number of entries' }),
  run: history,
};
