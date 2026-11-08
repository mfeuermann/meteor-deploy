import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

export const TOOL_VERSION: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

export const TOOL_ID = `comet-deploy@${TOOL_VERSION}`;
