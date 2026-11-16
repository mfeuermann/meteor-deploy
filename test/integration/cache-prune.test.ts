/**
 * `cache prune` against the local Docker (commands plan Task 6): tags of one small image stand
 * in for build versions, recorded in a state.json under a temporary XDG_CACHE_HOME. The local
 * registry part runs only with --dry-run, so the developer's real registry stays.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuildCache, type CacheEntry } from '../../src/build/cache.js';
import { run } from '../../src/local/exec.js';
import { tempDir } from '../helpers/fs.js';
import { cli } from './helpers.js';

const BASE = 'busybox:1.36';
const REPO = 'mup-prunetest';
const V1 = '20261101-000000';
const V2 = '20261105-000000';
const V3 = '20261110-000000';

async function docker(args: string[]): Promise<string> {
  const r = await run('docker', args);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const tags = async () => (await docker(['images', '--format', '{{.Tag}}', REPO])).split('\n').filter(Boolean).sort();

describe('cache prune on the local Docker', () => {
  const before = process.env.XDG_CACHE_HOME;
  let root: string;
  let appDir: string;

  beforeAll(async () => {
    process.env.XDG_CACHE_HOME = tempDir();
    if ((await run('docker', ['image', 'inspect', BASE])).code !== 0) await docker(['pull', BASE]);
    for (const t of [V1, V2, V3, 'latest']) await docker(['tag', BASE, `${REPO}:${t}`]);
    root = tempDir();
    appDir = join(root, 'app');
    mkdirSync(join(appDir, '.meteor'), { recursive: true });
    writeFileSync(join(appDir, '.meteor', 'release'), 'METEOR@3.1');
    writeFileSync(
      join(root, 'mup.js'),
      `module.exports = { servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } }, app: { name: 'prunetest', path: './app', servers: { one: {} }, env: { ROOT_URL: 'http://prunetest.example.com', MONGO_URL: 'mongodb://h/p' }, buildOptions: { buildLocation: ${JSON.stringify(join(root, 'build'))} } } };`,
    );
    const id = await docker(['image', 'inspect', '--format', '{{.Id}}', BASE]);
    const cache = new BuildCache(appDir);
    for (const v of [V2, V3]) {
      const e: CacheEntry = { inputHash: v, platform: 'linux/amd64', version: v, localTag: `${REPO}:${v}`, imageId: id, bundleDir: join(root, 'build', 'bundle'), nodeVersion: '24.22.1', depsHash: 'd', createdAt: new Date().toISOString() };
      cache.save(e);
    }
  });

  afterAll(async () => {
    await run('docker', ['rmi', ...[V1, V2, V3, 'latest'].map((t) => `${REPO}:${t}`)]);
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
  });

  it('removes the older versions and keeps the newest and latest', async () => {
    const r = await cli(['cache', 'prune', '--config', join(root, 'mup.js')], root);
    expect(r.code, r.output).toBe(0);
    expect(await tags()).toEqual([V3, 'latest'].sort());
    expect(new BuildCache(appDir).entries().map((e) => e.version)).toEqual([V3]);
    expect(await run('docker', ['image', 'inspect', BASE]).then((x) => x.code)).toBe(0);
  });

  it('--registry --dry-run changes nothing', async () => {
    const volumeBefore = (await run('docker', ['volume', 'inspect', 'comet-deploy-registry-data'])).code;
    const r = await cli(['cache', 'prune', '--registry', '--dry-run', '--config', join(root, 'mup.js')], root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/Would remove the local registry and its volume|There is no local registry\./);
    expect((await run('docker', ['volume', 'inspect', 'comet-deploy-registry-data'])).code).toBe(volumeBefore);
    expect(await tags()).toEqual([V3, 'latest'].sort());
  });

  it('--all keeps only the tags that are no version', async () => {
    const r = await cli(['cache', 'prune', '--all', '--config', join(root, 'mup.js')], root);
    expect(r.code, r.output).toBe(0);
    expect(await tags()).toEqual(['latest']);
    expect(new BuildCache(appDir).entries()).toEqual([]);
  });
});
