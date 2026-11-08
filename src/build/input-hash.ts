import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const ALWAYS_EXCLUDED = ['.meteor/local', 'node_modules', '.git'];

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

const toPosix = (p: string) => p.split(sep).join('/');

async function listFiles(root: string, excluded: Set<string>): Promise<Array<{ rel: string; dirent: Dirent }>> {
  const out: Array<{ rel: string; dirent: Dirent }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const d of entries) {
      const rel = toPosix(relative(root, join(dir, d.name)));
      if (excluded.has(rel)) continue;
      if (d.isDirectory()) await walk(join(dir, d.name));
      else if (d.isFile() || d.isSymbolicLink()) out.push({ rel, dirent: d });
    }
  }
  await walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** `name@version` of every top-level and scoped package in node_modules. */
async function nodeModulesManifest(appPath: string): Promise<string[]> {
  const nm = join(appPath, 'node_modules');
  const out: string[] = [];
  const readPkg = async (dir: string) => {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      out.push(`${pkg.name}@${pkg.version}`);
    } catch {
      // not a package (or unreadable): ignore
    }
  };
  let top: Dirent[];
  try {
    top = await readdir(nm, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of top) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    if (d.name.startsWith('@')) {
      for (const s of await readdir(join(nm, d.name), { withFileTypes: true }).catch(() => [] as Dirent[])) {
        await readPkg(join(nm, d.name, s.name));
      }
    } else if (!d.name.startsWith('.')) {
      await readPkg(join(nm, d.name));
    }
  }
  return out.sort();
}

/**
 * Content hash of the build inputs (spec §8.1): app files by relative path +
 * content (mtime is ignored), node_modules as a name@version list, plus `extra`
 * (build options, architecture, tool version, Dockerfile …).
 */
export async function computeInputHash(appPath: string, extra: Record<string, unknown>, o: { exclude?: string[] } = {}): Promise<string> {
  const excluded = new Set(ALWAYS_EXCLUDED);
  for (const e of o.exclude ?? []) {
    const rel = isAbsolute(e) ? relative(appPath, e) : e;
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) excluded.add(toPosix(rel).replace(/\/$/, ''));
  }
  const h = createHash('sha256');
  for (const { rel, dirent } of await listFiles(appPath, excluded)) {
    const abs = join(appPath, rel);
    const content = dirent.isSymbolicLink() ? `link:${await readlink(abs)}` : createHash('sha256').update(await readFile(abs)).digest('hex');
    h.update(`file\0${rel}\0${content}\n`);
  }
  for (const pkg of await nodeModulesManifest(appPath)) h.update(`npm\0${pkg}\n`);
  h.update(`extra\0${stableStringify(extra)}\n`);
  return h.digest('hex');
}
