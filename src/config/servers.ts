import { CometError } from '../core/errors.js';

/** `--servers` value → names. Accepts spaces (MUP) and commas (what MUP's help claims). */
export function parseServerFilter(v?: string): string[] | null {
  if (typeof v !== 'string') return null;
  const names = v.split(/[\s,]+/).filter(Boolean);
  return names.length ? names : null;
}

/** Applies a server filter, keeping the order of `all`. Unknown names are an error. */
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
