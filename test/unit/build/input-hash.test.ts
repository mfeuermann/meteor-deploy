import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeInputHash } from '../../../src/build/input-hash.js';
import { tempDir } from '../../helpers/fs.js';

function app() {
  return tempDir({
    '.meteor/release': 'METEOR@3.5.4',
    '.meteor/versions': 'meteor@2.0.0',
    'package.json': '{"name":"a"}',
    'client/main.js': 'console.log(1)',
    'node_modules/x/package.json': '{"name":"x","version":"1.0.0"}',
    'node_modules/x/README': 'readme',
    'node_modules/@s/y/package.json': '{"name":"@s/y","version":"2.0.0"}',
  });
}

describe('computeInputHash', () => {
  it('is a sha256 hex string and stable', async () => {
    const a = app();
    const h = await computeInputHash(a, {});
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeInputHash(a, {})).toBe(h);
  });

  it('changes with file content', async () => {
    const a = app();
    const h = await computeInputHash(a, {});
    writeFileSync(join(a, 'client/main.js'), 'console.log(2)');
    expect(await computeInputHash(a, {})).not.toBe(h);
  });

  it('ignores mtime-only changes', async () => {
    const a = app();
    const h = await computeInputHash(a, {});
    utimesSync(join(a, 'client/main.js'), new Date(2000, 1, 1), new Date(2000, 1, 1));
    expect(await computeInputHash(a, {})).toBe(h);
  });

  it('ignores .meteor/local, node_modules content and .git', async () => {
    const a = app();
    const h = await computeInputHash(a, {});
    mkdirSync(join(a, '.meteor/local/build'), { recursive: true });
    writeFileSync(join(a, '.meteor/local/build/x.js'), 'x');
    writeFileSync(join(a, 'node_modules/x/README'), 'changed');
    mkdirSync(join(a, '.git'));
    writeFileSync(join(a, '.git/HEAD'), 'ref');
    expect(await computeInputHash(a, {})).toBe(h);
  });

  it('changes when a node_modules package version changes (incl. scoped)', async () => {
    const a = app();
    const h = await computeInputHash(a, {});
    writeFileSync(join(a, 'node_modules/x/package.json'), '{"name":"x","version":"1.0.1"}');
    const h2 = await computeInputHash(a, {});
    expect(h2).not.toBe(h);
    writeFileSync(join(a, 'node_modules/@s/y/package.json'), '{"name":"@s/y","version":"2.0.1"}');
    expect(await computeInputHash(a, {})).not.toBe(h2);
  });

  it('changes with extra inputs, independent of key order', async () => {
    const a = app();
    expect(await computeInputHash(a, { arch: 'x' })).not.toBe(await computeInputHash(a, { arch: 'y' }));
    expect(await computeInputHash(a, { a: 1, b: { c: 2, d: 3 } })).toBe(await computeInputHash(a, { b: { d: 3, c: 2 }, a: 1 }));
  });

  it('honours extra excludes (e.g. a build dir inside the app)', async () => {
    const a = app();
    const h = await computeInputHash(a, {}, { exclude: ['build-out'] });
    mkdirSync(join(a, 'build-out'));
    writeFileSync(join(a, 'build-out/x'), 'x');
    expect(await computeInputHash(a, {}, { exclude: ['build-out'] })).toBe(h);
    expect(await computeInputHash(a, {}, { exclude: [join(a, 'build-out')] })).toBe(h);
  });
});
