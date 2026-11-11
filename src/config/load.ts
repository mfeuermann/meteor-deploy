/**
 * Finds and loads the config file (`mup.js` or `mup.json`) and the Meteor settings file, and
 * resolves user-supplied paths the way MUP does. This is the first step of every command that
 * needs a config: load, then normalize (normalize.ts), then validate (validate.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CometError } from '../core/errors.js';
import type { RawConfig } from './types.js';

/** A loaded, not yet normalized config. */
export interface LoadedConfig {
  /** Absolute path of the config file. */
  configPath: string;
  /** Directory that config-relative paths resolve against: the `--config` directory, else cwd. */
  basePath: string;
  /** The exported object as is. */
  raw: RawConfig;
}

// This package is ESM, but mup.js is a CommonJS module that MUP loads with require().
const require = createRequire(import.meta.url);

/** Expands a leading `~` or `~/` to the home directory; other paths are returned unchanged. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Returns the absolute path of the config file: `--config` (relative to cwd), else
 * `./mup.js`, else `./mup.json`. MUP only looks for `mup.js`; finding `mup.json` without
 * `--config` is a comet-deploy addition.
 *
 * @throws CometError when the file does not exist.
 */
export function findConfigFile(cwd: string, configFlag?: string): string {
  if (configFlag) {
    const p = resolve(cwd, expandTilde(configFlag));
    if (!existsSync(p)) throw new CometError(`Config file not found: ${p}`);
    return p;
  }
  for (const name of ['mup.js', 'mup.json']) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  throw new CometError(`"mup.js" or "mup.json" not found in ${cwd}.`, {
    hint: 'Run "comet-deploy init" to create one, or pass --config <path>.',
  });
}

/**
 * Reads a config file: JSON is parsed directly (for a clear error message), anything else is
 * executed as a CommonJS module. Every call evaluates the file again.
 *
 * @throws CometError when the file cannot be read, parsed or executed.
 */
function loadFile(path: string): RawConfig {
  if (path.endsWith('.json')) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new CometError(`Cannot read ${path}: ${(err as Error).message}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new CometError(`Invalid JSON in ${path}: ${(err as Error).message}`);
    }
  }
  try {
    const resolved = require.resolve(path);
    // Like MUP: drop the cached module so a changed file is picked up.
    delete require.cache[resolved];
    const mod = require(resolved);
    if (isEmptyEsmNamespace(mod)) return compileAsCommonJs(resolved);
    // `default` covers transpiled ESM and an `export default` file loaded by require(esm).
    return (mod && mod.__esModule && mod.default) || mod;
  } catch (err) {
    if (isCjsInEsmScopeError(err)) {
      try {
        return compileAsCommonJs(path);
      } catch (inner) {
        throw new CometError(`Failed to load ${path}: ${(inner as Error).message}`, { cause: inner });
      }
    }
    throw new CometError(`Failed to load ${path}: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * On Node versions with require(esm) (default since 22.12 and 20.19), require() of a `.js`
 * file in a `"type": "module"` package evaluates it as ESM. A file that runs as ESM without
 * throwing but exports nothing (for example one that only sets `module.exports` behind a
 * `typeof module` check) comes back as an empty module namespace, which means it was meant
 * as CommonJS. Node's `module.exports` interop export name does not count as an export.
 */
function isEmptyEsmNamespace(mod: unknown): boolean {
  return (
    !!mod &&
    typeof mod === 'object' &&
    (mod as any)[Symbol.toStringTag] === 'Module' &&
    Object.keys(mod as object).filter((k) => k !== 'module.exports').length === 0
  );
}

/**
 * The errors Node raises for a CommonJS file in a `"type": "module"` package:
 * `ERR_REQUIRE_ESM` on Node versions without require(esm), and a ReferenceError for
 * `module` / `exports` on versions that evaluate the file as ESM.
 */
function isCjsInEsmScopeError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === 'ERR_REQUIRE_ESM' || (e instanceof ReferenceError && /module is not defined|exports is not defined/.test(e.message));
}

/**
 * mup.js files use `module.exports`. When the file sits inside a package with
 * `"type": "module"` (common for Meteor 3 apps), Node treats it as ESM. Compile
 * it as CommonJS explicitly so such configs keep working.
 */
function compileAsCommonJs(path: string): RawConfig {
  // Module#_compile and Module._nodeModulePaths are internal but long-stable Node APIs. The
  // lookup paths let require() calls inside mup.js resolve from the config file's directory.
  const m = new Module(path) as Module & { _compile(code: string, file: string): void; paths: string[] };
  m.filename = path;
  m.paths = (Module as any)._nodeModulePaths(dirname(path));
  m._compile(readFileSync(path, 'utf8'), path);
  const exported = m.exports as any;
  return (exported && exported.__esModule && exported.default) || exported;
}

/**
 * Finds and loads the config file. The raw object is returned without normalization or
 * validation.
 *
 * @throws CometError when the file is missing, cannot be loaded or does not export an object.
 */
export function loadConfig(cwd: string, configFlag?: string): LoadedConfig {
  const configPath = findConfigFile(cwd, configFlag);
  // Same as MUP: base path is the --config directory, otherwise cwd.
  const basePath = configFlag ? dirname(configPath) : cwd;
  const raw = loadFile(configPath);
  if (!raw || typeof raw !== 'object') throw new CometError(`${configPath} must export an object.`);
  return { configPath, basePath, raw };
}

/**
 * Reads a Meteor settings file. It must be strict JSON, as in MUP.
 *
 * @throws CometError when the file is missing or is not valid JSON.
 */
export function loadSettingsFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new CometError(`Settings file not found: ${path}`, { hint: 'Create it or pass --settings <path>.' });
  }
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CometError(`Invalid JSON in settings file ${path}: ${(err as Error).message}`);
  }
}

/**
 * Loads the Meteor settings: `--settings` relative to cwd, default `<basePath>/settings.json`
 * (MUP behavior). Throws like `loadSettingsFile`.
 */
export function loadSettings(o: { cwd: string; basePath: string; settingsFlag?: string }): {
  settings: unknown;
  settingsPath: string;
} {
  const settingsPath = o.settingsFlag
    ? resolve(o.cwd, expandTilde(o.settingsFlag))
    : join(o.basePath, 'settings.json');
  return { settings: loadSettingsFile(settingsPath), settingsPath };
}

/**
 * Resolves a user-supplied path the way MUP does: `base: 'cwd'` for the paths MUP resolves
 * against the current directory (`servers.*.pem`, `app.servers.*.settings`), `base: 'config'`
 * for paths relative to the base path. `~` is expanded and absolute paths are returned as is.
 *
 * comet-deploy addition: a cwd-relative path that does not exist falls back to the config
 * directory (with a warning), so commands also work when run from another directory. When
 * neither exists, the cwd-relative path is returned and the caller reports it as missing.
 */
export function resolveUserPath(
  p: string,
  o: { cwd: string; basePath: string; base: 'cwd' | 'config'; warn?: (m: string) => void },
): string {
  const expanded = expandTilde(p);
  if (isAbsolute(expanded)) return expanded;
  if (o.base === 'config') return resolve(o.basePath, expanded);
  const fromCwd = resolve(o.cwd, expanded);
  if (existsSync(fromCwd)) return fromCwd;
  const fromBase = resolve(o.basePath, expanded);
  if (fromBase !== fromCwd && existsSync(fromBase)) {
    o.warn?.(`"${p}" not found relative to the current directory; using ${fromBase} (relative to the config file).`);
    return fromBase;
  }
  return fromCwd;
}
