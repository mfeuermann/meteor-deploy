/**
 * Runs MUP-style commands by key (e.g. `meteor.push`) and records them, like
 * MUP's `api.runCommand` / `commandHistory`. Phase 2 adds pre/post hooks here.
 */
export class CommandRunner {
  readonly history: string[] = [];

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.history.push(key);
    return fn();
  }
}
