/**
 * Runs the steps of a command under MUP's command keys (`default.deploy`, `meteor.push`, ...),
 * so the hook names a MUP config uses refer to the same points in comet-deploy.
 */
import { CometError } from './errors.js';

/**
 * MUP hook names that belong to a command key: `pre.<key>` / `post.<key>`, plus the short
 * form `pre.<cmd>` / `post.<cmd>` for `default.<cmd>` (MUP reads a hook name with one dot as
 * a `default.` hook).
 */
function hookNamesFor(key: string): string[] {
  const names = [`pre.${key}`, `post.${key}`];
  if (key.startsWith('default.')) {
    const short = key.slice('default.'.length);
    names.push(`pre.${short}`, `post.${short}`);
  }
  return names;
}

/**
 * Runs MUP-style commands by key (e.g. `meteor.push`) and records them, like
 * MUP's `api.runCommand` / `commandHistory`. Hooks are planned for phase 2: a command
 * that has one is refused instead of silently running without it.
 */
export class CommandRunner {
  /** Keys in the order their commands started, like MUP's `commandHistory`. */
  readonly history: string[] = [];

  /** @param hooks The config's `hooks` section. */
  constructor(private readonly hooks: Record<string, unknown> = {}) {}

  /**
   * Runs `fn` as the command `key`. Nested calls work like MUP's nested `runCommand`.
   *
   * @throws CometError before `fn` runs when the config has a pre or post hook for this key.
   *   A post hook is refused up front too, so the command never does its work and then skips
   *   the hook.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.refuseHooks([key]);
    this.history.push(key);
    return fn();
  }

  /**
   * Throws for the first of `keys` that has a hook. A command calls this with every key it
   * will enter, so a hook on a late step (e.g. `pre.meteor.start` of a deploy) is refused
   * before the build and the upload, not after them.
   *
   * @throws CometError naming the hook.
   */
  refuseHooks(keys: string[]): void {
    for (const key of keys) {
      const hook = hookNamesFor(key).find((n) => Object.prototype.hasOwnProperty.call(this.hooks ?? {}, n));
      if (hook) {
        throw new CometError(`Hook "${hook}" is not supported yet (hooks are planned for phase 2 of comet-deploy).`, {
          hint: 'Remove the hook from the config to use comet-deploy for this command, or keep using MUP for it.',
        });
      }
    }
  }
}
