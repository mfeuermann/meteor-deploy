import { spawnSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import type { readGitInfo } from '../build/version.js';
import { TOOL_ID } from '../core/version.js';
import type { HistoryEntry } from '../remote/ops.js';

let cachedUser: string | undefined;

/** git `user.name`, otherwise the OS user. */
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

export type MergedHistoryEntry = HistoryEntry & { reportedBy: string[]; resultBy: Record<string, HistoryEntry['result']> };

/** One row per deploy (same startedAt + version + action), newest first; `resultBy` keeps each server's result. */
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
