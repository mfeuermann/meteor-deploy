import { CometError } from './errors.js';

/** MUP hook names that belong to a command key: `pre.<key>` / `post.<key>`, and `pre.<cmd>` for `default.<cmd>`. */
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
 * MUP's `api.runCommand` / `commandHistory`. Hooks are phase 2: a command that
 * has one is refused instead of silently running without it.
 */
export class CommandRunner {
  readonly history: string[] = [];

  constructor(private readonly hooks: Record<string, unknown> = {}) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hook = hookNamesFor(key).find((n) => Object.prototype.hasOwnProperty.call(this.hooks ?? {}, n));
    if (hook) {
      throw new CometError(`Hook "${hook}" is not supported yet (hooks are planned for phase 2 of comet-deploy).`, {
        hint: 'Remove the hook from the config to use comet-deploy for this command, or keep using MUP for it.',
      });
    }
    this.history.push(key);
    return fn();
  }
}
