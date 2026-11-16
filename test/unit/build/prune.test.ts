import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildCache, type CacheEntry } from '../../../src/build/cache.js';
import { buildDirTargets, parseDockerSize, planPrune } from '../../../src/build/prune.js';
import { main } from '../../../src/cli/main.js';
import type { Platform } from '../../../src/config/types.js';
import { fakeDocker, type FakeDocker } from '../../helpers/fake-docker.js';
import { tempDir } from '../../helpers/fs.js';

/** An entry of `repo` built as `version` (createdAt from the version's timestamp). */
function entry(version: string, platform: Platform = 'linux/amd64', repo = 'mup-a'): CacheEntry {
  const v = version.slice(0, 15);
  const createdAt = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}.000Z`;
  return { inputHash: `${version}-${platform}`, platform, version, localTag: `${repo}:${version}`, imageId: `sha256:${version}`, bundleDir: '/b/bundle', nodeVersion: '24.22.1', depsHash: 'd', createdAt };
}

describe('planPrune', () => {
  it('keeps the newest entry per platform', () => {
    const a1 = entry('20261101-000000');
    const a2 = entry('20261110-000000');
    const a3 = entry('20261105-000000-arm64', 'linux/arm64');
    const refs = ['mup-a:20261101-000000', 'mup-a:20261110-000000', 'mup-a:20261105-000000-arm64'];
    const p = planPrune({ entries: [a2, a3, a1], repo: 'mup-a', refs, all: false });
    expect(p.keep).toEqual([a2, a3]);
    expect(p.removeEntries).toEqual([a1]);
    expect(p.removeRefs).toEqual(['mup-a:20261101-000000']);
  });

  it('leaves entries of another repo', () => {
    // .deploy/staging (app "b") and .deploy/production (app "a") with the same app.path share state.json.
    const a1 = entry('20261101-000000');
    const a2 = entry('20261110-000000');
    const b1 = entry('20261102-000000', 'linux/amd64', 'mup-b');
    const refs = ['mup-a:20261101-000000', 'mup-a:20261110-000000', 'mup-b:20261102-000000'];
    expect(planPrune({ entries: [a2, b1, a1], repo: 'mup-a', refs, all: false }).removeEntries).toEqual([a1]);
    const all = planPrune({ entries: [a2, b1, a1], repo: 'mup-a', refs, all: true });
    expect(all.removeEntries).toEqual([a2, a1]);
    expect(all.removeRefs).not.toContain('mup-b:20261102-000000');
  });

  it('removes unrecorded version refs older than the oldest kept entry, keeps newer ones and non-versions', () => {
    const kept = entry('20261110-000000');
    const refs = [
      'mup-a:20261110-000000',
      'mup-a:20261101-000000-1a2b3c4',
      'mup-a:20261101-000000-amd64',
      'mup-a:20261120-000000',
      'mup-a:latest',
      'mup-a:build',
      '127.0.0.1:5000/mup-a:20261101-000000',
      'mup-ab:20261101-000000',
      '<none>:<none>',
    ];
    const p = planPrune({ entries: [kept], repo: 'mup-a', refs, all: false });
    expect(p.removeRefs).toEqual(['mup-a:20261101-000000-1a2b3c4', 'mup-a:20261101-000000-amd64', '127.0.0.1:5000/mup-a:20261101-000000']);
    expect(p.untouched).toEqual(['mup-a:20261120-000000', 'mup-a:latest', 'mup-a:build']);
  });

  it('never removes a ref that another app path records', () => {
    // Two projects named "a" (the name `mup init` suggests is shared often), each with its own
    // state.json: the other one's images are not leftovers of this one.
    const a1 = entry('20261101-000000');
    const a2 = entry('20261110-000000');
    const refs = ['mup-a:20261101-000000', 'mup-a:20261110-000000', 'mup-a:20261103-000000', 'mup-a:20261102-000000'];
    const protectedRefs = ['mup-a:20261103-000000', 'mup-a:20261101-000000'];
    const p = planPrune({ entries: [a2, a1], repo: 'mup-a', refs, all: false, protectedRefs });
    expect(p.removeEntries).toEqual([a1]);
    expect(p.removeRefs).toEqual(['mup-a:20261102-000000']);
    expect(p.untouched).toEqual(['mup-a:20261103-000000']);
    const all = planPrune({ entries: [a2, a1], repo: 'mup-a', refs, all: true, protectedRefs });
    expect(all.removeRefs).toEqual(['mup-a:20261110-000000', 'mup-a:20261102-000000']);
  });

  it('without a kept entry, unrecorded versions stay', () => {
    // A deploy that builds right now has not saved its entry yet.
    const p = planPrune({ entries: [], repo: 'mup-a', refs: ['mup-a:20261101-000000'], all: false });
    expect(p.removeRefs).toEqual([]);
    expect(p.untouched).toEqual(['mup-a:20261101-000000']);
  });

  it('--all removes every version ref of the repo', () => {
    const kept = entry('20261110-000000');
    const refs = ['mup-a:20261110-000000', 'mup-a:20261120-000000', 'mup-a:latest', '127.0.0.1:5000/mup-a:20261121-000000'];
    const p = planPrune({ entries: [kept], repo: 'mup-a', refs, all: true });
    expect(p.keep).toEqual([]);
    expect(p.removeEntries).toEqual([kept]);
    expect(p.removeRefs).toEqual(['mup-a:20261110-000000', 'mup-a:20261120-000000', '127.0.0.1:5000/mup-a:20261121-000000']);
    expect(p.untouched).toEqual(['mup-a:latest']);
  });
});

describe('buildDirTargets', () => {
  it('cleanBuildLocation: the whole directory, and only the build files of its platform variants', () => {
    // Deploy deletes the -amd64/-arm64 directories only for multi-platform builds; a folder of
    // that name next to a custom buildLocation can be the user's own.
    const root = tempDir();
    const base = join(root, 'build');
    mkdirSync(base);
    mkdirSync(`${base}-arm64/bundle`, { recursive: true });
    writeFileSync(join(`${base}-arm64`, 'notes.txt'), 'mine');
    writeFileSync(join(root, 'notes.txt'), 'mine');
    expect(buildDirTargets({ buildLocation: base, cleanBuildLocation: true })).toEqual([base, join(`${base}-arm64`, 'bundle')]);
  });

  it("without cleanBuildLocation only comet-deploy's own files", () => {
    const base = tempDir({ 'bundle/main.js': 'x', 'bundle.tar.gz': 'x', '.dockerignore': 'x', 'notes.txt': 'mine' });
    mkdirSync(`${base}-amd64/bundle`, { recursive: true });
    expect(buildDirTargets({ buildLocation: base })).toEqual([join(base, 'bundle'), join(base, 'bundle.tar.gz'), join(base, '.dockerignore'), join(`${base}-amd64`, 'bundle')]);
  });
});

describe('parseDockerSize', () => {
  it('reads the sizes docker system df prints', () => {
    expect(parseDockerSize('3.371GB')).toBe(3_371_000_000);
    expect(parseDockerSize('512MB')).toBe(512_000_000);
    expect(parseDockerSize('12.4kB')).toBe(12_400);
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('N/A')).toBeNull();
  });
});

describe('cache prune command', () => {
  let docker: FakeDocker | undefined;
  let cacheHome: string | undefined;
  const before = process.env.XDG_CACHE_HOME;
  beforeEach(() => {
    cacheHome = tempDir();
    process.env.XDG_CACHE_HOME = cacheHome;
  });
  afterEach(() => {
    docker?.restore();
    docker = undefined;
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
  });

  /** A config of app "a" with its own buildLocation, two cache entries and the refs below. */
  function project() {
    const root = tempDir({ 'app/.meteor/release': 'METEOR@3.1', 'build/bundle/main.js': 'x'.repeat(1000), 'build/.dockerignore': 'x', 'build/notes.txt': 'mine' });
    const app = join(root, 'app');
    const build = join(root, 'build');
    writeFileSync(
      join(root, 'mup.js'),
      `module.exports = { servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } }, app: { name: 'a', path: ${JSON.stringify(app)}, servers: { one: {} }, env: { ROOT_URL: 'http://a.example.com', MONGO_URL: 'mongodb://h/a' }, buildOptions: { buildLocation: ${JSON.stringify(build)} } } };`,
    );
    const cache = new BuildCache(app);
    cache.save(entry('20261105-000000'));
    cache.save(entry('20261110-000000'));
    return { root, build, cache };
  }

  const REFS = ['mup-a:20261105-000000', 'mup-a:20261110-000000', 'mup-a:20261101-000000', 'mup-a:latest', '127.0.0.1:5000/mup-a:20261101-000000'];
  const script = (o: { refuse?: string; refs?: string[] } = {}) => `
case "$1" in
  images) printf '%s\\n' ${(o.refs ?? REFS).map((r) => `'${r}'`).join(' ')} ;;
  rmi) ${o.refuse ? `[ "$2" = '${o.refuse}' ] && { echo 'Error response from daemon: conflict: unable to remove repository reference "${o.refuse}" (must force) - container 1a2b is using its referenced image 3c4d' >&2; exit 1; };` : ''} exit 0 ;;
  volume) exit 0 ;;
  system) echo '{"Images":[],"Volumes":[{"Name":"other","Size":"1GB"},{"Name":"comet-deploy-registry-data","Size":"12.4GB"}]}' ;;
  *) exit 0 ;;
esac`;

  async function prune(root: string, args: string[] = []) {
    const out: string[] = [];
    const code = await main(['--config', join(root, 'mup.js'), 'cache', 'prune', ...args], { stdout: (s) => out.push(s), stderr: (s) => out.push(s) }, { cwd: root });
    return { code, out: out.join('') };
  }

  it('--dry-run removes nothing', async () => {
    const p = project();
    docker = fakeDocker(script());
    const state = readFileSync(p.cache.statePath, 'utf8');
    const r = await prune(p.root, ['--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Would remove 3 images of mup-a; the newest stays: mup-a:20261110-000000 (linux/amd64).');
    expect(r.out).toContain(`Would remove the build output`);
    expect(docker.calls().filter((c) => c.startsWith('rmi'))).toEqual([]);
    expect(readFileSync(p.cache.statePath, 'utf8')).toBe(state);
    expect(existsSync(join(p.build, 'bundle'))).toBe(true);
  });

  it('removes the old images and entries and only its own build files', async () => {
    const p = project();
    docker = fakeDocker(script());
    const r = await prune(p.root);
    expect(r.code).toBe(0);
    expect(docker.calls().filter((c) => c.startsWith('rmi'))).toEqual(['rmi mup-a:20261105-000000', 'rmi mup-a:20261101-000000', 'rmi 127.0.0.1:5000/mup-a:20261101-000000']);
    expect(r.out).toContain('Removed 3 images of mup-a; the newest stays: mup-a:20261110-000000 (linux/amd64).');
    expect(p.cache.entries().map((e) => e.version)).toEqual(['20261110-000000']);
    expect(existsSync(join(p.build, 'bundle'))).toBe(false);
    expect(existsSync(join(p.build, '.dockerignore'))).toBe(false);
    expect(existsSync(join(p.build, 'notes.txt'))).toBe(true);
  });

  it("leaves the images another project of the same name records", async () => {
    const p = project();
    // Another checkout of an app also named "a", with its own state.json.
    new BuildCache(join(p.root, 'other-app')).save(entry('20261101-000000'));
    docker = fakeDocker(script());
    const r = await prune(p.root);
    expect(r.code).toBe(0);
    expect(docker.calls().filter((c) => c.startsWith('rmi'))).toEqual(['rmi mup-a:20261105-000000', 'rmi 127.0.0.1:5000/mup-a:20261101-000000']);
  });

  it('rmi refused prints a warning and keeps the entry', async () => {
    const p = project();
    docker = fakeDocker(script({ refuse: 'mup-a:20261105-000000' }));
    const r = await prune(p.root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Warning: Could not remove mup-a:20261105-000000: Error response from daemon: conflict: unable to remove repository reference');
    expect(r.out).toContain('Removed 2 images of mup-a');
    expect(p.cache.entries().map((e) => e.version)).toEqual(['20261110-000000', '20261105-000000']);
  });

  it('ends with the registry hint when --registry is not given', async () => {
    const p = project();
    docker = fakeDocker(script());
    const r = await prune(p.root);
    expect(r.out.trimEnd().split('\n').pop()).toBe('The local registry holds 12.4 GB; "comet-deploy cache prune --registry" removes it.');
  });

  it('--registry removes the registry and its volume', async () => {
    const p = project();
    docker = fakeDocker(script());
    const r = await prune(p.root, ['--registry']);
    expect(r.code).toBe(0);
    expect(docker.calls()).toContain('rm -f comet-deploy-registry');
    expect(docker.calls()).toContain('volume rm comet-deploy-registry-data');
    expect(r.out).toContain('Removed the local registry and its volume (12.4 GB).');
    expect(r.out).not.toContain('"comet-deploy cache prune --registry" removes it');
  });

  it('--registry refuses while a deploy holds a lease', async () => {
    const p = project();
    docker = fakeDocker(script());
    const leases = join(cacheHome!, 'comet-deploy', 'registry-leases');
    mkdirSync(leases, { recursive: true });
    writeFileSync(join(leases, String(process.pid)), 'now');
    const r = await prune(p.root, ['--registry']);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`A deploy is using the local registry (pid ${process.pid}); run "cache prune --registry" when it has finished.`);
    expect(docker.calls().some((c) => c.startsWith('volume rm'))).toBe(false);
  });
});
