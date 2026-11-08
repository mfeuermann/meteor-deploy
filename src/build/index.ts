import { join } from 'node:path';
import { resolveAppPath } from '../config/normalize.js';
import type { DockerOptions, Platform } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { localImageRepo } from '../core/naming.js';
import { TOOL_ID } from '../core/version.js';
import { buildImage, imageId, pullImage } from '../local/docker.js';
import { BuildCache } from './cache.js';
import { argKeysForInstructions, computeDepsHash, DOCKERFILE_VERSION, planBuildContext, renderDockerfile } from './dockerfile.js';
import { computeInputHash } from './input-hash.js';
import { meteorArchFor, runMeteorBuild } from './meteor-build.js';
import { readNodeVersion } from './node-version.js';

export interface BuiltImage {
  platform: Platform;
  version: string;
  localTag: string;
  imageId: string;
  nodeVersion: string;
  depsHash: string;
  fromCache: boolean;
}

/** MUP's prepareBundleSupported (ref. §2.3). */
export function prepareBundleSupported(docker: DockerOptions): boolean {
  if ('prepareBundle' in docker) return !!docker.prepareBundle;
  return ['abernix/meteord', 'zodern/meteor'].some((img) => (docker.image ?? '').startsWith(img));
}

const archSuffix = (p: Platform) => (p === 'linux/arm64' ? 'arm64' : 'amd64');

/** Builds (or reuses) one local image per target platform. */
export async function buildApp(
  ctx: CommandContext,
  o: { platforms: Platform[]; version: string; cachedBuild: boolean; forceBuild: boolean },
): Promise<BuiltImage[]> {
  const { app } = ctx.config;
  const r = ctx.reporter;
  if (!prepareBundleSupported(app.docker)) {
    throw new CometError(
      `The docker image "${app.docker.image}" cannot build an app image (MUP bundle mode). Bundle mode is planned for phase 2 of comet-deploy.`,
      { hint: 'Use a zodern/meteor image (app.docker.image), e.g. "zodern/meteor:root".' },
    );
  }
  const appPath = resolveAppPath(ctx.config, ctx.basePath);
  const cache = new BuildCache(appPath);
  const multi = o.platforms.length > 1;
  const instructions = app.docker.buildInstructions ?? [];
  const results: BuiltImage[] = [];

  for (const platform of o.platforms) {
    const localTag = `${localImageRepo(ctx.config)}:${multi ? `${o.version}-${archSuffix(platform)}` : o.version}`;
    const buildLocation = multi ? `${app.buildOptions.buildLocation}-${archSuffix(platform)}` : app.buildOptions.buildLocation;

    if (o.cachedBuild) {
      const e = cache.latest(platform);
      if (!e || (await imageId(e.localTag)) !== e.imageId) {
        throw new CometError(`Unable to use previous build for ${platform}: no cached image found.`, { hint: 'Deploy without --cached-build.' });
      }
      r.info(`Using the previous build ${e.localTag} (--cached-build)`);
      results.push({ ...pick(e), fromCache: true });
      continue;
    }

    const inputHash = await computeInputHash(
      appPath,
      { buildOptions: app.buildOptions, platform, tool: TOOL_ID, image: app.docker.image, buildInstructions: instructions, dockerfile: DOCKERFILE_VERSION },
      { exclude: [buildLocation] },
    );
    if (!o.forceBuild) {
      const e = cache.lookup(inputHash, platform);
      if (e && (await imageId(e.localTag)) === e.imageId) {
        r.info(`No changes since ${e.version}: reusing ${e.localTag}`);
        results.push({ ...pick(e), fromCache: true });
        continue;
      }
    }

    await pullImage(app.docker.image!, platform, (l) => r.verboseLine(null, l));
    const bundleDir = await r.phase(`meteor build (${platform})`, () =>
      runMeteorBuild(app, { appPath, buildLocation, arch: meteorArchFor(platform), reporter: r }),
    );
    const nodeVersion = readNodeVersion(bundleDir);
    const plan = planBuildContext(bundleDir);
    const depsHash = await computeDepsHash(bundleDir, plan);
    const argKeys = argKeysForInstructions(instructions, Object.keys(app.env ?? {}));
    if (argKeys.length) r.warn(`build args are visible in image history: ${argKeys.join(', ')}`);
    const dockerfile = renderDockerfile({
      baseImage: app.docker.image!,
      buildInstructions: instructions,
      argKeys,
      plan,
      chownApp: (app.docker.image ?? '').startsWith('zodern/meteor'),
    });
    const buildArgs: Record<string, string> = { NODE_VERSION: nodeVersion };
    for (const k of argKeys) buildArgs[k] = String(app.env[k]);
    const built = await r.phase(`docker build (${platform})`, () =>
      buildImage({
        contextDir: join(bundleDir, '..'),
        dockerfile,
        platform,
        tag: localTag,
        buildArgs,
        labels: { 'comet-deploy.deps-hash': depsHash, 'comet-deploy.version': o.version },
        onLine: (l) => r.verboseLine(null, l),
      }),
    );
    const entry = {
      inputHash,
      platform,
      version: o.version,
      localTag,
      imageId: built.imageId,
      bundleDir,
      nodeVersion,
      depsHash,
      createdAt: new Date().toISOString(),
    };
    cache.save(entry);
    results.push({ ...pick(entry), fromCache: false });
  }
  return results;
}

function pick(e: { platform: Platform; version: string; localTag: string; imageId: string; nodeVersion: string; depsHash?: string }) {
  return { platform: e.platform, version: e.version, localTag: e.localTag, imageId: e.imageId, nodeVersion: e.nodeVersion, depsHash: e.depsHash ?? '' };
}
