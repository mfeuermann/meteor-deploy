/**
 * `history`: reads the deploy history (`/opt/<name>/config/deploy-history.jsonl`) from every
 * selected app server and prints it as one table, with one row per deploy across all servers.
 * MUP keeps no history, so servers deployed only by MUP contribute nothing.
 */
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { mergeHistory, type MergedHistoryEntry } from '../../deploy/history.js';
import { formatDuration } from '../../output/reporter.js';
import { formatTable } from '../../output/table.js';
import { readHistory, type HistoryEntry } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';

const HEADER = ['TIME', 'ACTION', 'VERSION', 'RESULT', 'DURATION', 'BY', 'COMMIT', 'SERVERS'];

/**
 * An ISO timestamp as `YYYY-MM-DD HH:MM:SS` in `timeZone` (default: the local time zone).
 * A value that does not parse is shown as it is.
 */
function formatTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '-';
  // The Swedish locale formats as "YYYY-MM-DD HH:MM:SS"; no Intl option yields that directly.
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

/** One result, or the results per server when they differ ("success: one+two, reverted: three"). */
function formatResult(e: MergedHistoryEntry): string {
  const groups = new Map<HistoryEntry['result'], string[]>();
  for (const [server, result] of Object.entries(e.resultBy ?? {})) groups.set(result, [...(groups.get(result) ?? []), server]);
  if (groups.size <= 1) return e.result;
  return [...groups].map(([result, servers]) => `${result}: ${servers.join('+')}`).join(', ');
}

/** `<sha7> <branch> [dirty]`, or `-` for a deploy made outside a git work tree. */
function formatCommit(e: HistoryEntry): string {
  if (!e.git?.commit) return '-';
  return [e.git.commit.slice(0, 7), e.git.branch, e.git.dirty ? 'dirty' : ''].filter(Boolean).join(' ');
}

/**
 * The `history` table: `TIME  ACTION  VERSION  RESULT  DURATION  BY  COMMIT  SERVERS`, each
 * column padded to its widest cell. `o.timeZone` fixes the time zone (for tests); the default
 * is the local one.
 */
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
  return formatTable(HEADER, data);
}

/**
 * Reads the history of every app server in parallel, merges it and prints the table. A
 * server whose history cannot be read only produces a warning, so one unreachable server does
 * not hide the history of the others.
 */
async function history(ctx: CommandContext, argv: Record<string, unknown>): Promise<void> {
  // The newest `limit` entries of each server are enough for the newest `limit` merged rows.
  const limit = Number(argv.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1) throw new CometError('--limit must be a whole number of 1 or more');
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

/** `history [--limit <n>]`, a comet-deploy command (MUP has no equivalent). */
export const historyCommand: ConfigCommand = {
  command: 'history',
  describe: 'Show the deploy history (who deployed what and when)',
  builder: (y) => y.option('limit', { type: 'number', default: 20, describe: 'Number of entries' }),
  run: history,
};
