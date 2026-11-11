/**
 * The global `--servers` filter: parsing the flag and applying it to a list of server names.
 * Commands use it to act on a subset of the configured servers.
 */
import { CometError } from '../core/errors.js';

/**
 * `--servers` value → names, or null when there is no filter (flag missing or blank).
 * Accepts spaces (what MUP's code splits on) and commas (what MUP's help text promises).
 */
export function parseServerFilter(v?: string): string[] | null {
  if (typeof v !== 'string') return null;
  const names = v.split(/[\s,]+/).filter(Boolean);
  return names.length ? names : null;
}

/**
 * Applies a server filter, keeping the order of `all`. Unknown names are an error (MUP
 * silently matches nothing), so a typo does not turn into a deploy to zero servers.
 *
 * @throws CometError listing the unknown names and the known ones.
 */
export function selectServers(all: string[], filter: string[] | null): string[] {
  if (!filter) return [...all];
  const unknown = filter.filter((n) => !all.includes(n));
  if (unknown.length) {
    throw new CometError(`Unknown server${unknown.length > 1 ? 's' : ''} in --servers: ${unknown.join(', ')}`, {
      hint: `Known servers: ${all.join(', ')}`,
    });
  }
  return all.filter((n) => filter.includes(n));
}
