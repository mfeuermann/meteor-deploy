/**
 * Local build cache. It records which image was built from which inputs, so a deploy whose input
 * hash matches an earlier build (and whose image still exists locally) skips both `meteor build`
 * and `docker build` and reuses that image. The state file lives in the user's cache directory,
 * never in the app repository.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Platform } from '../config/types.js';

/** One finished build, as stored in `state.json`. */
export interface CacheEntry {
  /** `computeInputHash` of the app at build time; together with `platform` the cache key. */
  inputHash: string;
  platform: Platform;
  /** Version the image was built under. A cache hit deploys the image under this version again. */
  version: string;
  /** Local image tag (`mup-<app>:<version>`, plus `-amd64`/`-arm64` for multi-platform builds). */
  localTag: string;
  /** Image id (`sha256:…`) of `localTag` at build time; another id means the tag was reused. */
  imageId: string;
  /** The `bundle/` directory that `meteor build` produced. */
  bundleDir: string;
  /** Node version of the bundle, passed to the image build as `NODE_VERSION`. */
  nodeVersion: string;
  /**
   * Content hash of the dependency layer inputs (see `computeDepsHash`), kept so that a shared
   * deps image keyed by this hash can be introduced later.
   */
  depsHash: string;
  /** ISO 8601 timestamp; `latest()` orders by it. */
  createdAt: string;
}

/** Entries kept per app; older ones are forgotten (their images stay in the local Docker). */
const MAX_ENTRIES = 20;

/**
 * Local build state of one app, outside the app repository:
 * `<cache root>/comet-deploy/<sha256(appPath)[0..16]>/state.json`, where the cache root is
 * `$XDG_CACHE_HOME` or `~/.cache`. A missing or unreadable state file reads as empty, so the worst
 * case is a needless build.
 */
export class BuildCache {
  readonly statePath: string;

  /** @param root Cache root directory; tests pass a temporary one. */
  constructor(appPath: string, root: string = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')) {
    const key = createHash('sha256').update(appPath).digest('hex').slice(0, 16);
    this.statePath = join(root, 'comet-deploy', key, 'state.json');
  }

  private read(): CacheEntry[] {
    try {
      const v = JSON.parse(readFileSync(this.statePath, 'utf8'));
      return Array.isArray(v?.entries) ? v.entries : [];
    } catch {
      return [];
    }
  }

  /**
   * The entry built from exactly these inputs for `platform`, or null. The caller still checks
   * that its image exists locally with the same id.
   */
  lookup(inputHash: string, platform: Platform): CacheEntry | null {
    return this.read().find((e) => e.inputHash === inputHash && e.platform === platform) ?? null;
  }

  /** The newest entry for `platform`, whatever its inputs (used by `--cached-build`), or null. */
  latest(platform: Platform): CacheEntry | null {
    const list = this.read().filter((e) => e.platform === platform);
    // ISO 8601 timestamps sort chronologically as strings; newest first.
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return list[0] ?? null;
  }

  /**
   * Stores `e` as the newest entry, replacing an older entry with the same input hash and
   * platform, and keeps at most `MAX_ENTRIES`. Writes the local cache directory.
   */
  save(e: CacheEntry): void {
    const entries = [e, ...this.read().filter((x) => !(x.inputHash === e.inputHash && x.platform === e.platform))].slice(0, MAX_ENTRIES);
    mkdirSync(dirname(this.statePath), { recursive: true });
    // Write a temp file and rename it over the state file (atomic on one filesystem), so a reader
    // or a crash never sees a half-written file. Two deploys of the same app saving at once can
    // still lose one entry (the last writer wins), which only costs a rebuild later.
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
    renameSync(tmp, this.statePath);
  }
}
