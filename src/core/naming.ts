/**
 * Names of the things comet-deploy creates on a server. They are exactly MUP's names, so MUP
 * and comet-deploy can manage the same servers and take over from each other. The values are
 * not shell-quoted; callers quote them.
 */
import type { NormalizedConfig } from '../config/types.js';

/**
 * Unprefixed image repository (what meteor-start.sh / meteor-destroy.sh inspect). It holds
 * the `:latest` and `:previous` tags like in MUP, plus comet-deploy's version tags.
 */
export function localImageRepo(c: NormalizedConfig): string {
  return `mup-${c.app.name.toLowerCase()}`;
}

/** The app container: the app name as is (not lowercased), like MUP. */
export function containerName(c: NormalizedConfig): string {
  return c.app.name;
}

/** The app's directory on the server; start.sh, env.list and the lock live in its `config/`. */
export function appDir(c: NormalizedConfig): string {
  return `/opt/${c.app.name}`;
}
