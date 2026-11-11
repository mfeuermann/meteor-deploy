/**
 * Entry-point detection for ESM: lets `main.ts` start the CLI when it is run as a script and
 * stay inert when tests import it.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the process was started with this module as its script. `argv1` is
 * `process.argv[1]`, `metaUrl` the module's `import.meta.url`. npm installs bins as
 * symlinks (node_modules/.bin, global bin), so both sides are compared after resolving
 * symlinks. A path that cannot be resolved counts as "not the entry point".
 */
export function isEntryPoint(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
