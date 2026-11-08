import type { NormalizedConfig } from '../config/types.js';

/** Image repository used by start.sh: `mup-<lc>` or `<imagePrefix>/mup-<lc>`. */
export function imageRepo(c: NormalizedConfig): string {
  const prefix = c.privateDockerRegistry?.imagePrefix;
  return prefix ? `${prefix}/${localImageRepo(c)}` : localImageRepo(c);
}

/** Unprefixed image repository (what meteor-start.sh / meteor-destroy.sh inspect). */
export function localImageRepo(c: NormalizedConfig): string {
  return `mup-${c.app.name.toLowerCase()}`;
}

export function containerName(c: NormalizedConfig): string {
  return c.app.name;
}

export function appDir(c: NormalizedConfig): string {
  return `/opt/${c.app.name}`;
}
