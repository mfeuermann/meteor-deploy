/**
 * The input hash of the build cache: a deterministic hash of everything that can change the built
 * image. File contents count and modification times do not, so a fresh checkout or a `touch`
 * does not force a rebuild. A needless build is better than a wrong skip, so the inputs are
 * chosen conservatively: any file in the app directory counts, not only source files.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Paths relative to the app root that never count: Meteor's local build cache, node_modules
 * (covered by `nodeModulesManifest` instead) and the git metadata.
 */
const ALWAYS_EXCLUDED = ['.meteor/local', 'node_modules', '.git'];

/** JSON with object keys sorted at every level, so key order in the config does not matter. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

const toPosix = (p: string) => p.split(sep).join('/');

interface Entry {
  /** Path relative to the walked root, with `/` separators. */
  rel: string;
  /** Absolute path to read (symlinks resolved by readFile); null for a broken link. */
  abs: string | null;
  /** Target text of a broken link. */
  link?: string;
}

/**
 * Every file below `root` (sorted by relative path). Symlinks are followed — a workspace package
 * or a linked directory is part of the build — with a guard against cycles; a broken link is
 * recorded by its target text. `excluded` holds paths relative to `root`; `skipNames` are names
 * skipped at any depth.
 */
async function listFiles(root: string, excluded: Set<string>, skipNames: Set<string> = new Set()): Promise<Entry[]> {
  const out: Entry[] = [];
  // Directories already walked, by real path: a symlink cycle (or a second link to the same
  // directory) is walked only once.
  const visited = new Set<string>();
  async function walk(dir: string, relDir: string): Promise<void> {
    const real = await realpath(dir).catch(() => dir);
    if (visited.has(real)) return;
    visited.add(real);
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (excluded.has(rel) || skipNames.has(d.name)) continue;
      const abs = join(dir, d.name);
      if (d.isDirectory()) await walk(abs, rel);
      else if (d.isFile()) out.push({ rel, abs });
      else if (d.isSymbolicLink()) {
        const target = await stat(abs).catch(() => null);
        if (!target) out.push({ rel, abs: null, link: await readlink(abs).catch(() => '?') });
        else if (target.isDirectory()) await walk(abs, rel);
        else if (target.isFile()) out.push({ rel, abs });
      }
    }
  }
  await walk(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** sha256 of a file's content; a broken link hashes as its target text. */
async function contentHash(e: Entry): Promise<string> {
  return e.abs ? createHash('sha256').update(await readFile(e.abs)).digest('hex') : `broken-link:${e.link}`;
}

/** Content hash of a linked package (its own node_modules and .git excluded). */
async function treeHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const e of await listFiles(dir, new Set(), new Set(['node_modules', '.git']))) h.update(`${e.rel}\0${await contentHash(e)}\n`);
  return h.digest('hex');
}

/**
 * `name@version` of every top-level and scoped package in node_modules. A symlinked package
 * (npm/yarn workspaces, `file:` deps) changes without a version bump, so it is hashed by content
 * instead. This is the quick variant: nested packages are not listed, but a change to them
 * normally shows up in `package-lock.json`, which is hashed as an app file.
 */
async function nodeModulesManifest(appPath: string): Promise<string[]> {
  const nm = join(appPath, 'node_modules');
  const out: string[] = [];
  const readPkg = async (dir: string, isLink: boolean, name: string) => {
    if (isLink) {
      const target = await stat(dir).catch(() => null);
      if (target?.isDirectory()) out.push(`${name}@link:${await treeHash(dir)}`);
      return;
    }
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
        await readPkg(join(nm, d.name, s.name), s.isSymbolicLink(), `${d.name}/${s.name}`);
      }
    } else if (!d.name.startsWith('.')) {
      // Dot directories (`.bin`, npm's `.cache`) are not packages.
      await readPkg(join(nm, d.name), d.isSymbolicLink(), d.name);
    }
  }
  return out.sort();
}

/**
 * Content hash of the build inputs: app files by relative path + content (mtime is ignored),
 * node_modules as a name@version list, plus `extra` (build options, architecture, tool version,
 * Dockerfile …) as key-order-independent JSON. Each part is tagged (`file`, `npm`, `extra`) and
 * NUL-separated, so the parts cannot run into each other.
 *
 * `o.exclude` lists more paths to leave out (the build location), absolute or relative to
 * `appPath`; paths outside the app directory are ignored.
 */
export async function computeInputHash(appPath: string, extra: Record<string, unknown>, o: { exclude?: string[] } = {}): Promise<string> {
  const excluded = new Set(ALWAYS_EXCLUDED);
  for (const e of o.exclude ?? []) {
    const rel = isAbsolute(e) ? relative(appPath, e) : e;
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) excluded.add(toPosix(rel).replace(/\/$/, ''));
  }
  const h = createHash('sha256');
  for (const e of await listFiles(appPath, excluded)) h.update(`file\0${e.rel}\0${await contentHash(e)}\n`);
  for (const pkg of await nodeModulesManifest(appPath)) h.update(`npm\0${pkg}\n`);
  h.update(`extra\0${stableStringify(extra)}\n`);
  return h.digest('hex');
}
