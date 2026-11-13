/**
 * Runs the steps of a command under MUP's command keys (`default.deploy`, `meteor.push`, ...)
 * with the config's hooks around them, as MUP's `api.runCommand` does (hooks design §4.2).
 */
import type { HookHandler, HookTable } from '../hooks/registry.js';

/** Runs one handler of the hook `name` (src/hooks/run.ts); throws when the hook fails. */
export type HookExecutor = (name: string, handler: HookHandler) => Promise<void>;

/**
 * Enters MUP command keys and records them, like MUP's `runCommand` / `commandHistory`.
 * `pre.<key>` hooks run before a step and `post.<key>` hooks after its success. After the
 * first failure (a throw through a step or a hook, or a result the step calls failed) no hook
 * runs any more: MUP exits the process at that point.
 */
export class CommandRunner {
  /** Keys in the order their steps started, like MUP's `commandHistory`. */
  readonly history: string[] = [];
  private readonly hooks: HookTable;
  private readonly exec?: HookExecutor;
  private readonly showHookNames?: (line: string) => void;
  private hasFailed = false;

  /**
   * @param o.hooks The config's hooks by normalized name (`hookTable`).
   * @param o.exec Runs one handler; required when `hooks` has any.
   * @param o.showHookNames `--show-hook-names`: receives `Hook: pre.<key>` / `Hook: post.<key>`.
   */
  constructor(o: { hooks?: HookTable; exec?: HookExecutor; showHookNames?: (line: string) => void } = {}) {
    this.hooks = o.hooks ?? new Map();
    this.exec = o.exec;
    this.showHookNames = o.showHookNames;
  }

  /** Whether a step or a hook of this command failed; no hook runs after that. */
  get failed(): boolean {
    return this.hasFailed;
  }

  /** Records a failure that did not throw (e.g. an unhealthy server), so no further hook runs. */
  markFailed(): void {
    this.hasFailed = true;
  }

  /** Starts the step `key`: records it and runs its `pre` hooks. */
  async enter(key: string): Promise<void> {
    this.history.push(key);
    await this.fire(`pre.${key}`);
  }

  /** Ends the step `key` successfully: runs its `post` hooks. */
  async leave(key: string): Promise<void> {
    await this.fire(`post.${key}`);
  }

  /**
   * Runs `fn` as the step `key`. Nested calls work like MUP's nested `runCommand`.
   *
   * @param o.failed Decides from the result whether the step failed without throwing; then
   *   its post hooks do not run.
   */
  async run<T>(key: string, fn: () => Promise<T>, o: { failed?: (result: T) => boolean } = {}): Promise<T> {
    await this.enter(key);
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      this.hasFailed = true;
      throw err;
    }
    if (o.failed?.(result)) {
      this.hasFailed = true;
      return result;
    }
    await this.leave(key);
    return result;
  }

  private async fire(name: string): Promise<void> {
    if (this.hasFailed) return;
    this.showHookNames?.(`Hook: ${name}`);
    const handlers = this.hooks.get(name);
    if (!handlers?.length) return;
    if (!this.exec) throw new Error(`No hook executor for ${name}`);
    try {
      for (const h of handlers) await this.exec(name, h);
    } catch (err) {
      this.hasFailed = true;
      throw err;
    }
  }
}
