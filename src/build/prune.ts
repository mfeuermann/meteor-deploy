/**
 * `cache prune` (commands design §4.5): removes local build leftovers of the app in the config
 * — image versions, the build output and, with `--registry`, the local registry — without
 * touching the servers.
 *
 * state.json is keyed by the app path, not by the config, so two configs with the same
 * `app.path` (`.deploy/staging`, `.deploy/production`) share one file. Prune therefore only
 * looks at entries and tags of this config's repository `mup-<app.name>`.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { resolveAppPath } from '../config/normalize.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { localImageRepo } from '../core/naming.js';
import { run } from '../local/exec.js';
import { formatBytes } from '../transfer/stream.js';
import { REGISTRY_VOLUME, removeLocalRegistry, type RegistryEnv } from '../transfer/local-registry.js';
import { BuildCache, type CacheEntry } from './cache.js';
import { VERSION_RE } from './version.js';

export interface PrunePlan {
  /** Refs to `docker rmi`: tags of the entries that go, then unrecorded version tags. */
  removeRefs: string[];
  /** Entries of the repo to forget (once `docker rmi` of their tag worked, or it is gone). */
  removeEntries: CacheEntry[];
  /** The newest entry per platform, which stays (empty with `all`). */
  keep: CacheEntry[];
  /** Refs of the repo that stay: tags that are no version, and versions not older than `keep`. */
  untouched: string[];
}

const repoOf = (ref: string) => ref.slice(0, ref.lastIndexOf(':'));
const tagOf = (ref: string) => ref.slice(ref.lastIndexOf(':') + 1);
/** The `YYYYMMDD-HHMMSS` of a version tag (with or without `-amd64`/`-arm64`), else null. */
function versionStamp(tag: string): string | null {
  const t = tag.replace(/-(amd64|arm64)$/, '');
  return VERSION_RE.test(t) ? t.slice(0, 15) : null;
}

/**
 * What to remove, from the cache entries and the local refs (`repository:tag` lines of
 * `docker images`). A ref belongs to `repo` when its repository is `repo` or ends with
 * `/<repo>` (`127.0.0.1:<port>/mup-a`, left by an interrupted push). Without `all`, the newest
 * entry per platform stays, and an unrecorded version tag goes only when it is older than the
 * oldest entry that stays; with no entry staying, unrecorded tags stay (a deploy that builds
 * right now has not recorded its image yet). `protectedRefs` (the tags other app paths record,
 * see BuildCache.entriesOfOtherApps) never go, also not with `all`. Pure.
 */
export function planPrune(o: { entries: CacheEntry[]; repo: string; refs: string[]; all: boolean; protectedRefs?: string[] }): PrunePlan {
  const own = o.entries.filter((e) => repoOf(e.localTag) === o.repo);
  const keep: CacheEntry[] = [];
  if (!o.all) {
    // ISO 8601 timestamps sort chronologically as strings; newest first.
    const newestFirst = [...own].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    for (const e of newestFirst) if (!keep.some((k) => k.platform === e.platform)) keep.push(e);
  }
  const removeEntries = own.filter((e) => !keep.includes(e));
  const present = new Set(o.refs);
  const keepTags = new Set(keep.map((e) => e.localTag));
  const recorded = new Set(own.map((e) => e.localTag));
  const others = new Set(o.protectedRefs ?? []);
  const removeRefs = [...new Set(removeEntries.map((e) => e.localTag))].filter((t) => !keepTags.has(t) && !others.has(t) && present.has(t));
  const stamps = keep.map((e) => versionStamp(e.version)).filter((s): s is string => s !== null);
  const threshold = stamps.length ? stamps.reduce((a, b) => (a < b ? a : b)) : null;
  const untouched: string[] = [];
  for (const ref of o.refs) {
    const repository = repoOf(ref);
    if (repository !== o.repo && !repository.endsWith(`/${o.repo}`)) continue;
    if (recorded.has(ref)) continue;
    if (others.has(ref)) {
      untouched.push(ref);
      continue;
    }
    const stamp = versionStamp(tagOf(ref));
    if (stamp !== null && (o.all || (threshold !== null && stamp < threshold))) removeRefs.push(ref);
    else untouched.push(ref);
  }
  return { removeRefs, removeEntries, keep, untouched };
}

/** What comet-deploy writes into a build directory. */
const BUILD_FILES = ['bundle', 'bundle.tar.gz', '.dockerignore'];

/**
 * The build output of the app that exists now: with `cleanBuildLocation` the whole
 * `buildLocation` (comet-deploy deletes it before each build anyway), else only what
 * comet-deploy writes into it (BUILD_FILES), so other files in a directory of the user stay.
 * Of the `-amd64`/`-arm64` variants only BUILD_FILES go: deploy creates and deletes those
 * directories only for multi-platform builds, and next to a custom `buildLocation` a folder of
 * that name can be the user's own.
 */
export function buildDirTargets(o: { buildLocation: string; cleanBuildLocation?: boolean }): string[] {
  const files = (d: string) => BUILD_FILES.map((f) => join(d, f));
  const variants = [`${o.buildLocation}-amd64`, `${o.buildLocation}-arm64`];
  const base = o.cleanBuildLocation ? [o.buildLocation] : files(o.buildLocation);
  return [...base, ...variants.flatMap(files)].filter((p) => existsSync(p));
}

/** A size as Docker prints it (`3.371GB`, `512MB`, `0B`; decimal units), in bytes; else null. */
export function parseDockerSize(s: string): number | null {
  const m = /^([\d.]+)\s*([kKMGTP]?)B$/.exec(s.trim());
  if (!m) return null;
  const power = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[m[2]] ?? 0;
  return Math.round(Number(m[1]) * 1000 ** power);
}

/** `312 MB`, from one gigabyte on `12.4 GB`. */
function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : formatBytes(bytes);
}

/** Bytes of a file or a directory tree; symbolic links count as themselves. */
function pathSize(p: string): number {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((sum, name) => sum + pathSize(join(p, name)), 0);
}

/**
 * Whether deleting `p` is out of the question whatever the config says: `/`, the home
 * directory, the app itself or a directory that holds it.
 */
function tooBroad(p: string, appPath: string): boolean {
  const abs = resolve(p);
  return abs === resolve('/') || abs === homedir() || abs === appPath || appPath.startsWith(abs + sep);
}

/** The size of the registry volume from `docker system df -v`; null when Docker does not say. */
async function registryVolumeSize(): Promise<number | null> {
  const r = await run('docker', ['system', 'df', '-v', '--format', 'json']);
  if (r.code !== 0) return null;
  try {
    const volumes = (JSON.parse(r.stdout) as { Volumes?: Array<{ Name?: string; Size?: string }> }).Volumes ?? [];
    const v = volumes.find((x) => x.Name === REGISTRY_VOLUME);
    return v?.Size ? parseDockerSize(v.Size) : null;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface PruneOptions {
  all: boolean;
  registry: boolean;
  dryRun: boolean;
}

/**
 * Runs `cache prune`: with `registry` the local registry first (so a refusal changes nothing),
 * then the image versions and cache entries of the app, then its build output, and without
 * `registry` a closing hint about the registry's size. A tag Docker refuses to remove (a
 * container uses it) is a warning, and its entry stays.
 *
 * @throws CometError when Docker does not answer, or a deploy holds a lease of the registry
 */
export async function pruneCache(ctx: CommandContext, o: PruneOptions, env: RegistryEnv = {}): Promise<void> {
  await ctx.runner.run('cache.prune', async () => {
    const c = ctx.config;
    const r = ctx.reporter;
    const verb = o.dryRun ? 'Would remove' : 'Removed';
    const repo = localImageRepo(c);
    const appPath = resolveAppPath(c, ctx.basePath);

    const images = await run('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
    if (images.code !== 0) {
      throw new CometError(`Docker does not answer: ${images.stderr.trim() || `exit ${images.code}`}`, { hint: 'Start Docker and run "comet-deploy cache prune" again.' });
    }
    const volumeExists = (await run('docker', ['volume', 'inspect', REGISTRY_VOLUME])).code === 0;
    const volumeSize = volumeExists ? await registryVolumeSize() : null;
    const sized = (what: string) => (volumeSize === null ? what : `${what} (${formatSize(volumeSize)})`);

    if (o.registry) {
      if (!o.dryRun) {
        const res = await removeLocalRegistry(env);
        if (!res.removed) throw new CometError(`A deploy is using the local registry (pid ${res.pid}); run "cache prune --registry" when it has finished.`);
      }
      r.info(volumeExists ? `${sized(`${verb} the local registry and its volume`)}.` : 'There is no local registry.');
    }

    const cache = new BuildCache(appPath);
    const refs = images.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const protectedRefs = cache.entriesOfOtherApps().map((e) => e.localTag);
    const plan = planPrune({ entries: cache.entries(), repo, refs, all: o.all, protectedRefs });
    const failed = new Set<string>();
    for (const ref of plan.removeRefs) {
      if (o.dryRun) {
        r.verboseLine(null, `would remove ${ref}`);
        continue;
      }
      const rmi = await run('docker', ['rmi', ref]);
      if (rmi.code === 0) r.verboseLine(null, `removed ${ref}`);
      else {
        failed.add(ref);
        r.warn(`Could not remove ${ref}: ${rmi.stderr.trim().split('\n')[0] || `exit ${rmi.code}`}`);
      }
    }
    for (const ref of plan.untouched) r.verboseLine(null, `left ${ref}`);
    if (!o.dryRun) {
      const key = (e: CacheEntry) => `${e.inputHash} ${e.platform} ${e.localTag}`;
      const forget = new Set(plan.removeEntries.filter((e) => !failed.has(e.localTag)).map(key));
      cache.remove((e) => forget.has(key(e)));
    }
    const count = plan.removeRefs.length - failed.size;
    const stays = plan.keep.length ? `; the newest stays: ${plan.keep.map((e) => `${e.localTag} (${e.platform})`).join(', ')}` : '';
    r.info(count ? `${verb} ${plural(count, 'image', 'images')} of ${repo}${stays}.` : `No images of ${repo} to remove${stays}.`);

    const targets = buildDirTargets(c.app.buildOptions);
    const removable = targets.filter((t) => {
      if (!tooBroad(t, appPath)) return true;
      r.warn(`Left ${t}: it is the app, holds the app, or is a top directory.`);
      return false;
    });
    if (removable.length) {
      const bytes = removable.reduce((sum, t) => sum + pathSize(t), 0);
      if (!o.dryRun) for (const t of removable) rmSync(t, { recursive: true, force: true, maxRetries: 10 });
      r.info(`${verb} the build output (${formatSize(bytes)}): ${removable.join(', ')}.`);
    }

    if (!o.registry && volumeExists) {
      r.info(
        volumeSize === null
          ? 'The local registry keeps the image layers of earlier deploys; "comet-deploy cache prune --registry" removes it.'
          : `The local registry holds ${formatSize(volumeSize)}; "comet-deploy cache prune --registry" removes it.`,
      );
    }
  });
}
