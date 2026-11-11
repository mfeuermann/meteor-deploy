/**
 * Secret masking for all output. collectSecrets gathers the values from the config and the
 * settings that must never be printed (env values, passwords, settings), and the reporter
 * replaces them with `***` in every line, including verbose remote output and error messages.
 */
import type { NormalizedConfig } from '../config/types.js';

// Shorter values are not masked: they would also match ordinary text and garble the output.
const MIN_SECRET_LENGTH = 4;
const MASK = '***';

/**
 * Replaces every occurrence of each secret with `***`. Longest first, so a secret that
 * contains a shorter one is masked whole instead of leaving its remainder visible.
 */
export function maskSecrets(text: string, secrets: string[]): string {
  const usable = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of usable) {
    if (out.includes(s)) out = out.split(s).join(MASK);
  }
  return out;
}

// Settings hold many short strings that are not secret ("en", "debug"); masking them
// would garble the output, so settings leaves need a longer minimum.
const MIN_SETTINGS_SECRET_LENGTH = 8;

/** Env keys whose values are public by design (URLs, ports, proxy routing). */
const PUBLIC_ENV_KEYS = new Set([
  'ROOT_URL',
  'PORT',
  'VIRTUAL_HOST',
  'VIRTUAL_PORT',
  'HTTPS_METHOD',
  'HTTP_FORWARDED_COUNT',
  'LETSENCRYPT_HOST',
  'NODE_ENV',
]);

function push(list: string[], v: unknown) {
  if (v === undefined || v === null) return;
  const s = String(v);
  if (s.length >= MIN_SECRET_LENGTH) list.push(s);
}

/**
 * Env values that could be secret: strings that are not plain numbers or booleans (masking
 * `3000` or `true` would hit unrelated output). Keys in PUBLIC_ENV_KEYS are skipped.
 */
function pushEnv(list: string[], env: Record<string, unknown> | undefined) {
  for (const [k, v] of Object.entries(env ?? {})) {
    if (PUBLIC_ENV_KEYS.has(k) || typeof v !== 'string' || /^(\d+|true|false)$/i.test(v)) continue;
    push(list, v);
  }
}

/** String leaves of everything in the settings except `public` (which is sent to clients). */
function pushSettingsLeaves(list: string[], v: unknown, isRoot = true) {
  if (typeof v === 'string') {
    if (v.length >= MIN_SETTINGS_SECRET_LENGTH) list.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) pushSettingsLeaves(list, x, false);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (isRoot && k === 'public') continue;
      pushSettingsLeaves(list, x, false);
    }
  }
}

/**
 * Values that must never be printed: app env and per-server env (except public
 * keys and plain numbers/booleans), SSH passwords and key passphrases, the
 * registry password, and for the Meteor settings and every per-server settings
 * file: the serialized JSON and its non-public string values. The serialized JSON is
 * included because it appears whole as the `METEOR_SETTINGS` line of env.list.
 */
export function collectSecrets(config: NormalizedConfig, settings?: unknown, perServerSettings: unknown[] = []): string[] {
  const out: string[] = [];
  pushEnv(out, config.app?.env);
  for (const ref of Object.values(config.app?.servers ?? {})) pushEnv(out, ref?.env);
  for (const s of Object.values(config.servers ?? {})) {
    push(out, s?.password);
    push(out, (s?.opts as { passphrase?: unknown } | undefined)?.passphrase);
  }
  if (config.privateDockerRegistry?.password) push(out, config.privateDockerRegistry.password);
  for (const v of [settings, ...perServerSettings]) {
    if (v === undefined) continue;
    push(out, JSON.stringify(v));
    pushSettingsLeaves(out, v);
  }
  return [...new Set(out)];
}
