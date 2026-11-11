/**
 * The deploy history kept on every server in `/opt/<app>/config/deploy-history.jsonl`: building
 * the entries the pipelines append, merging the per-server files for `history`, and reading which
 * versions ran healthy, which drives pruning and the automatic rollback target.
 */
import { spawnSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import type { readGitInfo } from '../build/version.js';
import { TOOL_ID } from '../core/version.js';
import type { HistoryEntry } from '../remote/ops.js';

let cachedUser: string | undefined;

/**
 * Who deploys, for history entries and lock records: git `user.name` (read once per process with
 * a local `git config`), otherwise the OS user.
 */
export function deployerName(): string {
  if (cachedUser) return cachedUser;
  const git = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' });
  const name = git.status === 0 ? git.stdout.trim() : '';
  let os = 'unknown';
  try {
    os = userInfo().username;
  } catch {
    // no passwd entry (some containers)
  }
  cachedUser = name || os;
  return cachedUser;
}

/**
 * One history entry for one server. `startedAt` is the start of the whole run and `servers` all
 * servers of the run, the same on every server, so `mergeHistory` can join the entries again.
 * `version` is null when the action did not name one (reconfig, restart, rollback to :previous).
 */
export function makeHistoryEntry(o: {
  action: HistoryEntry['action'];
  version: string | null;
  result: HistoryEntry['result'];
  startedAt: Date;
  durationMs: number;
  git: Awaited<ReturnType<typeof readGitInfo>>;
  servers: string[];
}): HistoryEntry {
  const e: HistoryEntry = {
    version: o.version,
    action: o.action,
    result: o.result,
    startedAt: o.startedAt.toISOString(),
    durationMs: o.durationMs,
    user: deployerName(),
    machine: hostname(),
    servers: o.servers,
    tool: TOOL_ID,
  };
  if (o.git) e.git = { commit: o.git.sha, branch: o.git.branch, dirty: o.git.dirty };
  return e;
}

/**
 * One run as seen by all servers: `reportedBy` lists the servers whose history has the entry,
 * `resultBy` each one's result. The other fields come from the first server read.
 */
export type MergedHistoryEntry = HistoryEntry & { reportedBy: string[]; resultBy: Record<string, HistoryEntry['result']> };

/**
 * One row per run (same startedAt + version + action), newest first, at most `limit` rows;
 * `resultBy` keeps each server's result. ISO 8601 UTC timestamps sort correctly as strings.
 */
export function mergeHistory(perServer: Record<string, HistoryEntry[]>, limit: number): MergedHistoryEntry[] {
  const byKey = new Map<string, MergedHistoryEntry>();
  for (const [server, entries] of Object.entries(perServer)) {
    for (const e of entries) {
      const key = `${e.startedAt}\0${e.version}\0${e.action}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.reportedBy.includes(server)) existing.reportedBy.push(server);
        existing.resultBy[server] = e.result;
      } else {
        byKey.set(key, { ...e, reportedBy: [server], resultBy: { [server]: e.result } });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)).slice(0, Math.max(0, limit));
}

/**
 * What the history of ONE server says about its version tags: `succeeded`
 * ran healthy at least once (deploy or rollback); `failedOnly` were deployed
 * there but never ran healthy (failed or reverted). Tags without any entry
 * (e.g. `meteor push` without activation) are in neither set.
 */
export function versionOutcomes(entries: HistoryEntry[]): { succeeded: Set<string>; failedOnly: Set<string> } {
  const succeeded = new Set<string>();
  const failed = new Set<string>();
  for (const e of entries) {
    if (!e.version || (e.action !== 'deploy' && e.action !== 'rollback')) continue;
    if (e.result === 'success') succeeded.add(e.version);
    else failed.add(e.version);
  }
  return { succeeded, failedOnly: new Set([...failed].filter((v) => !succeeded.has(v))) };
}
