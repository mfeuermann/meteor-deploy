import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp, hashExclusions, hashExtras, prepareBundleSupported } from '../../../src/build/index.js';
import type { AppConfig } from '../../../src/config/types.js';
import type { CommandContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import { createReporter } from '../../../src/output/reporter.js';
import { fakeDocker, type FakeDocker } from '../../helpers/fake-docker.js';
import { tempDir } from '../../helpers/fs.js';

describe('prepareBundleSupported', () => {
  it('follows MUP: zodern/meteor and abernix/meteord, or an explicit prepareBundle', () => {
    expect(prepareBundleSupported({ image: 'zodern/meteor:root' })).toBe(true);
    expect(prepareBundleSupported({ image: 'abernix/meteord:node-12-base' })).toBe(true);
    expect(prepareBundleSupported({ image: 'kadirahq/meteord' })).toBe(false);
    expect(prepareBundleSupported({ image: 'my/custom', prepareBundle: true })).toBe(true);
    expect(prepareBundleSupported({ image: 'zodern/meteor', prepareBundle: false })).toBe(false);
  });
});

describe('buildApp in bundle mode', () => {
  const V1 = '20261115-120000';
  const V2 = '20261115-130000';
  // Answers what buildApp asks the local docker; `buildx` must never be called.
  const DOCKER = `case "$1" in
  image) echo sha256:img ;;
  create) echo cid1 ;;
  cp) cat > /dev/null ;;
  buildx) exit 99 ;;
esac
exit 0`;
  let docker: FakeDocker;
  let cacheHome: string | undefined;

  beforeEach(() => {
    docker = fakeDocker(DOCKER);
    cacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = tempDir();
  });
  afterEach(() => {
    docker.restore();
    if (cacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = cacheHome;
  });

  /** A context for a kadirahq/meteord app with a fake meteor that writes a tiny bundle. */
  function setup(o: { starJson?: boolean; docker?: Record<string, unknown>; env?: Record<string, string> } = {}) {
    const root = tempDir({ 'app/.meteor/release': 'METEOR@3.5.4', 'app/server/main.js': 'x' });
    const meteor = join(tempDir(), 'meteor.sh');
    const star = o.starJson === false ? '' : `; echo '{"nodeVersion":"22.12.0"}' > "$3/bundle/star.json"`;
    // `meteor build --directory <loc> …`: $3 is the build location.
    writeFileSync(meteor, `#!/bin/sh\nmkdir -p "$3/bundle"; echo main > "$3/bundle/main.js"${star}\n`);
    chmodSync(meteor, 0o755);
    const buildLocation = join(tempDir(), 'build');
    const lines: string[] = [];
    const reporter = createReporter({ verbose: false, tty: false, write: (s) => lines.push(s) });
    const app = {
      name: 'myapp',
      path: 'app',
      servers: {},
      env: o.env ?? {},
      docker: { image: 'kadirahq/meteord', ...o.docker },
      buildOptions: { serverOnly: true, buildLocation, executable: meteor },
    };
    const ctx = { config: { app }, basePath: root, reporter } as unknown as CommandContext;
    return { ctx, buildLocation, output: () => lines.join('') };
  }
  const build = (ctx: CommandContext, version = V1, extra: Record<string, unknown> = {}) =>
    buildApp(ctx, { platforms: ['linux/amd64'], version, cachedBuild: false, forceBuild: false, ...extra });

  it('builds the image with create, cp and commit, never buildx', async () => {
    const { ctx, buildLocation } = setup();
    const r = await build(ctx);
    expect(r).toEqual([
      { platform: 'linux/amd64', version: V1, localTag: `mup-myapp:${V1}`, imageId: 'sha256:img', nodeVersion: '22.12.0', depsHash: '', fromCache: false },
    ]);
    const calls = docker.calls();
    expect(calls).toContain('create --platform linux/amd64 kadirahq/meteord');
    expect(calls).toContain('cp - cid1:/');
    expect(calls).toContain(`commit --change LABEL comet-deploy.version=${V1} --change LABEL comet-deploy.bundle=1 cid1 mup-myapp:${V1}`);
    expect(calls).toContain('rm -f cid1');
    expect(calls.some((c) => c.startsWith('buildx'))).toBe(false);
    expect(existsSync(join(buildLocation, 'bundle.tar.gz'))).toBe(true);
  });

  it('prints the bundle-mode info line', async () => {
    const { ctx, output } = setup();
    await build(ctx);
    expect(output()).toContain(
      `bundle mode: mup-myapp:${V1} is "kadirahq/meteord" with the bundle in /bundle; the app installs its npm dependencies each time the container starts.`,
    );
  });

  it('warns that --cache-from and --cache-to are ignored', async () => {
    const warning = '--cache-from and --cache-to are ignored in bundle mode: the app image is not built with BuildKit.';
    const a = setup();
    await build(a.ctx, V1, { cacheFrom: ['type=local,src=/c'] });
    expect(a.output().split(warning).length - 1).toBe(1);
    const b = setup();
    await build(b.ctx);
    expect(b.output()).not.toContain(warning);
  });

  it('does not need a Node version', async () => {
    const { ctx } = setup({ starJson: false });
    const [img] = await build(ctx);
    expect(img.nodeVersion).toBe('');
  });

  it('ignores buildInstructions', async () => {
    const { ctx, output } = setup({ docker: { buildInstructions: ['RUN echo $API_HOST'] }, env: { API_HOST: 'h' } });
    await build(ctx);
    expect(output()).not.toContain('build args are visible');
    expect(docker.calls().some((c) => c.startsWith('buildx'))).toBe(false);
  });

  it('builds one image per platform', async () => {
    const { ctx, buildLocation } = setup();
    const r = await build(ctx, V1, { platforms: ['linux/amd64', 'linux/arm64'] });
    expect(r.map((i) => i.localTag)).toEqual([`mup-myapp:${V1}-amd64`, `mup-myapp:${V1}-arm64`]);
    const calls = docker.calls();
    expect(calls).toContain('create --platform linux/amd64 kadirahq/meteord');
    expect(calls).toContain('create --platform linux/arm64 kadirahq/meteord');
    expect(existsSync(join(`${buildLocation}-amd64`, 'bundle.tar.gz'))).toBe(true);
    expect(existsSync(join(`${buildLocation}-arm64`, 'bundle.tar.gz'))).toBe(true);
  });

  it('reuses an unchanged build', async () => {
    const { ctx, output } = setup();
    await build(ctx, V1);
    await build(ctx, V2);
    expect(output()).toContain(`No changes since ${V1}: reusing mup-myapp:${V1}`);
    expect(docker.calls().filter((c) => c.startsWith('create')).length).toBe(1);
  });

  it('reports a base image missing for the platform', async () => {
    docker.restore();
    docker = fakeDocker(`case "$1" in create) echo "no matching manifest" >&2; exit 1 ;; esac\n${DOCKER}`);
    const { ctx } = setup();
    await expect(build(ctx)).rejects.toThrow(CometError);
    await expect(build(ctx)).rejects.toThrow('The docker image "kadirahq/meteord" is not available for linux/amd64: no matching manifest');
  });
});

describe('hashExtras', () => {
  const app = (env: Record<string, string>, buildInstructions: string[] = ['RUN echo "$API_HOST" > /built_app/api']) =>
    ({ buildOptions: { serverOnly: true }, docker: { image: 'zodern/meteor:root', buildInstructions }, env }) as unknown as AppConfig;

  it('changes when an env value that a build instruction uses changes', () => {
    expect(hashExtras(app({ API_HOST: 'a' }), 'linux/amd64')).not.toEqual(hashExtras(app({ API_HOST: 'b' }), 'linux/amd64'));
  });

  it('ignores env values no build instruction uses', () => {
    expect(hashExtras(app({ API_HOST: 'a', MONGO_URL: 'x' }), 'linux/amd64')).toEqual(hashExtras(app({ API_HOST: 'a', MONGO_URL: 'y' }), 'linux/amd64'));
  });

  it('adds the mode only in bundle mode', () => {
    const bundle = { ...app({}), docker: { image: 'kadirahq/meteord' } } as unknown as AppConfig;
    expect(hashExtras(bundle, 'linux/amd64')).toMatchObject({ mode: 'bundle', bundleImage: 1 });
    const prepare = hashExtras(app({}), 'linux/amd64');
    expect(prepare).not.toHaveProperty('mode');
    expect(prepare).not.toHaveProperty('bundleImage');
  });

  it('keeps the build-arg values out of the cache state (only a digest)', () => {
    expect(JSON.stringify(hashExtras(app({ API_HOST: 'very-secret-value' }), 'linux/amd64'))).not.toContain('very-secret-value');
  });
});

describe('hashExclusions', () => {
  const a = '/home/u/myapp';
  it('leaves out the build location and a config directory whose path starts with a dot directory', () => {
    expect(hashExclusions(a, join(a, '.deploy'), '/tmp/build')).toEqual(['/tmp/build', join(a, '.deploy')]);
  });

  it('keeps a config directory Meteor would bundle or load, and the app root', () => {
    expect(hashExclusions(a, join(a, 'deploy'), '/tmp/build')).toEqual(['/tmp/build']);
    expect(hashExclusions(a, join(a, 'private/deploy'), '/tmp/build')).toEqual(['/tmp/build']);
    expect(hashExclusions(a, a, '/tmp/build')).toEqual(['/tmp/build']);
  });
});
