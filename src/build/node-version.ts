/**
 * Reads the Node.js version a Meteor bundle was built for. It is passed to the image build as the
 * `NODE_VERSION` build arg, from which the base image installs that Node version (as in MUP).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CometError } from '../core/errors.js';

/**
 * Node version the bundle was built for, without a leading `v`: `star.json` `nodeVersion`
 * (Meteor 1.5.2 and later), else `.node_version.txt`, the same lookup as MUP.
 *
 * @throws CometError when neither file names a version.
 */
export function readNodeVersion(bundleDir: string): string {
  const star = join(bundleDir, 'star.json');
  if (existsSync(star)) {
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(star, 'utf8')).nodeVersion;
    } catch (err) {
      throw new CometError(`Cannot read the Node version from ${star}: ${(err as Error).message}`, { cause: err });
    }
    if (typeof v === 'string' && v) return v.replace(/^v/, '');
  }
  const txt = join(bundleDir, '.node_version.txt');
  if (existsSync(txt)) return readFileSync(txt, 'utf8').trim().replace(/^v/, '');
  throw new CometError(`Cannot determine the Node version of the bundle in ${bundleDir} (no star.json or .node_version.txt).`);
}
