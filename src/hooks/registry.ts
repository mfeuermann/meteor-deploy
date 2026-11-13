/**
 * The `hooks` section: MUP's hook names (hooks design §4.1), the command keys a hook can belong
 * to, and the validation of the section (§4.8).
 */
import type { Issue } from '../config/validate.js';

/** One hook as MUP accepts it, after a plain function became `{ method }`. */
export interface HookHandler {
  localCommand?: string;
  remoteCommand?: string;
  method?: (api: unknown, nodemiral: unknown) => unknown;
}

/** Normalized hook name (`pre.default.deploy`) → its handlers, in registration order. */
export type HookTable = Map<string, HookHandler[]>;

/**
 * The command keys of MUP 1.5.11: `<plugin>.<export name>` from `lib/plugins/*\/commands.js`.
 * A test compares this list with the MUP in devDependencies.
 */
export const MUP_COMMAND_KEYS: readonly string[] = [
  ...['init', 'deploy', 'logs', 'reconfig', 'restart', 'setup', 'start', 'stop', 'ssh', 'validate', 'status'].map((k) => `default.${k}`),
  ...['setup', 'restart', 'ps', 'status', 'update', 'destroyCluster'].map((k) => `docker.${k}`),
  ...['setup', 'deploy', 'destroy', 'prepareBundle', 'logs', 'start', 'stop', 'restart', 'status', 'debug', 'build', 'push', 'envconfig'].map((k) => `meteor.${k}`),
  ...['setup', 'logs', 'start', 'stop', 'shell', 'status'].map((k) => `mongo.${k}`),
  ...['setup', 'reconfigShared', 'logs', 'leLogs', 'envconfig', 'start', 'stop', 'nginxConfig', 'status'].map((k) => `proxy.${k}`),
];

/** MUP keys whose command comet-deploy does not have (or runs without the config), so their hooks never run. */
export const KEYS_COMET_DOES_NOT_RUN: readonly string[] = ['default.init', 'default.validate', 'default.ssh', 'meteor.debug', 'docker.destroyCluster', 'proxy.envconfig'];

/** Keys only comet-deploy has. */
export const COMET_ONLY_KEYS: readonly string[] = ['default.rollback'];

const KNOWN_KEYS = new Set([...MUP_COMMAND_KEYS, ...COMET_ONLY_KEYS]);

/** As MUP's `registerHook`: a name with exactly one dot belongs to the default plugin (`pre.deploy` → `pre.default.deploy`). */
export function normalizeHookName(name: string): string {
  const parts = name.split('.');
  return parts.length === 2 ? `${parts[0]}.default.${parts[1]}` : name;
}

/** The hooks of a config by normalized name. Handlers that meet under one name keep the order of `Object.keys`. */
export function hookTable(hooks: Record<string, unknown> | undefined): HookTable {
  const table: HookTable = new Map();
  for (const [name, value] of Object.entries(hooks ?? {})) {
    const handler = (typeof value === 'function' ? { method: value } : value) as HookHandler;
    const key = normalizeHookName(name);
    table.set(key, [...(table.get(key) ?? []), handler]);
  }
  return table;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Problems of the `hooks` section. A hook that cannot run (wrong form or type) is an error; a
 * hook that would never run (no `pre.`/`post.`, a misspelled key, a command comet-deploy does
 * not run) is a warning, since MUP accepts it too.
 */
export function hookIssues(hooks: unknown): Issue[] {
  if (hooks === undefined || hooks === null) return [];
  if (!isObject(hooks)) return [{ path: 'hooks', message: 'must be an object', severity: 'error' }];
  const issues: Issue[] = [];
  for (const [name, value] of Object.entries(hooks)) {
    const path = `hooks."${name}"`;
    if (isObject(value)) {
      for (const [prop, v] of Object.entries(value)) {
        if (prop === 'localCommand' || prop === 'remoteCommand') {
          if (typeof v !== 'string') issues.push({ path: `${path}.${prop}`, message: 'must be a string', severity: 'error' });
        } else if (prop === 'method') {
          if (typeof v !== 'function') issues.push({ path: `${path}.${prop}`, message: 'must be a function', severity: 'error' });
        } else {
          issues.push({ path: `${path}.${prop}`, message: 'is an unknown property', severity: 'warning' });
        }
      }
    } else if (typeof value !== 'function') {
      issues.push({ path, message: 'must be an object with localCommand, remoteCommand or method, or a function', severity: 'error' });
    }
    const normalized = normalizeHookName(name);
    const prefix = /^(pre|post)\./.exec(normalized);
    if (!prefix) {
      issues.push({ path, message: 'must start with "pre." or "post."', severity: 'warning' });
      continue;
    }
    const key = normalized.slice(prefix[0].length);
    if (KEYS_COMET_DOES_NOT_RUN.includes(key)) {
      issues.push({ path, message: `belongs to a command comet-deploy does not run (${key}), so it never runs`, severity: 'warning' });
    } else if (!KNOWN_KEYS.has(key)) {
      issues.push({ path, message: 'does not match a command, so it never runs', severity: 'warning' });
    }
  }
  return issues;
}
