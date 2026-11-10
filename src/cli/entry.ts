import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the process was started with this module as its script. npm
 * installs bins as symlinks (node_modules/.bin, global bin), so both sides are
 * compared after resolving symlinks.
 */
export function isEntryPoint(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
