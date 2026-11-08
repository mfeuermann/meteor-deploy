/** Version tags: `YYYYMMDD-HHMMSS[-sha7][-dirty]` (UTC). */
export const VERSION_RE = /^\d{8}-\d{6}(-[0-9a-f]{7})?(-dirty)?$/;

export function makeVersion(d: Date, git?: { sha: string; dirty: boolean }): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  if (!git) return stamp;
  return `${stamp}-${git.sha.slice(0, 7).toLowerCase()}${git.dirty ? '-dirty' : ''}`;
}
