/**
 * Which image a server rolls back to. Every deploy leaves its image on the server as
 * `mup-<app>:<version>` (the newest `keepVersions` are kept), so a rollback is only a retag and a
 * restart; this module picks the tag. `rollbackPipeline` does the rest.
 */
import type { ImageVersions } from '../remote/ops.js';

/**
 * A kept version tag, MUP's `:previous` image (which has no version tag), or nothing, with the
 * reason shown to the user.
 */
export type RollbackTarget = { kind: 'version'; tag: string } | { kind: 'previous' } | { kind: 'none'; reason: string };

/**
 * Picks what one server rolls back to:
 * - `to` → that kept version, if it is on the server;
 * - otherwise the newest kept version older than the one that runs
 *   (when `:latest` is no kept version — MUP deployed in between — the newest kept one);
 * - otherwise `:previous` (servers deployed by MUP), if it is another image.
 *
 * `ranOk` (the versions that ran healthy on this server, from its deploy
 * history) limits the automatic choice to versions known to work, so a
 * rollback never lands on a build that failed. Without it (no history) every
 * kept version is a candidate. An explicit `to` is never filtered.
 */
export function chooseRollbackTarget(v: ImageVersions, to?: string, ranOk?: ReadonlySet<string>): RollbackTarget {
  const available = v.versions.map((x) => x.tag);
  if (to !== undefined) {
    if (available.includes(to)) return { kind: 'version', tag: to };
    return { kind: 'none', reason: `Version ${to} is not on this server. Available: ${available.length ? available.join(', ') : 'none'}` };
  }
  // `versions` is newest first, so the candidates are the tags older than the running one.
  const running = v.versions.findIndex((x) => x.id === v.latestId);
  const candidates = running >= 0 ? v.versions.slice(running + 1) : v.versions;
  // Skip other tags of the running image itself: rolling back to it would change nothing.
  const older = candidates.find((x) => x.id !== v.latestId && (!ranOk || ranOk.has(x.tag)));
  if (older) return { kind: 'version', tag: older.tag };
  if (v.previousId && v.previousId !== v.latestId) return { kind: 'previous' };
  return { kind: 'none', reason: 'Nothing to roll back to: no older version and no :previous image on this server' };
}
