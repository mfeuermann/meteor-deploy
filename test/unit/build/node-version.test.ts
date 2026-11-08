import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readNodeVersion } from '../../../src/build/node-version.js';
import { CometError } from '../../../src/core/errors.js';
import { tempDir } from '../../helpers/fs.js';

const bundles = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/bundles');

describe('readNodeVersion', () => {
  it('reads star.json nodeVersion', () => {
    expect(readNodeVersion(join(bundles, 'star-json/bundle'))).toBe('24.22.1');
  });

  it('falls back to .node_version.txt without the leading v', () => {
    expect(readNodeVersion(join(bundles, 'node-version-txt/bundle'))).toBe('14.21.4');
  });

  it('fails clearly when neither exists', () => {
    expect(() => readNodeVersion(tempDir())).toThrow(CometError);
  });
});
