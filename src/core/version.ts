/**
 * The tool's own version and install location, read from comet-deploy's package.json. The
 * version is recorded in deploy history and lock records and is part of the build cache key;
 * the package root is where the bundled shell templates are found.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Walks up from `start` to comet-deploy's own package.json. A fixed relative path would
 * differ between the bundled build (`dist/cli/main.js`) and the sources run by the tests;
 * checking the name skips other package.json files on the way.
 *
 * @throws Error when it is not found (a broken install).
 */
function findPackageJson(start: string): string {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === 'comet-deploy') return candidate;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('comet-deploy package.json not found');
    dir = parent;
  }
}

/** Absolute path of the installed comet-deploy package root. */
export const PACKAGE_ROOT = dirname(findPackageJson(dirname(fileURLToPath(import.meta.url))));

/** The `version` field of comet-deploy's package.json. */
export const TOOL_VERSION: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

/**
 * `comet-deploy@<version>`: identifies the tool in deploy history and lock records. It is
 * also hashed into the build cache key, so a new release never reuses an older one's image.
 */
export const TOOL_ID = `comet-deploy@${TOOL_VERSION}`;
