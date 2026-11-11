/**
 * The build step of a deploy. For each target platform it either reuses a cached local image
 * (the inputs did not change, or `--cached-build`) or runs `meteor build` locally and builds the
 * layered app image with `docker buildx build`. The result is one local image per platform, ready
 * to be pushed to the local registry.
 */
import { join } from 'node:path';
import { resolveAppPath } from '../config/normalize.js';
import type { DockerOptions, Platform } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { localImageRepo } from '../core/naming.js';
import { TOOL_ID } from '../core/version.js';
import { buildImage, imageId, pullImage } from '../local/docker.js';
import { BuildCache } from './cache.js';
import { argKeysForInstructions, computeDepsHash, DOCKERFILE_VERSION, planBuildContext, renderDockerfile, writeContextIgnore } from './dockerfile.js';
import { computeInputHash } from './input-hash.js';
import { meteorArchFor, runMeteorBuild } from './meteor-build.js';
import { readNodeVersion } from './node-version.js';

/** A local image for one platform, built now or taken from the build cache. */
export interface BuiltImage {
  platform: Platform;
  /** Version the image was built under. After a cache hit this is the earlier build's version. */
  version: string;
  /** Local tag of the image (see `CacheEntry.localTag`). */
  localTag: string;
  imageId: string;
  nodeVersion: string;
  /** Content hash of the deps layer inputs; empty for a cache entry that has none. */
  depsHash: string;
  /** True when nothing was built (input-hash hit or `--cached-build`). */
  fromCache: boolean;
}

/**
 * MUP's `prepareBundleSupported`: whether the base image can build an app image. An explicit
 * `docker.prepareBundle` decides; otherwise only `abernix/meteord` and `zodern/meteor` images
 * can. Without it MUP runs in bundle mode (the container installs the uploaded bundle when it
 * starts), which comet-deploy does not support yet.
 */
export function prepareBundleSupported(docker: Pick<DockerOptions, 'image' | 'prepareBundle'>): boolean {
  if ('prepareBundle' in docker) return !!docker.prepareBundle;
  return ['abernix/meteord', 'zodern/meteor'].some((img) => (docker.image ?? '').startsWith(img));
}

/** Suffix that keeps the local tags and build directories of a multi-platform build apart. */
const archSuffix = (p: Platform) => (p === 'linux/arm64' ? 'arm64' : 'amd64');

/**
 * Builds (or reuses) one local image per target platform, one platform after the other.
 *
 * With `cachedBuild` the newest cached image of the platform is used whatever changed (MUP's
 * `--cached-build`). Otherwise the input hash is computed and a cached image built from the same
 * inputs is reused, unless `forceBuild`. A cached entry counts only while its tag still points to
 * the recorded image id. Everything else is a full build: pull the base image, `meteor build`,
 * render the Dockerfile, `docker buildx build`, then record the result in the build cache.
 *
 * @throws CometError when the base image cannot build an app image (MUP bundle mode), when
 *   `--cached-build` finds no usable image, or when `meteor build` or the image build fails.
 */
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
    // With several platforms each build gets its own local tag and bundle directory. The servers
    // still get `mup-<app>:<version>`: the pull script retags the image there.
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

    // `extra` holds the inputs outside the app directory that change the image. The build
    // location may lie inside the app; hashing it would change the hash on every build.
    const inputHash = await computeInputHash(
      appPath,
      { buildOptions: app.buildOptions, platform, tool: TOOL_ID, image: app.docker.image, buildInstructions: instructions, dockerfile: DOCKERFILE_VERSION },
      { exclude: [buildLocation] },
    );
    if (!o.forceBuild) {
      const e = cache.lookup(inputHash, platform);
      // The tag may have been removed or rebuilt since (`docker image prune`, a manual build).
      if (e && (await imageId(e.localTag)) === e.imageId) {
        r.info(`No changes since ${e.version}: reusing ${e.localTag}`);
        results.push({ ...pick(e), fromCache: true });
        continue;
      }
    }

    // As MUP does: refresh the base image first so `FROM` does not use an outdated local copy.
    // A failed pull (offline, rate limit) is ignored; the build reports real problems.
    await pullImage(app.docker.image!, platform, (l) => r.verboseLine(null, l));
    const bundleDir = await r.phase(`meteor build (${platform})`, () =>
      runMeteorBuild(app, { appPath, buildLocation, arch: meteorArchFor(platform), reporter: r }),
    );
    const nodeVersion = readNodeVersion(bundleDir);
    const plan = planBuildContext(bundleDir);
    const depsHash = await computeDepsHash(bundleDir, plan);
    const argKeys = argKeysForInstructions(instructions, Object.keys(app.env ?? {}));
    // Build-arg values are recorded in the image history (`docker history`) on every server.
    if (argKeys.length) r.warn(`build args are visible in image history: ${argKeys.join(', ')}`);
    const dockerfile = renderDockerfile({
      baseImage: app.docker.image!,
      buildInstructions: instructions,
      argKeys,
      plan,
      chownApp: (app.docker.image ?? '').startsWith('zodern/meteor'),
    });
    // NODE_VERSION is read by the base image's ONBUILD steps, which install that Node version.
    const buildArgs: Record<string, string> = { NODE_VERSION: nodeVersion };
    for (const k of argKeys) buildArgs[k] = String(app.env[k]);
    // The build context is the build location, the parent of `bundle/`.
    writeContextIgnore(join(bundleDir, '..'));
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

/**
 * The `BuiltImage` fields of a cache entry. `depsHash` is optional because a state file written
 * by an older comet-deploy may not have it.
 */
function pick(e: { platform: Platform; version: string; localTag: string; imageId: string; nodeVersion: string; depsHash?: string }) {
  return { platform: e.platform, version: e.version, localTag: e.localTag, imageId: e.imageId, nodeVersion: e.nodeVersion, depsHash: e.depsHash ?? '' };
}
