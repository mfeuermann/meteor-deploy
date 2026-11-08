import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Platform } from '../config/types.js';

export interface CacheEntry {
  inputHash: string;
  platform: Platform;
  version: string;
  localTag: string;
  imageId: string;
  bundleDir: string;
  nodeVersion: string;
  createdAt: string;
}

const MAX_ENTRIES = 20;

/** Local build state, outside the app repo: `<cache root>/comet-deploy/<sha256(appPath)[0..16]>/state.json`. */
export class BuildCache {
  readonly statePath: string;

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

  lookup(inputHash: string, platform: Platform): CacheEntry | null {
    return this.read().find((e) => e.inputHash === inputHash && e.platform === platform) ?? null;
  }

  latest(platform: Platform): CacheEntry | null {
    const list = this.read().filter((e) => e.platform === platform);
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return list[0] ?? null;
  }

  save(e: CacheEntry): void {
    const entries = [e, ...this.read().filter((x) => !(x.inputHash === e.inputHash && x.platform === e.platform))].slice(0, MAX_ENTRIES);
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
    renameSync(tmp, this.statePath);
  }
}
