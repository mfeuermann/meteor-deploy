import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CometError } from '../core/errors.js';

/** Node version the bundle was built for: star.json `nodeVersion`, else `.node_version.txt` (ref. §4.4). */
export function readNodeVersion(bundleDir: string): string {
  const star = join(bundleDir, 'star.json');
  if (existsSync(star)) {
    const v = JSON.parse(readFileSync(star, 'utf8')).nodeVersion;
    if (typeof v === 'string' && v) return v.replace(/^v/, '');
  }
  const txt = join(bundleDir, '.node_version.txt');
  if (existsSync(txt)) return readFileSync(txt, 'utf8').trim().replace(/^v/, '');
  throw new CometError(`Cannot determine the Node version of the bundle in ${bundleDir} (no star.json or .node_version.txt).`);
}
