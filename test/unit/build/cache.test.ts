import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BuildCache, type CacheEntry } from '../../../src/build/cache.js';
import { tempDir } from '../../helpers/fs.js';

const entry = (p: Partial<CacheEntry> = {}): CacheEntry => ({
  inputHash: 'h1',
  platform: 'linux/amd64',
  version: '20261107-183005',
  localTag: 'mup-app:20261107-183005',
  imageId: 'sha256:abc',
  bundleDir: '/tmp/b/bundle',
  nodeVersion: '24.22.1',
  depsHash: 'd'.repeat(64),
  createdAt: '2026-11-07T18:30:05.000Z',
  ...p,
});

describe('BuildCache', () => {
  it('saves and looks up by input hash and platform', () => {
    const root = tempDir();
    const c = new BuildCache('/apps/a', root);
    c.save(entry());
    const again = new BuildCache('/apps/a', root);
    expect(again.lookup('h1', 'linux/amd64')).toEqual(entry());
    expect(again.lookup('h1', 'linux/arm64')).toBeNull();
    expect(again.lookup('other', 'linux/amd64')).toBeNull();
    expect(existsSync(again.statePath)).toBe(true);
    expect(again.statePath.startsWith(root)).toBe(true);
  });

  it('returns the newest entry per platform and replaces duplicates', () => {
    const c = new BuildCache('/apps/a', tempDir());
    c.save(entry({ inputHash: 'h1', createdAt: '2026-11-01T00:00:00.000Z' }));
    c.save(entry({ inputHash: 'h2', createdAt: '2026-11-02T00:00:00.000Z', version: 'v2' }));
    c.save(entry({ inputHash: 'h1', createdAt: '2026-11-03T00:00:00.000Z', version: 'v3' }));
    expect(c.latest('linux/amd64')?.version).toBe('v3');
    expect(c.lookup('h1', 'linux/amd64')?.version).toBe('v3');
    expect(c.latest('linux/arm64')).toBeNull();
  });

  it('separates apps and tolerates a corrupted state file', async () => {
    const root = tempDir();
    new BuildCache('/apps/a', root).save(entry());
    expect(new BuildCache('/apps/b', root).lookup('h1', 'linux/amd64')).toBeNull();
    const { writeFileSync } = await import('node:fs');
    const c = new BuildCache('/apps/a', root);
    writeFileSync(c.statePath, '{broken');
    expect(new BuildCache('/apps/a', root).lookup('h1', 'linux/amd64')).toBeNull();
  });

  it('returns the entries it forgets, so their local images can be removed', () => {
    const c = new BuildCache('/apps/a', tempDir());
    for (let i = 0; i < 20; i++) expect(c.save(entry({ inputHash: `h${i}`, localTag: `mup-app:v${i}` }))).toEqual([]);
    expect(c.save(entry({ inputHash: 'h20', localTag: 'mup-app:v20' })).map((e) => e.localTag)).toEqual(['mup-app:v0']);
    // a rebuild of the same inputs (--force-build) replaces the entry and its image
    expect(c.save(entry({ inputHash: 'h20', localTag: 'mup-app:v21' })).map((e) => e.localTag)).toEqual(['mup-app:v20']);
    expect(c.save(entry({ inputHash: 'h20', localTag: 'mup-app:v21' }))).toEqual([]);
  });
});
