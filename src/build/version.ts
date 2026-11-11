/**
 * Version tags. Every deploy gets a version that names its image locally and on the servers
 * (`mup-<app>:<version>`) and appears in the deploy history. Versions sort by build time.
 */

/**
 * Version tags: `YYYYMMDD-HHMMSS[-sha7][-dirty]` (UTC). Also used to validate a version before it
 * goes into a server command and to tell versions apart from other tags (`latest`, `previous`).
 */
export const VERSION_RE = /^\d{8}-\d{6}(-[0-9a-f]{7})?(-dirty)?$/;

/**
 * The version for a deploy that started at `d`, with the short git commit and `-dirty` when
 * `git` is given. UTC, so versions built on machines in different time zones still sort by time;
 * the sha is lowercased because `VERSION_RE` accepts only lowercase hex.
 */
export function makeVersion(d: Date, git?: { sha: string; dirty: boolean }): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  if (!git) return stamp;
  return `${stamp}-${git.sha.slice(0, 7).toLowerCase()}${git.dirty ? '-dirty' : ''}`;
}

/**
 * Git commit/branch/dirty of the app, or null outside a git repository. Runs `git` locally in
 * `appPath`; untracked files count as dirty (`git status --porcelain` lists them).
 */
export async function readGitInfo(appPath: string): Promise<{ sha: string; branch: string; dirty: boolean } | null> {
  const { run } = await import('../local/exec.js');
  const sha = await run('git', ['rev-parse', 'HEAD'], { cwd: appPath });
  if (sha.code !== 0) return null;
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: appPath });
  const status = await run('git', ['status', '--porcelain'], { cwd: appPath });
  return { sha: sha.stdout.trim(), branch: branch.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}
