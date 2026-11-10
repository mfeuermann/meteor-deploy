import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isEntryPoint } from '../../../src/cli/entry.js';
import { tempDir } from '../../helpers/fs.js';

describe('isEntryPoint (C1: npm installs bins as symlinks)', () => {
  it('is true when started through a symlink to the module', () => {
    const d = tempDir();
    const real = join(d, 'main.js');
    writeFileSync(real, '');
    const link = join(d, 'comet-deploy');
    symlinkSync(real, link);
    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
    expect(isEntryPoint(real, pathToFileURL(real).href)).toBe(true);
  });

  it('is false for another script and without argv[1]', () => {
    const d = tempDir({ 'a.js': '', 'b.js': '' });
    expect(isEntryPoint(join(d, 'b.js'), pathToFileURL(join(d, 'a.js')).href)).toBe(false);
    expect(isEntryPoint(undefined, pathToFileURL(join(d, 'a.js')).href)).toBe(false);
    expect(isEntryPoint(join(d, 'missing.js'), pathToFileURL(join(d, 'a.js')).href)).toBe(false);
  });
});
