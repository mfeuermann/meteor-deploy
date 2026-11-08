import type { NormalizedConfig } from '../config/types.js';

const MIN_SECRET_LENGTH = 4;
const MASK = '***';

/** Replaces every occurrence of each secret (longest first) with `***`. */
export function maskSecrets(text: string, secrets: string[]): string {
  const usable = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of usable) {
    if (out.includes(s)) out = out.split(s).join(MASK);
  }
  return out;
}

function push(list: string[], v: unknown) {
  if (v === undefined || v === null) return;
  const s = String(v);
  if (s.length >= MIN_SECRET_LENGTH) list.push(s);
}

/**
 * Values that must never be printed: app env, per-server env, SSH passwords,
 * and the serialized Meteor settings.
 */
export function collectSecrets(config: NormalizedConfig, settings?: unknown): string[] {
  const out: string[] = [];
  for (const v of Object.values(config.app?.env ?? {})) push(out, v);
  for (const ref of Object.values(config.app?.servers ?? {})) {
    for (const v of Object.values(ref?.env ?? {})) push(out, v);
  }
  for (const s of Object.values(config.servers ?? {})) push(out, s?.password);
  if (config.privateDockerRegistry?.password) push(out, config.privateDockerRegistry.password);
  if (settings !== undefined) push(out, JSON.stringify(settings));
  return [...new Set(out)];
}
