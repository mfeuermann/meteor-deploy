/** Version tags: `YYYYMMDD-HHMMSS[-sha7][-dirty]` (UTC). */
export const VERSION_RE = /^\d{8}-\d{6}(-[0-9a-f]{7})?(-dirty)?$/;

export function makeVersion(d: Date, git?: { sha: string; dirty: boolean }): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  if (!git) return stamp;
  return `${stamp}-${git.sha.slice(0, 7).toLowerCase()}${git.dirty ? '-dirty' : ''}`;
}

/** Git commit/branch/dirty of the app, or null outside a git repository. */
export async function readGitInfo(appPath: string): Promise<{ sha: string; branch: string; dirty: boolean } | null> {
  const { run } = await import('../local/exec.js');
  const sha = await run('git', ['rev-parse', 'HEAD'], { cwd: appPath });
  if (sha.code !== 0) return null;
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: appPath });
  const status = await run('git', ['status', '--porcelain'], { cwd: appPath });
  return { sha: sha.stdout.trim(), branch: branch.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}
